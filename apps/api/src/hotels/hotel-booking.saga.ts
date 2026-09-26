import type { Money } from '@sales-travel/canonical';
import type { HotelBookResult, HotelBookingView, HotelRateSignal } from '@sales-travel/domain';
import type { OrderStatus } from '../database/database.types.js';
import type { HotelBookFailure, HotelRepriceOutcome } from '../providers/hotel-provider.types.js';

/**
 * Saga de reserva de hotel con intent antes del Book: **las decisiones, sin nada de I/O**
 * (docs/tbo/09 PR-4.6; 08 RF-17, RF-18, RF-20, RF-22; 03 §3.9, §4 y §5).
 *
 * Mismo criterio que `orders/order-create.saga.ts` y por el mismo motivo (D9): las sagas con dinero
 * corren hoy en el proceso y sobre BullMQ, y migrar a Temporal sale barato sólo si lo que decide no
 * vive pegado al runner. Este fichero sólo importa TIPOS.
 *
 * Qué decide, en el orden de la saga:
 *
 *   1. **¿Se puede reservar?** Antes de abrir la orden: la ventana, la tarifa sólo paquete, los
 *      cargos en el hotel sin reconocer y el precio aceptado contra el que se mostró.
 *   2. **¿La revalidación (C2) deja seguir?** Si el precio de venta sube o cambian las
 *      condiciones, 409 con los valores nuevos; si baja, se sigue con el nuevo y se avisa
 *      (D-TBO-20 A).
 *   3. **¿Qué dijo el Book?** Confirmado, fallido (el proveedor dijo que no), no enviado o
 *      incierto. Una excepción no es un fallo: un timeout es el proveedor no diciendo nada.
 *   4. **¿Qué dice la lectura de cierre?** Una reserva confirmada que el proveedor no encuentra o
 *      da por cancelada no se sigue mostrando como confirmada.
 *
 * Ninguna rama termina en silencio: lo que no se pudo comprobar se escala.
 */

/** "after 120 seconds of book response" (p. 42), contados desde el fallo observado (Q-38). */
export const HOTEL_BOOK_VERIFY_DELAY_MS = 120_000;

/**
 * Lo mínimo que tiene que quedar de la ventana para abrir la orden: el PreBook de revalidación
 * puede tardar hasta 23 s (p. 8) y sin margen el Book no saldría. El vencimiento ya descuenta los
 * 120 s del Book (RF-09), así que esto sólo cubre la revalidación.
 */
export const HOTEL_BOOK_MIN_REMAINING_MS = 30_000;

// ───────────────────────── 1. Antes de abrir la orden ─────────────────────────

/** Por qué no se abre la orden. Vocabulario cerrado: viaja como `reason` al navegador. */
export type HotelBookRejection =
  | 'PREBOOK_EXPIRED'
  | 'PACKAGE_ONLY_RATE'
  | 'AT_PROPERTY_NOT_ACKNOWLEDGED'
  | 'ACCEPTED_TOTAL_MISMATCH';

export interface HotelBookableFacts {
  readonly now: number;
  /** Vencimiento de la tarifa (`searchSentAt + 27 min` en TBO). */
  readonly expiresAt: number;
  readonly signals: readonly HotelRateSignal[];
  /** Cuántos cargos se pagan en el hotel (RF-10). */
  readonly atPropertyCharges: number;
  readonly atPropertyAcknowledged: boolean;
  /** Lo que el navegador dice que el vendedor aceptó. */
  readonly acceptedTotal: Money;
  /** El precio de venta del snapshot del PreBook: lo que el servidor le mostró. */
  readonly shownTotal: Money;
}

function sameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}

/**
 * La primera puerta que falla, o `undefined`. El precio aceptado tiene que ser EXACTAMENTE el que
 * se mostró: si pudiera ser mayor, una subida en la revalidación hasta ese importe pasaría sin que
 * nadie la aceptara.
 */
