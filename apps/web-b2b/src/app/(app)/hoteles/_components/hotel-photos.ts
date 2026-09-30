import { HOTEL_CONTENT_BATCH_MAX_HOTELS } from '../../../../lib/hotel-content-batch';
import type { HotelOffer } from '../actions';
import { hotelRefsOf } from './hotel-key';

/*
 * Las fotos de la pantalla de resultados, sin React (estrategia de fotos del 2026-09-29).
 *
 * Los resultados se muestran al instante: la foto que el catálogo ya tiene llega con la búsqueda
 * (`mainImage`), y para las demás la pantalla pide en segundo plano `POST /api/hotels/content/batch`,
 * en tandas de hasta {@link HOTEL_CONTENT_BATCH_MAX_HOTELS} hoteles y en el orden en que se ven. Lo
 * que el API todavía está trayendo del proveedor vuelve `pending` con `retryAfterMs` y se vuelve a
 * pedir, a lo sumo {@link PHOTO_MAX_ATTEMPTS} veces; lo que no tiene foto (`none`) queda con el
 * marcador. Nada de esto frena la búsqueda ni la lista.
 */

/** Intentos por hotel, contando el primero. Después, el marcador. */
export const PHOTO_MAX_ATTEMPTS = 3;
/** Espera antes de reintentar una tanda que falló sin decir cuánto esperar. */
export const PHOTO_RETRY_DEFAULT_MS = 4_000;
/** Ni menos de esto (un `retryAfterMs` de 0 sería un bucle) ni más (el vendedor ya se fue). */
const PHOTO_RETRY_MIN_MS = 1_000;
const PHOTO_RETRY_MAX_MS = 30_000;

/**
 * Una ruta del proxy propio, la única forma que acepta `next/image` (`images.localPatterns` de
 * next.config: `/api/hotels/images/**` y sin query). Cualquier otra cosa haría fallar el render.
 * Es `HOTEL_IMAGE_PROXY_PATH` de lib/hotel-image-proxy escrita acá, para no llevar al navegador el
 * módulo del proxy (y su caché); el test las compara.
 */
export const PHOTO_PROXY_PATH_RE = /^\/api\/hotels\/images\/[A-Za-z0-9_-]{1,2048}$/;

export function isProxyImagePath(value: unknown): value is string {
  return typeof value === 'string' && PHOTO_PROXY_PATH_RE.test(value);
}

export interface PhotoRef {
  readonly providerCode: string;
  readonly hotelId: string;
}

export function photoRefKey(ref: PhotoRef): string {
  return `${ref.providerCode}~${ref.hotelId}`;
}

/**
 * Con qué id pedir las fotos de una tarjeta: el de cada proveedor que la vende. Con varios, el API
 * elige la mejor foto del MISMO hotel (hotel_match), y un proveedor que no sabe dar contenido no
 * deja sin foto al que sí.
 */
export function photoRefsOf(
  offer: Pick<HotelOffer, 'hotelId' | 'roompacks' | 'providerHotels'>,
): PhotoRef[] {
  return hotelRefsOf(offer).map((r) => ({ providerCode: r.provider, hotelId: r.hotelId }));
}

export type PhotoStatus =
  /** Todavía no se pidió. */
  | 'idle'
  /** Pedida, esperando la respuesta. */
  | 'loading'
  /** El API la está trayendo del proveedor: se vuelve a pedir en `retryAt`. */
  | 'pending'
  | 'ready'
  /** No hay foto que mostrar: el marcador. */
  | 'none';

export interface PhotoState {
  readonly status: PhotoStatus;
  readonly url?: string;
  readonly attempts: number;
  /** Epoch en ms: cuándo se puede volver a pedir una `pending`. */
  readonly retryAt?: number;
}

export type PhotoStates = ReadonlyMap<string, PhotoState>;

export interface PhotoTarget {
  /** La clave de la tarjeta en la lista. */
  readonly key: string;
  readonly refs: readonly PhotoRef[];
}

