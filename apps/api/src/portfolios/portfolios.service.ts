import { BadRequestException, Injectable } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, DepositReportStatus } from '../database/database.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  BookingHoldPolicyService,
  type BookingHoldOutcome,
  type HoldBookingExpectations,
} from './booking-hold-policy.service.js';
import {
  BookingHoldLedger,
  type BookingHoldRelease,
  type BookingWithHold,
} from './booking-hold.ledger.js';
import type { BookingHoldPreview, BookingHoldQuote } from './booking-hold.js';
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
  type MovementsOptions,
  type WalletMovementView,
  type WalletView,
} from './wallet-store.js';

export type { PortfolioRow, PortfolioTransactionRow } from './wallet-store.js';
export type { BookingHoldOutcome, HoldBookingExpectations } from './booking-hold-policy.service.js';

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
  private readonly policy: BookingHoldPolicyService;

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: FlightProviderRegistry,
    private readonly orders: OrdersService,
    private readonly hotelProviders: HotelProviderRegistry,
  ) {
    // Se construyen acá y no se inyectan, como el intent de `OrdersService`: comparten la base y la
    // firma pública del servicio no cambia. La retención antes de reservar vive en su propio
    // servicio porque también la pide la saga de vuelos (`OrdersService`), que no puede depender de
    // este módulo.
    this.holds = new BookingHoldLedger(db);
    this.policy = new BookingHoldPolicyService(db);
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
   * /portfolios/hold-booking`). La regla vive en {@link BookingHoldPolicyService.holdBooking}.
   */
  holdBooking(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: HoldBookingExpectations = {},
  ): Promise<BookingHoldOutcome> {
    return this.policy.holdBooking(tenantId, orderId, createdBy, expected);
  }

  // ─────────────── Retención antes de reservar (docs/tbo/08 RF-23; D-TBO-21 A) ───────────────

  /**
   * ¿Alcanzan la cartera del nodo y las de su red para retener la venta? Lee sin bloquear, antes de
   * llamar al proveedor ({@link BookingHoldPolicyService.assertBookingHoldAffordable}).
   *
   * @throws BookingHoldRejectedError si no alcanza.
   */
  assertBookingHoldAffordable(
    tenantId: string,
    quote: BookingHoldQuote,
    opts: { readonly reportOrderId?: string } = {},
  ): Promise<void> {
    return this.policy.assertBookingHoldAffordable(tenantId, quote, opts);
  }

  /**
   * El aviso del PreBook: la misma decisión, devuelta en vez de lanzada
   * ({@link BookingHoldPolicyService.previewBookingHold}).
   */
  previewBookingHold(
    tenantId: string,
    quote: BookingHoldQuote,
    opts: { readonly reportNetworkBlock?: boolean } = {},
  ): Promise<BookingHoldPreview | undefined> {
    return this.policy.previewBookingHold(tenantId, quote, opts);
  }

  /**
   * Retiene el precio de venta sobre la orden ABIERTA, antes de llamar al proveedor, en la cartera
   * del nodo y en la de cada nivel de su red hasta el dueño de la credencial
   * ({@link BookingHoldPolicyService.holdBookingIntent}).
   */
  holdBookingIntent(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: Money,
  ): Promise<BookingHoldOutcome> {
    return this.policy.holdBookingIntent(tenantId, orderId, createdBy, expected);
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
