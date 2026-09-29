import { isCountryAlpha2 } from '../../../../lib/countries';
import type { HotelOffer, HotelSearchCriteriaView, RoomDistribution } from '../actions';
import { encodeHotelKey, hotelRefsOf } from './hotel-key';
import { isCurrencyCode } from './search-currency';

/*
 * Lo que el detalle de un hotel necesita de la búsqueda desde la que se abrió: la estadía, para
 * volver a pedir sus tarifas (D-TBO-19 A), y el ajuste de divulgación que el API resolvió para
 * esa búsqueda (RF-40).
 *
 * Viaja por `localStorage` y no por la URL: la nacionalidad del pasajero es un dato suyo y no va
 * en una dirección que se copia y se comparte (el formulario de búsqueda ya evita mandarla por
 * GET). La URL lleva sólo un identificador al azar de la búsqueda, así que dos búsquedas en dos
 * pestañas no se pisan. Y `localStorage` y no `sessionStorage` porque el detalle se abre en otra
 * pestaña, que no hereda el `sessionStorage` de la que la abrió.
 *
 * Es una comodidad de este navegador: sin almacenamiento, o pasado su plazo, el detalle muestra
 * la ficha del hotel y pide volver a buscar para ver tarifas.
 */

export interface HotelStay {
  readonly checkinDate: string;
  readonly checkoutDate: string;
  /** Una por habitación, en el orden de la búsqueda. */
  readonly rooms: readonly RoomDistribution[];
  /** ISO 3166-1 alfa-2. */
  readonly guestNationality: string;
  readonly refundableOnly: boolean;
  /**
   * La moneda de la búsqueda (ISO 4217, D-TBO-15): el detalle pide sus tarifas en la misma, o
   * mostraría otras que las del listado. Ausente: la de la agencia (una búsqueda sin moneda
   * elegida, o guardada antes del selector).
   */
  readonly currency?: string;
}

export interface SearchHandoff {
  readonly stay: HotelStay;
  /** El ajuste "Origen de las tarifas en los resultados" con el que respondió la búsqueda. */
  readonly showProviderInResults: boolean;
  /** Epoch en ms. */
  readonly savedAt: number;
}

export const HANDOFF_STORAGE_KEY = 'hoteles:busquedas';
/** Una jornada de trabajo: más tarde, la divulgación guardada puede no ser la vigente. */
export const HANDOFF_TTL_MS = 8 * 60 * 60_000;
/** Las búsquedas más recientes que se recuerdan; las demás se olvidan. */
export const HANDOFF_MAX_ENTRIES = 10;

/** Los topes del borde del API: lo que no los cumple no llega a pedirse. */
const MAX_ROOMS = 8;
const MAX_ADULTS = 8;
const MAX_CHILDREN = 6;
const MAX_CHILD_AGE = 17;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;

export function isSearchToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function roomOf(value: unknown): RoomDistribution | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { adults, childrenAges } = value as { adults?: unknown; childrenAges?: unknown };
  if (!isIntIn(adults, 1, MAX_ADULTS)) return undefined;
  const ages = childrenAges ?? [];
  if (!Array.isArray(ages) || ages.length > MAX_CHILDREN) return undefined;
  if (!ages.every((age) => isIntIn(age, 0, MAX_CHILD_AGE))) return undefined;
  return { adults, childrenAges: ages };
}

/**
 * Una estadía completa y dentro de los topes, o `undefined`. La usan el navegador, al leer lo que
 * guardó, y la acción del servidor, que no confía en lo que el navegador le manda.
 */
export function parseStay(value: unknown): HotelStay | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { checkinDate, checkoutDate, guestNationality } = raw;
  if (typeof checkinDate !== 'string' || !DATE_RE.test(checkinDate)) return undefined;
  if (typeof checkoutDate !== 'string' || !DATE_RE.test(checkoutDate)) return undefined;
  if (checkoutDate <= checkinDate) return undefined;
  if (typeof guestNationality !== 'string' || !isCountryAlpha2(guestNationality)) return undefined;
  if (!Array.isArray(raw['rooms']) || raw['rooms'].length === 0) return undefined;
  if (raw['rooms'].length > MAX_ROOMS) return undefined;
  const rooms = raw['rooms'].map(roomOf);
  if (rooms.some((r) => r === undefined)) return undefined;
  // Una moneda que no es un código ISO no se descarta callada: el detalle buscaría en otra que la
  // del listado. Sin moneda, sí vale: es la de la agencia.
  const currency = raw['currency'];
  if (currency !== undefined && !isCurrencyCode(currency)) return undefined;
  return {
    checkinDate,
    checkoutDate,
    rooms: rooms as RoomDistribution[],
    guestNationality,
    refundableOnly: raw['refundableOnly'] === true,
    ...(currency === undefined ? {} : { currency }),
  };
}

