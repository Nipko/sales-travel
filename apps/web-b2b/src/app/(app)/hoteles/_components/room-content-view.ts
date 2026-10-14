import { isProxyImagePath } from './hotel-photos';
import { normalizeRoomName } from './room-type-groups';

/*
 * El contenido de cada habitación de un hotel (`GET /hotels/content/:proveedor/:hotel/rooms`,
 * TBO-06) del lado de la pantalla, sin React: lectura defensiva de la respuesta y los textos que se
 * pintan con ella.
 *
 * El API ya valida al guardar y al servir; aquí se vuelve a comprobar, porque la pantalla no puede
 * depender de que un API de otra versión lo haga. Las fotos sólo entran como rutas del proxy propio
 * (`/api/hotels/images/…`, la única forma que acepta `next/image`) y los textos son texto plano que
 * React escapa al pintar. Una respuesta que no se entiende es `none`: las fotos de las habitaciones
 * acompañan a la venta y nunca rompen la ficha ni la tarjeta.
 */

/** Los proveedores que dan contenido por habitación (`HotelRoomContentPort` en el API). */
export const ROOM_CONTENT_PROVIDERS: ReadonlySet<string> = new Set(['tbo-hotels']);

/** Techos de la pantalla: los mismos del API, para que una respuesta rota no infle la página. */
export const ROOM_CONTENT_MAX_ROOMS = 100;
export const ROOM_CONTENT_MAX_IMAGES = 30;
const MAX_NAME = 300;
const MAX_SIZE_TEXT = 60;
const MAX_DESCRIPTION = 4_000;

/** Superficie aceptada, en m²: la misma ventana del API (`roomSizeM2`). */
const MIN_M2 = 5;
const MAX_M2 = 500;

/** Espera antes de volver a preguntar por un `pending`: ni un bucle ni más de lo que vale esperar. */
export const ROOM_CONTENT_RETRY_DEFAULT_MS = 3_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 10_000;

const ROOM_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * - `ready`: hay habitaciones con contenido.
 * - `none`: nada que mostrar; la tarjeta queda como antes.
 * - `pending`: el API lo está trayendo del proveedor: volver a preguntar a los `retryAfterMs`.
 * - `disabled`: el interruptor del API está apagado y el catálogo no tiene nada.
 */
export type RoomContentStatus = 'ready' | 'none' | 'pending' | 'disabled';

/** Una habitación del catálogo del proveedor, ya verificada. */
export interface RoomContent {
  /** Su identidad en el hotel (el id del proveedor o `n-…`). */
  readonly roomKey: string;
  /** El id del proveedor, el mismo `roomTypeId` de la tarifa; `null` si no lo mandó. */
  readonly roomId: string | null;
  /** El nombre normalizado como `normalizeRoomName`; `null` sin nombre. */
  readonly nameKey: string | null;
  readonly name: string | null;
  /** Tal como lo manda el proveedor (`"1830 ft"`). */
  readonly sizeText: string | null;
  readonly sizeM2: number | null;
  /** Texto plano. */
  readonly description: string | null;
  /** Rutas del proxy propio, sin repetir. */
  readonly images: readonly string[];
}

/** Lo que hay de las habitaciones de UN hotel en UN proveedor. */
export interface RoomContentResult {
  readonly status: RoomContentStatus;
  /** Sólo con `pending`. */
  readonly retryAfterMs?: number;
  readonly rooms: readonly RoomContent[];
}

/** Las habitaciones de cada proveedor del hotel que da contenido, por código de proveedor. */
export interface RoomContentReply {
  readonly byProvider: Readonly<Record<string, RoomContentResult>>;
}

/**
 * Lo que la pantalla sabe de las habitaciones de un hotel: nada que pedir (`idle`: ningún proveedor
 * del hotel da contenido), pidiéndolo, o la respuesta (que todavía puede traer algo `pending`).
 */
export type RoomContentState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly reply: RoomContentReply };

const NO_ROOMS: readonly RoomContent[] = Object.freeze([]);

export const ROOM_CONTENT_NONE: RoomContentResult = Object.freeze({
  status: 'none',
  rooms: NO_ROOMS,
});

const STATUSES: ReadonlySet<string> = new Set(['ready', 'none', 'pending', 'disabled']);

function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length === 0 || text.length > max ? null : text;
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && ROOM_KEY.test(value) && value !== '0' ? value : null;
}

/** El tiempo de espera de un `pending`, acotado; sin dato, el del API. */
export function clampRoomContentRetry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ROOM_CONTENT_RETRY_DEFAULT_MS;
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.round(value)));
}

function imagesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const src of value as unknown[]) {
    if (out.size >= ROOM_CONTENT_MAX_IMAGES) break;
    if (isProxyImagePath(src)) out.add(src);
  }
  return [...out];
}

