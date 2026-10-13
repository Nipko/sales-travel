'use client';

import { useEffect, useState } from 'react';
import { decodeHotelKey } from './hotel-key';
import {
  ROOM_CONTENT_PROVIDERS,
  hasPendingRoomContent,
  parseRoomContentReply,
  settlePendingRoomContent,
  type RoomContentReply,
  type RoomContentState,
} from './room-content-view';

/*
 * Las fotos, el tamaño y la descripción de las habitaciones de un hotel (TBO-07), pedidos en
 * segundo plano a `GET /api/hotels/rooms/<clave>` (una ruta, no una acción del servidor: ver
 * app/api/hotels/rooms/hotel-rooms-proxy.ts). En la ficha se piden junto con las tarifas; en la
 * tarjeta de resultados, sólo al desplegarla. Nada de esto frena las tarifas.
 *
 * Lo que el API todavía está trayendo del proveedor vuelve `pending`: se vuelve a preguntar a los
 * `retryAfterMs`, hasta {@link ROOM_CONTENT_MAX_RETRIES} veces, y después queda sin fotos. Lo que
 * llegó con contenido (`ready` en todos los proveedores) se recuerda por hotel mientras dura la
 * pestaña: volver a desplegar una tarjeta o abrir otra vez la ficha no vuelve a preguntar.
 *
 * Un `none` o un `disabled` NO se recuerdan. La ruta del panel convierte cualquier error del API
 * (un 429 del tope por vendedor, un 503 durante un despliegue, la sesión vencida) en `none`, y el
 * API mismo dice `none` cuando el proveedor falló hace un momento; `disabled` cambia cuando se
 * enciende el interruptor. Recordarlos dejaba el hotel sin fotos hasta recargar la pestaña. Volver
 * a preguntar es barato: el API responde del catálogo y acota él solo las llamadas al proveedor.
 */

export const ROOM_CONTENT_ENDPOINT = '/api/hotels/rooms/';
/** Reintentos de un `pending`, sin contar el primer pedido. */
export const ROOM_CONTENT_MAX_RETRIES = 3;
/** Hoteles recordados en la pestaña; el más viejo sale primero. */
export const ROOM_CONTENT_CACHE_MAX = 60;

/** El panel está en español; el API responde el inglés como respaldo. */
const LANG = 'es';

const IDLE: RoomContentState = Object.freeze({ status: 'idle' });
const LOADING: RoomContentState = Object.freeze({ status: 'loading' });
const EMPTY: RoomContentReply = Object.freeze({ byProvider: Object.freeze({}) });

const remembered = new Map<string, RoomContentReply>();

/** Lo recordado de un hotel, si lo hay (y queda como el más reciente). */
export function rememberedRoomContent(hotelKey: string): RoomContentReply | undefined {
  const hit = remembered.get(hotelKey);
  if (hit === undefined) return undefined;
  remembered.delete(hotelKey);
  remembered.set(hotelKey, hit);
  return hit;
}

/**
 * Lo que vale recordar: hay al menos un proveedor y todos trajeron contenido. Un `pending`, un
 * `none` (que puede ser un error de paso) o un `disabled` se vuelven a preguntar.
 */
export function isRememberableRoomContent(reply: RoomContentReply): boolean {
  const results = Object.values(reply.byProvider);
  return results.length > 0 && results.every((r) => r.status === 'ready');
}

/** Recuerda la respuesta de un hotel, sólo si todos sus proveedores trajeron contenido. */
export function rememberRoomContent(hotelKey: string, reply: RoomContentReply): void {
  if (!isRememberableRoomContent(reply)) return;
  remembered.delete(hotelKey);
  remembered.set(hotelKey, reply);
  for (const key of remembered.keys()) {
    if (remembered.size <= ROOM_CONTENT_CACHE_MAX) break;
    remembered.delete(key);
  }
}

/** Algún proveedor del hotel da contenido por habitación: si no, no hay nada que pedir. */
export function wantsRoomContent(hotelKey: string | undefined): boolean {
  if (hotelKey === undefined) return false;
  return (decodeHotelKey(hotelKey) ?? []).some((ref) => ROOM_CONTENT_PROVIDERS.has(ref.provider));
}

/** Lo que se pinta antes de preguntar: lo recordado, si lo hay. */
export function initialRoomContentState(
  hotelKey: string | undefined,
  enabled: boolean,
): RoomContentState {
  if (!enabled || hotelKey === undefined || !wantsRoomContent(hotelKey)) return IDLE;
  const hit = rememberedRoomContent(hotelKey);
  return hit === undefined ? LOADING : { status: 'done', reply: hit };
}

