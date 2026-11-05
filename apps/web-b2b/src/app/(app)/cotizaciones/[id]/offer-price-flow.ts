import { readJson } from '../../../../lib/read-json';
import type { FareComponent, Offer } from '../actions';

export interface OfferPriceEnvelope {
  readonly offer: Offer;
  readonly priceChanged: boolean;
  readonly warnings: readonly string[];
  /**
   * El proveedor de la oferta deja elegir asiento al reservar (SAB-16). Ausente o cualquier otra
   * cosa que no sea `true` = no: el botón no se ofrece.
   */
  readonly seatSelection?: boolean;
}

/** ¿Se ofrece «Elegir asientos»? Sólo con un `true` explícito del API. */
export function offersSeatSelection(envelope: OfferPriceEnvelope): boolean {
  return envelope.seatSelection === true;
}

export type OfferPriceRead =
  | { readonly ok: true; readonly data: OfferPriceEnvelope }
  | { readonly ok: false; readonly message: string };

/**
 * `checkedAt` (epoch ms) es cuándo respondió el proveedor: una confirmación de hace un rato ya no
 * garantiza nada y la reserva vuelve a revalidar antes de enviar (ver `reserveDecision`).
 */
export type PriceVerificationState =
  | {
      readonly kind: 'confirmed';
      readonly changed: boolean;
      readonly newTotal?: string;
      readonly checkedAt: number;
    }
  | { readonly kind: 'acceptance-required'; readonly newTotal: string; readonly checkedAt: number }
  | { readonly kind: 'error'; readonly message: string };

/**
 * `readJson` resuelve HTML/JSON, pero deliberadamente no interpreta HTTP ni contratos. Aquí sí se
 * necesitan las tres capas: un JSON de error en un 500 no es una confirmación y un 200 sin Offer
 * reservable tampoco.
 */
export async function readOfferPriceResponse(
  response: Response,
  previousOffer?: Offer,
): Promise<OfferPriceRead> {
  const read = await readJson<unknown>(response);
  if (!read.ok) return { ok: false, message: read.message };

  if (!response.ok) {
    return {
      ok: false,
      message:
        errorMessage(read.data) ??
        `No se pudo revalidar la tarifa (respuesta ${String(response.status)}).`,
    };
  }

  if (!isOfferPriceEnvelope(read.data)) {
    return {
      ok: false,
      message: 'El servidor respondió sin una oferta revalidada completa. No se puede reservar.',
    };
  }
  if (
    (previousOffer?.fareComponents?.length ?? 0) > 0 &&
    (read.data.offer.fareComponents?.length ?? 0) === 0
  ) {
    return {
      ok: false,
      message:
        'La revalidación perdió las familias por trayecto de la oferta. No se puede reservar.',
    };
  }
  return { ok: true, data: read.data };
}

/** Reemplazo total, no parche de precio: conserva handles, TTL y familias de la nueva Offer. */
export function withRevalidatedOffer<T extends { selectedOffer: Offer; expiresAt: string }>(
  quotation: T,
  offer: Offer,
): Omit<T, 'selectedOffer' | 'expiresAt'> & { selectedOffer: Offer; expiresAt: string } {
  return { ...quotation, selectedOffer: offer, expiresAt: offer.expiresAt };
}

export function displayedTotal(offer: Offer): { amountMinor: number; currency: string } {
  return {
    amountMinor: offer.pricing?.finalMinor ?? offer.total.amountMinor,
    currency: offer.pricing?.currency ?? offer.total.currency,
  };
}

export function displayedPriceChanged(
  previous: Offer,
  next: Offer,
  providerReportedChange: boolean,
): boolean {
  const before = displayedTotal(previous);
  const after = displayedTotal(next);
  return (
    providerReportedChange ||
    before.amountMinor !== after.amountMinor ||
    before.currency !== after.currency ||
    fareSelectionIdentity(previous) !== fareSelectionIdentity(next)
  );
}

/**
 * Misma identidad que protege el backend al crear la reserva. Un Flight Check puede conservar el
 * importe y cambiar marca, fare basis o RBD; ese cambio también necesita aceptación explícita.
 * `programId`/`programCode` se omiten porque Sabre puede enriquecerlos sin cambiar el producto.
 */
function fareSelectionIdentity(offer: Offer): string {
  if (!offer.fareComponents?.length) {
    return `legacy:${JSON.stringify({
      name: offer.fareFamily?.name.trim().toUpperCase() ?? '',
      cabin: offer.fareFamily?.cabin.trim().toUpperCase() ?? '',
    })}`;
  }

  const components = offer.fareComponents.map((component) => ({
    segmentRefs: [...component.segmentRefs].sort((a, b) => a - b),
    brand:
      component.brand?.code?.trim().toUpperCase() ??
      component.brand?.name?.trim().toUpperCase() ??
      null,
    fareBasisCode: component.fareBasisCode?.trim().toUpperCase() ?? null,
    cabin: component.cabin?.trim().toUpperCase() ?? null,
    bookingClasses: component.bookingClasses
      ? [...component.bookingClasses].map((value) => value.trim().toUpperCase()).sort()
      : null,
  }));
  components.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `components:${JSON.stringify(components)}`;
}

