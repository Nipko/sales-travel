import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, DepositReportStatus } from '../database/database.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  BookingHoldLedger,
  type BookingHoldRelease,
  type BookingWithHold,
} from './booking-hold.ledger.js';
import {
  BookingHoldRejectedError,
  bookingHoldMessage,
  isNetworkRejection,
  type BookingHoldPreview,
  type BookingHoldQuote,
} from './booking-hold.js';
import {
  PortfolioConflictError,
  isUniqueViolation,
  rethrowPortfolioError,
  walletNotEnabled,
} from './portfolio-errors.js';
import type { NetworkHoldsQuery, SubmitDepositReportDto } from './portfolios.schemas.js';
import {
  depositReportById,
  findWallet,
  listDepositReports,
  listMovements,
  listNetworkHolds,
  listWallets,
  walletView,
  type DepositReportView,
  type NetworkHoldsView,
  type PortfolioRow,
  type PortfolioTransactionRow,
  type MovementsOptions,
  type WalletMovementView,
  type WalletView,
} from './wallet-store.js';
import { WalletHoldStore, translateWalletHoldError } from './wallet-hold.store.js';

export type { PortfolioRow, PortfolioTransactionRow } from './wallet-store.js';

/** Las carteras de la agencia y quién se las financia (a quién pedirle cupo o una moneda). */
export interface AgencyWalletsView {
  portfolios: WalletView[];
  /**
   * `null` para la raíz de la red o un nodo legado sin padre: sus carteras las gestiona el
   * superadmin.
   */
  financier: { tenantId: string; name: string } | null;
  /**
   * Los proveedores en que el nodo tiene su PROPIA cuenta activa en la bóveda (la que
   * `resolve_provider_account` le resuelve antes que cualquier heredada), todos, también los que no
   * reservan (el correo). Una reserva que graba esa cuenta en la orden (hoy, hoteles de TBO) no
   * retiene de ninguna cartera (decisión del founder del 2026-09-30): la web decide con qué
   * proveedores vale y deja de avisar que falta una. Sólo códigos, sin cuentas ni credenciales.
   */
  ownProviderAccounts: string[];
}

/** Lo que una reserva retenida admite desde la cartera. */
interface BookingActionCapabilities {
  /** Emisión diferida: convertir la retención en el cargo de una emisión. */
  readonly pay: boolean;
  /** Cancelación real con el proveedor por `OrdersService.cancelOrder`, antes de liberar. */
  readonly cancel: boolean;
}

export type { BookingHoldRelease } from './booking-hold.ledger.js';

/**
 * Lo que dejó una retención: la cartera del nodo que vende y su asiento, o nada si la reserva es con
 * la cuenta propia del nodo (O = T; decisión del founder del 2026-09-30, opción B): no se retuvo en
 * ninguna cartera y no hizo falta tener una en esa moneda.
 */
export type BookingHoldOutcome =
  | {
      readonly status: 'held';
      readonly portfolio: PortfolioRow;
      readonly transaction: PortfolioTransactionRow;
    }
  | { readonly status: 'own-account' };

export interface HoldBookingExpectations {
  /**
   * Snapshot que vio el cliente. Sirve únicamente para detectar una pantalla vencida: el débito
   * siempre se calcula con `orders.total_amount` dentro de la transacción.
   */
  readonly amountMinor?: number;
  /** Misma regla que `amountMinor`: nunca selecciona la moneda que se carga. */
  readonly currency?: string;
}

const CONFIRMED_ONLY = 'Sólo una reserva confirmada y no emitida puede retener saldo de cartera.';
const OPEN_INTENT_ONLY =
  'Sólo una reserva abierta, antes de enviarse al proveedor, puede retener saldo de cartera.';
const ALREADY_HELD = 'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.';

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function assertSafePositiveMinor(amountMinor: number, label: string): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new BadRequestException(`${label} must be a positive safe integer`);
  }
}

/** El monto de una retención, validado y con la moneda normalizada. */
function holdAmount(amount: Money): Money {
  assertSafePositiveMinor(amount.amountMinor, 'Booking amount');
  const currency = normalizeCurrency(amount.currency);
  if (!currency) {
    throw new BadRequestException('La reserva no tiene una moneda válida para retener saldo.');
  }
  return { amountMinor: amount.amountMinor, currency };
}