/** El estado inicial: lista la que vino con la búsqueda, sin nada que pedir la que no dice de dónde es. */
export function initialPhotoState(
  offer: Pick<HotelOffer, 'mainImage' | 'hotelId' | 'roompacks' | 'providerHotels'>,
): PhotoState {
  const url = offer.mainImage?.url;
  if (isProxyImagePath(url)) return { status: 'ready', url, attempts: 0 };
  return photoRefsOf(offer).length > 0
    ? { status: 'idle', attempts: 0 }
    : { status: 'none', attempts: 0 };
}

function isDue(state: PhotoState | undefined, nowMs: number): boolean {
  if (state === undefined) return false;
  if (state.status === 'idle') return true;
  return state.status === 'pending' && (state.retryAt ?? 0) <= nowMs;
}

/**
 * La próxima tanda: las tarjetas que toca pedir, en el orden en que se ven, mientras sus códigos
 * entren en el tope del API. Vacía si no hay nada que pedir ahora.
 */
export function nextPhotoBatch(
  order: readonly PhotoTarget[],
  states: PhotoStates,
  nowMs: number,
  maxRefs = HOTEL_CONTENT_BATCH_MAX_HOTELS,
): PhotoTarget[] {
  const batch: PhotoTarget[] = [];
  const refs = new Set<string>();
  for (const target of order) {
    if (!isDue(states.get(target.key), nowMs)) continue;
    const keys = target.refs.map(photoRefKey).filter((k) => !refs.has(k));
    if (refs.size + keys.length > maxRefs) {
      if (batch.length === 0) continue;
      break;
    }
    for (const k of keys) refs.add(k);
    batch.push(target);
  }
  return batch;
}

/** El cuerpo del pedido de una tanda, sin códigos repetidos. */
export function photoBatchBody(batch: readonly PhotoTarget[]): {
  lang: 'es';
  hotels: PhotoRef[];
} {
  const seen = new Map<string, PhotoRef>();
  for (const t of batch) for (const r of t.refs) seen.set(photoRefKey(r), r);
  return { lang: 'es', hotels: [...seen.values()] };
}

export interface PhotoBatchReply {
  readonly items: ReadonlyMap<string, { status: 'ready' | 'pending' | 'none'; url?: string }>;
  readonly retryAfterMs?: number;
}

/** La respuesta del API, sin confiar en su forma. `undefined` si no tiene la esperada. */
export function parsePhotoBatchReply(raw: unknown): PhotoBatchReply | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { items, retryAfterMs } = raw as { items?: unknown; retryAfterMs?: unknown };
  if (!Array.isArray(items)) return undefined;
  const out = new Map<string, { status: 'ready' | 'pending' | 'none'; url?: string }>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { providerCode, hotelId, status, mainImage } = item as Record<string, unknown>;
    if (typeof providerCode !== 'string' || typeof hotelId !== 'string') continue;
    const key = photoRefKey({ providerCode, hotelId });
    const url = (mainImage as { url?: unknown } | null | undefined)?.url;
    if (status === 'ready' && isProxyImagePath(url)) out.set(key, { status: 'ready', url });
    else if (status === 'pending') out.set(key, { status: 'pending' });
    else out.set(key, { status: 'none' });
  }
  return {
    items: out,
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
}

/** La espera antes de volver a pedir, acotada; sin dato, {@link PHOTO_RETRY_DEFAULT_MS}. */
export function clampPhotoRetry(ms: number | undefined): number {
  const value = ms ?? PHOTO_RETRY_DEFAULT_MS;
  return Math.min(PHOTO_RETRY_MAX_MS, Math.max(PHOTO_RETRY_MIN_MS, value));
}

/** Marca una tanda como pedida. Sólo las que esperaban: una lista o sin foto no se toca. */
export function markLoading(
  states: PhotoStates,
  batch: readonly PhotoTarget[],
): Map<string, PhotoState> {
  const next = new Map(states);
  for (const t of batch) {
    const prev = states.get(t.key);
    if (prev !== undefined && prev.status !== 'idle' && prev.status !== 'pending') continue;
    next.set(t.key, { status: 'loading', attempts: (prev?.attempts ?? 0) + 1 });
  }
  return next;
}

/** Una foto que ya está lista no vuelve atrás por una respuesta tardía. */
function settled(states: PhotoStates, key: string): boolean {
  return states.get(key)?.status === 'ready';
}