export function checkBookable(facts: HotelBookableFacts): HotelBookRejection | undefined {
  if (facts.expiresAt - facts.now < HOTEL_BOOK_MIN_REMAINING_MS) return 'PREBOOK_EXPIRED';
  // RF-17 con D-TBO-22 A: no hay reservas de paquete que vinculen un vuelo, así que no se vende.
  if (facts.signals.includes('PACKAGE_WITH_FLIGHT_ONLY')) return 'PACKAGE_ONLY_RATE';
  if (facts.atPropertyCharges > 0 && !facts.atPropertyAcknowledged) {
    return 'AT_PROPERTY_NOT_ACKNOWLEDGED';
  }
  if (!sameMoney(facts.acceptedTotal, facts.shownTotal)) return 'ACCEPTED_TOTAL_MISMATCH';
  return undefined;
}

// ───────────────────────── 2. Después de la revalidación (C2) ─────────────────────────

export type HotelRepricedReason = 'PRICE_INCREASED' | 'CONDITIONS_CHANGED' | 'PACKAGE_ONLY_RATE';

export type HotelRevalidationDecision =
  | { readonly kind: 'proceed'; readonly priceDecreased: boolean }
  | { readonly kind: 'reject'; readonly reason: HotelRepricedReason };

/**
 * Se compara el precio de VENTA recalculado con la cascada sobre el neto nuevo, no el neto: es lo
 * que el vendedor aceptó y lo que paga el cliente. Si cambian a la vez el precio y las
 * condiciones, prevalecen las condiciones (03 §2.9 regla 2).
 */
export function decideAfterRevalidation(input: {
  readonly outcome: HotelRepriceOutcome;
  readonly signals: readonly HotelRateSignal[];
  readonly acceptedTotal: Money;
  readonly revalidatedTotal: Money;
}): HotelRevalidationDecision {
  if (input.signals.includes('PACKAGE_WITH_FLIGHT_ONLY')) {
    return { kind: 'reject', reason: 'PACKAGE_ONLY_RATE' };
  }
  if (
    input.outcome === 'CONDITIONS_CHANGED' ||
    input.revalidatedTotal.currency !== input.acceptedTotal.currency
  ) {
    return { kind: 'reject', reason: 'CONDITIONS_CHANGED' };
  }
  if (input.revalidatedTotal.amountMinor > input.acceptedTotal.amountMinor) {
    return { kind: 'reject', reason: 'PRICE_INCREASED' };
  }
  return {
    kind: 'proceed',
    priceDecreased: input.revalidatedTotal.amountMinor < input.acceptedTotal.amountMinor,
  };
}

// ───────────────────────── 3. Después del Book ─────────────────────────

/** Lo que se observó del Book. */
export type HotelBookObservation =
  /** El proveedor respondió sin lanzar. */
  | { readonly kind: 'answered'; readonly result: HotelBookResult; readonly reason: string }
  /** El Book lanzó, ya traducido por el proveedor o por quien sabe que no salió. */
  | { readonly kind: 'threw'; readonly failure: HotelBookFailure };

export type HotelBookDecision =
  | { readonly kind: 'confirmed'; readonly providerBookingId: string; readonly reason: string }
  /** El proveedor dijo que no reservó nada: `failed` y la clave se libera. */
  | { readonly kind: 'failed'; readonly reason: string; readonly providerStatus?: string }
  /** No salió ningún byte: `failed` antes del proveedor, sin nada que verificar. */
  | { readonly kind: 'not-dispatched'; readonly reason: string }
  /** Puede haber reserva: sigue `pending` y se verifica leyendo, nunca reintentando. */
  | { readonly kind: 'uncertain'; readonly reason: string; readonly providerStatus?: string };

export function decideAfterBook(observation: HotelBookObservation): HotelBookDecision {
  if (observation.kind === 'threw') {
    const { failure } = observation;
    const status =
      failure.providerStatus === undefined ? {} : { providerStatus: failure.providerStatus };
    if (failure.outcome === 'FAILED') {
      return failure.dispatched
        ? { kind: 'failed', reason: failure.reason, ...status }
        : { kind: 'not-dispatched', reason: failure.reason };
    }
    return { kind: 'uncertain', reason: failure.reason, ...status };
  }

  const { result, reason } = observation;
  const status =
    result.providerStatus === undefined ? {} : { providerStatus: result.providerStatus };
  const locator = result.providerBookingId?.trim();
  if (result.outcome === 'CONFIRMED') {
    // Confirmada sin localizador no se puede leer ni cancelar: para la saga es incierta.
    if (locator === undefined || locator.length === 0) {
      return {
        kind: 'uncertain',
        reason: reason === 'confirmed' ? 'missing-confirmation-number' : reason,
        ...status,
      };
    }
    return { kind: 'confirmed', providerBookingId: locator, reason };
  }
  if (result.outcome === 'FAILED') return { kind: 'failed', reason, ...status };
  // `PENDING` o `UNCERTAIN`: la respuesta no prueba la reserva.
  return { kind: 'uncertain', reason, ...status };
}

