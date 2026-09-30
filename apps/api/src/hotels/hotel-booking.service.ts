import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { HotelRoompack, Money } from '@sales-travel/canonical';
import type {
  HotelBookingContact,
  HotelBookingRoomGuests,
  HotelBookingView,
  SearchContext,
} from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { BookingPermissionsService } from '../booking-permissions/booking-permissions.service.js';
import { BrandingService } from '../branding/branding.service.js';
import type { OrderStatus } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import {
  ExternalOrderIntentService,
  type OpenExternalCreateIntentInput,
} from '../orders/external-order-intent.service.js';
import {
  ProviderAccountChangedError,
  createRequestKey,
} from '../orders/order-create-intent.store.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import type { OrderRow } from '../orders/orders.service.js';
import { PortfoliosService } from '../portfolios/portfolios.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelBookingContext,
  supportsHotelPrebookContext,
  type HotelBookContextRequest,
  type HotelBookingContextPort,
  type HotelGuestSent,
  type HotelOfferInvalidation,
  type HotelPrebookContextPort,
  type HotelPrebookWithContext,
  type HotelProviderAccountFingerprint,
  type HotelProviderAdapter,
  type ResolvedHotelProvider,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { providerAccountIssueEvent } from './hotel-account-issues.js';
import { agencyBookingContact } from './hotel-booking-contact.js';
import {
  HotelAcceptedTotalMismatchError,
  HotelAgencyContactMissingError,
  HotelAtPropertyNotAcknowledgedError,
  HotelBookIntentClosedError,
  HotelBookRepricedError,
  HotelGuestsInvalidError,
  HotelNonRefundableBlockedError,
  HotelNonRefundableNotAcknowledgedError,
  HotelPackageOnlyRateError,
  HotelPrebookExpiredError,
} from './hotel-booking-errors.js';
import {
  checkBookable,
  closingReadSummary,
  decideAfterBook,
  decideAfterClosingRead,
  decideAfterRevalidation,
  hotelBookHttpStatus,
  hotelBookProviderRaw,
  type HotelBookDecision,
  type HotelBookObservation,
  type HotelBookRejection,
} from './hotel-booking.saga.js';
import { HcnTrackingService } from './hcn-tracking.service.js';
import { HotelBookingVerificationService } from './hotel-booking-verification.service.js';
import { HOTEL_EVENTS } from './hotel-events.js';
import { effectiveNonRefundable, type HotelNonRefundableTerms } from './hotel-non-refundable.js';
import {
  HotelPrebookSnapshotStore,
  type HotelPrebookSnapshot,
} from './hotel-prebook-snapshot.store.js';
import { hotelHoldQuoteOf, priceRoompack, saleTotalOf } from './hotel-pricing.js';
import { HotelProviderCapabilityError } from './hotel-provider-errors.js';
import {
  HotelSearchAccountChangedError,
  HotelSearchContextStore,
} from './hotel-search-context.store.js';
import type { HotelBookInput } from './hotels.schemas.js';

/** Token DI opcional de {@link HotelBookOptions}. En producción no se provee. */
export const HOTEL_BOOK_OPTIONS = 'HOTEL_BOOK_OPTIONS';

export interface HotelBookOptions {
  /** Cuánto espera la petición a la saga antes de responder 202. */
  readonly syncWaitMs?: number;
}

/** 25 s: con los 23 s del PreBook de revalidación, la petición queda lejos del corte de 100 s. */
export const HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS = 25_000;
export const HOTEL_BOOK_MAX_SYNC_WAIT_MS = 60_000;

/**
 * `HOTEL_BOOK_SYNC_WAIT_MS` o el de por defecto. Un valor mal escrito no tumba la reserva: cae al
 * de por defecto con aviso, que nombra la variable y nunca repite el valor.
 */
export function hotelBookSyncWaitMs(env: Readonly<Record<string, string | undefined>>): {
  readonly waitMs: number;
  readonly invalidReason?: string;
} {
  const raw = env['HOTEL_BOOK_SYNC_WAIT_MS']?.trim();
  if (raw === undefined || raw.length === 0) return { waitMs: HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS };
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value > HOTEL_BOOK_MAX_SYNC_WAIT_MS) {
    return {
      waitMs: HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS,
      invalidReason: `HOTEL_BOOK_SYNC_WAIT_MS debe ser un entero de milisegundos entre 0 y ${HOTEL_BOOK_MAX_SYNC_WAIT_MS}; se usa ${HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS}`,
    };
  }
  return { waitMs: value };
}

/** Lo que responde `POST /hotels/book` con el cuerpo neutral. Sin datos de huéspedes. */
export interface HotelBookingSummary {
  readonly orderId: string;
  readonly orderNumber: number;
  /** `pending` = la saga sigue o la reserva se está verificando: la web consulta la orden. */
  readonly status: OrderStatus;
  readonly providerCode: string;
  /** Localizador del proveedor, sólo con la reserva confirmada. */
  readonly providerBookingId: string | null;
  /** Nuestra referencia, la que el proveedor devuelve en su conciliación. */
  readonly bookingReference: string;
  /** Precio de venta. */
  readonly total: Money;
  /** Motivo máquina del desenlace, en el vocabulario del proveedor o de la saga. */
  readonly reason?: string;
  readonly message?: string;
  /** `PRICE_DECREASED` si la revalidación bajó el precio (D-TBO-20 A: se sigue y se avisa). */
  readonly warnings: readonly string[];
  readonly retryForbidden?: true;
  readonly reconciliationRequired?: true;
}

export interface HotelBookResponse {
  readonly httpStatus: 201 | 202;
  readonly body: HotelBookingSummary;
}

type BookingAdapter = HotelProviderAdapter & HotelPrebookContextPort & HotelBookingContextPort;

/** Todo lo que la parte desacoplada de la saga necesita, ya validado y persistido. */
interface BookRun {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: ResolvedHotelProvider;
  readonly adapter: BookingAdapter;
  readonly intent: OrderRow;
  readonly request: HotelBookContextRequest;
  readonly snapshot: HotelPrebookSnapshot;
  readonly total: Money;
  readonly warnings: readonly string[];
}

/**
 * La confirmación del vendedor de que entiende que la tarifa no es reembolsable: quién, cuándo y
 * sobre qué importe (el precio de venta que aceptó).
 */
interface NonRefundableAcknowledgement {
  readonly acknowledgedBy: string;
  readonly acknowledgedAt: string;
  readonly acknowledgedAmount: Money;
}

/**
 * Lo que la orden guarda de una tarifa no reembolsable (`selected_offer.nonRefundable`): por qué lo
 * es, el 100 % en el precio de venta, la política aceptada en hora local del hotel y la
 * confirmación. Es lo que leen la orden, el voucher y los correos para decirlo de forma visible.
 */
