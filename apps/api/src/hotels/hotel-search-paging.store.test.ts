import { ConflictException, HttpStatus, Logger } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { HOTEL_SEARCH_PAGING_TTL_MS } from './hotel-search-paging.js';
import {
  HOTEL_SEARCH_PAGING_MAX_ENTRIES,
  HotelSearchPageNotNextError,
  HotelSearchPagingExhaustedError,
  HotelSearchPagingExpiredError,
  HotelSearchPagingMemoryCache,
  HotelSearchPagingStore,
  type HotelSearchPagingSession,
} from './hotel-search-paging.store.js';

/**
 * Las búsquedas por tramos en el servidor (docs/tbo/02 §4.4), sobre el adapter REAL del
 * `CachePort` y con el reloj falso: lo que se prueba es el vencimiento y el aislamiento por tenant.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const SESION = '5b0e8d1c-2a4f-4c6e-9b7a-0d3e1f2a4b6c';
const T0 = Date.parse('2026-09-30T15:00:00Z');

function sesion(extra: Partial<HotelSearchPagingSession> = {}): HotelSearchPagingSession {
  return {
    tenantId: AGENCIA,
    sessionId: SESION,
    nextPage: 1,
    createdAt: T0,
    expiresAt: T0 + HOTEL_SEARCH_PAGING_TTL_MS,
    search: {
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      destinationId: 'tbo-hotels:150184',
      rooms: [{ adults: 2, childrenAges: [7] }],
      guestNationality: 'CO',
      currency: 'USD',
    },
    cursors: [
      {
        code: 'tbo-hotels',
        hotelIds: ['1120548', '1402689', '1500001'],
        catalogTotal: 3,
        consulted: 2,
        pageSize: 2,
      },
    ],
    ...extra,
  };
}

/** Como queda en la caché: los códigos de cada proveedor en un solo texto. */
function guardada(s: HotelSearchPagingSession): unknown {
  return { ...s, cursors: s.cursors.map((c) => ({ ...c, hotelIds: c.hotelIds.join(',') })) };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HotelSearchPagingStore', () => {
  it('lo guardado se lee igual, con la búsqueda y el cursor de cada proveedor', async () => {
    const store = new HotelSearchPagingStore(new MemoryCacheAdapter());
    expect(await store.save(sesion())).toBe(true);

    expect(await store.get(AGENCIA, SESION)).toEqual(sesion());
  });

  it('también con un destino de la plataforma (un número)', async () => {
    const store = new HotelSearchPagingStore(new MemoryCacheAdapter());
    const conCiudad = sesion({ search: { ...sesion().search, destinationId: 2345 } });
    expect(await store.save(conCiudad)).toBe(true);

    expect((await store.get(AGENCIA, SESION))?.search.destinationId).toBe(2345);
  });

  it('por tenant: el mismo `sessionId` desde otra agencia no existe', async () => {
    const store = new HotelSearchPagingStore(new MemoryCacheAdapter());
    await store.save(sesion());

    expect(await store.get(OTRA_AGENCIA, SESION)).toBeUndefined();
  });

  it('vence a los 30 minutos del primer tramo, y guardar otra vez no lo estira', async () => {
    const cache = new MemoryCacheAdapter();
    const set = vi.spyOn(cache, 'set');
    const store = new HotelSearchPagingStore(cache);
    await store.save(sesion());
    expect(set.mock.calls[0]?.[2]).toBe(30 * 60);

    vi.setSystemTime(T0 + 20 * 60_000);
    await store.save(sesion({ nextPage: 2 }));
    // Lo que queda, no otra media hora.
    expect(set.mock.calls[1]?.[2]).toBe(10 * 60);

    vi.setSystemTime(T0 + HOTEL_SEARCH_PAGING_TTL_MS);
    expect(await store.get(AGENCIA, SESION)).toBeUndefined();
  });

  it('una ya vencida no se guarda', async () => {
    const store = new HotelSearchPagingStore(new MemoryCacheAdapter());
    vi.setSystemTime(T0 + HOTEL_SEARCH_PAGING_TTL_MS + 1);

    expect(await store.save(sesion())).toBe(false);
  });

  it.each([
    ['un campo de más en la búsqueda', { search: { ...sesion().search, email: 'x@y.co' } }],
    [
      'un cursor que dice más consultados que códigos',
      { cursors: [{ ...sesion().cursors[0]!, consulted: 9 }] },
    ],
    ['vida de más de 30 minutos', { expiresAt: T0 + HOTEL_SEARCH_PAGING_TTL_MS + 1 }],
    ['una que vence antes de empezar', { expiresAt: T0 }],
    ['el mismo proveedor dos veces', { cursors: [sesion().cursors[0]!, sesion().cursors[0]!] }],
    ['sin proveedores', { cursors: [] }],
  ])('no guarda %s, y el log no cita valores', async (_caso, extra) => {
    const store = new HotelSearchPagingStore(new MemoryCacheAdapter());
    expect(await store.save(sesion(extra as Partial<HotelSearchPagingSession>))).toBe(false);

    expect(await store.get(AGENCIA, SESION)).toBeUndefined();
    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).toContain('hotels.search_paging.rejected');
    expect(logs).not.toContain('x@y.co');
    expect(logs).not.toContain('"CO"');
  });

  /** Una caché que no vence sola: el que decide el vencimiento es el reloj del almacén. */
  function cacheSinReloj(responder?: () => unknown): CachePort & { valores: Map<string, unknown> } {
    const valores = new Map<string, unknown>();
    return {
      valores,
      get: <T>(key: string) =>
        Promise.resolve((responder ? responder() : (valores.get(key) ?? null)) as T | null),
      set: (key, value) => {
        valores.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        valores.delete(key);
        return Promise.resolve();
      },
      invalidatePattern: () => Promise.resolve(),
    };
  }

  it('vencida aunque la caché todavía la devuelva: no existe y se borra', async () => {
    const cache = cacheSinReloj();
    const store = new HotelSearchPagingStore(cache);
    await store.save(sesion());

    vi.setSystemTime(T0 + HOTEL_SEARCH_PAGING_TTL_MS);
    expect(await store.get(AGENCIA, SESION)).toBeUndefined();
    expect(cache.valores.size).toBe(0);
  });

  it('segunda puerta: lo que haya bajo la clave tiene que ser de ese tenant y esa búsqueda', async () => {
    // Una caché que resolviera claves distintas al mismo valor.
    const store = new HotelSearchPagingStore(cacheSinReloj(() => guardada(sesion())));

    expect(await store.get(AGENCIA, '6c1f9e2d-3b5a-4d7e-8f90-1a2b3c4d5e6f')).toBeUndefined();
    expect(await store.get(OTRA_AGENCIA, SESION)).toBeUndefined();
    expect(await store.get(AGENCIA, SESION)).toEqual(sesion());
  });

  it('un registro ilegible en la caché no existe y se borra', async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set(`hotels:search-paging:${AGENCIA}:${SESION}`, { basura: true }, 60);
    const store = new HotelSearchPagingStore(cache);

    expect(await store.get(AGENCIA, SESION)).toBeUndefined();
    expect(await cache.get(`hotels:search-paging:${AGENCIA}:${SESION}`)).toBeNull();
  });

  it('guarda los códigos de cada proveedor en UN texto, no en miles de textos', async () => {
    const cache = cacheSinReloj();
    const store = new HotelSearchPagingStore(cache);
    await store.save(sesion());

    const [valor] = [...cache.valores.values()] as Array<{ cursors: Array<{ hotelIds: unknown }> }>;
    expect(valor?.cursors[0]?.hotelIds).toBe('1120548,1402689,1500001');
    expect(await store.get(AGENCIA, SESION)).toEqual(sesion());
  });

  it.each([
    [
      'un código con coma',
      { cursors: [{ ...sesion().cursors[0]!, hotelIds: ['11,20', '1402689'] }] },
    ],
    ['sin la moneda ya resuelta', { search: { ...sesion().search, currency: undefined } }],
  ])('tampoco guarda %s', async (_caso, extra) => {
    const store = new HotelSearchPagingStore(new MemoryCacheAdapter());
    expect(await store.save(sesion(extra as Partial<HotelSearchPagingSession>))).toBe(false);
  });

  it('un texto de códigos que no se abre bien no existe y se borra', async () => {
    const cache = cacheSinReloj();
    const store = new HotelSearchPagingStore(cache);
    await store.save(sesion());
    const [clave] = [...cache.valores.keys()];
    cache.valores.set(clave!, {
      ...(guardada(sesion()) as object),
      cursors: [{ ...sesion().cursors[0]!, hotelIds: '1120548,,1500001' }],
    });

    expect(await store.get(AGENCIA, SESION)).toBeUndefined();
    expect(cache.valores.size).toBe(0);
  });

  it(`la caché de los tramos tiene su propio techo de ${HOTEL_SEARCH_PAGING_MAX_ENTRIES} búsquedas`, async () => {
    const cache = new HotelSearchPagingMemoryCache();
    for (let i = 0; i < HOTEL_SEARCH_PAGING_MAX_ENTRIES + 1; i++) await cache.set(`k:${i}`, i, 60);

    const size = (cache as unknown as { store: Map<string, unknown> }).store.size;
    expect(size).toBeLessThanOrEqual(HOTEL_SEARCH_PAGING_MAX_ENTRIES);
    await expect(cache.get('k:0')).resolves.toBeNull();
    await expect(cache.get(`k:${HOTEL_SEARCH_PAGING_MAX_ENTRIES}`)).resolves.toBe(
      HOTEL_SEARCH_PAGING_MAX_ENTRIES,
    );
  });

  it('ids mal formados no llegan a la caché', async () => {
    const cache = new MemoryCacheAdapter();
    const get = vi.spyOn(cache, 'get');
    const store = new HotelSearchPagingStore(cache);

    expect(await store.get(AGENCIA, 'hotels:*')).toBeUndefined();
    expect(await store.get('no-es-uuid', SESION)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('rechazos de un tramo', () => {
  it('son 409 con motivo máquina, y el que no es el siguiente dice cuál sigue', () => {
    const vencida = new HotelSearchPagingExpiredError();
    const fuera = new HotelSearchPageNotNextError(3);
    const agotada = new HotelSearchPagingExhaustedError();

    for (const e of [vencida, fuera, agotada]) {
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getStatus()).toBe(HttpStatus.CONFLICT);
    }
    expect(vencida.reason).toBe('SEARCH_PAGING_EXPIRED');
    expect(fuera.reason).toBe('SEARCH_PAGE_NOT_NEXT');
    expect(fuera.publicDetails).toEqual({ nextPage: 3 });
    const paging = { sessionId: SESION, page: 2, consulted: 200, total: 420, hasMore: true };
    expect(new HotelSearchPageNotNextError(3, paging).publicDetails).toEqual({
      nextPage: 3,
      paging,
    });
    expect(agotada.reason).toBe('SEARCH_PAGING_EXHAUSTED');
    // En "tú": nada de voseo en lo que ve el vendedor.
    expect(vencida.message).toBe(
      'Esta búsqueda ya no está vigente. Vuelve a buscar para ver más hoteles.',
    );
    expect(new HotelSearchPagingExpiredError('Otro motivo.').reason).toBe('SEARCH_PAGING_EXPIRED');
  });
});