/** Cuándo se lee la reserva por nuestra referencia después de un desenlace incierto (RF-21). */
export function planBookVerification(failedAt: number): { readonly verifyAt: number } {
  return { verifyAt: failedAt + HOTEL_BOOK_VERIFY_DELAY_MS };
}

// ───────────────────────── 4. Lectura de cierre ─────────────────────────

export type HotelClosingEscalation =
  /** La lectura no se pudo hacer: la reserva existe, falta comprobarla. */
  | 'verification-unavailable'
  /** Leímos por el localizador que acaba de dar el proveedor y dice que no la tiene. */
  | 'verified-not-found'
  /** El proveedor ya la da por cancelada, o cancelándose. */
  | 'verified-cancelled-upstream'
  /** Un estado que no es de una reserva confirmada ni cancelada. */
  | 'verified-status-unexpected';

export type HotelClosingDecision =
  | { readonly kind: 'settled'; readonly status: 'confirmed' }
  | {
      readonly kind: 'escalate';
      readonly reason: HotelClosingEscalation;
      readonly status: Extract<OrderStatus, 'confirmed' | 'pending'>;
    };

/**
 * `view === null` es ignorancia nuestra (la lectura falló): la reserva sigue `confirmed`, como en
 * vuelos, y se escala. Una contradicción del proveedor no se muestra como confirmada: vuelve a
 * `pending` y la mira una persona. Nunca `failed`: una lectura degradada no prueba que no exista.
 */
export function decideAfterClosingRead(view: HotelBookingView | null): HotelClosingDecision {
  if (view === null) {
    return { kind: 'escalate', reason: 'verification-unavailable', status: 'confirmed' };
  }
  if (!view.found) return { kind: 'escalate', reason: 'verified-not-found', status: 'pending' };
  switch (view.status) {
    case 'CONFIRMED':
      return { kind: 'settled', status: 'confirmed' };
    case 'CANCELLED':
    case 'CANCELLATION_IN_PROGRESS':
      return { kind: 'escalate', reason: 'verified-cancelled-upstream', status: 'pending' };
    default:
      return { kind: 'escalate', reason: 'verified-status-unexpected', status: 'pending' };
  }
}

/** Resumen de la lectura de cierre para el `domain_event`: códigos y conteos, sin texto. */
export function closingReadSummary(view: HotelBookingView | null): Record<string, unknown> {
  if (view === null) return { verified: false, reason: 'read-failed' };
  return {
    verified: true,
    found: view.found,
    ...(view.status === undefined ? {} : { status: view.status }),
    warnings: view.warnings.length,
  };
}

// ───────────────────────── Respuesta HTTP (RF-22) ─────────────────────────

/**
 * `201` si la saga terminó con un estado final; `202` si no terminó dentro de la espera o si la
 * reserva quedó `pending` (verificándose): en los dos casos la web consulta `GET /orders/:id`.
 */
export function hotelBookHttpStatus(status: OrderStatus | undefined): 201 | 202 {
  return status === undefined || status === 'pending' ? 202 : 201;
}

/**
 * La lista blanca de `orders.provider_raw` de una reserva de hotel: escalares cerrados, nunca la
 * respuesta del proveedor, que arrastra el eco de los nombres y el contacto.
 */
export function hotelBookProviderRaw(input: {
  readonly bookingReference: string;
  readonly reason: string;
  readonly providerStatus?: string;
}): Record<string, string> {
  return {
    vertical: 'hotels',
    bookingReference: input.bookingReference,
    reason: input.reason,
    ...(input.providerStatus === undefined ? {} : { providerStatus: input.providerStatus }),
  };
}
