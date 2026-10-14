import { Logger, NotFoundException } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import type { SearchContext } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HotelRoomContentOutcome } from '../database/database.types.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import {
  supportsHotelRoomContent,
  type HotelContentFetchOptions,
  type HotelContentLanguage,
  type HotelProviderRoomContent,
  type HotelRoomContentFetch,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import {
  fakeDespegarFactory,
  FakeDespegarHotelsAdapter,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import type {
  HotelCatalogStore,
  HotelRoomContentFetchState,
  HotelRoomContentRow,
  HotelRoomContentState,
  HotelRoomContentStoreResult,
} from './hotel-catalog.store.js';
import { HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS } from './hotel-content.service.js';
import { HOTEL_IMAGE_PROXY_PATH } from './hotel-image-proxy.js';
import { UnknownHotelProviderError } from './hotel-provider-errors.js';
import {
  parseHotelRoomContentSwitch,
  readHotelRoomContentSwitch,
  type HotelRoomContentSwitch,
} from './hotel-room-content.config.js';
import {
  HOTEL_ROOM_CONTENT_FAILED_TTL_S,
  HOTEL_ROOM_CONTENT_FETCH_TIMEOUT_MS,
  HOTEL_ROOM_CONTENT_RETRY_AFTER_MS,
  HOTEL_ROOM_CONTENT_TTL_MS,
  HotelRoomContentService,
  roomSizeM2,
  type HotelRoomContentView,
} from './hotel-room-content.service.js';

/**
 * Contenido por habitación bajo demanda (TBO-06; docs/tbo/05 §2.6.3). El catálogo es uno en memoria
 * que imita la función de 0070 (reemplaza el set de un idioma y anota qué respondió el proveedor);
 * el registry y el breaker son los REALES con el stub anónimo, al que se le pega un
 * `fetchHotelRoomContent` espiable; la caché es la de memoria. Contra Postgres, lo prueba
 * `hotel-room-content.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROVEEDOR = 'stub-hotels';
const HOTEL = '1000000';
const HOST = 'img.example';
const DAY_MS = 24 * 60 * 60 * 1_000;

function habitacion(
  n: number,
  extra: Partial<HotelProviderRoomContent> = {},
): HotelProviderRoomContent {
  return {
    roomKey: String(197_350 + n),
    roomRef: String(197_350 + n),
    nameKey: `deluxe room ${n}`,
    name: `Deluxe Room ${n}`,
    sizeText: '1830 ft',
    description: 'Vista al jardín; cama king',
    images: [`https://${HOST}/r/${n}.jpg`],
    ...extra,
  };
}

function proxy(url: string): string {
  return `${HOTEL_IMAGE_PROXY_PATH}${Buffer.from(url, 'utf8').toString('base64url')}`;
}

function key(hotelId: string, lang: HotelContentLanguage): string {
  return `${hotelId} ${lang}`;
}

/** Lo que haría `hotel_catalog_store_room_contents`, en memoria. */
class CatalogoEnMemoria {
  readonly enCatalogo = new Set<string>([HOTEL]);
  readonly fetches = new Map<string, HotelRoomContentFetchState>();
  readonly filas = new Map<string, HotelRoomContentRow[]>();
  readonly guardados: {
    hotelId: string;
    lang: HotelContentLanguage;
    outcome: HotelRoomContentOutcome;
    rooms: readonly HotelProviderRoomContent[];
  }[] = [];
  readonly lecturas: string[] = [];
  /** Habitaciones que la "base" rechaza. */
  rechazar: (room: HotelProviderRoomContent) => boolean = () => false;
  fallaGuardar: Error | undefined;

  /** Deja guardado lo que respondió el proveedor hace `haceMs`. */
  guardar(
    lang: HotelContentLanguage,
    outcome: HotelRoomContentOutcome,
    rooms: readonly HotelProviderRoomContent[] = [],
    haceMs = 0,
    hotelId = HOTEL,
  ): void {
    this.filas.set(
      key(hotelId, lang),
      rooms.map((r) => ({
        lang,
        roomKey: r.roomKey,
        roomRef: r.roomRef,
        nameKey: r.nameKey === '' ? null : r.nameKey,
        name: r.name === '' ? null : r.name,
        sizeText: r.sizeText,
        description: r.description,
        images: [...r.images],
      })),
    );
    this.fetches.set(key(hotelId, lang), {
      outcome,
      roomCount: rooms.length,
      fetchedAt: new Date(Date.now() - haceMs),
    });
  }

  roomContentState(
    _provider: string,
    hotelId: string,
    langs: readonly HotelContentLanguage[],
  ): Promise<HotelRoomContentState> {
    this.lecturas.push('state');
    const fetches = new Map<HotelContentLanguage, HotelRoomContentFetchState>();
    for (const lang of langs) {
      const f = this.fetches.get(key(hotelId, lang));
      if (f !== undefined) fetches.set(lang, f);
    }
    return Promise.resolve({ inCatalog: this.enCatalogo.has(hotelId), fetches });
  }

  roomContents(
    _provider: string,
    hotelId: string,
    langs: readonly HotelContentLanguage[],
  ): Promise<HotelRoomContentRow[]> {
    this.lecturas.push('rows');
    return Promise.resolve(langs.flatMap((lang) => this.filas.get(key(hotelId, lang)) ?? []));
  }

  storeRoomContents(
    _provider: string,
    hotelId: string,
    lang: HotelContentLanguage,
    outcome: HotelRoomContentOutcome,
    rooms: readonly HotelProviderRoomContent[],
  ): Promise<HotelRoomContentStoreResult> {
    this.guardados.push({ hotelId, lang, outcome, rooms });
    if (this.fallaGuardar !== undefined) return Promise.reject(this.fallaGuardar);
    const ok = rooms.filter((r) => !this.rechazar(r));
    this.guardar(
      lang,
      outcome === 'rooms' && ok.length === 0 ? 'unreadable' : outcome,
      ok,
      0,
      hotelId,
    );
    return Promise.resolve({ stored: ok.length, rejected: rooms.length - ok.length });
  }
}

type FetchRooms = Mock<
  (
    hotelId: string,
    lang: HotelContentLanguage,
    ctx: SearchContext,
    options: HotelContentFetchOptions,
  ) => Promise<HotelRoomContentFetch>
>;

/** Responde habitaciones en los idiomas de `con`; en los demás, el hotel sin contenido. */
function proveedor(
  con: Partial<Record<HotelContentLanguage, HotelProviderRoomContent[]>>,
): FetchRooms {
  return vi.fn((_hotelId: string, lang: HotelContentLanguage) => {
    const rooms = con[lang];
    return Promise.resolve<HotelRoomContentFetch>(
      rooms === undefined
        ? { lang, outcome: 'none', rooms: [] }
        : { lang, outcome: 'rooms', rooms },
    );
  });
}

interface Banco {
  service: HotelRoomContentService;
  catalogo: CatalogoEnMemoria;
  fetchRooms: FetchRooms;
  cache: CachePort;
  breaker: CircuitBreakerService;
  factory: StubHotelProviderFactory;
}

interface BancoOpts {
  fetchRooms?: FetchRooms;
  interruptor?: HotelRoomContentSwitch;
  flag?: boolean;
  /** Sin el puerto de habitaciones en el adapter. */
  sinPuerto?: boolean;
  cache?: CachePort;
  failResolveWith?: Error;
  imageHosts?: readonly string[];
}

function banco(opts: BancoOpts = {}): Banco {
  const fetchRooms = opts.fetchRooms ?? proveedor({ es: [habitacion(1), habitacion(2)] });
  const factory = new StubHotelProviderFactory({
    code: PROVEEDOR,
    callPolicy: 'opt-in',
    searchProfile: {
      idSpace: 'provider',
      contentFromCatalog: true,
      ...(opts.imageHosts === undefined ? { imageHosts: [HOST] } : { imageHosts: opts.imageHosts }),
    },
    ...(opts.failResolveWith === undefined ? {} : { failResolveWith: opts.failResolveWith }),
  });
  const adapter = factory.adapterFor(TENANT);
  if (opts.sinPuerto !== true) Object.assign(adapter, { fetchHotelRoomContent: fetchRooms });
  vi.spyOn(factory, 'adapterFor').mockReturnValue(adapter);

  const despegar = fakeDespegarFactory(new FakeDespegarHotelsAdapter());
  const registry = hotelRegistry(
    [despegar.factory, factory],
    hotelFlags((_tenant, code) => code === PROVEEDOR && (opts.flag ?? true)),
  );
  const catalogo = new CatalogoEnMemoria();
  const breaker = new CircuitBreakerService();
  const cache = opts.cache ?? new MemoryCacheAdapter();
  const service = new HotelRoomContentService(
    registry,
    catalogo as unknown as HotelCatalogStore,
    breaker,
    cache,
    opts.interruptor ?? 'on',
  );
  return { service, catalogo, fetchRooms, cache, breaker, factory };
}

function pedir(
  b: Banco,
  lang: HotelContentLanguage = 'es',
  providerCode = PROVEEDOR,
): Promise<HotelRoomContentView> {
  return b.service.getRoomContent(TENANT, { providerCode, hotelId: HOTEL, lang });
}

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('lo guardado y vigente sale sin llamar al proveedor', () => {
  it('habitaciones vigentes en el idioma pedido → `ready`, fotos por el proxy y tamaño en m²', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'rooms', [habitacion(1)], 29 * DAY_MS);

    const res = await pedir(b);

    expect(b.fetchRooms).not.toHaveBeenCalled();
    expect(res).toEqual({
      providerCode: PROVEEDOR,
      hotelId: HOTEL,
      requestedLang: 'es',
      lang: 'es',
      langFallback: false,
      status: 'ready',
      rooms: [
        {
          roomKey: '197351',
          roomId: '197351',
          nameKey: 'deluxe room 1',
          name: 'Deluxe Room 1',
          sizeText: '1830 ft',
          sizeM2: 170,
          description: 'Vista al jardín; cama king',
          images: [proxy(`https://${HOST}/r/1.jpg`)],
        },
      ],
    });
    // La URL del proveedor no sale tal cual: sólo la del proxy propio.
    expect(JSON.stringify(res)).not.toContain(`https://${HOST}`);
  });

  it('el pedido vigente sin habitaciones y el inglés vigente con habitaciones → el inglés, marcado', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'none', [], 6 * DAY_MS);
    b.catalogo.guardar('en', 'rooms', [habitacion(3)], DAY_MS);

    const res = await pedir(b);

    expect(b.fetchRooms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'ready', lang: 'en', langFallback: true });
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['197353']);
  });

  it('los dos idiomas vigentes sin habitaciones → `none`, sin llamar', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'none', [], 0);
    b.catalogo.guardar('en', 'unreadable', [], DAY_MS - 60_000);

    const res = await pedir(b);

    expect(b.fetchRooms).not.toHaveBeenCalled();
    expect(res).toEqual({
      providerCode: PROVEEDOR,
      hotelId: HOTEL,
      requestedLang: 'es',
      lang: null,
      langFallback: false,
      status: 'none',
      rooms: [],
    });
  });

  it('pedido en inglés: no hay respaldo que buscar', async () => {
    const b = banco();
    b.catalogo.guardar('en', 'none', [], 0);

    expect(await pedir(b, 'en')).toMatchObject({ status: 'none', lang: null });
    expect(b.fetchRooms).not.toHaveBeenCalled();
  });

  it('las vigencias: 30 días con habitaciones, 7 sin el hotel y 1 si no se pudo leer', () => {
    expect(HOTEL_ROOM_CONTENT_TTL_MS).toEqual({
      rooms: 30 * DAY_MS,
      none: 7 * DAY_MS,
      unreadable: DAY_MS,
    });
  });
});

