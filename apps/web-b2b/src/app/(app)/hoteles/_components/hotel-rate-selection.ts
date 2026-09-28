import type { HotelRoompack, Money } from '../actions';
import { decodeHotelKey } from './hotel-key';
import {
  hotelDetailLink,
  isSearchToken,
  parseStay,
  type HotelDetailLink,
  type HotelStay,
} from './hotel-search-handoff';

/*
 * La tarifa que el vendedor eligió en el detalle de un hotel, tal como la necesita el checkout.
 *
 * Viaja por `localStorage` con un identificador al azar en la URL, por lo mismo que la búsqueda
 * (`hotel-search-handoff.ts`): la estadía lleva la nacionalidad del pasajero, que no va en una
 * dirección que se copia. Lleva una copia de la estadía y no sólo el identificador de la búsqueda:
 * el checkout (y los huéspedes, que se cargan por habitación en su orden) no puede depender de que
 * esa búsqueda siga entre las diez que se recuerdan.
 *
 * Lo único que el API recibe de acá es la referencia neutral `{ providerCode, searchId, offerRef }`
 * (RF-08 CA-4): precio, ocupación y fechas los pone el servidor con el contexto de la búsqueda.
 */

/** Lo que el PreBook neutral pide: de qué proveedor, de qué búsqueda y cuál. */
export interface HotelOfferReference {
  readonly providerCode: string;
  readonly searchId: string;
  readonly offerRef: string;
}

export interface RateSelection {
  readonly reference: HotelOfferReference;
  /** Para volver al detalle del hotel, que vuelve a buscar sus tarifas. */
  readonly hotelKey: string;
  /** La búsqueda desde la que se abrió el detalle, si la hubo. */
  readonly searchToken?: string;
  readonly stay: HotelStay;
  /** El ajuste de divulgación con el que respondió la búsqueda (RF-40). */
  readonly showProviderInResults: boolean;
  /** Con qué nombre y dirección figura el hotel en la reserva: los del proveedor que lo vende. */
  readonly hotel: { readonly name?: string; readonly address?: string };
  /** El precio de VENTA que el vendedor vio al elegir: contra él se avisa el cambio. */
  readonly shownSale: Money;
  /** Epoch en ms. */
  readonly savedAt: number;
}

export const RATE_SELECTION_STORAGE_KEY = 'hoteles:tarifas';
/**
 * Una tarifa se sostiene 27 minutos desde la búsqueda. Una hora alcanza para volver a abrir el
 * checkout y leer que venció; más tarde, la elección ya no le dice nada a nadie.
 */
export const RATE_SELECTION_TTL_MS = 60 * 60_000;
export const RATE_SELECTION_MAX_ENTRIES = 10;

/** Los mismos formatos que valida el API: lo que no los cumple no llega a pedirse. */
const PROVIDER_CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEARCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OFFER_REF = 255;
const MAX_TEXT = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** La referencia neutral, o `undefined` ante cualquier cosa que el API rechazaría. */
export function parseOfferReference(value: unknown): HotelOfferReference | undefined {
  if (!isRecord(value)) return undefined;
  const { providerCode, searchId, offerRef } = value;
  if (
    typeof providerCode !== 'string' ||
    providerCode.length < 2 ||
    providerCode.length > 40 ||
    !PROVIDER_CODE_RE.test(providerCode)
  ) {
    return undefined;
  }
  if (typeof searchId !== 'string' || !SEARCH_ID_RE.test(searchId)) return undefined;
  if (typeof offerRef !== 'string' || offerRef.length === 0 || offerRef.length > MAX_OFFER_REF) {
    return undefined;
  }
  return { providerCode, searchId, offerRef };
}

/**
 * Con qué se revalida una tarifa por el PreBook neutral, o `undefined` si no se puede: sólo las
 * tarifas cuya búsqueda dejó contexto en el servidor traen `provider.raw.searchId`. Las de un
 * proveedor que reserva por su flujo propio (Despegar, D-TBO-08 A) no lo traen.
 */
export function offerReferenceOf(
  pack: Pick<HotelRoompack, 'provider'>,
): HotelOfferReference | undefined {
  const provider = pack.provider;
  if (provider === undefined) return undefined;
  return parseOfferReference({
    providerCode: provider.name,
    searchId: provider.raw?.['searchId'],
    offerRef: provider.offerRef,
  });
}

/** Nombre y dirección con que un proveedor conoce al hotel. */
interface HotelFactsInput {
  readonly name?: string;
  readonly address?: string;
}

/**
 * La elección de una tarifa del detalle, o `undefined` si esa tarifa no se revalida por el PreBook
 * neutral. El hotel que se guarda es el del proveedor que VENDE la tarifa, que es con el que figura
 * en la reserva (docs/tbo/05 §4); lo que falte, del encabezado del detalle.
 */
