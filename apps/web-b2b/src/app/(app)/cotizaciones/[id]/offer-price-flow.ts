import { readJson } from '../../../../lib/read-json';
import type { FareComponent, Offer } from '../actions';

export interface OfferPriceEnvelope {
  readonly offer: Offer;
  readonly priceChanged: boolean;
  readonly warnings: readonly string[];
}

export type OfferPriceRead =
  | { readonly ok: true; readonly data: OfferPriceEnvelope }
  | { readonly ok: false; readonly message: string };

export type PriceVerificationState =
  | {
      readonly kind: 'confirmed';
      readonly changed: boolean;
      readonly newTotal?: string;
    }
  | { readonly kind: 'acceptance-required'; readonly newTotal: string }
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

export function canReserveAfterPriceCheck(
  state: PriceVerificationState | null,
  verifying: boolean,
): boolean {
  return !verifying && state?.kind === 'confirmed';
}

export function reservationGateMessage(
  state: PriceVerificationState | null,
  verifying: boolean,
): string | undefined {
  if (verifying) return 'Esperá a que termine la revalidación antes de reservar.';
  if (state === null) return 'Verificá el precio para habilitar la reserva.';
  if (state.kind === 'error') return state.message;
  if (state.kind === 'acceptance-required') {
    return 'Aceptá la tarifa revalidada para habilitar la reserva.';
  }
  return undefined;
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

function isPolicies(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['changeable'] === 'boolean' &&
    typeof value['refundable'] === 'boolean'
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
