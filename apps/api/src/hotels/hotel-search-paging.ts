import type { HotelProviderOutcome } from './hotel-search.aggregate.js';

/*
 * Carga por tramos de la búsqueda de hoteles por destino (pedido del founder del 2026-09-30: "no
 * veo más páginas para seguir"). Lo que se decide sin I/O: qué códigos van en el tramo siguiente
 * de cada proveedor, cuándo avanza su cursor y qué le dice la respuesta a la web.
 *
 * Una búsqueda por destino le pedía a cada proveedor sólo los primeros `maxHotelsPerSearch` códigos
 * de su catálogo (100 en TBO, el tope de su Search): en Cartagena, con cientos de hoteles, el
 * vendedor veía los que salían de esos 100 y nada le decía que había más. Ahora la búsqueda guarda,
 * en el servidor, los códigos del destino en el orden del catálogo, y cada "Ver más hoteles" le
 * pide a cada proveedor su tramo siguiente: un Search más por tramo, por el mismo circuito y el
 * mismo limitador que la búsqueda, con la misma estadía, ocupación, moneda y nacionalidad
 * (docs/tbo/02 §4.4).
 */

/**
 * Tramos por búsqueda, contando el primero. Es también el tope de códigos que se guardan de cada
 * proveedor (`maxHotelsPerSearch × 20`: 2.000 en TBO): cada tramo es un Search que el proveedor
 * cobra y que cuenta en la cuota de la agencia, y pasados 20 lo útil es afinar el destino.
 */
export const HOTEL_SEARCH_MAX_PAGES = 20;

/**
 * El número de tramo más alto que se acepta. No es {@link HOTEL_SEARCH_MAX_PAGES}: un tramo en el
 * que un proveedor falló se le vuelve a pedir en el siguiente "Ver más", así que puede haber más
 * pedidos que tramos. Lo que acota el gasto es el tope de códigos y la cuota de la agencia.
 */
export const HOTEL_SEARCH_MAX_PAGE_NUMBER = 999;

/**
 * Cuánto se puede seguir cargando después del primer tramo. Algo más que la ventana de las tarifas
 * de TBO (27 min, RF-09): pasado eso la pantalla ya pide buscar de nuevo.
 */
export const HOTEL_SEARCH_PAGING_TTL_MS = 30 * 60_000;

/**
 * Lo mínimo que le tiene que quedar a la búsqueda para empezar un tramo. Un Search de TBO tarda
 * hasta 13 s más la espera del limitador: un tramo que empieza con menos que esto terminaría con
 * la búsqueda ya vencida, gastaría una consulta y la cuota, y la pantalla no sabría ofrecer
 * "Buscar de nuevo". Se rechaza antes, como vencida.
 */
export const HOTEL_SEARCH_PAGING_MIN_LEFT_MS = 2 * 60_000;

/**
 * Cuánto se puede volver a pedir el ÚLTIMO tramo cargado sin consultar a nadie: la respuesta que
 * se cortó en el camino (la red del teléfono de un vendedor en ruta) se repite tal cual, sin otro
 * Search y sin gastar cuota. Pasado esto, el mismo pedido es `SEARCH_PAGE_NOT_NEXT`.
 */
export const HOTEL_SEARCH_PAGE_REPLAY_MS = 2 * 60_000;

/**
 * Tramos recientes que se pueden repetir sin consultar a nadie, como mucho: uno por búsqueda que
 * cargó más en los últimos {@link HOTEL_SEARCH_PAGE_REPLAY_MS}. Llegado el techo se olvidan los más
 * viejos ya respondidos (uno en vuelo nunca).
 */
export const HOTEL_SEARCH_MAX_RECENT_PAGES = 50;

/**
 * Lo que la respuesta le dice a la web de la carga por tramos. Sólo en las búsquedas por destino:
 * una por IDs escritos a mano no tiene tramos.
 */
export interface HotelSearchPaging {
  /** Con qué pedir el tramo siguiente. Ausente si no queda ninguno. */
  readonly sessionId?: string;
  /** El tramo que trae esta respuesta, base 0. */
  readonly page: number;
  /** Códigos del catálogo del destino ya consultados, sumando proveedores. */
  readonly consulted: number;
  /** Hoteles activos del catálogo del destino, sumando proveedores. Puede pasar el tope de tramos. */
  readonly total: number;
  readonly hasMore: boolean;
  /** Cuántos códigos consulta el tramo siguiente, como mínimo. Sólo con `hasMore`. */
  readonly nextBatch?: number;
}