/**
 * Cuánto vale una confirmación de precio para reservar sin volver a preguntar. Pasado esto, el
 * clic en «Reservar» revalida primero: el servidor lo haría igual, pero un 409 a mitad de la
 * reserva es peor experiencia que un segundo más de espera antes de enviarla.
 */
export const PRICE_CHECK_FRESH_MS = 5 * 60_000;

/**
 * La revalidación ya no es un paso que el vendedor dispara: corre sola al abrir la cotización. No
 * corre sobre una cotización cerrada —aceptada o cancelada—, donde no queda nada que reservar y la
 * llamada al proveedor sólo gastaría cuota.
 */
export function shouldAutoVerifyPrice(status: string): boolean {
  return status !== 'accepted' && status !== 'cancelled';
}

/**
 * Qué hace el clic en «Reservar» según el último estado del precio:
 *
 * - `go`: confirmación fresca, se crea la reserva en el mismo clic.
 * - `revalidate`: sin confirmación, con error o vieja; se revalida primero y se espera.
 * - `ask`: el precio cambió y nadie lo aceptó todavía; se pregunta antes de reservar.
 */
export type ReserveDecision = 'go' | 'revalidate' | 'ask';

export function reserveDecision(
  state: PriceVerificationState | null,
  now: number,
  freshForMs: number = PRICE_CHECK_FRESH_MS,
): ReserveDecision {
  if (state === null || state.kind === 'error') return 'revalidate';
  if (state.kind === 'acceptance-required') return 'ask';
  return now - state.checkedAt <= freshForMs ? 'go' : 'revalidate';
}

/** El vendedor aceptó el precio nuevo: la oferta ya es la revalidada, sólo cambia el estado. */
export function acceptRevalidatedPrice(
  state: Extract<PriceVerificationState, { kind: 'acceptance-required' }>,
): PriceVerificationState {
  return {
    kind: 'confirmed',
    changed: true,
    newTotal: state.newTotal,
    checkedAt: state.checkedAt,
  };
}

/**
 * ¿Los asientos elegidos siguen valiendo tras una revalidación? (SAB-16) Sólo si el proveedor
 * sigue ofreciendo asientos y la oferta no cambió: un cambio de tarifa puede cambiar la cabina o
 * la clase, y un asiento elegido sobre la oferta anterior ya no es de fiar.
 */
export function seatsSurviveRevalidation(
  state: PriceVerificationState,
  seatSelectionOffered: boolean,
): boolean {
  return seatSelectionOffered && state.kind === 'confirmed' && !state.changed;
}

export type PriceStatusTone = 'pending' | 'ok' | 'warning' | 'error';

export interface PriceStatusLine {
  readonly tone: PriceStatusTone;
  readonly text: string;
  /** Sólo los errores se reintentan a mano; lo demás se resuelve al reservar. */
  readonly retry: boolean;
}

/** La línea discreta junto al resumen. `null` = nada que decir (cotización cerrada). */
export function priceStatusLine(
  state: PriceVerificationState | null,
  verifying: boolean,
): PriceStatusLine | null {
  if (verifying) return { tone: 'pending', text: 'Verificando precio…', retry: false };
  if (state === null) return null;
  switch (state.kind) {
    case 'confirmed':
      return state.changed
        ? {
            tone: 'ok',
            text: `Nuevo precio aceptado: ${state.newTotal ?? ''}`.trim(),
            retry: false,
          }
        : { tone: 'ok', text: 'Precio confirmado', retry: false };
    case 'acceptance-required':
      return {
        tone: 'warning',
        text: `El precio cambió a ${state.newTotal}. Se confirma al reservar.`,
        retry: false,
      };
    case 'error':
      return { tone: 'error', text: state.message, retry: true };
  }
}

export function priceChangeQuestion(newTotal: string): string {
  return `El precio cambió a ${newTotal}. ¿Reservar con el nuevo precio?`;
}

/**
 * El 409 con el que el servidor se niega a reservar porque su propia revalidación vio otro precio
 * u otra familia (`orders.service.ts`). Es el mismo caso que la revalidación del navegador: hay
 * que preguntar, no fallar. Otros 409 —oferta vencida, conciliación pendiente— no lo son.
 */
export function isServerPriceChange(status: number, message: string | undefined): boolean {
  if (status !== 409 || message === undefined) return false;
  return /precio cambi[oó]|familia o la base tarifaria cambi[oó]/i.test(message);
}