function nonRefundableRecordOf(
  terms: HotelNonRefundableTerms,
  roompack: HotelRoompack,
  ack: NonRefundableAcknowledgement,
): Record<string, unknown> {
  const c = roompack.cancellation;
  return {
    reason: terms.reason,
    penalty: { ...terms.penalty },
    ...(terms.fullPenaltySinceLocal === undefined
      ? {}
      : { fullPenaltySinceLocal: terms.fullPenaltySinceLocal }),
    policy: {
      refundable: c.refundable,
      status: c.status,
      policySource: c.policySource ?? 'undeclared',
      ...(c.freeCancellationUntilLocal === undefined
        ? {}
        : { freeCancellationUntilLocal: c.freeCancellationUntilLocal }),
      rules: c.rules.map((rule) => ({ ...rule })),
    },
    acknowledgedBy: ack.acknowledgedBy,
    acknowledgedAt: ack.acknowledgedAt,
    acknowledgedAmount: { ...ack.acknowledgedAmount },
  };
}

/** La política del evento: tramos con fecha, porcentaje e importe, sin el texto del proveedor. */
function policyForEvent(roompack: HotelRoompack): Record<string, unknown> {
  const c = roompack.cancellation;
  return {
    refundableDeclared: c.refundable,
    status: c.status,
    policySource: c.policySource ?? 'undeclared',
    rules: c.rules.map((rule) => ({
      ...(rule.fromLocalDateTime === undefined ? {} : { fromLocal: rule.fromLocalDateTime }),
      ...(rule.penaltyPercentage === undefined ? {} : { percentage: rule.penaltyPercentage }),
      ...(rule.penaltyAmount === undefined
        ? {}
        : {
            amountMinor: rule.penaltyAmount.amountMinor,
            currency: rule.penaltyAmount.currency,
          }),
      ...(rule.roomIndex === undefined ? {} : { room: rule.roomIndex }),
    })),
  };
}

const OPERATION = 'la reserva con órdenes (se reserva con su flujo propio)';

const PENDING_MESSAGE =
  'La reserva sigue en curso con el proveedor. Consultá su estado en Mis Reservas y no la repitas.';

const UNCERTAIN_MESSAGE =
  'No recibimos la confirmación del proveedor. Estamos verificando si la reserva quedó hecha; no la repitas.';

const PERSISTENCE_MESSAGE =
  'El proveedor respondió, pero no pudimos registrar el resultado en la reserva. Ya quedó para conciliarla; no la repitas.';

const NOT_DISPATCHED_UNCLOSED_MESSAGE =
  'La reserva no llegó a enviarse al proveedor, pero no pudimos cerrarla en el sistema. Ya quedó para revisarla; consultá su estado en Mis Reservas antes de volver a intentar.';

const CLOSING_MESSAGES = {
  'verification-unavailable':
    'La reserva está confirmada, pero no pudimos leerla de vuelta en el proveedor. Ya quedó registrado para revisarla.',
  'verified-not-found':
    'El proveedor confirmó la reserva pero al leerla no la encontró. Estamos verificándola; no la repitas.',
  'verified-cancelled-upstream':
    'El proveedor informa la reserva como cancelada. Estamos revisándola; no la repitas.',
  'verified-status-unexpected':
    'El proveedor informa la reserva con un estado que no esperábamos. Estamos revisándola; no la repitas.',
} as const;

/** La tarifa como salió de una revalidación, con el precio de venta ya calculado. */
interface RevalidatedRate {
  readonly roompack: HotelRoompack;
  readonly found: HotelPrebookWithContext;
}

function sameAccount(
  a: HotelProviderAccountFingerprint,
  b: HotelProviderAccountFingerprint,
): boolean {
  return a.accountId === b.accountId && Date.parse(a.updatedAt) === Date.parse(b.updatedAt);
}

/** El rechazo previo a la orden como error HTTP con su motivo. */
function rejectionError(
  rejection: HotelBookRejection,
  shown: Money,
  terms: HotelNonRefundableTerms | undefined,
): Error {
  switch (rejection) {
    case 'PREBOOK_EXPIRED':
      return new HotelPrebookExpiredError();
    case 'PACKAGE_ONLY_RATE':
      return new HotelPackageOnlyRateError();
    case 'NON_REFUNDABLE_BLOCKED':
      return new HotelNonRefundableBlockedError();
    case 'AT_PROPERTY_NOT_ACKNOWLEDGED':
      return new HotelAtPropertyNotAcknowledgedError();
    case 'NON_REFUNDABLE_NOT_ACKNOWLEDGED':
      return new HotelNonRefundableNotAcknowledgedError(
        terms ?? { reason: 'declared', penalty: shown },
      );
    case 'ACCEPTED_TOTAL_MISMATCH':
      return new HotelAcceptedTotalMismatchError(shown);
  }
}

/** Neto, venta y margen, como guarda autos (`cars.service.ts`), para reportes y conciliación. */
function pricingSummary(roompack: HotelRoompack): Record<string, unknown> {
  const net = roompack.price.total;
  const sale = saleTotalOf(roompack);
  return {
    finalMinor: sale.amountMinor,
    netMinor: net.amountMinor,
    totalMarkupMinor: sale.amountMinor - net.amountMinor,
    currency: net.currency,
  };
}

/**
 * `orders.selected_offer` de una reserva de hotel (03 §8.4): la tarifa, sus políticas, las
 * condiciones en sus dos versiones, las señales y el precio. Sin datos de huéspedes.
 */
function selectedOfferOf(
  snapshot: HotelPrebookSnapshot,
  prebookRef: string,
  rate?: RevalidatedRate,
  nonRefundable?: Record<string, unknown>,
): Record<string, unknown> {
  const roompack = rate?.roompack ?? snapshot.roompack;
  const comparison = rate?.found.comparison ?? snapshot.comparison;
  return {
    vertical: 'hotels',
    providerCode: snapshot.providerCode,
    hotelId: snapshot.hotelId,
    searchId: snapshot.searchId,
    prebookRef,
    offerRef: rate?.found.pack.offerRef ?? snapshot.offerRef,
    totalText: rate?.found.pack.totalText ?? snapshot.totalText,
    currency: rate?.found.pack.currency ?? snapshot.currency,
    checkinDate: snapshot.checkinDate,
    checkoutDate: snapshot.checkoutDate,
    searchSentAt: new Date(snapshot.searchSentAt).toISOString(),
    expiresAt: new Date(snapshot.expiresAt).toISOString(),
    roompack,
    rateConditions: rate?.found.result.rateConditions ?? snapshot.rateConditions,
    signals: rate?.found.result.signals ?? snapshot.signals,
    rateConditionsHash: rate?.found.rateConditionsHash ?? snapshot.rateConditionsHash,
    comparison: {
      stage: comparison.stage,
      outcome: comparison.outcome,
      price: comparison.price,
      changes: [...comparison.changes],
    },
    pricing: pricingSummary(roompack),
    ...(nonRefundable === undefined ? {} : { nonRefundable }),
  };
}