export function rateSelectionOf(input: {
  readonly pack: Pick<HotelRoompack, 'provider'>;
  readonly sale: Money;
  readonly hotelKey: string;
  readonly searchToken: string | undefined;
  readonly stay: HotelStay;
  readonly showProviderInResults: boolean;
  readonly sellerFacts: HotelFactsInput | undefined;
  readonly shownFacts: HotelFactsInput | undefined;
  readonly nowMs: number;
}): RateSelection | undefined {
  const reference = offerReferenceOf(input.pack);
  if (reference === undefined) return undefined;
  const name = shortText(input.sellerFacts?.name) ?? shortText(input.shownFacts?.name);
  const address = shortText(input.sellerFacts?.address) ?? shortText(input.shownFacts?.address);
  return {
    reference,
    hotelKey: input.hotelKey,
    ...(isSearchToken(input.searchToken) ? { searchToken: input.searchToken } : {}),
    stay: input.stay,
    showProviderInResults: input.showProviderInResults,
    hotel: { ...(name ? { name } : {}), ...(address ? { address } : {}) },
    shownSale: { amountMinor: input.sale.amountMinor, currency: input.sale.currency },
    savedAt: input.nowMs,
  };
}

function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) &&
    typeof value['amountMinor'] === 'number' &&
    Number.isInteger(value['amountMinor']) &&
    typeof value['currency'] === 'string' &&
    /^[A-Z]{3}$/.test(value['currency'])
  );
}

function shortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_TEXT ? text : undefined;
}

function selectionOf(value: unknown): RateSelection | undefined {
  if (!isRecord(value)) return undefined;
  const reference = parseOfferReference(value['reference']);
  const stay = parseStay(value['stay']);
  const hotelKey = value['hotelKey'];
  const savedAt = value['savedAt'];
  const shownSale = value['shownSale'];
  if (reference === undefined || stay === undefined || !isMoney(shownSale)) return undefined;
  if (typeof hotelKey !== 'string' || decodeHotelKey(hotelKey) === undefined) return undefined;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  const hotel = isRecord(value['hotel']) ? value['hotel'] : {};
  const name = shortText(hotel['name']);
  const address = shortText(hotel['address']);
  const searchToken = value['searchToken'];
  return {
    reference,
    hotelKey,
    ...(isSearchToken(searchToken) ? { searchToken } : {}),
    stay,
    // `=== true`, como la búsqueda: cualquier otra cosa es oculto.
    showProviderInResults: value['showProviderInResults'] === true,
    hotel: { ...(name ? { name } : {}), ...(address ? { address } : {}) },
    shownSale: { amountMinor: shownSale.amountMinor, currency: shownSale.currency },
    savedAt,
  };
}

/** Lo guardado, sin confiar en su forma: una entrada rota se descarta, no rompe las demás. */
export function parseRateSelections(raw: string | null): Record<string, RateSelection> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, RateSelection> = {};
  for (const [token, value] of Object.entries(parsed)) {
    const selection = isSearchToken(token) ? selectionOf(value) : undefined;
    if (selection !== undefined) out[token] = selection;
  }
  return out;
}

function isFresh(selection: RateSelection, nowMs: number): boolean {
  return nowMs - selection.savedAt <= RATE_SELECTION_TTL_MS && selection.savedAt <= nowMs + 60_000;
}

/** Suma una elección y olvida las vencidas y las que pasan del tope, de la más vieja a la nueva. */
export function withRateSelection(
  entries: Readonly<Record<string, RateSelection>>,
  token: string,
  selection: RateSelection,
  nowMs: number,
): Record<string, RateSelection> {
  const kept = Object.entries({ ...entries, [token]: selection })
    .filter(([, s]) => isFresh(s, nowMs))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, RATE_SELECTION_MAX_ENTRIES);
  return Object.fromEntries(kept);
}

/** La elección de un identificador, si sigue vigente. */
export function rateSelectionFor(
  entries: Readonly<Record<string, RateSelection>>,
  token: string,
  nowMs: number,
): RateSelection | undefined {
  const selection = entries[token];
  return selection !== undefined && isFresh(selection, nowMs) ? selection : undefined;
}

/**
 * Guarda la elección para el checkout. `false` si no se pudo (almacenamiento bloqueado o lleno):
 * entonces el checkout no tendría qué revalidar, y no se navega a él.
 */
export function saveRateSelection(token: string, selection: RateSelection): boolean {
  try {
    const entries = parseRateSelections(window.localStorage.getItem(RATE_SELECTION_STORAGE_KEY));
    const next = withRateSelection(entries, token, selection, Date.now());
    window.localStorage.setItem(RATE_SELECTION_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function readRateSelection(token: string): RateSelection | undefined {
  try {
    const entries = parseRateSelections(window.localStorage.getItem(RATE_SELECTION_STORAGE_KEY));
    return rateSelectionFor(entries, token, Date.now());
  } catch {
    return undefined;
  }
}

/** La dirección del checkout de una tarifa elegida. */
export function checkoutHref(token: string): string {
  return `/hoteles/checkout?tarifa=${encodeURIComponent(token)}`;
}

/** Volver al detalle del hotel desde el checkout, con su búsqueda si la hubo. */
export function hotelLinkOf(
  selection: Pick<RateSelection, 'hotelKey' | 'searchToken'>,
): HotelDetailLink {
  return hotelDetailLink(selection.hotelKey, selection.searchToken);
}
