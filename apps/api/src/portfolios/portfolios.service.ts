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
  RELEASE_AFTER_CANCEL_NOTES,
  RELEASE_AFTER_FAILURE_NOTES,
  isUniqueViolation,
  type BookingHoldRelease,
  type BookingWithHold,
} from './booking-hold.ledger.js';
import {
  BookingHoldRejectedError,
  bookingHoldMessage,
  decideBookingHold,
  type BookingHoldDecision,
  type BookingHoldFacts,
  type BookingHoldPreview,
  type BookingHoldRejection,
} from './booking-hold.js';
import {
  PortfolioConflictError,
  rethrowPortfolioError,
  walletNotEnabled,
} from './portfolio-errors.js';
import type { SubmitDepositReportDto } from './portfolios.schemas.js';
import {
  depositReportById,
  findWallet,
  listDepositReports,
  listMovements,
  listWallets,
  walletView,
  type DepositReportView,
  type PortfolioRow,
  type PortfolioTransactionRow,
  type WalletMovementView,
  type WalletView,
} from './wallet-store.js';

export type { PortfolioRow, PortfolioTransactionRow } from './wallet-store.js';

/** Las carteras de la agencia y quién se las financia (a quién pedirle cupo o una moneda). */
export interface AgencyWalletsView {
  portfolios: WalletView[];
  /**
   * `null` para la raíz de la red o un nodo legado sin padre: sus carteras las gestiona el
   * superadmin.
   */
  financier: { tenantId: string; name: string } | null;
}

/** Lo que una reserva retenida admite desde la cartera. */
interface BookingActionCapabilities {
  /** Emisión diferida: convertir la retención en el cargo de una emisión. */
  readonly pay: boolean;
  /** Cancelación real con el proveedor por `OrdersService.cancelOrder`, antes de liberar. */
  readonly cancel: boolean;
}

export type { BookingHoldRelease } from './booking-hold.ledger.js';

const HOLD_BEFORE_BOOK_NOTES = 'Retención de saldo antes de reservar con el proveedor';
const HOLD_CONFIRMED_NOTES = 'Retención preventiva de saldo por reserva pendiente de emisión';

interface HeldOnWallet {
  portfolio: PortfolioRow;
  transaction: PortfolioTransactionRow;
}

export interface HoldBookingExpectations {
  /**
   * Snapshot que vio el cliente. Sirve únicamente para detectar una pantalla vencida: el débito
   * siempre se calcula con `orders.total_amount` dentro de la transacción.
   */
  readonly amountMinor?: number;
  /** Misma regla que `amountMinor`: nunca selecciona la moneda que se carga. */
  readonly currency?: string;
}

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

function holdRejection(reason: BookingHoldRejection, amount: Money): BookingHoldRejectedError {
  return new BookingHoldRejectedError(reason, { amountCurrency: amount.currency });
}

