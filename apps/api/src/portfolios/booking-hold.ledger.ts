import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';

/**
 * La retención de saldo de una reserva (`BOOKING_HOLD`) y su liberación (`BOOKING_RELEASED`), sin
 * nada más de la cartera.
 *
 * Vive fuera de `PortfoliosService` porque la liberación la dispara también la post-venta de una
 * orden: la cancelación de un hotel se cierra en `OrdersModule`, a veces horas después del pedido
 * (docs/tbo/09 PR-5.3; D-TBO-25 A), y `PortfoliosModule` ya importa `OrdersModule` para cancelar
 * desde la cartera. Sólo depende de la base, así que los dos módulos la usan sin ciclo.
 *
 * Las reglas son las de siempre: un asiento de liberación por orden (índice único), idempotente,
 * con el mismo monto y la misma cartera que la retención, y el saldo acotado al rango seguro.
 */

export interface BookingHoldRow {
  readonly id: string;
  readonly portfolioId: string;
  readonly amountMinor: number;
  readonly createdBy: string;
}

/** Una reserva del tenant y su retención, si tiene una. */
export interface HeldBooking {
  readonly orderId: string;
  readonly provider: string;
  /** `search_criteria.vertical`; vuelos no lo escribe, así que su ausencia es vuelos. */
  readonly vertical: string;
  readonly providerOrderId: string | null;
  readonly orderStatus: string;
  readonly hold?: BookingHoldRow;
}

export type BookingWithHold = HeldBooking & { readonly hold: BookingHoldRow };

/** Qué pasó al pedir que se libere la retención de una reserva. */
export type BookingHoldRelease = 'released' | 'already-released' | 'no-hold';

export const RELEASE_AFTER_CANCEL_NOTES =
  'Cancelación confirmada por el proveedor; saldo retenido liberado';
export const RELEASE_AFTER_FAILURE_NOTES =
  'El proveedor no hizo la reserva; saldo retenido liberado';

interface ReleaseRow {
  readonly portfolio_id: string;
  readonly amount_minor: number | string;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** La vertical que declara la orden; vuelos no la escribe. */
function verticalOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'flights';
}

@Injectable()
export class BookingHoldLedger {
  constructor(private readonly db: DatabaseService) {}