/** Por dónde va UN proveedor en una búsqueda por tramos. */
export interface HotelPagingCursor {
  readonly code: string;
  /** Sus códigos del destino en el orden del catálogo, hasta {@link catalogCapOf}. */
  readonly hotelIds: readonly string[];
  /** Hoteles activos del destino en su catálogo, aunque pasen el tope. */
  readonly catalogTotal: number;
  /** Cuántos de `hotelIds` ya se consultaron: siempre los primeros. */
  readonly consulted: number;
  /** De a cuántos se le pregunta: su `maxHotelsPerSearch`. */
  readonly pageSize: number;
  /** De respaldo (`callPolicy: 'fallback'`): sólo sale si los demás traen poco. */
  readonly fallback?: true;
  /** No se le pregunta más en esta búsqueda: cotiza en otra moneda o dejó de estar activo. */
  readonly stopped?: true;
}

/** Cuántos códigos de un proveedor se guardan para los tramos. */
export function catalogCapOf(pageSize: number): number {
  return pageSize * HOTEL_SEARCH_MAX_PAGES;
}

/** Los códigos del tramo siguiente del proveedor; vacío si no le queda nada. */
export function nextSliceOf(cursor: HotelPagingCursor): string[] {
  if (cursor.stopped === true) return [];
  return cursor.hotelIds.slice(cursor.consulted, cursor.consulted + cursor.pageSize);
}

export function cursorHasMore(cursor: HotelPagingCursor): boolean {
  return nextSliceOf(cursor).length > 0;
}

/**
 * Qué hace un tramo con el cursor de un proveedor, según su parte en la respuesta.
 *
 * - `advance`: respondió, con o sin hoteles, entero o en parte. Esos códigos no se vuelven a pedir.
 * - `retry`: falló o, por ser de respaldo, no hizo falta. El mismo tramo sale en el siguiente
 *   "Ver más": que falle una vez no deja esos hoteles fuera para siempre.
 * - `stop`: respondió en otra moneda (los tramos siguientes vendrían igual) o dejó de estar activo
 *   para la agencia. No se le pregunta más en esta búsqueda.
 */
export type HotelTramoResult = 'advance' | 'retry' | 'stop';

export function tramoResultOf(outcome: HotelProviderOutcome | undefined): HotelTramoResult {
  if (outcome === undefined) return 'retry';
  switch (outcome.status) {
    case 'ok':
    case 'empty':
      return 'advance';
    case 'error':
      return 'retry';
    case 'unavailable':
      return 'stop';
    case 'skipped':
      if (outcome.skipReason === 'currency-mismatch') return 'stop';
      if (outcome.skipReason === 'fallback-not-needed') return 'retry';
      return 'stop';
  }
}

/** El cursor después de un tramo en el que se le pidieron `asked` códigos. */
export function advanceCursor(
  cursor: HotelPagingCursor,
  asked: number,
  result: HotelTramoResult,
): HotelPagingCursor {
  if (result === 'retry') return cursor;
  const consulted = Math.min(cursor.hotelIds.length, cursor.consulted + asked);
  if (result === 'advance') return { ...cursor, consulted };
  // Un proveedor que respondió en otra moneda sí consultó esos códigos; uno que dejó de estar
  // activo, no (`asked` es 0).
  return { ...cursor, consulted, stopped: true };
}

/**
 * Lo que ve la web. `total` es el catálogo entero aunque pase el tope: "Consultamos 2.000 de 3.400"
 * dice la verdad, y sin `hasMore` la pantalla explica que no se puede seguir en esta búsqueda.
 */
export function pagingSummary(
  cursors: readonly HotelPagingCursor[],
  page: number,
  sessionId: string | undefined,
): HotelSearchPaging {
  const consulted = cursors.reduce((n, c) => n + c.consulted, 0);
  const total = cursors.reduce((n, c) => n + Math.max(c.catalogTotal, c.consulted), 0);
  const primaries = cursors.filter((c) => c.fallback !== true && cursorHasMore(c));
  const pending = primaries.length > 0 ? primaries : cursors.filter(cursorHasMore);
  const nextBatch = pending.reduce((n, c) => n + nextSliceOf(c).length, 0);
  if (nextBatch === 0 || sessionId === undefined) {
    return { page, consulted, total, hasMore: false };
  }
  return { sessionId, page, consulted, total, hasMore: true, nextBatch };
}