describe('vencido o nunca pedido: se pide, se guarda y se responde', () => {
  it('nunca pedido: UNA llamada por el circuito, con su plazo, y se guarda el set', async () => {
    const b = banco();

    const res = await pedir(b);

    expect(b.fetchRooms).toHaveBeenCalledTimes(1);
    const [hotelId, lang, ctx, options] = b.fetchRooms.mock.calls[0] ?? [];
    expect([hotelId, lang, ctx]).toEqual([HOTEL, 'es', { tenantId: TENANT }]);
    expect(options?.timeoutMs).toBe(HOTEL_ROOM_CONTENT_FETCH_TIMEOUT_MS);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(b.catalogo.guardados).toEqual([
      { hotelId: HOTEL, lang: 'es', outcome: 'rooms', rooms: [habitacion(1), habitacion(2)] },
    ]);
    expect(res).toMatchObject({ status: 'ready', lang: 'es', langFallback: false });
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['197351', '197352']);
    expect(info).toHaveBeenCalledWith(
      `hotels.room_content.traido provider=${PROVEEDOR} lang=es outcome=rooms rooms=2 stored=2 rejected=0`,
    );
  });

  it('vencido (31 días): se vuelve a pedir y lo nuevo reemplaza a lo viejo', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'rooms', [habitacion(9)], 31 * DAY_MS);

    const res = await pedir(b);

    expect(b.fetchRooms).toHaveBeenCalledTimes(1);
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['197351', '197352']);
  });

  it('`unreadable` vence al día y `none` a la semana', async () => {
    const b = banco({ fetchRooms: proveedor({}) });
    b.catalogo.guardar('es', 'unreadable', [], DAY_MS + 1);
    b.catalogo.guardar('en', 'none', [], 7 * DAY_MS + 1);

    await pedir(b);

    expect(b.fetchRooms.mock.calls.map((c) => c[1])).toEqual(['es', 'en']);
  });

  it('CE-23: sin habitaciones en español se piden en inglés en la misma respuesta', async () => {
    const b = banco({ fetchRooms: proveedor({ en: [habitacion(5)] }) });

    const res = await pedir(b);

    expect(b.fetchRooms.mock.calls.map((c) => c[1])).toEqual(['es', 'en']);
    expect(b.catalogo.guardados.map((g) => [g.lang, g.outcome])).toEqual([
      ['es', 'none'],
      ['en', 'rooms'],
    ]);
    expect(res).toMatchObject({ status: 'ready', lang: 'en', langFallback: true });
  });

  it('con habitaciones en el idioma pedido, el inglés no se pide', async () => {
    const b = banco();
    await pedir(b, 'pt');
    // El stub sólo tiene `es`: en portugués responde sin el hotel y se pide el inglés.
    expect(b.fetchRooms.mock.calls.map((c) => c[1])).toEqual(['pt', 'en']);

    const c = banco({ fetchRooms: proveedor({ pt: [habitacion(1)] }) });
    await pedir(c, 'pt');
    expect(c.fetchRooms.mock.calls.map((call) => call[1])).toEqual(['pt']);
  });

  it('el pedido vigente sin habitaciones y el inglés vencido: sólo se pide el inglés', async () => {
    const b = banco({ fetchRooms: proveedor({ en: [habitacion(4)] }) });
    b.catalogo.guardar('es', 'none', [], DAY_MS);
    b.catalogo.guardar('en', 'rooms', [habitacion(8)], 40 * DAY_MS);

    const res = await pedir(b);

    expect(b.fetchRooms.mock.calls.map((c) => c[1])).toEqual(['en']);
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['197354']);
  });

  it('el pedido vencido con habitaciones y el inglés vigente: sólo se refresca el pedido', async () => {
    const b = banco({ fetchRooms: proveedor({}) });
    b.catalogo.guardar('es', 'rooms', [habitacion(1)], 31 * DAY_MS);
    b.catalogo.guardar('en', 'rooms', [habitacion(2)], DAY_MS);

    const res = await pedir(b);

    expect(b.fetchRooms.mock.calls.map((c) => c[1])).toEqual(['es']);
    // El proveedor ya no tiene el español: sale el inglés vigente.
    expect(res).toMatchObject({ status: 'ready', lang: 'en', langFallback: true });
  });

  it('respondió sin habitaciones en los dos idiomas → `none` y queda recordado', async () => {
    const b = banco({ fetchRooms: proveedor({}) });

    expect(await pedir(b)).toMatchObject({ status: 'none', rooms: [] });
    expect(await pedir(b)).toMatchObject({ status: 'none', rooms: [] });
    expect(b.fetchRooms).toHaveBeenCalledTimes(2);
  });

  it('habitaciones que la base rechaza se cuentan; si no entra ninguna, el resultado no es `rooms`', async () => {
    const b = banco();
    b.catalogo.rechazar = () => true;

    const res = await pedir(b, 'en');

    expect(res).toMatchObject({ status: 'none', rooms: [] });
    expect(b.catalogo.fetches.get(key(HOTEL, 'en'))?.outcome).toBe('none');
    expect(info).toHaveBeenCalledWith(
      `hotels.room_content.traido provider=${PROVEEDOR} lang=en outcome=none rooms=0 stored=0 rejected=0`,
    );

    const c = banco({ fetchRooms: proveedor({ en: [habitacion(1), habitacion(2)] }) });
    c.catalogo.rechazar = (room) => room.roomKey === '197352';
    expect((await pedir(c, 'en')).rooms.map((r) => r.roomKey)).toEqual(['197351']);
    expect(info).toHaveBeenCalledWith(
      `hotels.room_content.traido provider=${PROVEEDOR} lang=en outcome=rooms rooms=2 stored=1 rejected=1`,
    );
  });

  it('`unreadable` del proveedor se guarda tal cual, sin habitaciones', async () => {
    const fetchRooms: FetchRooms = vi.fn((_h: string, lang: HotelContentLanguage) =>
      Promise.resolve<HotelRoomContentFetch>({ lang, outcome: 'unreadable', rooms: [] }),
    );
    const b = banco({ fetchRooms });

    await pedir(b, 'en');

    expect(b.catalogo.guardados).toEqual([
      { hotelId: HOTEL, lang: 'en', outcome: 'unreadable', rooms: [] },
    ]);
  });

  it('más de 100 habitaciones: se guardan las primeras 100', async () => {
    const muchas = Array.from({ length: 120 }, (_, i) => habitacion(i + 1));
    const b = banco({ fetchRooms: proveedor({ en: muchas }) });

    const res = await pedir(b, 'en');

    expect(b.catalogo.guardados[0]?.rooms).toHaveLength(100);
    expect(res.rooms).toHaveLength(100);
  });

  it('dos fichas a la vez del mismo hotel esperan UNA llamada', async () => {
    let soltar: (() => void) | undefined;
    const fetchRooms: FetchRooms = vi.fn(
      (_h: string, lang: HotelContentLanguage) =>
        new Promise<HotelRoomContentFetch>((resolve) => {
          soltar = () => resolve({ lang, outcome: 'rooms', rooms: [habitacion(1)] });
        }),
    );
    const b = banco({ fetchRooms });

    const una = pedir(b, 'en');
    const otra = pedir(b, 'en');
    await vi.waitFor(() => expect(soltar).toBeDefined());
    soltar?.();

    const [r1, r2] = await Promise.all([una, otra]);
    expect(fetchRooms).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe('ready');
    expect(r2.status).toBe('ready');
  });
});