/**
 * Un pedido a la ruta del panel. Nunca lanza: una red caída, un corte por `signal` o una respuesta
 * que no se entiende son `undefined`.
 */
export async function requestRoomContent(
  hotelKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<RoomContentReply | undefined> {
  try {
    const res = await fetchImpl(
      `${ROOM_CONTENT_ENDPOINT}${encodeURIComponent(hotelKey)}?lang=${LANG}`,
      { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal },
    );
    if (!res.ok) return undefined;
    return parseRoomContentReply(await res.json());
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const id = setTimeout(done, ms);
    function done() {
      clearTimeout(id);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Cuánto esperar antes de volver a preguntar: lo que pidió el proveedor más lento. */
function retryDelay(reply: RoomContentReply): number {
  return Math.max(0, ...Object.values(reply.byProvider).map((r) => r.retryAfterMs ?? 0));
}

export interface RoomContentLoad {
  readonly reply: RoomContentReply;
  /** Llegó todo; `false` si algo quedó `pending` (y se muestra sin fotos) o el pedido falló. */
  readonly complete: boolean;
}

export interface RoomContentDeps {
  readonly request?: (
    hotelKey: string,
    signal: AbortSignal,
  ) => Promise<RoomContentReply | undefined>;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly maxRetries?: number;
}

/**
 * Pide las habitaciones de un hotel y vuelve a preguntar mientras algo siga `pending`. Cada
 * respuesta intermedia sale por `onUpdate` (lo que ya llegó se muestra sin esperar al resto). Lo que
 * al final sigue `pending` queda `none`.
 */
export async function loadRoomContent(
  hotelKey: string,
  signal: AbortSignal,
  onUpdate: (reply: RoomContentReply) => void,
  deps: RoomContentDeps = {},
): Promise<RoomContentLoad> {
  const request = deps.request ?? requestRoomContent;
  const wait = deps.sleep ?? sleep;
  const maxRetries = deps.maxRetries ?? ROOM_CONTENT_MAX_RETRIES;

  let reply = await request(hotelKey, signal);
  if (reply === undefined) return { reply: EMPTY, complete: false };
  for (let retry = 0; retry < maxRetries && hasPendingRoomContent(reply); retry += 1) {
    onUpdate(reply);
    await wait(retryDelay(reply), signal);
    if (signal.aborted) break;
    const next = await request(hotelKey, signal);
    // Un reintento que falla no borra lo que ya llegó: termina con eso.
    if (next === undefined) break;
    reply = next;
  }
  const complete = !hasPendingRoomContent(reply);
  return { reply: settlePendingRoomContent(reply), complete };
}

/**
 * Las habitaciones del catálogo de un hotel. `enabled` en `false` no pide nada (la ficha sin
 * búsqueda no tiene tarifas a las que ponerles foto).
 */
export function useRoomContent(
  hotelKey: string | undefined,
  { enabled = true }: { readonly enabled?: boolean } = {},
): RoomContentState {
  const active = enabled && wantsRoomContent(hotelKey);
  const [state, setState] = useState<{ key: string | undefined; value: RoomContentState }>(() => ({
    key: hotelKey,
    value: initialRoomContentState(hotelKey, enabled),
  }));

  useEffect(() => {
    if (!active || hotelKey === undefined) return;
    const hit = rememberedRoomContent(hotelKey);
    if (hit !== undefined) {
      setState({ key: hotelKey, value: { status: 'done', reply: hit } });
      return;
    }
    const run = new AbortController();
    setState({ key: hotelKey, value: LOADING });
    const show = (reply: RoomContentReply) => {
      if (!run.signal.aborted) setState({ key: hotelKey, value: { status: 'done', reply } });
    };
    void loadRoomContent(hotelKey, run.signal, show).then(({ reply, complete }) => {
      if (run.signal.aborted) return;
      if (complete) rememberRoomContent(hotelKey, reply);
      show(reply);
    });
    return () => run.abort();
  }, [active, hotelKey]);

  if (!active) return IDLE;
  // Otro hotel, o recién encendido (la ficha leyó su búsqueda): lo de antes no vale para esto.
  return state.key === hotelKey && state.value.status !== 'idle'
    ? state.value
    : initialRoomContentState(hotelKey, enabled);
}