function handoffOf(value: unknown): SearchHandoff | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const stay = parseStay(raw['stay']);
  const savedAt = raw['savedAt'];
  if (stay === undefined || typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
    return undefined;
  }
  // `=== true`, como en la búsqueda: cualquier otra cosa es oculto.
  return { stay, showProviderInResults: raw['showProviderInResults'] === true, savedAt };
}

/** Lo guardado, sin confiar en su forma: una entrada rota se descarta, no rompe las demás. */
export function parseHandoffs(raw: string | null): Record<string, SearchHandoff> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, SearchHandoff> = {};
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    const handoff = isSearchToken(token) ? handoffOf(value) : undefined;
    if (handoff !== undefined) out[token] = handoff;
  }
  return out;
}

function isFresh(handoff: SearchHandoff, nowMs: number): boolean {
  return nowMs - handoff.savedAt <= HANDOFF_TTL_MS && handoff.savedAt <= nowMs + 60_000;
}

/** Suma una búsqueda y olvida las vencidas y las que pasan del tope, de la más vieja a la nueva. */
export function withHandoff(
  entries: Readonly<Record<string, SearchHandoff>>,
  token: string,
  handoff: SearchHandoff,
  nowMs: number,
): Record<string, SearchHandoff> {
  const kept = Object.entries({ ...entries, [token]: handoff })
    .filter(([, h]) => isFresh(h, nowMs))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, HANDOFF_MAX_ENTRIES);
  return Object.fromEntries(kept);
}

/** La búsqueda de un identificador, si sigue vigente. */
export function handoffFor(
  entries: Readonly<Record<string, SearchHandoff>>,
  token: string,
  nowMs: number,
): SearchHandoff | undefined {
  const handoff = entries[token];
  return handoff !== undefined && isFresh(handoff, nowMs) ? handoff : undefined;
}

/** Identificador de una búsqueda. No protege nada: sólo separa una búsqueda de otra. */
export function newSearchToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Contexto sin `crypto`: el respaldo de abajo alcanza para no pisar otra búsqueda.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Guarda una búsqueda para los detalles que se abran desde ella. Sin almacenamiento, nada. */
export function saveSearchHandoff(token: string, handoff: SearchHandoff): void {
  try {
    const entries = parseHandoffs(window.localStorage.getItem(HANDOFF_STORAGE_KEY));
    const next = withHandoff(entries, token, handoff, Date.now());
    window.localStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Almacenamiento bloqueado o lleno: el detalle pedirá volver a buscar.
  }
}

export function readSearchHandoff(token: string): SearchHandoff | undefined {
  try {
    const entries = parseHandoffs(window.localStorage.getItem(HANDOFF_STORAGE_KEY));
    return handoffFor(entries, token, Date.now());
  } catch {
    return undefined;
  }
}

/** La dirección del detalle, con la forma de objeto que acepta `<Link>`. */
export interface HotelDetailLink {
  readonly pathname: string;
  readonly query?: { readonly busqueda: string };
}

/** La dirección del detalle de un hotel abierto desde una búsqueda. */
export function hotelDetailLink(hotelKey: string, token: string | undefined): HotelDetailLink {
  const pathname = `/hoteles/${hotelKey}`;
  return token !== undefined && isSearchToken(token)
    ? { pathname, query: { busqueda: token } }
    : { pathname };
}

/** El detalle de la tarjeta de un hotel, o nada si su clave no se puede armar. */
export function detailLinkForOffer(
  offer: Pick<HotelOffer, 'hotelId' | 'roompacks' | 'providerHotels'>,
  token: string | undefined,
): HotelDetailLink | undefined {
  const key = encodeHotelKey(hotelRefsOf(offer));
  return key === undefined ? undefined : hotelDetailLink(key, token);
}

/** La estadía de una búsqueda que salió bien, como la guarda el detalle. */
export function stayOfCriteria(
  criteria: Pick<
    HotelSearchCriteriaView,
    | 'checkinDate'
    | 'checkoutDate'
    | 'occupancy'
    | 'guestNationality'
    | 'refundableOnly'
    | 'currency'
  >,
): HotelStay | undefined {
  return parseStay({
    checkinDate: criteria.checkinDate,
    checkoutDate: criteria.checkoutDate,
    rooms: criteria.occupancy,
    guestNationality: criteria.guestNationality,
    refundableOnly: criteria.refundableOnly,
    ...(criteria.currency === undefined ? {} : { currency: criteria.currency }),
  });
}