describe('nunca bloquea la ficha', () => {
  it('el proveedor tarda más que el plazo: `pending` con `retryAfterMs`, y la llamada sigue y guarda', async () => {
    vi.useFakeTimers();
    let soltar: (() => void) | undefined;
    const fetchRooms: FetchRooms = vi.fn(
      (_h: string, lang: HotelContentLanguage) =>
        new Promise<HotelRoomContentFetch>((resolve) => {
          soltar = () => resolve({ lang, outcome: 'rooms', rooms: [habitacion(1)] });
        }),
    );
    const b = banco({ fetchRooms });

    const respuesta = pedir(b);
    await vi.advanceTimersByTimeAsync(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS);
    const res = await respuesta;

    expect(res).toEqual({
      providerCode: PROVEEDOR,
      hotelId: HOTEL,
      requestedLang: 'es',
      lang: null,
      langFallback: false,
      status: 'pending',
      retryAfterMs: HOTEL_ROOM_CONTENT_RETRY_AFTER_MS,
      rooms: [],
    });
    expect(b.catalogo.guardados).toEqual([]);

    soltar?.();
    await vi.waitFor(() => expect(b.catalogo.guardados).toHaveLength(1));
    // La próxima ficha ya lo lee del catálogo, sin llamar.
    expect(await pedir(b)).toMatchObject({ status: 'ready', lang: 'es' });
    expect(fetchRooms).toHaveBeenCalledTimes(1);
  });

  it('vencido y lento: sale lo guardado, aunque esté vencido, en vez de `pending`', async () => {
    vi.useFakeTimers();
    const fetchRooms: FetchRooms = vi.fn(() => new Promise<HotelRoomContentFetch>(() => undefined));
    const b = banco({ fetchRooms });
    b.catalogo.guardar('es', 'rooms', [habitacion(7)], 45 * DAY_MS);

    const respuesta = pedir(b);
    await vi.advanceTimersByTimeAsync(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS);

    const res = await respuesta;
    expect(res).toMatchObject({ status: 'ready', lang: 'es' });
    expect(res).not.toHaveProperty('retryAfterMs');
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['197357']);
  });
});