  /**
   * La reserva del tenant y su retención, si tiene una.
   *
   * @throws BadRequestException si la reserva no es del tenant o la retención tiene un monto
   *   inválido.
   */
  async load(tenantId: string, orderId: string): Promise<HeldBooking> {
    return this.db.withTenant(tenantId, async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .select([
          'id',
          'provider',
          'provider_order_id',
          'status',
          sql<string | null>`search_criteria->>'vertical'`.as('vertical'),
        ])
        .where('id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!order) {
        throw new BadRequestException(
          'No se encontró la reserva. No se modificó el saldo de la cartera.',
        );
      }
      const base = {
        orderId: order.id,
        provider: order.provider,
        vertical: verticalOf(order.vertical),
        providerOrderId: order.provider_order_id,
        orderStatus: order.status,
      };

      const hold = await trx
        .selectFrom('portfolio_transactions')
        .select(['id', 'portfolio_id', 'amount_minor', 'created_by'])
        .where('transaction_type', '=', 'BOOKING_HOLD')
        .where(sql<boolean>`lower(reference_id) = lower(${order.id})`)
        .executeTakeFirst();
      if (!hold) return base;

      const heldMinor = Number(hold.amount_minor);
      if (!Number.isSafeInteger(heldMinor) || heldMinor >= 0) {
        throw new BadRequestException(
          'La retención tiene un monto inválido y requiere conciliación manual. No se modificó ' +
            'el saldo.',
        );
      }

      return {
        ...base,
        hold: {
          id: hold.id,
          portfolioId: hold.portfolio_id,
          amountMinor: heldMinor,
          createdBy: hold.created_by,
        },
      };
    });
  }

  /**
   * Libera la retención de una reserva que el proveedor NO hizo (RF-23 CA-2). `failed` es la única
   * prueba de eso: una orden `pending` puede tener reserva del otro lado (D-TBO-24 A).
   *
   * @throws ConflictException si la orden tiene retención y no está `failed`.
   */
  async releaseFailed(
    tenantId: string,
    orderId: string,
    createdBy: string,
  ): Promise<BookingHoldRelease> {
    return this.releaseIf(tenantId, orderId, createdBy, 'failed', RELEASE_AFTER_FAILURE_NOTES);
  }

  /**
   * Libera la retención de una reserva que el proveedor ya muestra cancelada. `cancelled` es la
   * prueba: una cancelación aceptada pero en curso deja la orden `pending` y la habitación sigue
   * cobrable hasta que el hotel la libera (D-TBO-25 A).
   *
   * @throws ConflictException si la orden tiene retención y no está `cancelled`.
   */
  async releaseCancelled(
    tenantId: string,
    orderId: string,
    createdBy: string,
  ): Promise<BookingHoldRelease> {
    return this.releaseIf(tenantId, orderId, createdBy, 'cancelled', RELEASE_AFTER_CANCEL_NOTES);
  }

  /**
   * El asiento de liberación y el saldo, en una transacción. Idempotente: una segunda llamada
   * encuentra la liberación y no vuelve a acreditar.
   */
  async release(
    tenantId: string,
    booking: BookingWithHold,
    createdBy: string,
    notes: string,
  ): Promise<'released' | 'already-released'> {
    const releaseAmount = -booking.hold.amountMinor;
    // `load` ya lo valida; se repite en el borde del write por defensa.
    if (!Number.isSafeInteger(releaseAmount) || releaseAmount <= 0) {
      throw new BadRequestException(
        'La retención tiene un monto inválido y no puede liberarse automáticamente.',
      );
    }

    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const existing = await this.findRelease(trx, booking);
        if (existing) {
          this.assertReleaseMatches(existing, booking);
          return 'already-released';
        }

        // Asiento positivo append-only: el BOOKING_HOLD original conserva monto y actor.
        const release = await trx
          .insertInto('portfolio_transactions')
          .values({
            portfolio_id: booking.hold.portfolioId,
            amount_minor: releaseAmount,
            transaction_type: 'BOOKING_RELEASED',
            reference_id: booking.orderId,
            notes,
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
        return 'released';
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Reintento/concurrencia después del COMMIT: verificar el asiento ganador basta; no se
      // vuelve a incrementar el balance.
      const replay = await this.db.withTenant(tenantId, (trx) => this.findRelease(trx, booking));
      if (!replay) throw error;
      this.assertReleaseMatches(replay, booking);
      return 'already-released';
    }
  }

  private async releaseIf(
    tenantId: string,
    orderId: string,
    createdBy: string,
    required: 'failed' | 'cancelled',
    notes: string,
  ): Promise<BookingHoldRelease> {
    const booking = await this.load(tenantId, orderId);
    if (booking.hold === undefined) return 'no-hold';
    if (booking.orderStatus !== required) {
      throw new ConflictException(
        required === 'failed'
          ? 'La reserva no está cerrada como no realizada: su retención de saldo se mantiene.'
          : 'La reserva no figura cancelada: su retención de saldo se mantiene.',
      );
    }
    return this.release(tenantId, { ...booking, hold: booking.hold }, createdBy, notes);
  }

  private assertReleaseMatches(release: ReleaseRow, booking: BookingWithHold): void {
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

  private async findRelease(
    trx: Transaction<DB>,
    booking: BookingWithHold,
  ): Promise<ReleaseRow | null> {
    const release = await trx
      .selectFrom('portfolio_transactions')
      .select(['portfolio_id', 'amount_minor'])
      .where('portfolio_id', '=', booking.hold.portfolioId)
      .where('transaction_type', '=', 'BOOKING_RELEASED')
      .where(sql<boolean>`lower(reference_id) = lower(${booking.orderId})`)
      .executeTakeFirst();
    return release ?? null;
  }
}