function pendingOrNone(attempts: number, retryAt: number): PhotoState {
  return attempts >= PHOTO_MAX_ATTEMPTS
    ? { status: 'none', attempts }
    : { status: 'pending', attempts, retryAt };
}

/**
 * Lo que respondió el API para una tanda. Una tarjeta con varios códigos toma la primera foto lista
 * de cualquiera; si ninguno está listo y alguno sigue `pending`, se reintenta; si no, el marcador.
 */
export function applyPhotoBatch(
  states: PhotoStates,
  batch: readonly PhotoTarget[],
  reply: PhotoBatchReply,
  nowMs: number,
): Map<string, PhotoState> {
  const next = new Map(states);
  const retryAt = nowMs + clampPhotoRetry(reply.retryAfterMs);
  for (const t of batch) {
    if (settled(states, t.key)) continue;
    const attempts = states.get(t.key)?.attempts ?? 1;
    const items = t.refs.map((r) => reply.items.get(photoRefKey(r)));
    const ready = items.find((i) => i?.status === 'ready' && i.url !== undefined);
    if (ready?.url !== undefined) {
      next.set(t.key, { status: 'ready', url: ready.url, attempts });
    } else if (items.some((i) => i?.status === 'pending')) {
      next.set(t.key, pendingOrNone(attempts, retryAt));
    } else {
      next.set(t.key, { status: 'none', attempts });
    }
  }
  return next;
}

/**
 * La tanda no se pudo pedir. `retryable`: la red, un 429 o un 5xx, que pasan; lo demás (un 400, la
 * sesión vencida) no se arregla insistiendo y deja el marcador.
 */
export function failPhotoBatch(
  states: PhotoStates,
  batch: readonly PhotoTarget[],
  nowMs: number,
  retryable: boolean,
  retryAfterMs?: number,
): Map<string, PhotoState> {
  const next = new Map(states);
  const retryAt = nowMs + clampPhotoRetry(retryAfterMs);
  for (const t of batch) {
    if (settled(states, t.key)) continue;
    const attempts = states.get(t.key)?.attempts ?? 1;
    next.set(t.key, retryable ? pendingOrNone(attempts, retryAt) : { status: 'none', attempts });
  }
  return next;
}

/** Cuándo hay que despertarse a reintentar, o `undefined` si no queda nada en espera. */
export function nextPhotoWakeUp(states: PhotoStates): number | undefined {
  let at: number | undefined;
  for (const s of states.values()) {
    if (s.status === 'pending' && s.retryAt !== undefined) {
      at = at === undefined ? s.retryAt : Math.min(at, s.retryAt);
    }
  }
  return at;
}

/** Si una respuesta HTTP de la tanda vale un reintento. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// ───────────────────────── El pedido ─────────────────────────

export const PHOTO_BATCH_ENDPOINT = '/api/hotels/content/batch';

export type PhotoBatchOutcome =
  | { readonly ok: true; readonly reply: PhotoBatchReply }
  | { readonly ok: false; readonly retryable: boolean; readonly retryAfterMs?: number };

/** `Retry-After` en segundos, si vino y es un número. */
function retryAfterHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null || !/^\d{1,4}$/.test(raw.trim())) return undefined;
  return Number(raw.trim()) * 1_000;
}

/**
 * Pide una tanda al route handler del panel. Nunca lanza: una red caída o un corte por `signal` es
 * un fallo pasajero; una respuesta sin la forma esperada, uno que no se arregla insistiendo.
 */
export async function requestPhotoBatch(
  batch: readonly PhotoTarget[],
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PhotoBatchOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(PHOTO_BATCH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(photoBatchBody(batch)),
      cache: 'no-store',
      signal,
    });
  } catch {
    return { ok: false, retryable: true };
  }
  if (!res.ok) {
    const retryAfterMs = retryAfterHeader(res);
    return {
      ok: false,
      retryable: isRetryableStatus(res.status),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, retryable: false };
  }
  const reply = parsePhotoBatchReply(body);
  return reply === undefined ? { ok: false, retryable: false } : { ok: true, reply };
}