function roomOf(raw: unknown): RoomContent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const roomKey = idOf(r.roomKey);
  if (roomKey === null) return undefined;
  const name = textOf(r.name, MAX_NAME);
  // La clave se vuelve a normalizar: es la que se compara con la de la tarifa, y si el API no la
  // mandó pero sí el nombre, sale del nombre con la misma regla.
  const rawKey = textOf(r.nameKey, MAX_NAME) ?? name;
  const nameKey = rawKey === null ? '' : normalizeRoomName(rawKey);
  const description = textOf(r.description, MAX_DESCRIPTION);
  const sizeM2 =
    typeof r.sizeM2 === 'number' &&
    Number.isFinite(r.sizeM2) &&
    r.sizeM2 >= MIN_M2 &&
    r.sizeM2 <= MAX_M2
      ? r.sizeM2
      : null;
  return {
    roomKey,
    roomId: idOf(r.roomId),
    nameKey: nameKey.length === 0 ? null : nameKey,
    name,
    sizeText: textOf(r.sizeText, MAX_SIZE_TEXT),
    sizeM2,
    // Texto plano: algo con marcas no es una descripción que se pueda mostrar tal cual.
    description: description !== null && /[<>]/.test(description) ? null : description,
    images: imagesOf(r.images),
  };
}

/**
 * La respuesta del API para un hotel, verificada. Nunca lanza: lo que no tiene la forma esperada es
 * `none`. Las habitaciones que no se pueden leer se descartan una a una, y un `ready` que se queda
 * sin ninguna también es `none`.
 */
export function parseRoomContent(raw: unknown): RoomContentResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ROOM_CONTENT_NONE;
  const body = raw as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : '';
  if (!STATUSES.has(status)) return ROOM_CONTENT_NONE;
  if (status === 'pending') {
    return { status, retryAfterMs: clampRoomContentRetry(body.retryAfterMs), rooms: [] };
  }
  if (status !== 'ready') return { status: status as RoomContentStatus, rooms: [] };
  if (!Array.isArray(body.rooms)) return ROOM_CONTENT_NONE;
  const rooms: RoomContent[] = [];
  const keys = new Set<string>();
  for (const item of (body.rooms as unknown[]).slice(0, ROOM_CONTENT_MAX_ROOMS)) {
    const room = roomOf(item);
    if (room === undefined || keys.has(room.roomKey)) continue;
    keys.add(room.roomKey);
    rooms.push(room);
  }
  return rooms.length === 0 ? ROOM_CONTENT_NONE : { status: 'ready', rooms };
}

/**
 * La respuesta de la ruta del panel (`GET /api/hotels/rooms/<clave>`), que ya viene verificada por
 * {@link parseRoomContent} en el servidor; aquí se vuelve a pasar por el mismo lector. Sólo
 * proveedores que dan contenido: cualquier otra clave no se usa.
 */
export function parseRoomContentReply(raw: unknown): RoomContentReply | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const byProvider = (raw as { byProvider?: unknown }).byProvider;
  if (typeof byProvider !== 'object' || byProvider === null || Array.isArray(byProvider)) {
    return undefined;
  }
  const out: Record<string, RoomContentResult> = {};
  for (const code of ROOM_CONTENT_PROVIDERS) {
    if (Object.prototype.hasOwnProperty.call(byProvider, code)) {
      out[code] = parseRoomContent((byProvider as Record<string, unknown>)[code]);
    }
  }
  return { byProvider: out };
}

/** Algún proveedor sigue trayendo sus habitaciones. */
export function hasPendingRoomContent(reply: RoomContentReply): boolean {
  return Object.values(reply.byProvider).some((r) => r.status === 'pending');
}

/** Lo `pending` que ya no se va a volver a pedir queda como `none`: sin esqueleto para siempre. */
export function settlePendingRoomContent(reply: RoomContentReply): RoomContentReply {
  if (!hasPendingRoomContent(reply)) return reply;
  const out: Record<string, RoomContentResult> = {};
  for (const [code, result] of Object.entries(reply.byProvider)) {
    out[code] = result.status === 'pending' ? ROOM_CONTENT_NONE : result;
  }
  return { byProvider: out };
}

const M2 = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });

/**
 * El tamaño para la línea de la habitación: «≈ 25 m²» si se pudo leer en m²; si no, el texto del
 * proveedor tal cual; sin ninguno, nada.
 */
export function roomSizeLabel(room: Pick<RoomContent, 'sizeM2' | 'sizeText'>): string | undefined {
  if (room.sizeM2 !== null) return `≈ ${M2.format(room.sizeM2)} m²`;
  return room.sizeText ?? undefined;
}

/** «Ver la foto de …» o «Ver 6 fotos de …»: lo que dice el botón de la miniatura. */
export function roomPhotosLabel(count: number, name: string): string {
  return count === 1 ? `Ver la foto de ${name}` : `Ver ${count} fotos de ${name}`;
}

/** La explicación de «Foto de referencia» (D-TBO-H2). */
export const REFERENCE_PHOTO_NOTE =
  'Es la foto de una habitación con el mismo nombre en el catálogo del proveedor.';

/**
 * Desde cuántos caracteres una descripción probablemente no entra en dos líneas: es lo que decide
 * «Ver más» en el primer pintado, antes de poder medir.
 */
export const ROOM_DESCRIPTION_CLAMP_CHARS = 140;