/**
 * `orders.passengers`: los nombres como los escribió el vendedor, para el voucher, y como salieron
 * al proveedor (RF-18; D-TBO-23 A).
 */
function passengersOf(
  rooms: readonly HotelBookingRoomGuests[],
  sent: readonly (readonly HotelGuestSent[])[],
): unknown {
  return rooms.map((room, roomIndex) => ({
    room: roomIndex,
    guests: room.guests.map((guest, guestIndex) => {
      const out = sent[roomIndex]?.[guestIndex];
      return {
        paxType: guest.paxType,
        title: out?.title ?? guest.title ?? null,
        firstName: guest.firstName,
        lastName: guest.lastName,
        sent: out === undefined ? null : { firstName: out.firstName, lastName: out.lastName },
      };
    }),
  }));
}

/** El rechazo del breaker lleva la marca: no salió nada hacia el proveedor. */
function sentNothing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { sentToProvider?: unknown }).sentToProvider === false
  );
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

/** Lo que liberar una retención necesita saber de la reserva, haya o no saga en curso. */
interface HoldRef {
  readonly tenantId: string;
  readonly userId: string;
  readonly orderId: string;
  readonly providerCode: string;
  readonly bookingReference: string;
}

/**
 * Reserva de hotel con orden detrás (docs/tbo/09 PR-4.6; 08 RF-17, RF-18, RF-20, RF-22, RF-10
 * CA-2; 03 §3, §4.5 y §5). Las decisiones viven en `hotel-booking.saga.ts`; aquí sólo se ejecutan.
 *
 * En la petición, y todo lo que rechaza lo rechaza ANTES de abrir la orden:
 *
 * 1. `Idempotency-Key` UUID, proveedor con Book por contexto, snapshot del PreBook vigente de este
 *    tenant y de la cuenta con la que se reservaría, ventana, tarifa sólo paquete, tarifa no
 *    reembolsable permitida a la agencia (0055) y reconocida por el vendedor, cargos en el hotel
 *    reconocidos, precio aceptado igual al mostrado, huéspedes contra la ocupación de la búsqueda y
 *    contacto operativo de la agencia. "No reembolsable" lo decide el servidor con la política del
 *    PreBook y la hora de ahora (`hotel-non-refundable.ts`), no el navegador.
 * 2. **Orden `pending`** con la clave, la referencia de reserva y la cuenta, comprometida antes de
 *    llamar (D-TBO-07 A). Una clave repetida es 409 `duplicateRequest` sin tocar al proveedor.
 * 3. **Cartera** (RF-23 CA-1): la de la agencia en la moneda de la tarifa, activa, con saldo más
 *    el cupo que le fija quien la financia para el precio mostrado; con cuenta propia o heredada,
 *    el mismo tope (el crédito interno de 0007 pasó a ese cupo en 0053). Sin cartera en esa moneda
 *    (`PORTFOLIO_CURRENCY_NOT_ENABLED`), suspendida o sin saldo, la orden se cierra como no enviada
 *    y el proveedor no se entera. El PreBook ya se lo avisó al vendedor (`funding`).
 * 4. **PreBook de revalidación (C2)** contra lo aceptado y precio de venta con la cascada y el
 *    piso. Si sube o cambian las condiciones, la orden se cierra como no enviada y 409 con los
 *    valores nuevos; si baja, se sigue con el nuevo y se avisa.
 * 5. La orden pasa a decir lo que se va a reservar (el PreBook de C2), con la confirmación de "no
 *    reembolsable" si aplica (quién, cuándo, el monto y la política), se **retiene** ese precio de
 *    venta en la cartera sobre la orden abierta (D-TBO-21 A), `HotelNonRefundableAcknowledged` si
 *    aplica y `OrderCreateRequested`.
 *
 * Después, dentro del proceso y desacoplado de la petición: **el Book**, UN intento, nunca como job
 * de la cola (03 §4.4: la cola reintenta, y un Book repetido puede reservar dos veces), la
 * clasificación, la consolidación con CAS y la lectura de cierre por el localizador. La petición
 * espera hasta `syncWaitMs`: si la saga terminó, 201 con la orden; si no, o si la reserva quedó
 * verificándose, 202 y la web consulta `GET /orders/:id` (RF-22; D-TBO-09 A). El apagado ordenado
 * espera a la saga (`InflightWorkRegistry`).
 *
 * Un desenlace incierto deja la orden `pending` con su referencia y abre el calendario de
 * verificación (`HotelBookingVerificationService`, PR-4.7): la primera lectura por la referencia
 * sale a los 120 s del fallo, fuera de la petición, y `OrderEscalated` dice si quedó programada
 * (`queued`). Si no, la recoge el barrido.
 *
 * Una reserva que queda `confirmed` abre el plan del HCN (PR-5.4; 04 §6.3 filas 2 y 3): también si
 * la lectura de cierre falló, porque las lecturas del plan leen igual por el localizador.
 *
 * La retención sigue a la orden (RF-23 CA-2): se libera cuando la orden queda `failed` —el
 * proveedor no reservó, o no salió nada— y se mantiene mientras esté `pending` o `confirmed`. Un
 * rechazo por la cuenta del proveedor (sin saldo, bloqueada) avisa además a su dueño con
 * `ProviderAccountIssueDetected`, sin mostrarle nada de esa cuenta a la agencia que vendía.
 */
