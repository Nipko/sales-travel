import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';
import type { Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  BookingHoldRejectedError,
  bookingHoldMessage,
  isNetworkRejection,
  type BookingHoldPreview,
  type BookingHoldQuote,
} from './booking-hold.js';
import { isUniqueViolation } from './portfolio-errors.js';
import type { PortfolioRow, PortfolioTransactionRow } from './wallet-store.js';
import {
  WalletHoldStore,
  translateWalletHoldError,
  type WalletHoldAdjusted,
} from './wallet-hold.store.js';

/**
 * La retención de cartera de una reserva ANTES de llamar al proveedor y sobre una reserva ya
 * confirmada (docs/tbo/08 RF-23; D-TBO-21 A; en cascada por la red desde 0060, docs/platform/12
 * §14): el aviso previo, la retención sobre el intent abierto y la de una orden confirmada.
 *
 * Vive fuera de `PortfoliosService` porque la piden dos sagas de reserva: la de hoteles (que llega
 * por `PortfoliosService`) y la de vuelos de `OrdersService`, cuando el proveedor liquida por la red
 * (SAB-FD-2 A). `PortfoliosModule` importa `OrdersModule` para cancelar desde la cartera, así que
 * `OrdersModule` no puede importar `PortfoliosService`: este servicio sólo depende de la base, como
 * `BookingHoldLedger`, y los dos módulos lo usan sin ciclo. Las reglas siguen en un solo lugar: la
 * base (`wallet_hold_*`) y este archivo.
 */

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
const NOT_ADJUSTABLE =
  'La retención de saldo de esta reserva está cerrada o en revisión, así que no se puede ajustar. No se cambió nada en la reserva.';

/**
 * El ajuste de la retención de UNA orden dentro de la transacción que cambia su total
 * ({@link BookingHoldPolicyService.adjustOrderHold}): `wallet_hold_adjust` con el actor y la operación
 * de servicios que lo explica.
 */
export type HoldAdjuster = (actorId: string, operationId: string) => Promise<WalletHoldAdjusted>;

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

@Injectable()
export class BookingHoldPolicyService {
  private readonly walletHolds: WalletHoldStore;

  constructor(private readonly db: DatabaseService) {
    // Se construye acá y no se inyecta: sólo depende de la base, como el ledger.
    this.walletHolds = new WalletHoldStore(db);
  }

  /**
   * Retiene el total de una reserva ya confirmada y no emitida (vuelos y autos, `POST
   * /portfolios/hold-booking`), con las mismas reglas que la retención previa al Book de un hotel:
   * la cartera de la moneda de la orden, activa, y su saldo más el cupo que fija quien financia; y,
   * desde 0060, la cartera de cada nivel de su red hasta el dueño de la credencial. La retención
   * nace cobrada: la reserva ya existe.
   *
   * El dueño sale de la cuenta con que se reservó si la orden la guarda: los vuelos de un proveedor
   * que opera su post-venta por cuenta la guardan (0081), y si es la propia del nodo, no se retiene
   * nada (`own-account`), como en hoteles. Si no la guarda (autos, los demás vuelos y las órdenes
   * anteriores), la base toma la que la bóveda le resuelve hoy al nodo para el proveedor, o la raíz
   * con credenciales de entorno; esa cuenta no prueba con cuál se reservó, así que la del propio
   * nodo no la exime: retiene en su cartera, como antes de 0060. La plataforma, dueña de todo lo que
   * se le resuelve, queda sin retener (`own-account`).
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
   * Corre `work` en la transacción de las retenciones (la de 0060: `lock_timeout` acotado y la
   * transacción entera repetida ante un bloqueo) con el ajuste de la retención de la orden a mano
   * (0086). Es para lo que cambia el total de una orden ya confirmada —los servicios adicionales—:
   * el total y la retención se mueven juntos o no se mueve ninguno.
   *
   * La diferencia la decide la base desde la orden (`orders.total_amount` contra lo retenido), así
   * que `work` primero escribe el total nuevo y después llama al ajuste. Sin retención (cuenta de
   * pruebas, proveedor que cobra por su cuenta) o con la cuenta propia del nodo, el ajuste no hace
   * nada y lo dice.
   *
   * Un error que no es de las retenciones (un índice único de quien llama, por ejemplo) sale tal
   * cual, para que lo traduzca quien lo provocó.
   *
   * @throws BookingHoldRejectedError si al retener un nivel no cubre la diferencia: no queda nada.
   * @throws PortfolioHoldBusyError o PortfolioReleaseBusyError si la red siguió contenida.
   * @throws BadRequestException si la retención está cerrada o en conflicto.
   */
  async adjustOrderHold<T>(
    tenantId: string,
    order: { readonly id: string; readonly currency: string },
    direction: 'retain' | 'release',
    work: (trx: Transaction<DB>, adjust: HoldAdjuster) => Promise<T>,
  ): Promise<T> {
    const run = (trx: Transaction<DB>): Promise<T> =>
      work(trx, (actorId, operationId) =>
        this.walletHolds.adjust(trx, order.id, actorId, operationId),
      );
    try {
      return direction === 'retain'
        ? await this.walletHolds.run(tenantId, run)
        : await this.walletHolds.runRelease(tenantId, run);
    } catch (error) {
      throw (
        translateWalletHoldError(
          error,
          normalizeCurrency(order.currency) ?? undefined,
          NOT_ADJUSTABLE,
        ) ?? error
      );
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
}