describe('fallos', () => {
  it('el proveedor falla: se recuerda 2 minutos, se escribe el log sin datos y sale lo guardado vencido', async () => {
    const fetchRooms: FetchRooms = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed http://x')),
    );
    const b = banco({ fetchRooms });
    b.catalogo.guardar('es', 'rooms', [habitacion(6)], 60 * DAY_MS);

    const res = await pedir(b);

    expect(res).toMatchObject({ status: 'ready', lang: 'es' });
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['197356']);
    expect(warn).toHaveBeenCalledWith(
      `hotels.room_content.fallo provider=${PROVEEDOR} lang=es error=TypeError`,
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('http://x');
    expect(await b.cache.get(`hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:es`)).toBe('failed');
    // Falló el pedido: el inglés no se pide (nada indica que vaya a llegar).
    expect(fetchRooms.mock.calls.map((c) => c[1])).toEqual(['es']);

    // Dentro de los 2 minutos no se vuelve a llamar.
    expect(await pedir(b)).toMatchObject({ status: 'ready' });
    expect(fetchRooms).toHaveBeenCalledTimes(1);
    // Pasiva para el circuito: un HotelDetails que falla no corta las búsquedas de la red.
    expect(b.breaker.snapshot()[PROVEEDOR]).toEqual({ state: 'closed', failures: 0 });
  });

  it('la caché de fallos dura lo suyo: pasados los 2 minutos se vuelve a pedir', async () => {
    const cache = new MemoryCacheAdapter();
    const set = vi.spyOn(cache, 'set');
    const fetchRooms: FetchRooms = vi.fn(() => Promise.reject(new Error('caído')));
    const b = banco({ fetchRooms, cache });

    expect(await pedir(b, 'en')).toMatchObject({ status: 'none', rooms: [] });
    expect(set).toHaveBeenCalledWith(
      `hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:en`,
      'failed',
      HOTEL_ROOM_CONTENT_FAILED_TTL_S,
    );
    expect(HOTEL_ROOM_CONTENT_FAILED_TTL_S).toBe(120);
  });

  it('guardar falla: también es un fallo recordado, con el nombre del error', async () => {
    const b = banco();
    b.catalogo.fallaGuardar = new RangeError('pg dijo algo con datos');

    expect(await pedir(b, 'en')).toMatchObject({ status: 'none' });
    expect(warn).toHaveBeenCalledWith(
      `hotels.room_content.fallo provider=${PROVEEDOR} lang=en error=RangeError`,
    );
    expect(await b.cache.get(`hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:en`)).toBe('failed');
  });

  it('un rechazo que no es un Error se nombra `UnknownError`', async () => {
    const fetchRooms: FetchRooms = vi.fn();
    fetchRooms.mockRejectedValue('texto del proveedor con datos');
    const b = banco({ fetchRooms });

    await pedir(b, 'en');

    expect(warn).toHaveBeenCalledWith(
      `hotels.room_content.fallo provider=${PROVEEDOR} lang=en error=UnknownError`,
    );
  });

  it('una caché que falla no tumba la ficha: cuenta como fallo', async () => {
    const rota: CachePort = {
      get: () => Promise.reject(new Error('cache caída')),
      set: () => Promise.reject(new Error('cache caída')),
      delete: () => Promise.resolve(),
      invalidatePattern: () => Promise.resolve(),
    };
    const b = banco({ cache: rota });

    expect(await pedir(b, 'en')).toMatchObject({ status: 'none', rooms: [] });
    expect(b.fetchRooms).not.toHaveBeenCalled();
  });

  it('`opt-in` apagado para la agencia: `none` sin llamar y sin recordar nada', async () => {
    const b = banco({ flag: false });

    expect(await pedir(b)).toMatchObject({ status: 'none' });
    expect(b.fetchRooms).not.toHaveBeenCalled();
    expect(await b.cache.get(`hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:es`)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('sin cuenta del proveedor: `none`, sin aviso y sin recordar', async () => {
    const b = banco({ failResolveWith: new NotFoundException('sin cuenta') });

    expect(await pedir(b)).toMatchObject({ status: 'none' });
    expect(warn).not.toHaveBeenCalled();
    expect(await b.cache.get(`hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:es`)).toBeNull();
  });

  it('la bóveda de credenciales falla: se avisa con el nombre del error, `none` y sin recordar', async () => {
    const b = banco({ failResolveWith: new TypeError('bóveda caída: secreto') });

    expect(await pedir(b)).toMatchObject({ status: 'none' });
    expect(warn).toHaveBeenCalledWith(
      `hotels.room_content.proveedor_no_resuelto provider=${PROVEEDOR} error=TypeError`,
    );
    expect(await b.cache.get(`hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:es`)).toBeNull();
  });

  it('kill-switch de ventas del proveedor: el circuito no lo deja salir y no se recuerda', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', `${PROVEEDOR}:ventas`);
    const b = banco();

    expect(await pedir(b)).toMatchObject({ status: 'none' });
    expect(b.fetchRooms).not.toHaveBeenCalled();
    expect(await b.cache.get(`hotels:room-content-failed:${PROVEEDOR}:${HOTEL}:es`)).toBeNull();
  });

  it('un adapter sin el puerto de habitaciones: `none` sin llamar', async () => {
    const b = banco({ sinPuerto: true });

    expect(await pedir(b)).toMatchObject({ status: 'none' });
    expect(b.fetchRooms).not.toHaveBeenCalled();
  });
});

describe('interruptores', () => {
  it('`HOTEL_ROOM_CONTENT=off`: sale lo guardado aunque esté vencido, sin llamar', async () => {
    const b = banco({ interruptor: 'off' });
    b.catalogo.guardar('es', 'rooms', [habitacion(1)], 90 * DAY_MS);

    expect(await pedir(b)).toMatchObject({ status: 'ready', lang: 'es' });
    expect(b.fetchRooms).not.toHaveBeenCalled();
  });

  it('`HOTEL_ROOM_CONTENT=off` sin nada guardado: `disabled`', async () => {
    const b = banco({ interruptor: 'off' });

    expect(await pedir(b)).toMatchObject({ status: 'disabled', rooms: [], lang: null });
    expect(b.fetchRooms).not.toHaveBeenCalled();
  });

  it('el proveedor dice que hoy no puede pedirlo (`TBO_ROOM_DETAILS=off`): `disabled`, sin guardar', async () => {
    const fetchRooms: FetchRooms = vi.fn((_h: string, lang: HotelContentLanguage) =>
      Promise.resolve<HotelRoomContentFetch>({ lang, outcome: 'unavailable', rooms: [] }),
    );
    const b = banco({ fetchRooms });

    expect(await pedir(b)).toMatchObject({ status: 'disabled', rooms: [] });
    expect(b.catalogo.guardados).toEqual([]);
    // Tampoco se le pide el inglés: tampoco podría.
    expect(fetchRooms).toHaveBeenCalledTimes(1);
  });

  it('con el pedido guardado y el inglés no disponible hoy: sale el pedido', async () => {
    const fetchRooms: FetchRooms = vi.fn((_h: string, lang: HotelContentLanguage) =>
      Promise.resolve<HotelRoomContentFetch>(
        lang === 'es'
          ? { lang, outcome: 'none', rooms: [] }
          : { lang, outcome: 'unavailable', rooms: [] },
      ),
    );
    const b = banco({ fetchRooms });

    expect(await pedir(b)).toMatchObject({ status: 'disabled', rooms: [] });
    expect(b.catalogo.guardados.map((g) => g.lang)).toEqual(['es']);
  });
});

describe('qué hoteles y qué proveedores', () => {
  it('un proveedor que la plataforma no conoce es un error tipado', async () => {
    const b = banco();
    await expect(pedir(b, 'es', 'nadie-hotels')).rejects.toBeInstanceOf(UnknownHotelProviderError);
  });

  it('un proveedor que trae su contenido con la disponibilidad (Despegar): `none` sin leer la base', async () => {
    const b = banco();

    expect(await pedir(b, 'es', 'despegar-hotels')).toMatchObject({
      providerCode: 'despegar-hotels',
      status: 'none',
    });
    expect(b.catalogo.lecturas).toEqual([]);
  });

  it('un hotel fuera del catálogo: `none` sin llamar (un código inventado no gasta cupo)', async () => {
    const b = banco();
    b.catalogo.enCatalogo.clear();

    expect(await pedir(b)).toMatchObject({ status: 'none', rooms: [] });
    expect(b.fetchRooms).not.toHaveBeenCalled();
  });
});

describe('lo que sale se verifica', () => {
  it('fotos que el proxy no puede servir se descartan y se cuentan; una habitación sin id válido no sale', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'rooms', [
      habitacion(1, {
        images: [
          `https://${HOST}/r/1.jpg`,
          'http://img.example/r/plano.jpg',
          'https://otro.example/r/ajeno.jpg',
          `https://${HOST}/r/1.jpg`,
        ],
      }),
      habitacion(2, { roomKey: '0' }),
      habitacion(3, { roomKey: 'con espacio' }),
    ]);

    const res = await pedir(b);

    expect(res.rooms.map((r) => [r.roomKey, r.images])).toEqual([
      ['197351', [proxy(`https://${HOST}/r/1.jpg`)]],
    ]);
    expect(warn).toHaveBeenCalledWith(
      `hotels.room_content.descartado provider=${PROVEEDOR} rooms=2 images=2`,
    );
  });

  it('un proveedor sin dominios de fotos: las habitaciones salen sin fotos', async () => {
    const b = banco({ imageHosts: [] });
    b.catalogo.guardar('es', 'rooms', [habitacion(1)]);

    const res = await pedir(b);

    expect(res.rooms[0]?.images).toEqual([]);
    expect(res.rooms[0]?.name).toBe('Deluxe Room 1');
  });

  it('hasta 30 fotos por habitación, y una lista que no es lista no da fotos', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'rooms', [
      habitacion(1, { images: Array.from({ length: 35 }, (_, i) => `https://${HOST}/r/${i}.jpg`) }),
    ]);
    const filas = b.catalogo.filas.get(key(HOTEL, 'es')) ?? [];
    filas.push({ ...(filas[0] as HotelRoomContentRow), roomKey: 'otra', images: 'no-lista' });

    const res = await pedir(b);

    expect(res.rooms[0]?.images).toHaveLength(30);
    expect(res.rooms[1]).toMatchObject({ roomKey: 'otra', images: [] });
  });

  it('id del proveedor inválido o `0` → `null`; textos vacíos o con `<` → `null`', async () => {
    const b = banco();
    b.catalogo.guardar('es', 'rooms', [
      habitacion(1, { roomRef: '0', description: '<b>Hola</b>', nameKey: '', name: '  ' }),
      habitacion(2, { roomRef: 'x y', sizeText: null, description: null }),
      habitacion(3, { roomKey: 'n-0123456789abcdef', roomRef: null }),
    ]);

    const res = await pedir(b);

    expect(res.rooms.map((r) => [r.roomKey, r.roomId, r.nameKey, r.name, r.description])).toEqual([
      ['197351', null, null, null, null],
      ['197352', null, 'deluxe room 2', 'Deluxe Room 2', null],
      ['n-0123456789abcdef', null, 'deluxe room 3', 'Deluxe Room 3', 'Vista al jardín; cama king'],
    ]);
    expect(res.rooms[1]).toMatchObject({ sizeText: null, sizeM2: null });
  });
});