/** Lo que la orden dice, leído con la fila bloqueada, para validar antes de retener. */
interface LockedOrder {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
}

/** Un depósito informado anterior con la misma Idempotency-Key, para comparar con el reenvío. */
interface PriorDepositReport {
  id: string;
  currency: string;
  amount_minor: number | string;
  reference: string;
  deposited_on: string | null;
  notes: string | null;
  reported_by: string;
}

@Injectable()
export class PortfoliosService {
  private readonly holds: BookingHoldLedger;
  private readonly walletHolds: WalletHoldStore;

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: FlightProviderRegistry,
    private readonly orders: OrdersService,
    private readonly hotelProviders: HotelProviderRegistry,
  ) {
    // Se construyen acá y no se inyectan, como el intent de `OrdersService`: comparten la base y la
    // firma pública del servicio no cambia.
    this.holds = new BookingHoldLedger(db);
    this.walletHolds = new WalletHoldStore(db);
  }

  // ─────────────────────── Lo que ve y hace la agencia (Cartera B2B) ───────────────────────

  /**
   * Las carteras de la agencia, una por moneda, quién la financia y con qué proveedores reserva con
   * su cuenta propia (esas reservas no retienen). Sólo lee: una agencia sin carteras no tiene
   * ninguna hasta que quien la financia le habilite una moneda.
   */
  async overview(tenantId: string): Promise<AgencyWalletsView> {
    return this.db.withTenant(tenantId, async (trx) => {
      const wallets = await listWallets(trx, tenantId);
      // `tenants` no tiene RLS; tenant_financier_id devuelve sólo el id del ancestro.
      const financier = await sql<{ id: string; name: string }>`
        SELECT f.id, f.name FROM tenants f WHERE f.id = tenant_financier_id(${tenantId}::uuid)
      `.execute(trx);
      // La RLS de provider_accounts deja ver sólo las del tenant: nunca las de un ancestro.
      const own = await trx
        .selectFrom('provider_accounts')
        .select('provider_code')
        .distinct()
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .orderBy('provider_code')
        .execute();
      const row = financier.rows[0];
      return {
        portfolios: wallets.map(walletView),
        financier: row === undefined ? null : { tenantId: row.id, name: row.name },
        ownProviderAccounts: own.map((a) => a.provider_code),
      };
    });
  }

  /**
   * Los movimientos de las carteras de la agencia, o de la de una moneda. Los datos de las reservas
   * de la red (agencia de origen, número) sólo con `includeNetwork`, para quien administra el nodo.
   */
  async listTransactions(
    tenantId: string,
    currency?: string,
    options: MovementsOptions = { includeNetwork: false },
  ): Promise<WalletMovementView[]> {
    return this.db.withTenant(tenantId, (trx) => listMovements(trx, tenantId, currency, options));
  }

  /**
   * Lo que la red del nodo tiene retenido o cobrado en sus carteras, al costo de su nivel
   * (`NETWORK_HOLD`, 0060). Sin vendedores, pasajeros ni precio de venta.
   */
  async listNetworkHolds(tenantId: string, query: NetworkHoldsQuery): Promise<NetworkHoldsView> {
    return this.db.withTenant(tenantId, (trx) => listNetworkHolds(trx, tenantId, query));
  }

  /** Los depósitos que informó la agencia, pendientes y resueltos. */
  async listDepositReports(
    tenantId: string,
    status?: DepositReportStatus,
  ): Promise<DepositReportView[]> {
    return this.db.withTenant(tenantId, (trx) =>
      listDepositReports(trx, tenantId, status === undefined ? {} : { status }),
    );
  }

  /**
   * La agencia informa un depósito sobre su cartera de esa moneda. Nace pendiente y no mueve el
   * saldo: lo acredita quien la financia al aprobarlo (WalletFinancingService). El rastro
   * (`portfolio.deposit_report.submitted`) lo deja la base en la misma transacción.
   *
   * Corre con el usuario que informa y el tenant de la agencia: la RLS de 0052 exige los dos. Un
   * reenvío con la misma Idempotency-Key devuelve el mismo informe; con otros datos, 409.
   *
   * @throws PortfolioConflictError `PORTFOLIO_CURRENCY_NOT_ENABLED` si no hay cartera en esa moneda.
   */
  async submitDepositReport(
    actorUserId: string,
    tenantId: string,
    input: SubmitDepositReportDto,
    idempotencyKey: string,
  ): Promise<DepositReportView> {
    const submit = () =>
      this.db.withRequestContext({ userId: actorUserId, tenantId }, async (trx) => {
        const prior = await this.priorDepositReport(trx, tenantId, idempotencyKey);
        if (prior) return this.replayDepositReport(trx, tenantId, prior, actorUserId, input);

        const wallet = await findWallet(trx, tenantId, input.currency);
        if (!wallet) throw walletNotEnabled(input.currency);
        const inserted = await trx
          .insertInto('portfolio_deposit_reports')
          .values({
            tenant_id: tenantId,
            portfolio_id: wallet.id,
            amount_minor: input.amountMinor,
            currency: wallet.currency,
            reference: input.reference,
            deposited_on: input.depositedOn,
            notes: input.notes,
            idempotency_key: idempotencyKey,
            reported_by: actorUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return this.reportOrFail(trx, tenantId, inserted.id);
      });

    try {
      return await submit();
    } catch (error) {
      // Otro envío con la misma clave confirmó mientras este insertaba: se responde con el suyo.
      if (isUniqueViolation(error)) return submit().catch(rethrowPortfolioError);
      return rethrowPortfolioError(error);
    }
  }

  private async priorDepositReport(
    trx: Transaction<DB>,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PriorDepositReport | undefined> {
    return trx
      .selectFrom('portfolio_deposit_reports')
      .select([
        'id',
        'currency',
        'amount_minor',
        'reference',
        sql<string | null>`to_char(deposited_on, 'YYYY-MM-DD')`.as('deposited_on'),
        'notes',
        'reported_by',
      ])
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  private async replayDepositReport(
    trx: Transaction<DB>,
    tenantId: string,
    prior: PriorDepositReport,
    actorUserId: string,
    input: SubmitDepositReportDto,
  ): Promise<DepositReportView> {
    const same =
      prior.reported_by === actorUserId &&
      prior.currency === input.currency &&
      Number(prior.amount_minor) === input.amountMinor &&
      prior.reference === input.reference &&
      prior.deposited_on === input.depositedOn &&
      prior.notes === input.notes;
    if (!same) throw new PortfolioConflictError('PORTFOLIO_IDEMPOTENCY_KEY_REUSED');
    return this.reportOrFail(trx, tenantId, prior.id);
  }

  private async reportOrFail(
    trx: Transaction<DB>,
    tenantId: string,
    reportId: string,
  ): Promise<DepositReportView> {
    const report = await depositReportById(trx, tenantId, reportId);
    if (!report) throw new Error(`deposit report ${reportId} not readable after write`);
    return report;
  }

  /**
   * Retiene el total de una reserva ya confirmada y no emitida (vuelos y autos, `POST
   * /portfolios/hold-booking`), con las mismas reglas que la retención previa al Book de un hotel:
   * la cartera de la moneda de la orden, activa, y su saldo más el cupo que fija quien financia; y,
   * desde 0060, la cartera de cada nivel de su red hasta el dueño de la credencial (vuelos y autos no
   * guardan la cuenta en la orden: la base toma la que la bóveda le resuelve al nodo para el
   * proveedor, o la raíz con credenciales de entorno). La retención nace cobrada: la reserva ya
   * existe. Como la orden no guarda con qué cuenta se reservó, la del propio nodo que hoy le resuelve
   * la bóveda no la exime: retiene en su cartera, como antes de 0060. Sólo la plataforma, dueña de
   * todo lo que se le resuelve, queda sin retener (`own-account`).
   *
   * @throws BookingHoldRejectedError si la cartera propia o la de un nivel de la red no alcanza.
   * @throws BadRequestException si la orden no es una reserva confirmada de este tenant, o no dice
   *   lo que el cliente esperaba.
   * @throws ConflictException si la orden ya tiene una retención.
   * @throws PortfolioHoldBusyError si la red siguió contenida después de los reintentos.
   */
  async holdBooking(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: HoldBookingExpectations = {},
  ): Promise<BookingHoldOutcome> {
    let currency: string | undefined;
    try {
      return await this.walletHolds.run(tenantId, async (trx) => {
        // La orden, su monto y su moneda se leen bajo el tenant y dentro de la MISMA transacción
        // que toma el hold. Ningún campo financiero del request participa en el débito.
        const order = await this.lockOrder(trx, tenantId, orderId, (row) =>
          row.status === 'confirmed' ? undefined : CONFIRMED_ONLY,
        );
        currency = order.currency;

        // Los valores opcionales del cliente son un control optimista, no una fuente de verdad.
        if (expected.amountMinor !== undefined && expected.amountMinor !== order.amountMinor) {
          throw new BadRequestException(
            'El total de la reserva cambió. Actualice la reserva antes de retener saldo.',
          );
        }
        if (expected.currency !== undefined) {
          const expectedCurrency = normalizeCurrency(expected.currency);
          if (!expectedCurrency || expectedCurrency !== order.currency) {
            throw new BadRequestException(
              'La moneda de la reserva cambió. Actualice la reserva antes de retener saldo.',
            );
          }
        }

        return this.retainOnWallets(trx, tenantId, order, createdBy);
      });
    } catch (error) {
      throw await this.holdFailure(tenantId, orderId, error, currency, CONFIRMED_ONLY);
    }
  }

  // ─────────────── Retención antes de reservar (docs/tbo/08 RF-23; D-TBO-21 A) ───────────────

  /**
   * ¿Alcanzan la cartera del nodo en la moneda de la tarifa y las de su red para retener la venta?
   * Lee sin bloquear y ANTES de llamar al proveedor, para que una agencia sin cartera en esa
   * moneda, sin saldo ni cupo, o con un nivel de su red que no la cubre, no llegue a llamarlo
   * (RF-23 CA-1). No reemplaza a {@link holdBookingIntent}, que vuelve a decidir con las carteras
   * bloqueadas. Si la base no puede evaluarlo (una cuenta que ya no se resuelve), sigue: decide la
   * reserva. Con la cuenta propia del nodo no hay nada que cubrir: sigue sin mirar carteras.
   *
   * Con `reportOrderId` (la orden ya abierta), un rechazo de la red deja el aviso al nivel que
   * bloqueó (`portfolio.network_hold.blocked`).
   *
   * @throws BookingHoldRejectedError si no alcanza.
   */
  async assertBookingHoldAffordable(
    tenantId: string,
    quote: BookingHoldQuote,
    opts: { readonly reportOrderId?: string } = {},
  ): Promise<void> {
    const preview = await this.previewBookingHold(tenantId, quote);
    if (preview?.status !== 'blocked') return;
    if (isNetworkRejection(preview.reason) && opts.reportOrderId !== undefined) {
      await this.walletHolds.reportBlock(tenantId, opts.reportOrderId);
    }
    throw new BookingHoldRejectedError(preview.reason, { amountCurrency: preview.currency });
  }

  /**
   * El aviso del PreBook: la misma decisión que {@link assertBookingHoldAffordable}, devuelta en vez
   * de lanzada, para que el vendedor sepa ANTES de cargar huéspedes que la agencia o su red no
   * pueden retener la tarifa. Sólo lee y no promete nada: la reserva vuelve a decidir con las
   * carteras bloqueadas. `undefined` si la base no lo puede evaluar; `own-account` si se reserva con
   * la cuenta propia del nodo, que no retiene nada (la web no avisa nada por la cartera).
   *
   * Con `reportNetworkBlock` (el PreBook), un bloqueo de la red deja además el aviso al nivel que
   * bloquea, sin orden: la web frena al vendedor acá y el Book, que lo avisaría, no llega a correr.
   */
  async previewBookingHold(
    tenantId: string,
    quote: BookingHoldQuote,
    opts: { readonly reportNetworkBlock?: boolean } = {},
  ): Promise<BookingHoldPreview | undefined> {
    const amount = holdAmount(quote.amount);
    const decision = await this.db.withTenant(tenantId, (trx) =>
      this.walletHolds.preview(trx, { ...quote, amount }),
    );
    if (decision === undefined) return undefined;
    if (decision.status === 'ok') return { status: 'ok', currency: amount.currency };
    if (decision.status === 'exempt') return { status: 'own-account', currency: amount.currency };
    if (opts.reportNetworkBlock === true && isNetworkRejection(decision.reason)) {
      await this.walletHolds.reportPreviewBlock(tenantId, { ...quote, amount });
    }
    return {
      status: 'blocked',
      currency: amount.currency,
      reason: decision.reason,
      message: bookingHoldMessage(decision.reason, amount.currency),
    };
  }

  /**
   * Retiene el precio de venta sobre la orden ABIERTA, antes de llamar al proveedor (RF-23;
   * D-TBO-21 A), en la cartera del nodo y en la de cada nivel de su red hasta el dueño de la
   * credencial (0060). Es la retención de {@link holdBooking} —mismo asiento `BOOKING_HOLD` en la
   * cartera propia, mismo débito—, sobre el intent en vez de sobre una reserva confirmada: con un
   * proveedor que cobra al crédito de una cuenta, la plata tiene que estar comprometida cuando sale
   * la reserva, no después.
   *
   * El monto y la moneda se leen de la orden bajo el tenant y en la misma transacción; `expected` es
   * sólo el control de que la saga retiene lo que cree. Las carteras se bloquean ANTES de decidir
   * (la propia primero, después la red por nivel), así que dos reservas no gastan el mismo saldo.
   * Con la cuenta propia del nodo (la de la orden) no se retiene nada: `own-account`, y la reserva
   * sigue aunque el nodo no tenga cartera en esa moneda.
   *
   * @throws BookingHoldRejectedError si la cartera propia o la de un nivel de la red no alcanza.
   * @throws BadRequestException si la orden no es un intent abierto de este tenant.
   * @throws ConflictException si la orden ya tiene una retención.
   * @throws PortfolioHoldAccountChangedError si la cuenta de la orden ya no se resuelve.
   * @throws PortfolioHoldBusyError si la red siguió contenida después de los reintentos.
   */
  async holdBookingIntent(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: Money,
  ): Promise<BookingHoldOutcome> {
    const target = holdAmount(expected);
    try {
      return await this.walletHolds.run(tenantId, async (trx) => {
        // Una orden con desenlace ya lo tiene, y una sin clave no es una creación en curso.
        const order = await this.lockOrder(trx, tenantId, orderId, (row) =>
          row.status !== 'pending' || row.provider_raw !== null || row.create_request_key === null
            ? OPEN_INTENT_ONLY
            : undefined,
        );
        if (order.amountMinor !== target.amountMinor || order.currency !== target.currency) {
          throw new BadRequestException(
            'El total de la reserva cambió. No se retuvo saldo de la cartera.',
          );
        }
        return this.retainOnWallets(trx, tenantId, order, createdBy);
      });
    } catch (error) {
      throw await this.holdFailure(tenantId, orderId, error, target.currency, OPEN_INTENT_ONLY);
    }
  }

  /**
   * La orden del tenant, bloqueada, con su total y su moneda validados. `refuse` dice por qué su
   * estado no admite la retención de esa vía.
   */
  private async lockOrder(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    refuse: (row: {
      status: string;
      provider_raw: unknown;
      create_request_key: string | null;
    }) => string | undefined,
  ): Promise<LockedOrder> {
    const order = await trx
      .selectFrom('orders')
      .select(['id', 'status', 'total_amount', 'currency', 'provider_raw', 'create_request_key'])
      .where('id', '=', orderId)
      .where('tenant_id', '=', tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) {
      throw new BadRequestException(
        'No se encontró la reserva. No se modificó el saldo de la cartera.',
      );
    }
    const refused = refuse(order);
    if (refused !== undefined) throw new BadRequestException(refused);

    const amountMinor = Number(order.total_amount);
    const currency = normalizeCurrency(order.currency);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !currency) {
      throw new BadRequestException(
        'La reserva no tiene un total y una moneda válidos para crear la retención.',
      );
    }
    // `order.id` y no `orderId`: PostgreSQL lo devuelve en su forma canónica.
    return { id: order.id, amountMinor, currency };
  }

  /**
   * La retención por `wallet_hold_retain`, dentro de la transacción que ya bloqueó la orden, y lo
   * que quedó en la cartera propia. La base decide la cadena, los montos, el orden de los bloqueos y
   * si la cuenta es la propia del nodo (entonces no retiene nada); la respuesta sólo lleva datos del
   * nodo que vende.
   */
  private async retainOnWallets(
    trx: Transaction<DB>,
    tenantId: string,
    order: LockedOrder,
    createdBy: string,
  ): Promise<BookingHoldOutcome> {
    const retained = await this.walletHolds.retain(trx, order.id, createdBy);
    if (retained.status === 'exempt') return { status: 'own-account' };
    const portfolio = await trx
      .selectFrom('agency_portfolios')
      .selectAll()
      .where('id', '=', retained.ownPortfolioId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    const transaction = await trx
      .selectFrom('portfolio_transactions')
      .selectAll()
      .where('id', '=', retained.ownTransactionId)
      .where('portfolio_id', '=', retained.ownPortfolioId)
      .executeTakeFirst();
    if (!portfolio || !transaction) {
      throw new Error('la retención propia no se puede leer después de escribirla');
    }
    return {
      status: 'held',
      portfolio: portfolio as unknown as PortfolioRow,
      transaction: transaction as unknown as PortfolioTransactionRow,
    };
  }

  /**
   * El error HTTP de una retención que no se hizo. Un rechazo de la red deja, además, el aviso al
   * nivel que bloqueó, en su propia transacción (la de la retención ya se revirtió).
   */
  private async holdFailure(
    tenantId: string,
    orderId: string,
    error: unknown,
    currency: string | undefined,
    notHoldableMessage: string,
  ): Promise<unknown> {
    // El índice de 0039 frena una segunda retención que se colara por otra ruta.
    if (isUniqueViolation(error)) return new ConflictException(ALREADY_HELD);
    const translated = translateWalletHoldError(error, currency, notHoldableMessage) ?? error;
    if (translated instanceof BookingHoldRejectedError && isNetworkRejection(translated.reason)) {
      await this.walletHolds.reportBlock(tenantId, orderId);
    }
    return translated;
  }

  /**
   * Libera la retención de una reserva que el proveedor NO hizo (RF-23 CA-2). `failed` es la única
   * prueba de eso: una orden `pending` puede tener reserva del otro lado (desenlace incierto,
   * D-TBO-24 A) y conserva la retención hasta que se resuelva; una confirmada la convierte en cargo.
   *
   * Idempotente: una segunda llamada encuentra la liberación y no vuelve a acreditar. Sin retención
   * no hace nada.
   *
   * @throws ConflictException si la orden tiene retención y no está `failed`.
   */
  async releaseFailedBookingHold(
    tenantId: string,
    orderId: string,
    createdBy: string,
  ): Promise<BookingHoldRelease> {
    return this.holds.releaseFailed(tenantId, orderId, createdBy);
  }

  /**
   * Libera la retención de una reserva que el proveedor ya muestra cancelada (docs/tbo/09 PR-5.3).
   * La cancelación de un hotel puede quedar en curso y cerrarse horas después por una lectura, sin
   * que nadie vuelva a pasar por {@link rejectBooking}. Idempotente; sin retención no hace nada.
   *
   * @throws ConflictException si la orden tiene retención y no está `cancelled`.
   */
  async releaseCancelledBookingHold(
    tenantId: string,
    orderId: string,
    createdBy: string,
  ): Promise<BookingHoldRelease> {
    return this.holds.releaseCancelled(tenantId, orderId, createdBy);
  }

  async approveBooking(
    tenantId: string,
    orderId: string,
  ): Promise<{ success: boolean; message: string }> {
    const booking = await this.getBookingActionContext(tenantId, orderId);
    const capabilities = this.actionCapabilities(booking);

    if (capabilities?.pay !== true) {
      throw new BadRequestException(
        `El proveedor '${booking.provider}' no admite emisión diferida desde cartera. ` +
          'No se debitó el saldo ni se cambió el estado de la reserva.',
      );
    }

    // `pay` sólo declara que el proveedor tiene una operación de pago/emisión. Este endpoint no
    // recibe los datos que esa operación exige ni tiene un fulfillment de cartera conectado.
    // Convertir el hold en cargo aquí volvería a afirmar una emisión que nunca ocurrió.
    throw new BadRequestException(
      `La emisión desde cartera para '${booking.provider}' todavía no está conectada a una ` +
        'operación real del proveedor. No se debitó el saldo ni se cambió el estado de la reserva.',
    );
  }

  async rejectBooking(
    tenantId: string,
    orderId: string,
    actorUserId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const booking = await this.getBookingActionContext(tenantId, orderId);
    // Recuperación idempotente: si la cancelación real ya quedó persistida pero el proceso cayó
    // antes de liberar el hold, no se reenvía el write al proveedor. Se termina únicamente la
    // mitad contable pendiente. El claim condicional de abajo sigue impidiendo doble liberación.
    // Una reserva `failed` tampoco tiene nada que cancelar: el proveedor no la hizo, y si la saga
    // no pudo liberar su retención, esto la libera.
    const failed = booking.orderStatus === 'failed';
    if (booking.orderStatus !== 'cancelled' && !failed) {
      const capabilities = this.actionCapabilities(booking);

      if (capabilities?.cancel !== true) {
        throw new BadRequestException(
          `El proveedor '${booking.provider}' no admite cancelación real desde este flujo. ` +
            'No se liberó el saldo ni se cambió el estado de la reserva.',
        );
      }
      if (!booking.providerOrderId) {
        throw new BadRequestException(
          'La reserva no tiene un localizador del proveedor que se pueda cancelar. ' +
            'No se liberó el saldo ni se cambió el estado de la reserva.',
        );
      }

      try {
        // Reutiliza el único camino que ya registra el intento, distingue UNVERIFIED, gobierna
        // reintentos y sólo persiste `cancelled` después de una respuesta exitosa del proveedor.
        const cancellation = await this.orders.cancelOrder(
          tenantId,
          orderId,
          booking.providerOrderId,
          actorUserId,
        );

        if (!cancellation.result.success || cancellation.order?.status !== 'cancelled') {
          throw new BadRequestException(
            'El proveedor no confirmó la cancelación. No se liberó el saldo ni se cambió el ' +
              'estado de la reserva.',
          );
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException(
          'No fue posible confirmar la cancelación con el proveedor. No se liberó el saldo ni ' +
            'se cambió el estado de la reserva.',
        );
      }
    }

    // Libera todos los niveles de la red de una vez, sobre lo que se retuvo. Si la cancelación de
    // arriba ya lo hizo (un vuelo), devuelve `already-released` sin acreditar otra vez.
    await this.holds.settleExpected(
      tenantId,
      orderId,
      actorUserId ?? booking.hold.createdBy,
      failed ? 'failed' : 'cancelled',
    );

    return {
      success: true,
      message: failed
        ? 'El proveedor no hizo la reserva y el saldo retenido quedó liberado.'
        : 'Cancelación confirmada por el proveedor y saldo retenido liberado.',
    };
  }

  /**
   * Qué admite desde la cartera una reserva retenida, según su vertical. Un hotel no se busca en el
   * registry de vuelos: ahí no existe, y un "no admite" por ese motivo diría lo correcto por la
   * razón equivocada el día que el código de un proveedor se repita entre verticales.
   */
  private actionCapabilities(booking: BookingWithHold): BookingActionCapabilities | undefined {
    if (booking.vertical === 'flights') return this.providers.capabilitiesOf(booking.provider);
    if (booking.vertical !== 'hotels') return undefined;
    if (this.hotelProviders.capabilitiesOf(booking.provider) === undefined) return undefined;
    // El voucher del hotel sale con el Book: no queda una emisión que cobrar desde aquí. Y su
    // cancelación puede quedar en curso horas (docs/tbo/04 §4.4), cosa que este rechazo, que
    // libera en el acto, no sabe esperar: se cancela desde Reservas, y la retención la libera la
    // propia cancelación, o su verificación, cuando la orden queda `cancelled`.
    return { pay: false, cancel: false };
  }

  private async getBookingActionContext(
    tenantId: string,
    orderId: string,
  ): Promise<BookingWithHold> {
    const booking = await this.holds.load(tenantId, orderId);
    if (booking.hold === undefined) {
      throw new BadRequestException(
        'No existe una retención pendiente para esta reserva. No se modificó el saldo.',
      );
    }
    return { ...booking, hold: booking.hold };
  }
}
