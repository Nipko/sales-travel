import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';

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

interface BookingActionContext {
  readonly orderId: string;
  readonly provider: string;
  readonly providerOrderId: string | null;
  readonly orderStatus: string;
  readonly hold: {
    readonly id: string;
    readonly portfolioId: string;
    readonly amountMinor: number;
    readonly createdBy: string;
  };
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
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

type FinancialMutationType = 'DEPOSIT_PAYMENT' | 'MANUAL_ADJUSTMENT';

@Injectable()
export class PortfoliosService {
  constructor(
    private readonly db: DatabaseService,
    private readonly providers: FlightProviderRegistry,
    private readonly orders: OrdersService,
  ) {}

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
      .onConflict((conflict) => conflict.column('tenant_id').doNothing())
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

  async approveBooking(
    tenantId: string,
    orderId: string,
  ): Promise<{ success: boolean; message: string }> {
    const booking = await this.getBookingActionContext(tenantId, orderId);
    const capabilities = this.providers.capabilitiesOf(booking.provider);

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
    if (booking.orderStatus !== 'cancelled') {
      const capabilities = this.providers.capabilitiesOf(booking.provider);

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

    await this.releaseBookingHold(tenantId, booking, actorUserId ?? booking.hold.createdBy);

    return {
      success: true,
      message: 'Cancelación confirmada por el proveedor y saldo retenido liberado.',
    };
  }

  private assertReleaseMatches(
    release: Pick<PortfolioTransactionRow, 'portfolio_id' | 'amount_minor'>,
    booking: BookingActionContext,
  ): void {
    const amount = Number(release.amount_minor);
    const expected = -booking.hold.amountMinor;
    if (
      release.portfolio_id !== booking.hold.portfolioId ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount !== expected
    ) {
      throw new ConflictException(
        'La reserva tiene una liberación contable inconsistente y requiere conciliación manual.',
      );
    }
  }

  private async findBookingRelease(
    trx: Transaction<DB>,
    booking: BookingActionContext,
  ): Promise<PortfolioTransactionRow | null> {
    const release = await trx
      .selectFrom('portfolio_transactions')
      .selectAll()
      .where('portfolio_id', '=', booking.hold.portfolioId)
      .where('transaction_type', '=', 'BOOKING_RELEASED')
      .where(sql<boolean>`lower(reference_id) = lower(${booking.orderId})`)
      .executeTakeFirst();
    return (release as unknown as PortfolioTransactionRow | undefined) ?? null;
  }

  private async releaseBookingHold(
    tenantId: string,
    booking: BookingActionContext,
    createdBy: string,
  ): Promise<void> {
    const releaseAmount = -booking.hold.amountMinor;
    // `getBookingActionContext` ya lo valida; se repite en el borde del write por defensa.
    if (!Number.isSafeInteger(releaseAmount) || releaseAmount <= 0) {
      throw new BadRequestException(
        'La retención tiene un monto inválido y no puede liberarse automáticamente.',
      );
    }

    try {
      await this.db.withTenant(tenantId, async (trx) => {
        const existing = await this.findBookingRelease(trx, booking);
        if (existing) {
          this.assertReleaseMatches(existing, booking);
          return;
        }

        // Asiento positivo append-only: el BOOKING_HOLD original conserva monto y actor.
        const release = await trx
          .insertInto('portfolio_transactions')
          .values({
            portfolio_id: booking.hold.portfolioId,
            amount_minor: releaseAmount,
            transaction_type: 'BOOKING_RELEASED',
            reference_id: booking.orderId,
            notes: 'Cancelación confirmada por el proveedor; saldo retenido liberado',
            created_by: createdBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        this.assertReleaseMatches(release, booking);
        const nextBalance = sql<number>`balance_minor + ${releaseAmount}`;
        const portfolio = await trx
          .updateTable('agency_portfolios')
          .set({ balance_minor: nextBalance })
          .where('id', '=', booking.hold.portfolioId)
          .where(
            sql<boolean>`balance_minor::numeric + ${releaseAmount} BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`,
          )
          .returning('id')
          .executeTakeFirst();
        if (!portfolio) {
          throw new BadRequestException(
            'No se encontró la cartera o el saldo liberado excede el rango seguro.',
          );
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Reintento/concurrencia después del COMMIT: verificar el asiento ganador basta; no se
      // vuelve a incrementar el balance.
      const replay = await this.db.withTenant(tenantId, (trx) =>
        this.findBookingRelease(trx, booking),
      );
      if (!replay) throw error;
      this.assertReleaseMatches(replay, booking);
    }
  }

  private async getBookingActionContext(
    tenantId: string,
    orderId: string,
  ): Promise<BookingActionContext> {
    return this.db.withTenant(tenantId, async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .select(['id', 'provider', 'provider_order_id', 'status'])
        .where('id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!order) {
        throw new BadRequestException(
          'No se encontró la reserva. No se modificó el saldo de la cartera.',
        );
      }

      const hold = await trx
        .selectFrom('portfolio_transactions')
        .select(['id', 'portfolio_id', 'amount_minor', 'created_by'])
        .where('transaction_type', '=', 'BOOKING_HOLD')
        .where(sql<boolean>`lower(reference_id) = lower(${order.id})`)
        .executeTakeFirst();
      if (!hold) {
        throw new BadRequestException(
          'No existe una retención pendiente para esta reserva. No se modificó el saldo.',
        );
      }

      const holdAmount = Number(hold.amount_minor);
      if (!Number.isSafeInteger(holdAmount) || holdAmount >= 0) {
        throw new BadRequestException(
          'La retención tiene un monto inválido y requiere conciliación manual. No se modificó ' +
            'el saldo.',
        );
      }

      return {
        orderId: order.id,
        provider: order.provider,
        providerOrderId: order.provider_order_id,
        orderStatus: order.status,
        hold: {
          id: hold.id,
          portfolioId: hold.portfolio_id,
          amountMinor: holdAmount,
          createdBy: hold.created_by,
        },
      };
    });
  }
}
