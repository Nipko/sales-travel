import { describe, expect, it } from 'vitest';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import {
  HOTEL_SEARCH_MAX_PAGES,
  advanceCursor,
  catalogCapOf,
  cursorHasMore,
  nextSliceOf,
  pagingSummary,
  tramoResultOf,
  type HotelPagingCursor,
} from './hotel-search-paging.js';

/*
 * Las reglas de la carga por tramos, sin I/O (docs/tbo/02 §4.4): qué códigos van en el tramo
 * siguiente, cuándo avanza el cursor de cada proveedor y qué ve la web.
 */

const codigos = (n: number, desde = 0): string[] =>
  Array.from({ length: n }, (_, i) => String(1000 + desde + i));

function cursor(extra: Partial<HotelPagingCursor> = {}): HotelPagingCursor {
  return {
    code: 'tbo-hotels',
    hotelIds: codigos(250),
    catalogTotal: 250,
    consulted: 0,
    pageSize: 100,
    ...extra,
  };
}

const parte = (extra: Partial<HotelProviderOutcome>): HotelProviderOutcome => ({
  code: 'tbo-hotels',
  status: 'ok',
  count: 3,
  ...extra,
});

describe('tramos — el tope', () => {
  it('se guardan los códigos de 20 tramos: 2.000 en TBO, 1.000 en Despegar', () => {
    expect(HOTEL_SEARCH_MAX_PAGES).toBe(20);
    expect(catalogCapOf(100)).toBe(2_000);
    expect(catalogCapOf(50)).toBe(1_000);
  });
});

describe('tramos — el siguiente de cada proveedor', () => {
  it('son los códigos que siguen a los consultados, de a `pageSize`, en el orden del catálogo', () => {
    expect(nextSliceOf(cursor())).toEqual(codigos(100));
    expect(nextSliceOf(cursor({ consulted: 100 }))).toEqual(codigos(100, 100));
    expect(nextSliceOf(cursor({ consulted: 200 }))).toEqual(codigos(50, 200));
  });

  it('sin códigos por consultar, o detenido, no hay tramo', () => {
    expect(nextSliceOf(cursor({ consulted: 250 }))).toEqual([]);
    expect(cursorHasMore(cursor({ consulted: 250 }))).toBe(false);
    expect(nextSliceOf(cursor({ stopped: true }))).toEqual([]);
    expect(cursorHasMore(cursor({ stopped: true }))).toBe(false);
  });
});

describe('tramos — qué hace cada respuesta con el cursor', () => {
  it.each([
    ['ok', parte({}), 'advance'],
    ['ok en parte', parte({ partial: true, reason: 'faltó un lote' }), 'advance'],
    ['empty (201: sin cupo en esos hoteles)', parte({ status: 'empty', count: 0 }), 'advance'],
    ['error: se reintenta en el siguiente', parte({ status: 'error', count: 0 }), 'retry'],
    [
      'de respaldo que no hizo falta: se le pide después',
      parte({ status: 'skipped', count: 0, skipReason: 'fallback-not-needed' }),
      'retry',
    ],
    [
      'en otra moneda: los siguientes vendrían igual',
      parte({ status: 'skipped', count: 0, skipReason: 'currency-mismatch' }),
      'stop',
    ],
    [
      'apagado para la agencia desde el primer tramo',
      parte({ status: 'skipped', count: 0, skipReason: 'platform-disabled' }),
      'stop',
    ],
    [
      'sin cuenta desde el primer tramo',
      parte({ status: 'unavailable', count: 0, unavailableReason: 'no-credentials' }),
      'stop',
    ],
  ] as const)('%s → %s', (_caso, outcome, esperado) => {
    expect(tramoResultOf(outcome)).toBe(esperado);
  });

  it('sin parte (no se le preguntó) → se reintenta', () => {
    expect(tramoResultOf(undefined)).toBe('retry');
  });

  it('`advance` suma lo pedido, sin pasarse de los códigos guardados', () => {
    expect(advanceCursor(cursor(), 100, 'advance').consulted).toBe(100);
    expect(advanceCursor(cursor({ consulted: 200 }), 100, 'advance').consulted).toBe(250);
  });

  it('`retry` deja el cursor como estaba: esos hoteles salen en el siguiente "Ver más"', () => {
    const antes = cursor({ consulted: 100 });
    expect(advanceCursor(antes, 100, 'retry')).toBe(antes);
  });

  it('`stop` cuenta lo que sí se consultó y no le pide más', () => {
    const tras = advanceCursor(cursor(), 100, 'stop');
    expect(tras).toMatchObject({ consulted: 100, stopped: true });
    expect(cursorHasMore(tras)).toBe(false);
    expect(advanceCursor(cursor({ consulted: 100 }), 0, 'stop')).toMatchObject({
      consulted: 100,
      stopped: true,
    });
  });
});

describe('tramos — lo que ve la web', () => {
  const SESION = '5b0e8d1c-2a4f-4c6e-9b7a-0d3e1f2a4b6c';

  it('"Consultamos 100 de 250" y cuántos trae el siguiente', () => {
    expect(pagingSummary([cursor({ consulted: 100 })], 0, SESION)).toEqual({
      sessionId: SESION,
      page: 0,
      consulted: 100,
      total: 250,
      hasMore: true,
      nextBatch: 100,
    });
    expect(pagingSummary([cursor({ consulted: 200 })], 1, SESION)).toMatchObject({
      nextBatch: 50,
    });
  });

  it('sin nada por consultar no hay `sessionId` ni `nextBatch`', () => {
    expect(pagingSummary([cursor({ consulted: 250 })], 2, SESION)).toEqual({
      page: 2,
      consulted: 250,
      total: 250,
      hasMore: false,
    });
  });

  it('sin búsqueda guardada tampoco se ofrece seguir, aunque queden códigos', () => {
    expect(pagingSummary([cursor({ consulted: 100 })], 0, undefined)).toEqual({
      page: 0,
      consulted: 100,
      total: 250,
      hasMore: false,
    });
  });

  it('suma los proveedores; el total es el catálogo entero aunque pase el tope', () => {
    const tbo = cursor({ consulted: 100, catalogTotal: 3_400, hotelIds: codigos(2_000) });
    const despegar = cursor({
      code: 'despegar-hotels',
      consulted: 50,
      pageSize: 50,
      catalogTotal: 80,
      hotelIds: codigos(80),
    });
    expect(pagingSummary([tbo, despegar], 0, SESION)).toMatchObject({
      consulted: 150,
      total: 3_480,
      nextBatch: 130,
    });
  });

  it('`nextBatch` cuenta primero los que siempre salen; el de respaldo, cuando ya no quedan', () => {
    const principal = cursor({ consulted: 100 });
    const respaldo = cursor({ code: 'respaldo', fallback: true, consulted: 0 });
    expect(pagingSummary([principal, respaldo], 0, SESION).nextBatch).toBe(100);
    expect(pagingSummary([cursor({ consulted: 250 }), respaldo], 2, SESION).nextBatch).toBe(100);
  });

  it('un proveedor detenido no se ofrece: "100 de 250" sin seguir', () => {
    expect(pagingSummary([cursor({ consulted: 100, stopped: true })], 0, SESION)).toEqual({
      page: 0,
      consulted: 100,
      total: 250,
      hasMore: false,
    });
  });
});