/** Lo que la decisión necesita de la cartera de la agencia en la moneda de la reserva. */
function holdFacts(portfolio: PortfolioRow | undefined, amount: Money): BookingHoldFacts {
  if (portfolio === undefined) return { amount, portfolio: null };
  return {
    amount,
    portfolio: {
      balanceMinor: Number(portfolio.balance_minor),
      creditLimitMinor: Number(portfolio.credit_limit_minor),
      currency: normalizeCurrency(portfolio.currency) ?? '',
      status: portfolio.status,
    },
  };
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

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: FlightProviderRegistry,
    private readonly orders: OrdersService,
    private readonly hotelProviders: HotelProviderRegistry,
  ) {
    // Se construye acá y no se inyecta, como el intent de `OrdersService`: comparte la base y la
    // firma pública del servicio no cambia.
    this.holds = new BookingHoldLedger(db);
  }

  // ─────────────────────── Lo que ve y hace la agencia (Cartera B2B) ───────────────────────

  /**
   * Las carteras de la agencia, una por moneda, y quién la financia. Sólo lee: una agencia sin
   * carteras no tiene ninguna hasta que quien la financia le habilite una moneda.
   */
  async overview(tenantId: string): Promise<AgencyWalletsView> {
    return this.db.withTenant(tenantId, async (trx) => {
      const wallets = await listWallets(trx, tenantId);
      // `tenants` no tiene RLS; tenant_financier_id devuelve sólo el id del ancestro.
      const financier = await sql<{ id: string; name: string }>`
        SELECT f.id, f.name FROM tenants f WHERE f.id = tenant_financier_id(${tenantId}::uuid)
      `.execute(trx);
      const row = financier.rows[0];
      return {
        portfolios: wallets.map(walletView),
        financier: row === undefined ? null : { tenantId: row.id, name: row.name },
      };
    });
  }

  /** Los movimientos de las carteras de la agencia, o de la de una moneda. */
  async listTransactions(tenantId: string, currency?: string): Promise<WalletMovementView[]> {
    return this.db.withTenant(tenantId, (trx) => listMovements(trx, tenantId, currency));
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
   * la cartera de la moneda de la orden, activa, y su saldo más el cupo que fija quien financia.
   *
   * @throws BookingHoldRejectedError sin cartera en esa moneda, suspendida o sin saldo ni cupo.
   * @throws BadRequestException si la orden no es una reserva confirmada de este tenant, o no dice
   *   lo que el cliente esperaba.
   * @throws ConflictException si la orden ya tiene una retención.
   */
  async holdBooking(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: HoldBookingExpectations = {},
  ): Promise<HeldOnWallet> {
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        // La orden, su monto y su moneda se leen bajo el tenant y dentro de la MISMA transacción
        // que toma el hold. Ningún campo financiero del request participa en el débito.
        const order = await trx
          .selectFrom('orders')
          .select(['id', 'status', 'total_amount', 'currency'])
          .where('id', '=', orderId)
          .where('tenant_id', '=', tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!order) {
          throw new BadRequestException(
            'No se encontró la reserva. No se modificó el saldo de la cartera.',
          );
        }
        if (order.status !== 'confirmed') {
          throw new BadRequestException(
            'Sólo una reserva confirmada y no emitida puede retener saldo de cartera.',
          );
        }

        const amountMinor = Number(order.total_amount);
        const orderCurrency = normalizeCurrency(order.currency);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !orderCurrency) {
          throw new BadRequestException(
            'La reserva no tiene un total y una moneda válidos para crear la retención.',
          );
        }

        // Los valores opcionales del cliente son un control optimista, no una fuente de verdad.
        if (expected.amountMinor !== undefined && expected.amountMinor !== amountMinor) {
          throw new BadRequestException(
            'El total de la reserva cambió. Actualice la reserva antes de retener saldo.',
          );
        }
        if (expected.currency !== undefined) {
          const expectedCurrency = normalizeCurrency(expected.currency);
          if (!expectedCurrency || expectedCurrency !== orderCurrency) {
            throw new BadRequestException(
              'La moneda de la reserva cambió. Actualice la reserva antes de retener saldo.',
            );
          }
        }

        // `order.id` y no `orderId`: PostgreSQL lo devuelve en su forma canónica, y el asiento no
        // guarda el casing que llegó por HTTP.
        return this.retainOnWallet(
          trx,
          tenantId,
          order.id,
          { amountMinor, currency: orderCurrency },
          createdBy,
          HOLD_CONFIRMED_NOTES,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.',
        );
      }
      throw error;
    }
  }

  // ─────────────── Retención antes de reservar (docs/tbo/08 RF-23; D-TBO-21 A) ───────────────

  /**
   * ¿Alcanza la cartera de la moneda de `amount` para retenerlo? Lee sin bloquear y ANTES de abrir
   * la orden, para que una agencia sin cartera en esa moneda, sin saldo o sin cupo no llegue a
   * llamar al proveedor (RF-23 CA-1). No reemplaza a {@link holdBookingIntent}, que vuelve a decidir
   * con la cartera bloqueada.
   *
   * @throws BookingHoldRejectedError si no alcanza.
   */
  async assertBookingHoldAffordable(tenantId: string, amount: Money): Promise<void> {
    const target = holdAmount(amount);
    const decision = await this.readHoldDecision(tenantId, target);
    if (!decision.ok) throw holdRejection(decision.reason, target);
  }

  /**
   * El aviso del PreBook: la misma decisión que {@link assertBookingHoldAffordable}, devuelta en vez
   * de lanzada, para que el vendedor sepa ANTES de cargar huéspedes que la agencia no tiene cartera
   * en la moneda de la tarifa, que está suspendida o que no le alcanza. Sólo lee y no promete nada:
   * la reserva vuelve a decidir con la cartera bloqueada.
   */
  async previewBookingHold(tenantId: string, amount: Money): Promise<BookingHoldPreview> {
    const target = holdAmount(amount);
    const decision = await this.readHoldDecision(tenantId, target);
    if (decision.ok) return { status: 'ok', currency: target.currency };
    return {
      status: 'blocked',
      currency: target.currency,
      reason: decision.reason,
      message: bookingHoldMessage(decision.reason, target.currency),
    };
  }

  /** La decisión sobre la cartera de la moneda de `target`, leída sin bloquearla. */
  private async readHoldDecision(tenantId: string, target: Money): Promise<BookingHoldDecision> {
    return this.db.withTenant(tenantId, async (trx) =>
      decideBookingHold(holdFacts(await findWallet(trx, tenantId, target.currency), target)),
    );
  }

  /**
   * Retiene el precio de venta sobre la orden ABIERTA, antes de llamar al proveedor (RF-23;
   * D-TBO-21 A). Es la retención de {@link holdBooking} —mismo asiento `BOOKING_HOLD`, mismo índice
   * único por orden, mismo débito—, sobre el intent en vez de sobre una reserva confirmada: con un
   * proveedor que cobra al crédito de una cuenta, la plata tiene que estar comprometida cuando sale
   * la reserva, no después.
   *
   * El monto y la moneda se leen de la orden bajo el tenant y en la misma transacción; `expected` es
   * sólo el control de que la saga retiene lo que cree. La cartera se bloquea ANTES de decidir, así
   * que dos reservas de la misma agencia no gastan el mismo saldo.
   *
   * @throws BookingHoldRejectedError si no hay cartera en esa moneda o no alcanza.
   * @throws BadRequestException si la orden no es un intent abierto de este tenant.
   * @throws ConflictException si la orden ya tiene una retención.
   */
  async holdBookingIntent(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: Money,
  ): Promise<HeldOnWallet> {
    const target = holdAmount(expected);
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const order = await trx
          .selectFrom('orders')
          .select([
            'id',
            'status',
            'total_amount',
            'currency',
            'provider_raw',
            'create_request_key',
          ])
          .where('id', '=', orderId)
          .where('tenant_id', '=', tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!order) {
          throw new BadRequestException(
            'No se encontró la reserva. No se modificó el saldo de la cartera.',
          );
        }
        // Una orden con desenlace ya lo tiene, y una sin clave no es una creación en curso.
        if (
          order.status !== 'pending' ||
          order.provider_raw !== null ||
          order.create_request_key === null
        ) {
          throw new BadRequestException(
            'Sólo una reserva abierta, antes de enviarse al proveedor, puede retener saldo de cartera.',
          );
        }

        const amountMinor = Number(order.total_amount);
        const orderCurrency = normalizeCurrency(order.currency);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !orderCurrency) {
          throw new BadRequestException(
            'La reserva no tiene un total y una moneda válidos para crear la retención.',
          );
        }
        if (amountMinor !== target.amountMinor || orderCurrency !== target.currency) {
          throw new BadRequestException(
            'El total de la reserva cambió. No se retuvo saldo de la cartera.',
          );
        }

        return this.retainOnWallet(
          trx,
          tenantId,
          order.id,
          target,
          createdBy,
          HOLD_BEFORE_BOOK_NOTES,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.',
        );
      }
      throw error;
    }
  }

  /**
   * El asiento `BOOKING_HOLD` y el débito, dentro de la transacción que ya bloqueó la orden. Una
   * cartera por moneda: se usa la de la moneda de la reserva, nunca otra, y sin ella no se abre una
   * implícita. La cartera se bloquea ANTES de decidir, así que dos reservas de la misma agencia no
   * gastan el mismo saldo. El índice único por orden (0039) frena una segunda retención con 23505,
   * que traduce quien llama.
   *
   * @throws BookingHoldRejectedError sin cartera en esa moneda, suspendida o sin saldo ni cupo.
   */
  private async retainOnWallet(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    target: Money,
    createdBy: string,
    notes: string,
  ): Promise<HeldOnWallet> {
    const portfolio = await findWallet(trx, tenantId, target.currency, { forUpdate: true });
    if (!portfolio) throw holdRejection('PORTFOLIO_CURRENCY_NOT_ENABLED', target);
    const decision = decideBookingHold(holdFacts(portfolio, target));
    if (!decision.ok) throw holdRejection(decision.reason, target);

    const transaction = await trx
      .insertInto('portfolio_transactions')
      .values({
        portfolio_id: portfolio.id,
        amount_minor: -target.amountMinor,
        transaction_type: 'BOOKING_HOLD',
        reference_id: orderId,
        notes,
        created_by: createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // La fila está bloqueada y la decisión ya se tomó; el predicado repite el cupo por si otra ruta
    // escribió el saldo sin tomar el mismo bloqueo.
    const updatedPortfolio = await trx
      .updateTable('agency_portfolios')
      .set({ balance_minor: sql<number>`balance_minor - ${target.amountMinor}` })
      .where('id', '=', portfolio.id)
      .where('status', '=', 'active')
      .where(
        sql<boolean>`balance_minor::numeric + ${decision.creditMinor} >= ${target.amountMinor}`,
      )
      .where(
        sql<boolean>`balance_minor::numeric - ${target.amountMinor} BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`,
      )
      .returningAll()
      .executeTakeFirst();
    if (!updatedPortfolio) throw holdRejection('PORTFOLIO_FUNDS_INSUFFICIENT', target);

    return {
      portfolio: updatedPortfolio as unknown as PortfolioRow,
      transaction: transaction as unknown as PortfolioTransactionRow,
    };
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

    await this.holds.release(
      tenantId,
      booking,
      actorUserId ?? booking.hold.createdBy,
      failed ? RELEASE_AFTER_FAILURE_NOTES : RELEASE_AFTER_CANCEL_NOTES,
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
