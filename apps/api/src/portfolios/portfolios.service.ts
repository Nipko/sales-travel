import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
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
  decideBookingHold,
  internalCreditMinor,
  type BookingHoldFacts,
  type BookingHoldPolicy,
  type BookingHoldRejection,
} from './booking-hold.js';

export interface PortfolioRow {
  id: string;
  tenant_id: string;
  credit_limit_minor: number;
  balance_minor: number;
  currency: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface PortfolioTransactionRow {
  id: string;
  portfolio_id: string;
  amount_minor: number;
  transaction_type: string;
  reference_id: string | null;
  idempotency_key: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
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

function canonicalUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${label} must be a valid UUID`);
  }
  return value.toLowerCase();
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

function holdRejection(
  reason: BookingHoldRejection,
  facts: BookingHoldFacts,
): BookingHoldRejectedError {
  return new BookingHoldRejectedError(reason, {
    amountCurrency: facts.amount.currency,
    portfolioCurrency: facts.portfolio.currency,
  });
}

type FinancialMutationType = 'DEPOSIT_PAYMENT' | 'MANUAL_ADJUSTMENT';

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

  async getPortfolio(tenantId: string): Promise<PortfolioRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      return this.getOrCreatePortfolio(trx, tenantId);
    });
  }

  async updateCreditLimit(tenantId: string, limitMinor: number): Promise<PortfolioRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('agency_portfolios')
        .set({ credit_limit_minor: limitMinor })
        .where('tenant_id', '=', tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return row as unknown as PortfolioRow;
    });
  }

  async deposit(
    tenantId: string,
    amountMinor: number,
    createdBy: string,
    idempotencyKey: string,
    notes?: string,
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
    assertSafePositiveMinor(amountMinor, 'Deposit amount');
    const key = canonicalUuid(idempotencyKey, 'Idempotency-Key');
    return this.runIdempotentBalanceMutation({
      tenantId,
      amountMinor,
      createdBy,
      idempotencyKey: key,
      transactionType: 'DEPOSIT_PAYMENT',
      notes: notes ?? 'Recarga de saldo por transferencia',
    });
  }

  async withdraw(
    tenantId: string,
    amountMinor: number,
    createdBy: string,
    idempotencyKey: string,
    notes?: string,
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
    assertSafePositiveMinor(amountMinor, 'Withdrawal amount');
    const key = canonicalUuid(idempotencyKey, 'Idempotency-Key');
    return this.runIdempotentBalanceMutation({
      tenantId,
      amountMinor,
      createdBy,
      idempotencyKey: key,
      transactionType: 'MANUAL_ADJUSTMENT',
      notes: notes ?? 'Retiro o ajuste manual de saldo',
    });
  }

  async getTransactions(tenantId: string): Promise<PortfolioTransactionRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const portfolio = await this.getOrCreatePortfolio(trx, tenantId);
      const rows = await trx
        .selectFrom('portfolio_transactions')
        .selectAll()
        .where('portfolio_id', '=', portfolio.id)
        .orderBy('created_at', 'desc')
        .execute();
      return rows as unknown as PortfolioTransactionRow[];
    });
  }

  /** Obtiene/crea la cartera usando el MISMO trx del llamador, incluso bajo primer acceso doble. */
  private async getOrCreatePortfolio(
    trx: Transaction<DB>,
    tenantId: string,
  ): Promise<PortfolioRow> {
    const existing = await trx
      .selectFrom('agency_portfolios')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (existing) return existing as unknown as PortfolioRow;

    const inserted = await trx
      .insertInto('agency_portfolios')
      .values({
        tenant_id: tenantId,
        credit_limit_minor: 0,
        balance_minor: 0,
        currency: 'COP',
        status: 'active',
      })
      // Una cartera por (tenant, moneda) desde 0052.
      .onConflict((conflict) => conflict.columns(['tenant_id', 'currency']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted as unknown as PortfolioRow;

    // ON CONFLICT espera el commit competidor; esta segunda sentencia ya ve la fila ganadora.
    const concurrent = await trx
      .selectFrom('agency_portfolios')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    return concurrent as unknown as PortfolioRow;
  }

  private assertIdempotentMutationMatches(
    transaction: PortfolioTransactionRow,
    expected: {
      transactionType: FinancialMutationType;
      signedAmountMinor: number;
      createdBy: string;
      notes: string;
    },
  ): void {
    const storedAmount = Number(transaction.amount_minor);
    if (
      transaction.transaction_type !== expected.transactionType ||
      !Number.isSafeInteger(storedAmount) ||
      storedAmount !== expected.signedAmountMinor ||
      transaction.created_by !== expected.createdBy ||
      transaction.notes !== expected.notes
    ) {
      throw new ConflictException(
        'Idempotency-Key ya fue usada con una operación o contenido diferente.',
      );
    }
  }

  private async replayIdempotentBalanceMutation(input: {
    tenantId: string;
    idempotencyKey: string;
    transactionType: FinancialMutationType;
    signedAmountMinor: number;
    createdBy: string;
    notes: string;
  }): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow } | null> {
    return this.db.withTenant(input.tenantId, async (trx) => {
      const portfolio = await trx
        .selectFrom('agency_portfolios')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .executeTakeFirst();
      if (!portfolio) return null;
      const transaction = await trx
        .selectFrom('portfolio_transactions')
        .selectAll()
        .where('portfolio_id', '=', portfolio.id)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (!transaction) return null;

      const row = transaction as unknown as PortfolioTransactionRow;
      this.assertIdempotentMutationMatches(row, input);
      return { portfolio: portfolio as unknown as PortfolioRow, transaction: row };
    });
  }

  private async runIdempotentBalanceMutation(input: {
    tenantId: string;
    amountMinor: number;
    createdBy: string;
    idempotencyKey: string;
    transactionType: FinancialMutationType;
    notes: string;
  }): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
    const signedAmountMinor =
      input.transactionType === 'DEPOSIT_PAYMENT' ? input.amountMinor : -input.amountMinor;
    const replayInput = { ...input, signedAmountMinor };

    try {
      return await this.db.withTenant(input.tenantId, async (trx) => {
        const portfolio = await this.getOrCreatePortfolio(trx, input.tenantId);
        const prior = await trx
          .selectFrom('portfolio_transactions')
          .selectAll()
          .where('portfolio_id', '=', portfolio.id)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (prior) {
          const row = prior as unknown as PortfolioTransactionRow;
          this.assertIdempotentMutationMatches(row, replayInput);
          return { portfolio, transaction: row };
        }

        // La clave se reclama antes de tocar saldo. Cualquier fallo posterior revierte ambos.
        const transaction = await trx
          .insertInto('portfolio_transactions')
          .values({
            portfolio_id: portfolio.id,
            amount_minor: signedAmountMinor,
            transaction_type: input.transactionType,
            idempotency_key: input.idempotencyKey,
            notes: input.notes,
            created_by: input.createdBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const balanceExpression =
          input.transactionType === 'DEPOSIT_PAYMENT'
            ? sql<number>`balance_minor + ${input.amountMinor}`
            : sql<number>`balance_minor - ${input.amountMinor}`;
        const safeBalanceExpression =
          input.transactionType === 'DEPOSIT_PAYMENT'
            ? sql<number>`balance_minor::numeric + ${input.amountMinor}`
            : sql<number>`balance_minor::numeric - ${input.amountMinor}`;
        let update = trx
          .updateTable('agency_portfolios')
          .set({ balance_minor: balanceExpression })
          .where('id', '=', portfolio.id)
          // No permitimos que BIGINT se convierta después en un Number redondeado en la API.
          .where(
            sql<boolean>`(${safeBalanceExpression}) BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`,
          );
        if (input.transactionType === 'MANUAL_ADJUSTMENT') {
          // El predicado se reevalúa después de adquirir el lock de fila: no existe TOCTOU.
          update = update
            .where('status', '=', 'active')
            .where(
              sql<boolean>`balance_minor::numeric + credit_limit_minor::numeric >= ${input.amountMinor}`,
            );
        }

        const updatedPortfolio = await update.returningAll().executeTakeFirst();
        if (!updatedPortfolio) {
          if (input.transactionType === 'MANUAL_ADJUSTMENT') {
            throw new BadRequestException(
              'Insufficient credit limit and portfolio balance, or portfolio is not active',
            );
          }
          throw new BadRequestException('Portfolio balance exceeds the safe integer range');
        }

        return {
          portfolio: updatedPortfolio as unknown as PortfolioRow,
          transaction: transaction as unknown as PortfolioTransactionRow,
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // El competidor pudo haber hecho COMMIT mientras esta inserción esperaba el índice.
      const replay = await this.replayIdempotentBalanceMutation(replayInput);
      if (replay) return replay;
      throw error;
    }
  }

  // Flujo de Aprobación de Reserva
  async holdBooking(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: HoldBookingExpectations = {},
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
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

        const portfolio = await this.getOrCreatePortfolio(trx, tenantId);
        const portfolioCurrency = normalizeCurrency(portfolio.currency);
        if (!portfolioCurrency || portfolioCurrency !== orderCurrency) {
          throw new BadRequestException(
            `La cartera está en ${portfolioCurrency ?? 'una moneda inválida'} y la reserva en ` +
              `${orderCurrency}. No se pueden mezclar monedas en una retención.`,
          );
        }
        if (portfolio.status !== 'active') {
          throw new BadRequestException(
            'La cartera no está activa. No se creó ninguna retención de saldo.',
          );
        }

        // El índice parcial único reclama primero el orderId. Si dos requests compiten, el
        // perdedor falla aquí y toda su transacción se revierte sin un segundo débito.
        const transaction = await trx
          .insertInto('portfolio_transactions')
          .values({
            portfolio_id: portfolio.id,
            amount_minor: -amountMinor,
            transaction_type: 'BOOKING_HOLD',
            // PostgreSQL devuelve UUID en representación canónica minúscula. No persistimos el
            // casing/control textual que llegó por HTTP.
            reference_id: order.id,
            notes: 'Retención preventiva de saldo por reserva pendiente de emisión',
            created_by: createdBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // La suficiencia se evalúa en el UPDATE que descuenta, después de adquirir el lock de la
        // fila. Así dos reservas distintas tampoco pueden gastar el mismo saldo simultáneamente.
        const heldBalance = sql<number>`balance_minor - ${amountMinor}`;
        const updatedPortfolio = await trx
          .updateTable('agency_portfolios')
          .set({ balance_minor: heldBalance })
          .where('id', '=', portfolio.id)
          .where('status', '=', 'active')
          .where(
            sql<boolean>`balance_minor::numeric + credit_limit_minor::numeric >= ${amountMinor}`,
          )
          .where(
            sql<boolean>`balance_minor::numeric - ${amountMinor} BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`,
          )
          .returningAll()
          .executeTakeFirst();
        if (!updatedPortfolio) {
          throw new BadRequestException(
            'Saldo insuficiente para reservar. Recargue saldo o solicite límite de crédito.',
          );
        }

        return {
          portfolio: updatedPortfolio as unknown as PortfolioRow,
          transaction: transaction as unknown as PortfolioTransactionRow,
        };
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
   * ¿Alcanza la cartera para retener `amount`? Lee sin bloquear y ANTES de abrir la orden, para que
   * una agencia sin saldo o sin crédito interno no llegue a llamar al proveedor (RF-23 CA-1). No
   * reemplaza a {@link holdBookingIntent}, que vuelve a decidir con la cartera bloqueada.
   *
   * @throws BookingHoldRejectedError si no alcanza.
   */
  async assertBookingHoldAffordable(
    tenantId: string,
    amount: Money,
    policy: BookingHoldPolicy,
  ): Promise<void> {
    const target = holdAmount(amount);
    await this.db.withTenant(tenantId, async (trx) => {
      const portfolio = await this.getOrCreatePortfolio(trx, tenantId);
      const facts = await this.holdFacts(trx, tenantId, portfolio, target, policy);
      const decision = decideBookingHold(facts);
      if (!decision.ok) throw holdRejection(decision.reason, facts);
    });
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
   * @throws BookingHoldRejectedError si la cartera o el crédito interno no alcanzan.
   * @throws BadRequestException si la orden no es un intent abierto de este tenant.
   * @throws ConflictException si la orden ya tiene una retención.
   */
  async holdBookingIntent(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: Money,
    policy: BookingHoldPolicy,
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
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

        const created = await this.getOrCreatePortfolio(trx, tenantId);
        const portfolio = (await trx
          .selectFrom('agency_portfolios')
          .selectAll()
          .where('id', '=', created.id)
          .forUpdate()
          .executeTakeFirstOrThrow()) as unknown as PortfolioRow;
        const facts = await this.holdFacts(trx, tenantId, portfolio, target, policy);
        const decision = decideBookingHold(facts);
        if (!decision.ok) throw holdRejection(decision.reason, facts);

        const transaction = await trx
          .insertInto('portfolio_transactions')
          .values({
            portfolio_id: portfolio.id,
            amount_minor: -amountMinor,
            transaction_type: 'BOOKING_HOLD',
            reference_id: order.id,
            notes: HOLD_BEFORE_BOOK_NOTES,
            created_by: createdBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // La fila está bloqueada y la decisión ya se tomó; el predicado repite el cupo por si otra
        // ruta escribió el saldo sin tomar el mismo bloqueo.
        const updatedPortfolio = await trx
          .updateTable('agency_portfolios')
          .set({ balance_minor: sql<number>`balance_minor - ${amountMinor}` })
          .where('id', '=', portfolio.id)
          .where('status', '=', 'active')
          .where(sql<boolean>`balance_minor::numeric + ${decision.creditMinor} >= ${amountMinor}`)
          .where(
            sql<boolean>`balance_minor::numeric - ${amountMinor} BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`,
          )
          .returningAll()
          .executeTakeFirst();
        if (!updatedPortfolio) throw holdRejection('PORTFOLIO_FUNDS_INSUFFICIENT', facts);

        return {
          portfolio: updatedPortfolio as unknown as PortfolioRow,
          transaction: transaction as unknown as PortfolioTransactionRow,
        };
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

  /**
   * Lo que la decisión necesita: la cartera y, con una cuenta heredada, el crédito interno del
   * tenant. `tenants` no tiene RLS; el tenant es siempre el de la transacción.
   */
  private async holdFacts(
    trx: Transaction<DB>,
    tenantId: string,
    portfolio: PortfolioRow,
    amount: Money,
    policy: BookingHoldPolicy,
  ): Promise<BookingHoldFacts> {
    const facts: BookingHoldFacts = {
      amount,
      portfolio: {
        balanceMinor: Number(portfolio.balance_minor),
        creditLimitMinor: Number(portfolio.credit_limit_minor),
        currency: normalizeCurrency(portfolio.currency),
        status: portfolio.status,
      },
    };
    if (!policy.inheritedAccount) return facts;

    const tenant = await trx
      .selectFrom('tenants')
      .select(['credit_limit', 'default_currency'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    return {
      ...facts,
      internalCredit: {
        limitMinor: internalCreditMinor(tenant?.credit_limit),
        currency: normalizeCurrency(tenant?.default_currency),
      },
    };
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