@Injectable()
export class HotelBookingService {
  private readonly logger = new Logger(HotelBookingService.name);
  private readonly syncWaitMs: number;

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly snapshots: HotelPrebookSnapshotStore,
    private readonly searchContexts: HotelSearchContextStore,
    private readonly intents: ExternalOrderIntentService,
    private readonly pricing: PricingService,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
    private readonly inflight: InflightWorkRegistry,
    private readonly verification: HotelBookingVerificationService,
    private readonly portfolios: PortfoliosService,
    private readonly hcn: HcnTrackingService,
    private readonly permissions: BookingPermissionsService,
    @Optional() @Inject(HOTEL_BOOK_OPTIONS) options?: HotelBookOptions,
  ) {
    if (options?.syncWaitMs !== undefined) {
      this.syncWaitMs = options.syncWaitMs;
    } else {
      const config = hotelBookSyncWaitMs(process.env);
      if (config.invalidReason !== undefined) this.logger.warn(config.invalidReason);
      this.syncWaitMs = config.waitMs;
    }
  }

  async book(
    tenantId: string,
    userId: string,
    idempotencyKey: string | undefined,
    input: HotelBookInput,
  ): Promise<HotelBookResponse> {
    // Sin clave no hay forma de reconocer el segundo envío: 400 antes de tocar nada.
    createRequestKey(undefined, idempotencyKey);

    // Es venta nueva: un proveedor que la plataforma apagó para el tenant no reserva, aunque el
    // PreBook sea de antes del apagado. Lo que sigue sobre la orden (verificación, HCN, cancelación)
    // va por `forOrder` y no mira la habilitación.
    const provider = await this.registry.byCodeForOffer(tenantId, input.providerCode);
    const { adapter } = provider;
    if (!supportsHotelBookingContext(adapter) || !supportsHotelPrebookContext(adapter)) {
      throw new HotelProviderCapabilityError(provider.code, OPERATION);
    }

    const snapshot = await this.snapshots.get(tenantId, input.prebookRef);
    // Uno de otro proveedor responde igual que uno vencido: no se confirma que exista.
    if (snapshot === undefined || snapshot.providerCode !== provider.code) {
      throw new HotelPrebookExpiredError();
    }
    if (!sameAccount(snapshot.account, adapter.searchAccount)) {
      throw new HotelSearchAccountChangedError();
    }

    const shown = saleTotalOf(snapshot.roompack);
    const now = Date.now();
    const nonRefundable = effectiveNonRefundable(snapshot.roompack, now);
    // Sólo se pregunta si hace falta: una reembolsable no depende del permiso.
    const blocked =
      nonRefundable === undefined ? undefined : await this.blocksNonRefundable(tenantId);
    const rejection = checkBookable({
      now,
      expiresAt: snapshot.expiresAt,
      signals: snapshot.signals,
      atPropertyCharges: snapshot.roompack.atPropertyCharges?.length ?? 0,
      atPropertyAcknowledged: input.atPropertyAcknowledged === true,
      nonRefundable: nonRefundable !== undefined,
      nonRefundableBlocked: blocked === true,
      nonRefundableAcknowledged: input.nonRefundableAcknowledged === true,
      acceptedTotal: input.acceptedTotal,
      shownTotal: shown,
    });
    if (rejection !== undefined) throw rejectionError(rejection, shown, nonRefundable);
    const acknowledgement: NonRefundableAcknowledgement | undefined =
      input.nonRefundableAcknowledged === true
        ? {
            acknowledgedBy: userId,
            acknowledgedAt: new Date(now).toISOString(),
            acknowledgedAmount: { ...input.acceptedTotal },
          }
        : undefined;

    const guests = adapter.checkBookingGuests(input.rooms, snapshot.rooms);
    if (!guests.ok) throw new HotelGuestsInvalidError(guests.issues);

    const contact = agencyBookingContact(await this.branding.resolveSupportContact(tenantId));
    if (contact === undefined) throw new HotelAgencyContactMissingError();

    const bookingReference = adapter.newBookingReference();
    const intent = await this.openIntent(tenantId, userId, {
      provider: provider.code,
      vertical: 'hotels',
      idempotencyKey,
      searchCriteria: {
        hotelId: snapshot.hotelId,
        searchId: snapshot.searchId,
        checkinDate: snapshot.checkinDate,
        checkoutDate: snapshot.checkoutDate,
        rooms: snapshot.rooms,
        ...(snapshot.guestNationality === undefined
          ? {}
          : { guestNationality: snapshot.guestNationality }),
      },
      selectedOffer: selectedOfferOf(
        snapshot,
        input.prebookRef,
        undefined,
        nonRefundable === undefined || acknowledgement === undefined
          ? undefined
          : nonRefundableRecordOf(nonRefundable, snapshot.roompack, acknowledgement),
      ),
      passengers: passengersOf(input.rooms, guests.rooms),
      contactInfo: input.contact,
      totalAmountMinor: shown.amountMinor,
      currency: shown.currency,
      providerBookingRef: bookingReference,
      providerAccountId: snapshot.account.accountId,
      providerAccountVersion: snapshot.account.updatedAt,
    });

    // Todo lo que sale al proveedor desde aquí —PreBook de C2, Book y lectura de cierre— queda atado
    // a esta orden en la bóveda de payloads: es lo que se exporta para un ticket o la certificación.
    const payloadScope = { tenantId, orderId: intent.id };
    let run: BookRun;
    try {
      run = await withProviderPayloadScope(payloadScope, () =>
        this.prepare({
          tenantId,
          userId,
          provider,
          adapter,
          intent,
          snapshot,
          input,
          bookingReference,
          contact,
          ...(acknowledgement === undefined ? {} : { acknowledgement }),
          ...(blocked === undefined ? {} : { blocked }),
        }),
      );
    } catch (err) {
      // Nada salió hacia el Book: se libera la clave para que el vendedor corrija y reintente.
      const closed = await this.intents.failExternalCreateIntent(tenantId, intent);
      // Una retención cuyo COMMIT se confirmó pero cuya respuesta se perdió no puede quedar
      // colgada de una orden cerrada. Sin retención no hace nada.
      if (closed) {
        await this.releaseHold({
          tenantId,
          userId,
          orderId: intent.id,
          providerCode: provider.code,
          bookingReference,
        });
      }
      throw err;
    }

    const booking = run;
    const saga = this.inflight.track(
      'hotel-book',
      withProviderPayloadScope(payloadScope, () => this.runBook(booking)),
    );
    const done = await this.waitAtMost(saga, this.syncWaitMs);
    if (done === undefined) {
      return {
        httpStatus: 202,
        body: {
          ...this.base(run),
          status: 'pending',
          providerBookingId: null,
          reason: 'book-in-progress',
          message: PENDING_MESSAGE,
          retryForbidden: true,
          reconciliationRequired: true,
        },
      };
    }
    return { httpStatus: hotelBookHttpStatus(done.status), body: done };
  }

  /**
   * Abre el intent con la versión de la cuenta que vio la búsqueda. Si la cuenta cambió entre la
   * comparación de arriba y el INSERT, es el mismo caso que una cuenta cambiada desde la búsqueda, y
   * el vendedor recibe el mismo 409: no se guardó nada y nada salió al proveedor.
   */
  private async openIntent(
    tenantId: string,
    userId: string,
    input: OpenExternalCreateIntentInput,
  ): Promise<OrderRow> {
    try {
      return await this.intents.openExternalCreateIntent(tenantId, userId, input);
    } catch (err) {
      if (err instanceof ProviderAccountChangedError) throw new HotelSearchAccountChangedError();
      throw err;
    }
  }

  // ───────────────────────── Revalidación (C2), en la petición ─────────────────────────

  private async prepare(c: {
    readonly tenantId: string;
    readonly userId: string;
    readonly provider: ResolvedHotelProvider;
    readonly adapter: BookingAdapter;
    readonly intent: OrderRow;
    readonly snapshot: HotelPrebookSnapshot;
    readonly input: HotelBookInput;
    readonly bookingReference: string;
    readonly contact: HotelBookingContact;
    readonly acknowledgement?: NonRefundableAcknowledgement;
    /** Si ya se leyó en la petición el permiso de no reembolsables. */
    readonly blocked?: boolean;
  }): Promise<BookRun> {
    const { tenantId, provider, adapter, intent, snapshot, input } = c;
    const ctx: SearchContext = { tenantId, requestId: intent.id };

    // RF-23 CA-1: sin cartera en la moneda de la tarifa, o sin saldo ni cupo en ella para lo que se
    // mostró —la propia o la de un nivel de la red que la financia hasta el dueño de la cuenta
    // (0060)—, no se le pregunta nada al proveedor.
    // Va después de abrir la orden y no antes para que un reintento con la misma clave siga siendo
    // un 409 de duplicado aunque la primera retención ya haya gastado el saldo. Es una lectura: la
    // retención que vale se toma con las carteras bloqueadas, después de C2. Con la orden abierta,
    // un rechazo de la red le avisa al nivel que bloqueó.
    await this.portfolios.assertBookingHoldAffordable(
      tenantId,
      hotelHoldQuoteOf(snapshot.roompack, provider.code, snapshot.account.accountId),
      { reportOrderId: intent.id },
    );

    let found: HotelPrebookWithContext;
    try {
      found = await this.breaker.execute(
        provider.code,
        () =>
          adapter.prebookWithContext(
            {
              searchId: snapshot.searchId,
              hotelId: snapshot.hotelId,
              offerRef: snapshot.offerRef,
              searchSentAt: snapshot.searchSentAt,
              rooms: snapshot.rooms,
              baseline: {
                stage: 'C2',
                accepted: {
                  totalText: snapshot.totalText,
                  roompack: snapshot.roompack,
                  signals: snapshot.signals,
                  rateConditionsHash: snapshot.rateConditionsHash,
                },
              },
            },
            ctx,
          ),
        provider.circuit,
      );
    } catch (err) {
      await this.invalidate(tenantId, snapshot, adapter.offerInvalidatedBy(err));
      await this.reportAccountIssue(provider, err, {
        tenantId,
        userId: c.userId,
        stage: 'prebook',
        orderId: intent.id,
      });
      throw err;
    }

    const rules = await this.pricing.getApplicableRules(tenantId, 'hotels');
    const priced = priceRoompack(found.result.roompack, rules, tenantId);
    const rate: RevalidatedRate = {
      found,
      // `raw` viaja al navegador y a la orden: sólo la clave de la búsqueda (RF-08 CA-5).
      roompack: {
        ...priced,
        provider: { ...priced.provider, raw: { searchId: snapshot.searchId } },
      },
    };
    const revalidatedTotal = saleTotalOf(rate.roompack);

    if (found.comparison.outcome !== 'UNCHANGED') {
      await this.audit.emit({
        eventType: HOTEL_EVENTS.offerRepriced,
        tenantId,
        actorUserId: c.userId,
        aggregateType: 'order',
        aggregateId: intent.id,
        payload: {
          vertical: 'hotels',
          provider: provider.code,
          hotelId: found.pack.hotelId,
          stage: found.comparison.stage,
          outcome: found.comparison.outcome,
          price: found.comparison.price,
          changes: [...found.comparison.changes],
          previousTotal: { ...found.comparison.previousTotal },
          currentTotal: { ...found.comparison.currentTotal },
        },
      });
    }

    const decision = decideAfterRevalidation({
      outcome: found.comparison.outcome,
      signals: found.result.signals,
      acceptedTotal: input.acceptedTotal,
      revalidatedTotal,
    });
    if (decision.kind === 'reject') {
      const prebookRef = await this.saveRevalidated(tenantId, snapshot, rate);
      throw new HotelBookRepricedError(decision.reason, {
        outcome: found.comparison.outcome,
        price: found.comparison.price,
        changes: [...found.comparison.changes],
        acceptedTotal: { ...input.acceptedTotal },
        currentTotal: revalidatedTotal,
        ...(prebookRef === undefined ? {} : { prebookRef }),
      });
    }

    // La tarifa que se va a reservar es la de C2 y "ahora" es ahora: si pasó a cobrar el 100 % entre
    // la petición y la revalidación, se exige lo mismo que a una no reembolsable. Nada salió todavía.
    const nonRefundable = effectiveNonRefundable(rate.roompack, Date.now());
    if (nonRefundable !== undefined) {
      if (c.blocked ?? (await this.blocksNonRefundable(tenantId))) {
        throw new HotelNonRefundableBlockedError();
      }
      if (c.acknowledgement === undefined) {
        throw new HotelNonRefundableNotAcknowledgedError(nonRefundable);
      }
    }
    const nonRefundableRecord =
      nonRefundable === undefined || c.acknowledgement === undefined
        ? undefined
        : nonRefundableRecordOf(nonRefundable, rate.roompack, c.acknowledgement);

    const revised = await this.intents.reviseExternalCreateIntent(tenantId, intent, {
      selectedOffer: selectedOfferOf(snapshot, input.prebookRef, rate, nonRefundableRecord),
      totalAmountMinor: revalidatedTotal.amountMinor,
      currency: revalidatedTotal.currency,
    });
    if (!revised) throw new HotelBookIntentClosedError(intent.id);

    // D-TBO-21 A: el precio de venta que la orden ya dice, retenido antes del Book. Con `Limit` el
    // proveedor lo carga al crédito de la cuenta en cuanto confirma, y una reserva cuyo cobro no
    // alcanza tiene que fallar aquí, sin salir.
    await this.portfolios.holdBookingIntent(tenantId, intent.id, c.userId, revalidatedTotal);

    if (nonRefundable !== undefined && c.acknowledgement !== undefined) {
      // Quién aceptó, cuándo, el 100 % y la política, sobre la orden y antes de llamar. Sin texto del
      // proveedor ni datos de huéspedes. La orden ya lo guarda en `selected_offer.nonRefundable`.
      await this.audit.emit({
        eventType: HOTEL_EVENTS.nonRefundableAcknowledged,
        tenantId,
        actorUserId: c.acknowledgement.acknowledgedBy,
        aggregateType: 'order',
        aggregateId: intent.id,
        payload: {
          vertical: 'hotels',
          provider: provider.code,
          hotelId: found.pack.hotelId,
          bookingReference: c.bookingReference,
          reason: nonRefundable.reason,
          penaltyMinor: nonRefundable.penalty.amountMinor,
          currency: nonRefundable.penalty.currency,
          acknowledgedAt: c.acknowledgement.acknowledgedAt,
          acknowledgedAmountMinor: c.acknowledgement.acknowledgedAmount.amountMinor,
          ...(nonRefundable.fullPenaltySinceLocal === undefined
            ? {}
            : { fullPenaltySinceLocal: nonRefundable.fullPenaltySinceLocal }),
          rateConditionsHash: found.rateConditionsHash,
          policy: policyForEvent(rate.roompack),
        },
      });
    }

    // Antes de llamar, no después: si el Book no responde, esto demuestra que salió un intento.
    await this.audit.emit({
      eventType: ORDER_EVENTS.createRequested,
      tenantId,
      actorUserId: c.userId,
      aggregateType: 'order',
      aggregateId: intent.id,
      payload: {
        provider: provider.code,
        vertical: 'hotels',
        hotelId: found.pack.hotelId,
        bookingReference: c.bookingReference,
        amountMinor: revalidatedTotal.amountMinor,
        netMinor: rate.roompack.price.total.amountMinor,
        currency: revalidatedTotal.currency,
        rooms: input.rooms.length,
        guests: input.rooms.reduce((n, room) => n + room.guests.length, 0),
        stage: found.comparison.stage,
        repriced: found.comparison.outcome,
        ...(nonRefundable === undefined ? {} : { nonRefundable: nonRefundable.reason }),
      },
    });

    return {
      tenantId,
      userId: c.userId,
      provider,
      adapter,
      intent,
      snapshot,
      total: revalidatedTotal,
      warnings: decision.priceDecreased ? ['PRICE_DECREASED'] : [],
      request: {
        // El `BookingCode` y el literal del `TotalFare` son los de C2, nunca los de la búsqueda
        // ni los del primer PreBook (RF-20 CA-6; CK-11).
        offerRef: found.pack.offerRef,
        totalText: found.pack.totalText,
        bookingReference: c.bookingReference,
        searchSentAt: snapshot.searchSentAt,
        occupancy: snapshot.rooms,
        rooms: input.rooms,
        contact: c.contact,
      },
    };
  }

  /**
   * La tarifa revalidada como snapshot aceptable nuevo, para que el vendedor la confirme sin pedir
   * otro PreBook. Si no se puede guardar, el 409 sale igual sin la referencia.
   */
  private async saveRevalidated(
    tenantId: string,
    snapshot: HotelPrebookSnapshot,
    rate: RevalidatedRate,
  ): Promise<string | undefined> {
    const prebookRef = randomUUID();
    try {
      await this.snapshots.save({
        ...snapshot,
        prebookRef,
        hotelId: rate.found.pack.hotelId,
        offerRef: rate.found.pack.offerRef,
        totalText: rate.found.pack.totalText,
        currency: rate.found.pack.currency,
        roompack: rate.roompack,
        rateConditions: rate.found.result.rateConditions.map((r) => ({ ...r })),
        signals: [...rate.found.result.signals],
        rateConditionsHash: rate.found.rateConditionsHash,
        comparison: { ...rate.found.comparison, changes: [...rate.found.comparison.changes] },
        createdAt: Date.now(),
      });
      return prebookRef;
    } catch {
      this.logger.warn(
        `hotels.book.revalidated_snapshot_unsaved provider=${snapshot.providerCode}`,
      );
      return undefined;
    }
  }

  // ───────────────────────── Book, desacoplado de la petición ─────────────────────────

  /**
   * Nunca rechaza: lo que se rompe después de que el Book pudo salir se escala, no se pierde. El
   * Book mismo no llega aquí (lo que lanza se clasifica); sí la consolidación y los eventos.
   */
  private async runBook(run: BookRun): Promise<HotelBookingSummary> {
    try {
      return await this.bookAndSettle(run);
    } catch (err) {
      this.logger.error(
        `hotels.book.saga_failed provider=${run.provider.code} order=${run.intent.id} error=${errorName(err)}`,
      );
      try {
        await this.escalate(run, 'result-persistence-unavailable', {});
      } catch {
        // La orden `pending` con su referencia ya está escrita: es la fuente de la conciliación.
      }
      return {
        ...this.base(run),
        status: 'pending',
        providerBookingId: null,
        reason: 'result-persistence-unavailable',
        message: PERSISTENCE_MESSAGE,
        retryForbidden: true,
        reconciliationRequired: true,
      };
    }
  }

  private async bookAndSettle(run: BookRun): Promise<HotelBookingSummary> {
    const { provider, adapter, tenantId, intent } = run;
    const ctx: SearchContext = { tenantId, requestId: intent.id };

    let observation: HotelBookObservation;
    let thrown: unknown;
    let failedAt: number | undefined;
    try {
      // UN intento. El breaker cuenta el rechazo del proveedor; su propio rechazo no salió.
      const reply = await this.breaker.execute(
        provider.code,
        () => adapter.bookWithContext(run.request, ctx),
        provider.circuit,
      );
      observation = { kind: 'answered', result: reply.result, reason: reply.reason };
    } catch (err) {
      thrown = err;
      failedAt = Date.now();
      observation = {
        kind: 'threw',
        failure: sentNothing(err)
          ? { outcome: 'FAILED', reason: 'not-dispatched', dispatched: false }
          : adapter.bookFailureOf(err),
      };
    }

    const decision = decideAfterBook(observation);
    if (thrown !== undefined && decision.kind !== 'uncertain') {
      await this.invalidate(tenantId, run.snapshot, adapter.offerInvalidatedBy(thrown));
    }

    switch (decision.kind) {
      case 'not-dispatched':
        return this.closeNotDispatched(run, thrown);
      case 'failed':
        return this.closeFailed(run, decision, thrown);
      case 'uncertain':
        return this.leaveUncertain(run, decision, thrown, failedAt ?? Date.now());
      case 'confirmed':
        return this.closeConfirmed(run, decision, ctx);
    }
  }

  /** No salió nada: la orden se cierra como no enviada y la clave se libera. */
  private async closeNotDispatched(run: BookRun, err: unknown): Promise<HotelBookingSummary> {
    const closed = await this.intents.failExternalCreateIntent(run.tenantId, run.intent);
    await this.audit.emit({
      eventType: ORDER_EVENTS.createFailed,
      tenantId: run.tenantId,
      actorUserId: run.userId,
      aggregateType: 'order',
      aggregateId: run.intent.id,
      payload: {
        ...this.eventBase(run),
        reason: 'not-dispatched',
        errorName: errorName(err),
        uncertain: false,
        dispatched: false,
      },
    });
    if (!closed) {
      // La fila sigue `pending` y con la clave tomada. Responder `failed` contradiría a la orden:
      // el mismo formulario reenviado recibiría un 409 de duplicado. Nada salió hacia el
      // proveedor, pero cerrarla le toca a quien concilie.
      await this.escalate(run, 'result-persistence-unavailable', {
        outcome: 'NOT_DISPATCHED',
        dispatched: false,
      });
      return {
        ...this.base(run),
        status: 'pending',
        providerBookingId: null,
        reason: 'not-dispatched',
        message: NOT_DISPATCHED_UNCLOSED_MESSAGE,
        retryForbidden: true,
        reconciliationRequired: true,
      };
    }
    await this.releaseHold(this.holdRef(run));
    return {
      ...this.base(run),
      status: 'failed',
      providerBookingId: null,
      reason: 'not-dispatched',
      message: this.humanize(run, err),
    };
  }

  /** El proveedor dijo que no reservó nada (03 §3.9): `failed`, clave liberada y `OrderCreated`. */
  private async closeFailed(
    run: BookRun,
    decision: Extract<HotelBookDecision, { kind: 'failed' }>,
    err: unknown,
  ): Promise<HotelBookingSummary> {
    const message = this.humanize(run, err);
    await this.audit.emit({
      eventType: ORDER_EVENTS.created,
      tenantId: run.tenantId,
      actorUserId: run.userId,
      aggregateType: 'order',
      aggregateId: run.intent.id,
      payload: {
        ...this.eventBase(run),
        outcome: 'FAILED',
        reason: decision.reason,
        ...(decision.providerStatus === undefined
          ? {}
          : { providerStatus: decision.providerStatus }),
      },
    });
    await this.reportAccountIssue(run.provider, err, {
      tenantId: run.tenantId,
      userId: run.userId,
      stage: 'book',
      orderId: run.intent.id,
    });
    const order = await this.intents.settleExternalCreateIntent(run.tenantId, run.intent, {
      status: 'failed',
      providerRaw: hotelBookProviderRaw({
        bookingReference: run.request.bookingReference,
        reason: decision.reason,
        ...(decision.providerStatus === undefined
          ? {}
          : { providerStatus: decision.providerStatus }),
      }),
      errorMessage: message.slice(0, 500),
    });
    if (order === undefined) {
      // La fila no dice `failed`: la retención sigue hasta que la cierre quien concilie.
      await this.escalate(run, 'result-persistence-unavailable', { outcome: 'FAILED' });
      return {
        ...this.base(run),
        status: 'pending',
        providerBookingId: null,
        reason: 'result-persistence-unavailable',
        message,
        retryForbidden: true,
        reconciliationRequired: true,
      };
    }
    await this.releaseHold(this.holdRef(run));
    return { ...this.summaryOf(run, order), reason: decision.reason, message };
  }

  /**
   * Puede haber reserva: la orden sigue `pending` con la clave tomada y su referencia. Se verifica
   * leyendo por la referencia a los 120 s del fallo (RF-21); nunca se reenvía el Book.
   */
  private async leaveUncertain(
    run: BookRun,
    decision: Extract<HotelBookDecision, { kind: 'uncertain' }>,
    err: unknown,
    failedAt: number,
  ): Promise<HotelBookingSummary> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.createFailed,
      tenantId: run.tenantId,
      actorUserId: run.userId,
      aggregateType: 'order',
      aggregateId: run.intent.id,
      payload: {
        ...this.eventBase(run),
        reason: decision.reason,
        ...(err === undefined ? {} : { errorName: errorName(err) }),
        ...(decision.providerStatus === undefined
          ? {}
          : { providerStatus: decision.providerStatus }),
        uncertain: true,
        dispatched: true,
      },
    });
    const scheduled = await this.verification.scheduleAfterUncertainBook({
      tenantId: run.tenantId,
      orderId: run.intent.id,
      failedAt,
      actorUserId: run.userId,
    });
    await this.escalate(run, 'create-uncertain', {
      verifyAfter: new Date(scheduled.verifyAt).toISOString(),
      queued: scheduled.queued,
    });
    return {
      ...this.base(run),
      status: 'pending',
      providerBookingId: null,
      reason: decision.reason,
      message: err === undefined ? UNCERTAIN_MESSAGE : this.humanize(run, err),
      retryForbidden: true,
      reconciliationRequired: true,
    };
  }

  /** Confirmada: CAS a `confirmed` y lectura de cierre por el localizador (03 §5.1). */
  private async closeConfirmed(
    run: BookRun,
    decision: Extract<HotelBookDecision, { kind: 'confirmed' }>,
    ctx: SearchContext,
  ): Promise<HotelBookingSummary> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.created,
      tenantId: run.tenantId,
      actorUserId: run.userId,
      aggregateType: 'order',
      aggregateId: run.intent.id,
      payload: {
        ...this.eventBase(run),
        outcome: 'CONFIRMED',
        reason: decision.reason,
        providerBookingId: decision.providerBookingId,
      },
    });
    const order = await this.intents.settleExternalCreateIntent(run.tenantId, run.intent, {
      status: 'confirmed',
      providerOrderId: decision.providerBookingId,
      providerRaw: hotelBookProviderRaw({
        bookingReference: run.request.bookingReference,
        reason: decision.reason,
      }),
      errorMessage: null,
    });
    if (order === undefined) {
      // La reserva existe del otro lado y la fila no la refleja: nunca se repite el Book.
      await this.escalate(run, 'result-persistence-unavailable', {
        outcome: 'CONFIRMED',
        providerBookingId: decision.providerBookingId,
      });
      return {
        ...this.base(run),
        status: 'pending',
        providerBookingId: decision.providerBookingId,
        reason: 'result-persistence-unavailable',
        message: PERSISTENCE_MESSAGE,
        retryForbidden: true,
        reconciliationRequired: true,
      };
    }

    const view = await this.closingRead(run, decision.providerBookingId, ctx);
    await this.audit.emit({
      eventType: ORDER_EVENTS.verified,
      tenantId: run.tenantId,
      actorUserId: run.userId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { ...this.eventBase(run), ...closingReadSummary(view) },
    });

    const closing = decideAfterClosingRead(view);
    if (closing.status === 'confirmed') {
      await this.hcn.schedule({ tenantId: run.tenantId, orderId: order.id });
    }
    if (closing.kind === 'settled') return { ...this.summaryOf(run, order), reason: 'confirmed' };

    await this.escalate(run, closing.reason, { outcome: 'CONFIRMED' });
    const final =
      closing.status === 'pending'
        ? ((await this.intents.markExternalCreatePending(run.tenantId, order)) ?? {
            ...order,
            status: 'pending' as const,
          })
        : order;
    return {
      ...this.summaryOf(run, final),
      reason: closing.reason,
      message: CLOSING_MESSAGES[closing.reason],
      ...(final.status === 'pending'
        ? { retryForbidden: true as const, reconciliationRequired: true as const }
        : {}),
    };
  }

  /** `null` = la lectura no se pudo hacer (o el proveedor no sabe leer): se escala, no se adivina. */
  private async closingRead(
    run: BookRun,
    providerBookingId: string,
    ctx: SearchContext,
  ): Promise<HotelBookingView | null> {
    if (!run.provider.capabilities.retrieve) return null;
    try {
      // Post-venta: frenar las ventas de un proveedor no puede impedir leer lo que ya se vendió. Y
      // el vendedor espera esta lectura: sin propósito saldría por el cupo de fondo, detrás de una
      // ráfaga de HCN o de conciliación (04 §9.5 punto 5, PV-41).
      return await this.breaker.execute(
        run.provider.code,
        () => run.adapter.getBooking(providerBookingId, ctx, { purpose: 'booking' }),
        { ...run.provider.circuit, scope: 'post-sale' },
      );
    } catch {
      return null;
    }
  }

  // ───────────────────────── Piezas ─────────────────────────

  /**
   * Si quien financia a la agencia le bloqueó las tarifas no reembolsables (0055), a ella o a un
   * nivel de arriba. Un fallo de lectura sube: no se reserva una no reembolsable sin saberlo.
   */
  private async blocksNonRefundable(tenantId: string): Promise<boolean> {
    const policy = await this.permissions.nonRefundableRates(tenantId);
    return policy.effective === 'blocked';
  }

  /**
   * Libera la retención de una orden que quedó `failed` (RF-23 CA-2). Nunca rechaza: si no se
   * puede, la orden queda `failed` con la retención tomada y se escala; el rechazo desde Carteras
   * la libera sin tocar al proveedor.
   */
  private async releaseHold(ref: HoldRef): Promise<void> {
    try {
      await this.portfolios.releaseFailedBookingHold(ref.tenantId, ref.orderId, ref.userId);
    } catch (err) {
      this.logger.warn(
        `hotels.book.hold_release_failed provider=${ref.providerCode} order=${ref.orderId} error=${errorName(err)}`,
      );
      try {
        await this.audit.emit({
          eventType: ORDER_EVENTS.escalated,
          tenantId: ref.tenantId,
          actorUserId: ref.userId,
          aggregateType: 'order',
          aggregateId: ref.orderId,
          payload: {
            provider: ref.providerCode,
            vertical: 'hotels',
            bookingReference: ref.bookingReference,
            reason: 'portfolio-hold-release-failed',
            queued: false,
            errorName: errorName(err),
          },
        });
      } catch {
        // La línea de log ya lo dejó escrito; el error que el vendedor ve es el de la reserva.
      }
    }
  }

  private holdRef(run: BookRun): HoldRef {
    return {
      tenantId: run.tenantId,
      userId: run.userId,
      orderId: run.intent.id,
      providerCode: run.provider.code,
      bookingReference: run.request.bookingReference,
    };
  }

  /** `ProviderAccountIssueDetected` al dueño de la cuenta, si el error es de la cuenta (RF-23). */
  private async reportAccountIssue(
    provider: ResolvedHotelProvider,
    err: unknown,
    at: {
      readonly tenantId: string;
      readonly userId: string;
      readonly stage: 'prebook' | 'book';
      readonly orderId: string;
    },
  ): Promise<void> {
    const event = providerAccountIssueEvent({
      provider,
      err,
      sellerTenantId: at.tenantId,
      actorUserId: at.userId,
      stage: at.stage,
      orderId: at.orderId,
    });
    if (event === undefined) return;
    try {
      await this.audit.emit(event);
    } catch {
      // El aviso es best-effort: no puede tapar el error de la reserva que lo motivó.
    }
  }

  private async escalate(
    run: BookRun,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId: run.tenantId,
      actorUserId: run.userId,
      aggregateType: 'order',
      aggregateId: run.intent.id,
      payload: {
        ...this.eventBase(run),
        reason,
        // Sólo el desenlace incierto programa una verificación. Una orden que quedó abierta la
        // adopta el barrido; una ya consolidada, una persona.
        queued: false,
        ...extra,
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
  }

  /** Lo que todo evento de la reserva lleva: sin nombres, email, teléfono ni texto del proveedor. */
  private eventBase(run: BookRun): Record<string, unknown> {
    return {
      provider: run.provider.code,
      vertical: 'hotels',
      bookingReference: run.request.bookingReference,
    };
  }

  private base(
    run: BookRun,
  ): Omit<HotelBookingSummary, 'status' | 'providerBookingId' | 'reason' | 'message'> {
    return {
      orderId: run.intent.id,
      orderNumber: run.intent.order_number,
      providerCode: run.provider.code,
      bookingReference: run.request.bookingReference,
      total: { ...run.total },
      warnings: [...run.warnings],
    };
  }

  private summaryOf(run: BookRun, order: OrderRow): HotelBookingSummary {
    return {
      ...this.base(run),
      status: order.status,
      providerBookingId: order.provider_order_id,
      total: { amountMinor: order.total_amount, currency: order.currency },
    };
  }

  private humanize(run: BookRun, err: unknown): string {
    return this.registry.humanizeError(run.provider.code, err, {
      credentialSource: run.provider.credentialSource,
    });
  }

  /**
   * Lo que el error del proveedor deja inservible, marcado antes de seguir: el próximo intento
   * responde sin volver a preguntarle. Si la marca falla se pierde la marca, no el error.
   */
  private async invalidate(
    tenantId: string,
    snapshot: HotelPrebookSnapshot,
    scope: HotelOfferInvalidation | undefined,
  ): Promise<void> {
    if (scope === undefined) return;
    try {
      if (scope === 'search') await this.searchContexts.forget(tenantId, snapshot.searchId);
      else
        await this.searchContexts.invalidateOffer(tenantId, snapshot.searchId, snapshot.offerRef);
    } catch {
      this.logger.warn(
        `hotels.book.invalidation_failed provider=${snapshot.providerCode} scope=${scope}`,
      );
    }
  }

  private async waitAtMost<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
      // La espera no retiene el proceso: la saga ya está registrada para el apagado.
      timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