function isOfferPriceEnvelope(value: unknown): value is OfferPriceEnvelope {
  if (!isRecord(value)) return false;
  return (
    typeof value['priceChanged'] === 'boolean' &&
    Array.isArray(value['warnings']) &&
    value['warnings'].every((warning) => typeof warning === 'string') &&
    isOffer(value['offer'])
  );
}

function isOffer(value: unknown): value is Offer {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['tenantId']) &&
    Array.isArray(value['products']) &&
    value['products'].length > 0 &&
    value['products'].every(isNonEmptyString) &&
    isProvider(value['provider']) &&
    isMoney(value['total']) &&
    isMoney(value['baseFare']) &&
    isMoney(value['taxes']) &&
    isOptional(value['pricing'], isPricing) &&
    isOptional(value['itineraries'], isItineraries) &&
    isOptional(value['fareFamily'], isFareFamily) &&
    isOptional(value['fareComponents'], isFareComponents) &&
    isOptional(value['baggage'], isBaggage) &&
    isOptional(value['policies'], isPolicies) &&
    isNonEmptyString(value['fetchedAt']) &&
    isNonEmptyString(value['expiresAt'])
  );
}

function isProvider(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value['name']) && isNonEmptyString(value['offerRef']);
}

function isMoney(value: unknown): boolean {
  return isRecord(value) && isInteger(value['amountMinor']) && isNonEmptyString(value['currency']);
}

function isPricing(value: unknown): boolean {
  return (
    isRecord(value) &&
    isInteger(value['costMinor']) &&
    isInteger(value['finalMinor']) &&
    isInteger(value['ownMarkupMinor']) &&
    isNonEmptyString(value['currency'])
  );
}

function isItineraries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (itinerary) =>
        isRecord(itinerary) &&
        isInteger(itinerary['totalDurationMinutes']) &&
        isInteger(itinerary['stops']) &&
        Array.isArray(itinerary['segments']) &&
        itinerary['segments'].length > 0 &&
        itinerary['segments'].every(isSegment),
    )
  );
}

function isSegment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    [
      'carrier',
      'flightNumber',
      'origin',
      'destination',
      'departureAt',
      'arrivalAt',
      'cabin',
      'bookingClass',
    ].every((field) => isNonEmptyString(value[field])) && isInteger(value['durationMinutes'])
  );
}

function isFareFamily(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value['name']) && isNonEmptyString(value['cabin']);
}

function isFareComponents(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isFareComponent);
}

function isFareComponent(value: unknown): value is FareComponent {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value['segmentRefs']) &&
    value['segmentRefs'].length > 0 &&
    value['segmentRefs'].every(
      (ref) => typeof ref === 'number' && Number.isInteger(ref) && ref >= 0,
    ) &&
    isOptional(value['brand'], isFareBrand) &&
    isOptional(value['fareBasisCode'], isNonEmptyString) &&
    isOptional(
      value['bookingClasses'],
      (classes) => Array.isArray(classes) && classes.length > 0 && classes.every(isNonEmptyString),
    ) &&
    isOptional(value['origin'], isNonEmptyString) &&
    isOptional(value['destination'], isNonEmptyString) &&
    isOptional(value['cabin'], isNonEmptyString)
  );
}

function isFareBrand(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isOptional(value['code'], isNonEmptyString) &&
    isOptional(value['name'], isNonEmptyString) &&
    isOptional(value['programCode'], isNonEmptyString) &&
    isOptional(
      value['programId'],
      (programId) => typeof programId === 'number' && Number.isInteger(programId) && programId >= 0,
    )
  );
}

function isBaggage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isOptional(value['personalItem'], isNonNegativeInteger) &&
    isOptional(value['carryOn'], isAllowance) &&
    isOptional(value['checked'], isAllowance)
  );
}

function isAllowance(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value['qty']) &&
    isOptional(value['weightKg'], (weight) => typeof weight === 'number' && Number.isFinite(weight))
  );
}

/** Cada campo es opcional: ausente = «no informado» (ver `lib/fare-policy.ts`). */
function isPolicies(value: unknown): boolean {
  const isBoolean = (candidate: unknown) => typeof candidate === 'boolean';
  return (
    isRecord(value) &&
    isOptional(value['changeable'], isBoolean) &&
    isOptional(value['refundable'], isBoolean) &&
    isOptional(value['changeFee'], isMoney) &&
    isOptional(value['refundFee'], isMoney)
  );
}

function isNonNegativeInteger(value: unknown): boolean {
  return isInteger(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOptional(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === undefined || predicate(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const message = value['error'] ?? value['message'];
  return typeof message === 'string' && message.trim() ? message : undefined;
}
