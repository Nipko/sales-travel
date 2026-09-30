import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { WalletHoldStateConflictError } from './booking-hold.js';
import { walletHoldStateRule } from './portfolio-errors.js';
import {
  WalletHoldStore,
  translateWalletHoldError,
  type WalletHoldExpectedStatus,
  type WalletHoldSettleOutcome,
} from './wallet-hold.store.js';

/**
 * La retención de saldo de una reserva vista desde su orden, y su cierre, sin nada más de la
 * cartera.
 *
 * Vive fuera de `PortfoliosService` porque la liberación la dispara también la post-venta de una
 * orden: la cancelación de un hotel se cierra en `OrdersModule`, a veces horas después del pedido
 * (docs/tbo/09 PR-5.3; D-TBO-25 A), y `PortfoliosModule` ya importa `OrdersModule` para cancelar
 * desde la cartera. Sólo depende de la base, así que los dos módulos la usan sin ciclo.
 *
 * Desde 0060 no escribe asientos: la retención es un grupo con un nivel por cartera retenida (la del
 * nodo que vende y la de cada nivel de su red) y la cierra `wallet_hold_settle` sobre lo registrado,
 * de una vez en todos los niveles. Lo de siempre sigue igual: idempotente, la liberación en la misma
 * cartera y por el mismo monto que la retención, y el saldo acotado al rango seguro.
 */

export interface BookingHoldRow {
  /** El asiento `BOOKING_HOLD` del nodo que vende. */
  readonly id: string;
  readonly portfolioId: string;
  /** Negativo, como el asiento. */
  readonly amountMinor: number;
  readonly createdBy: string;
}

/** Una reserva del tenant y su retención abierta, si tiene una. */
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

/** El nivel 0 de una retención abierta, como lo guarda 0060. */
const OwnLevelSchema = z.object({
  hold_transaction_id: z.string().uuid(),
  portfolio_id: z.string().uuid(),
  amount_minor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_by: z.string().uuid(),
});

/** Lo que una liberación con precondición no puede devolver sin contradecirla. */
const STILL_OPEN: ReadonlySet<WalletHoldSettleOutcome> = new Set([
  'open',
  'captured',
  'already-captured',
]);

function stillOpenError(expected: WalletHoldExpectedStatus): ConflictException {
  return new ConflictException(
    expected === 'failed'
      ? 'La reserva no está cerrada como no realizada: su retención de saldo se mantiene.'
      : 'La reserva no figura cancelada: su retención de saldo se mantiene.',
  );
}

/** La vertical que declara la orden; vuelos no la escribe. */
function verticalOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'flights';
}

@Injectable()
export class BookingHoldLedger {
  private readonly store: WalletHoldStore;

  constructor(private readonly db: DatabaseService) {
    // Se construye acá y no se inyecta: sólo depende de la base, como el ledger.
    this.store = new WalletHoldStore(db);
  }

  /**
   * La reserva del tenant y su retención, si la tiene abierta (retenida o cobrada). Una retención
   * liberada o en conflicto no cuenta: no hay nada que cobrar ni que liberar desde la cartera.
   *
   * @throws BadRequestException si la reserva no es del tenant, o su retención no cumple 0060.
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

      // El nivel 0 lo ve el nodo que vende (RLS de 0060); los de su red, no.
      const level = await trx
        .selectFrom('wallet_hold_groups as g')
        .innerJoin('wallet_hold_levels as l', (join) =>
          join.onRef('l.group_id', '=', 'g.id').on('l.depth', '=', 0),
        )
        .select(['l.hold_transaction_id', 'l.portfolio_id', 'l.amount_minor', 'g.created_by'])
        .where('g.order_id', '=', order.id)
        .where('g.origin_tenant_id', '=', tenantId)
        .where('g.status', 'in', ['held', 'captured'])
        .executeTakeFirst();
      if (!level) return base;

      const parsed = OwnLevelSchema.safeParse(level);
      if (!parsed.success) {
        throw new BadRequestException(
          'La retención tiene un monto inválido y requiere conciliación manual. No se modificó ' +
            'el saldo.',
        );
      }
      return {
        ...base,
        hold: {
          id: parsed.data.hold_transaction_id,
          portfolioId: parsed.data.portfolio_id,
          amountMinor: -parsed.data.amount_minor,
          createdBy: parsed.data.created_by,
        },
      };
    });
  }

  /**
   * Libera la retención de una reserva que el proveedor NO hizo (RF-23 CA-2), en todos sus niveles.
   * `failed` es la única prueba de eso: una orden `pending` puede tener reserva del otro lado
   * (D-TBO-24 A).
   *
   * @throws ConflictException si la orden tiene la retención abierta y no está `failed`.
   * @throws WalletHoldStateConflictError si la reserva figuró confirmada antes (la retención ya
   *   era un cargo) o el libro no casa: queda para conciliación manual.
   */
  async releaseFailed(
    tenantId: string,
    orderId: string,
    createdBy: string,
  ): Promise<BookingHoldRelease> {
    return this.settleExpected(tenantId, orderId, createdBy, 'failed');
  }

  /**
   * Libera la retención de una reserva que el proveedor ya muestra cancelada, en todos sus niveles.
   * `cancelled` es la prueba: una cancelación aceptada pero en curso deja la orden `pending` y la
   * habitación sigue cobrable hasta que el hotel la libera (D-TBO-25 A).
   *
   * @throws ConflictException si la orden tiene la retención abierta y no está `cancelled`.
   */
  async releaseCancelled(
    tenantId: string,
    orderId: string,
    createdBy: string,
  ): Promise<BookingHoldRelease> {
    return this.settleExpected(tenantId, orderId, createdBy, 'cancelled');
  }

  /**
   * La liberación con la precondición de quien llama. Idempotente: una segunda llamada encuentra la
   * retención liberada y no vuelve a acreditar en ningún nivel.
   *
   * @throws PortfolioReleaseBusyError si la red siguió contenida después de los reintentos: la
   *   retención sigue abierta y repetir el pedido la cierra.
   */
  async settleExpected(
    tenantId: string,
    orderId: string,
    createdBy: string,
    expected: WalletHoldExpectedStatus,
  ): Promise<BookingHoldRelease> {
    let outcome: WalletHoldSettleOutcome;
    try {
      outcome = await this.store.runRelease(tenantId, (trx) =>
        this.store.settle(trx, orderId, createdBy, expected),
      );
    } catch (error) {
      if (walletHoldStateRule(error) === 'hold_release_order_open') {
        throw stillOpenError(expected);
      }
      throw translateWalletHoldError(error) ?? error;
    }

    if (outcome === 'conflict') throw new WalletHoldStateConflictError();
    if (STILL_OPEN.has(outcome)) throw stillOpenError(expected);
    return outcome === 'released'
      ? 'released'
      : outcome === 'no-hold'
        ? 'no-hold'
        : 'already-released';
  }

  /**
   * Cierra la retención de la orden según el estado en que está, sin precondición: la conciliación
   * de una red y la cancelación de un vuelo. Captura, libera o la deja en conflicto; nunca
   * recalcula la red.
   */
  async settle(tenantId: string, orderId: string, actor: string): Promise<WalletHoldSettleOutcome> {
    try {
      return await this.store.runRelease(tenantId, (trx) => this.store.settle(trx, orderId, actor));
    } catch (error) {
      throw translateWalletHoldError(error) ?? error;
    }
  }
}