describe('roomSizeM2: el tamaño en m²', () => {
  it.each([
    ['25 m2', 25],
    ['25,5 m²', 25.5],
    ['32 sqm', 32],
    ['40 sq. m', 40],
    ['1830 ft', 170],
    ['300 sq ft', 28],
    ['350 square feet', 33],
    ['1830 ft (170 m2)', 170],
  ])('%s → %s', (texto, esperado) => {
    expect(roomSizeM2(texto)).toBe(esperado);
  });

  it.each([null, 'grande', '2 m2', '900 m2', '12 metros', 'Tamaño: 18ft2'])(
    '%s → null',
    (texto) => {
      expect(roomSizeM2(texto)).toBeNull();
    },
  );
});

describe('el puerto se detecta por presencia', () => {
  it('supportsHotelRoomContent', () => {
    expect(supportsHotelRoomContent({ fetchHotelRoomContent: () => undefined })).toBe(true);
    expect(supportsHotelRoomContent({ fetchHotelContent: () => undefined })).toBe(false);
  });
});

describe('HOTEL_ROOM_CONTENT: el interruptor del API', () => {
  it.each([
    [undefined, 'on'],
    ['', 'on'],
    ['  ', 'on'],
    ['on', 'on'],
    [' OFF ', 'off'],
    ['off', 'off'],
  ] as const)('%j → %s', (raw, valor) => {
    expect(parseHotelRoomContentSwitch(raw)).toEqual({ value: valor, invalid: false });
  });

  it.each(['apagado', 'false', 0])('un valor fuera de la lista (%j) lo apaga', (raw) => {
    expect(parseHotelRoomContentSwitch(raw)).toEqual({ value: 'off', invalid: true });
  });

  it('se lee de `HOTEL_ROOM_CONTENT` y un valor inválido se avisa sin repetirlo', () => {
    const logger = { warn: vi.fn() };

    vi.stubEnv('HOTEL_ROOM_CONTENT', 'off');
    expect(readHotelRoomContentSwitch(logger)).toBe('off');
    expect(logger.warn).not.toHaveBeenCalled();

    vi.stubEnv('HOTEL_ROOM_CONTENT', 'sk-secreto-pegado-aqui');
    expect(readHotelRoomContentSwitch(logger)).toBe('off');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).not.toContain('sk-secreto');

    vi.stubEnv('HOTEL_ROOM_CONTENT', '');
    expect(readHotelRoomContentSwitch()).toBe('on');
  });
});
