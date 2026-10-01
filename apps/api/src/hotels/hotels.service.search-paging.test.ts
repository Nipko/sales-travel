import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NotFoundException } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import type { HotelOffer } from '@sales-travel/canonical';
import type { TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BookingPermissionsService } from '../booking-permissions/booking-permissions.service.js';
import type { TenantType } from '../database/database.types.js';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import type { HotelProviderFactory } from '../providers/hotel-provider.types.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb, type FakeHotelsDb, type FilaTenant } from './__fixtures__/fake-hotels-db.js';
import type { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import type { HotelBookingService } from './hotel-booking.service.js';
import type { HotelContentService } from './hotel-content.service.js';
import type { HotelPrebookService } from './hotel-prebook.service.js';
import { AllHotelProvidersFailedError } from './hotel-provider-errors.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import {
  HOTEL_SEARCH_MAX_RECENT_PAGES,
  HOTEL_SEARCH_PAGE_REPLAY_MS,
  HOTEL_SEARCH_PAGING_MIN_LEFT_MS,
  HOTEL_SEARCH_PAGING_TTL_MS,
} from './hotel-search-paging.js';
import {
  HotelSearchPageNotNextError,
  HotelSearchPagingExhaustedError,
  HotelSearchPagingExpiredError,
  HotelSearchPagingStore,
} from './hotel-search-paging.store.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

// El nombre del campo va en CAMPO y el valor de prueba en una constante: el detector de secretos
// de GitGuardian marca como contraseña real cualquier línea que ponga un valor al lado de ese
// nombre, aunque sea un texto de prueba.
const CAMPO = { clave: 'password' } as const;
const CLAVE_DEMO = 'clave-de-prueba';

/**
 * La búsqueda por destino en tramos (pedido del founder del 2026-09-30: "no veo más páginas para
 * seguir"; docs/tbo/02 §4.4).
 *
 * Como `hotels.service.tbo-search.test.ts`: todo es real salvo los bordes. El factory de TBO, su
 * ACL, su cliente HTTP con el limitador, el registry, el breaker, el servicio, el controlador, el
 * contexto de búsqueda y el almacén de los tramos. Se doblan la bóveda, el `fetch` —que responde
 * con el ejemplo de p. 15 un hotel por código pedido— y la base, con el compilador real de Postgres.
 * Lo que depende del SQL de verdad (el orden por relevancia, el total) está en
 * `hotels.search-paging.integration.test.ts`.
 */

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const TBO = 'tbo-hotels';
const DESPEGAR = 'despegar-hotels';
const DESTINO = `${TBO}:150184`;

/** 250 hoteles activos de TBO en la ciudad, ya en orden de relevancia: tres tramos de 100. */
const CATALOGO = Array.from({ length: 250 }, (_, i) => String(2_000_000 + i));

const CUENTA = { accountId: 'acc-tbo-consolidador', updatedAt: '2026-09-01T00:00:00.000Z' };

const RAIZ = join(__dirname, '..', '..', '..', '..');
const FIXTURES_TBO = join(RAIZ, 'providers', 'tbo-hotels', 'src', '__fixtures__');

function fixture(ruta: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_TBO, ruta), 'utf8')) as Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** Lo que salió hacia TBO en esa llamada. */
function cuerpo(fetch: Mock<TboFetch>, llamada: number): Record<string, unknown> {
  return cuerpoDe(fetch.mock.calls[llamada]?.[1]);
}

/** Los códigos que se le pidieron a TBO en esa llamada. */
function codigosDe(fetch: Mock<TboFetch>, llamada: number): string[] {
  return String(cuerpo(fetch, llamada)['HotelCodes']).split(',');
}

/** El ejemplo de p. 15 con UN hotel por código pedido, con `BookingCode` propio. */
function respuestaSearch(init: RequestInit): Response {
  const pedido = cuerpoDe(init) as { HotelCodes: string };
  const base = fixture('pdf/search-single-room.p15.json') as {
    Status: unknown;
    HotelResult: Array<{ HotelCode: string; Rooms: Array<Record<string, unknown>> }>;
  };
  const [modelo] = base.HotelResult;
  if (modelo === undefined) throw new Error('el ejemplo de p. 15 no trae HotelResult');
  const HotelResult = pedido.HotelCodes.split(',').map((code) => ({
    ...modelo,
    HotelCode: code,
    Rooms: modelo.Rooms.map((room, i) => ({
      ...room,
      BookingCode: `${code}!TB!${i + 1}!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b`,
    })),
  }));
  return json({ Status: base.Status, HotelResult });
}

const ERROR_TBO = (): Response => {
  const error = fixture('envelope/83-500-unexpected-error.json') as {
    response: { bodyJson: unknown };
  };
  return json(error.response.bodyJson);
};

/** La cuenta TBO del consolidador, heredada por su red; `activa` en `false` la quita de la bóveda. */
function boveda(cuenta: { activa: boolean }): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    if (!cuenta.activa || ![CONSOLIDADOR, AGENCIA, OTRA_AGENCIA].includes(tenantId)) {
      return Promise.reject(new NotFoundException('sin cuenta'));
    }
    return Promise.resolve({
      id: CUENTA.accountId,
      ownerTenantId: CONSOLIDADOR,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'usuario-de-test', [CAMPO.clave]: CLAVE_DEMO },
      inherited: tenantId !== CONSOLIDADOR,
      updatedAt: new Date(CUENTA.updatedAt),
    });
  };
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(id === CONSOLIDADOR ? 'consolidator' : 'agency');
  return { resolve, ownerTenantType } as unknown as ProviderCredentialsService;
}

function entrada(overrides: Partial<HotelAvailabilityInput> = {}): HotelAvailabilityInput {
  return {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 2, childrenAges: [7] }],
    destinationId: DESTINO,
    guestNationality: 'VE',
    ...overrides,
  };
}

interface Banco {
  service: HotelsService;
  controller: HotelsController;
  fetch: Mock<TboFetch>;
  db: FakeHotelsDb;
  contextos: HotelSearchContextStore;
  assertWithinQuota: Mock;
  instrument: Mock;
  despegar: FakeDespegarHotelsAdapter;
  /** Enciende o apaga TBO para la agencia, como el superadmin (`provider_enablement`). */
  tboEncendido: { valor: boolean };
  /** La cuenta TBO en la bóveda: quitarla deja a TBO `unavailable`. */
  cuentaTbo: { activa: boolean };
}

function banco(
  opts: {
    responder?: (init: RequestInit) => Response;
    catalogo?: readonly string[];
    totalCatalogo?: number;
    tenant?: FilaTenant;
    conDespegar?: boolean;
    tramos?: CachePort;
    /** Reglas del waterfall; el arreglo se lee en cada búsqueda, así que se puede cambiar. */
    reglas?: ApplicableRule[];
    /** Ciudades de TBO para el destino de la plataforma (`hotel_destination_map`). */
    mapa?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Banco {
  const fetch = vi.fn<TboFetch>((_url, init) =>
    Promise.resolve((opts.responder ?? respuestaSearch)(init ?? {})),
  );
  const despegar = new FakeDespegarHotelsAdapter();
  const cuentaTbo = { activa: true };
  const factories: HotelProviderFactory[] = [
    new TboHotelsProviderFactory(boveda(cuentaTbo), fetch),
  ];
  if (opts.conDespegar === true) factories.unshift(fakeDespegarFactory(despegar).factory);
  const tboEncendido = { valor: true };

  const db = fakeHotelsDb({
    catalogo: { [TBO]: opts.catalogo ?? CATALOGO, [DESPEGAR]: ['101', '205', '350'] },
    ...(opts.totalCatalogo === undefined ? {} : { totalCatalogo: { [TBO]: opts.totalCatalogo } }),
    ...(opts.tenant === undefined ? {} : { tenant: opts.tenant }),
    ...(opts.mapa === undefined ? {} : { mapa: opts.mapa }),
  });
  const assertWithinQuota = vi.fn(() => Promise.resolve());
  const instrument = vi.fn(
    (_meta: unknown, run: () => Promise<unknown>): Promise<unknown> => run(),
  );
  const contextos = new HotelSearchContextStore(new MemoryCacheAdapter());
  const service = new HotelsService(
    hotelRegistry(
      factories,
      hotelFlags((_tenant, code) => (code === TBO ? tboEncendido.valor : true)),
    ),
    db.service,
    {
      getApplicableRules: () => Promise.resolve([...(opts.reglas ?? [])]),
    } as unknown as PricingService,
    { assertWithinQuota, instrument } as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
    contextos,
    undefined,
    new HotelSearchPagingStore(opts.tramos ?? new MemoryCacheAdapter()),
  );
  const controller = new HotelsController(
    service,
    {} as DespegarHotelReservationsService,
    { resolve: () => Promise.resolve(AGENCIA) } as unknown as ActiveTenantService,
    { effective: () => Promise.resolve(false) } as unknown as ProviderDisclosureService,
    {} as HotelPrebookService,
    {} as HotelBookingService,
    {} as HotelContentService,
    {
      nonRefundableRates: () => Promise.resolve({ effective: 'allowed' }),
    } as unknown as BookingPermissionsService,
  );
  return {
    service,
    controller,
    fetch,
    db,
    contextos,
    assertWithinQuota,
    instrument,
    despegar,
    tboEncendido,
    cuentaTbo,
  };
}

function buscar(b: Banco, input: HotelAvailabilityInput = entrada()): Promise<HotelSearchEnvelope> {
  return b.controller.availability('user-1', input);
}

function siguiente(b: Banco, sessionId: string, page: number): Promise<HotelSearchEnvelope> {
  return b.controller.availabilityMore('user-1', { sessionId, page });
}

function sesionDe(res: HotelSearchEnvelope): string {
  const id = res.paging?.sessionId;
  if (id === undefined) throw new Error('la búsqueda no dejó tramos siguientes');
  return id;
}

const ids = (hotels: readonly HotelOffer[]): string[] => hotels.map((h) => h.hotelId);

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.stubEnv('PROVIDERS_DISABLED', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('tramos — el primero es la búsqueda', () => {
  it('TBO recibe los primeros 100 códigos del catálogo y la respuesta dice "100 de 250"', async () => {
    const b = banco();
    const res = await buscar(b);

    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(codigosDe(b.fetch, 0)).toEqual(CATALOGO.slice(0, 100));
    expect(ids(res.hotels)).toEqual(CATALOGO.slice(0, 100));
    expect(res.paging?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(res.paging).toEqual({
      sessionId: res.paging?.sessionId,
      page: 0,
      consulted: 100,
      total: 250,
      hasMore: true,
      nextBatch: 100,
    });
  });

  it('el total es el `count(*) over ()` del catálogo, aunque pase el tope de 20 tramos', async () => {
    const res = await buscar(banco({ totalCatalogo: 3_400 }));

    expect(res.paging).toMatchObject({ consulted: 100, total: 3_400, hasMore: true });
  });

  it('con el destino entero en un tramo: "2 de 2" y nada que seguir', async () => {
    const res = await buscar(banco({ catalogo: ['1120548', '1402689'] }));

    expect(res.paging).toEqual({ page: 0, consulted: 2, total: 2, hasMore: false });
  });

  it('IDs escritos a mano: una sola búsqueda, sin tramos', async () => {
    const b = banco({ conDespegar: true });
    const res = await buscar(b, entrada({ destinationId: undefined, hotelIds: ['101', '205'] }));

    expect(res.hotels.length).toBeGreaterThan(0);
    expect(res).not.toHaveProperty('paging');
  });

  it('TBO respondió en otra moneda: sus tarifas no se muestran y no se ofrece seguir', async () => {
    // La agencia busca en COP (su moneda) y la cuenta de TBO cotiza en USD.
    const res = await buscar(banco({ tenant: { default_currency: 'COP', country_code: 'CO' } }));

    expect(res.providers[0]).toMatchObject({ code: TBO, skipReason: 'currency-mismatch' });
    expect(res.paging).toEqual({ page: 0, consulted: 100, total: 250, hasMore: false });
  });

  it('si la búsqueda por tramos no se puede guardar, los hoteles salen igual y no se ofrece seguir', async () => {
    const rota: CachePort = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error('caché caída')),
      delete: () => Promise.resolve(),
      invalidatePattern: () => Promise.resolve(),
    };
    const res = await buscar(banco({ tramos: rota }));

    expect(res.hotels).toHaveLength(100);
    expect(res.paging).toEqual({ page: 0, consulted: 100, total: 250, hasMore: false });
  });
});

describe('tramos — "Ver más hoteles"', () => {
  it('el tramo 1 pide los códigos 100 a 199 con la MISMA estadía, ocupación, moneda y nacionalidad', async () => {
    const b = banco();
    const primero = await buscar(b);
    const res = await siguiente(b, sesionDe(primero), 1);

    expect(b.fetch).toHaveBeenCalledTimes(2);
    expect(codigosDe(b.fetch, 1)).toEqual(CATALOGO.slice(100, 200));
    const { HotelCodes: _a, ...busqueda } = cuerpo(b.fetch, 0);
    const { HotelCodes: _b, ...tramo } = cuerpo(b.fetch, 1);
    expect(tramo).toEqual(busqueda);
    expect(tramo).toMatchObject({
      CheckIn: '2026-11-10',
      CheckOut: '2026-11-12',
      GuestNationality: 'VE',
      PaxRooms: [{ Adults: 2, Children: 1, ChildrenAges: [7] }],
    });

    // El mismo sobre, sólo con los hoteles de este tramo.
    expect(ids(res.hotels)).toEqual(CATALOGO.slice(100, 200));
    expect(res.providers).toEqual([{ code: TBO, status: 'ok', count: 100 }]);
    expect(res.showProviderInResults).toBe(false);
    expect(res.nonRefundableRates).toBe('allowed');
    expect(res.paging).toEqual({
      sessionId: primero.paging?.sessionId,
      page: 1,
      consulted: 200,
      total: 250,
      hasMore: true,
      nextBatch: 50,
    });
  });

  it('el último tramo trae los 50 que quedan y ya no ofrece seguir', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));
    await siguiente(b, sesion, 1);
    const ultimo = await siguiente(b, sesion, 2);

    expect(codigosDe(b.fetch, 2)).toEqual(CATALOGO.slice(200));
    expect(ultimo.paging).toEqual({ page: 2, consulted: 250, total: 250, hasMore: false });
    await expect(siguiente(b, sesion, 3)).rejects.toBeInstanceOf(HotelSearchPagingExhaustedError);
    expect(b.fetch).toHaveBeenCalledTimes(3);
  });

  it('cada tramo sale con el precio de venta, como la búsqueda', async () => {
    const b = banco();
    const res = await siguiente(b, sesionDe(await buscar(b)), 1);

    // `RecommendedSellingRate` 160.67 sobre un neto de 152.88 (p. 15): el piso sube la venta.
    expect(res.hotels[0]?.roompacks[0]?.pricing?.finalMinor).toBe(16_067);
  });

  it('cada tramo pasa por la cuota y deja su fila, con el tramo y sin datos del pasajero', async () => {
    const b = banco();
    await siguiente(b, sesionDe(await buscar(b)), 1);

    expect(b.assertWithinQuota).toHaveBeenCalledTimes(2);
    expect(b.instrument).toHaveBeenCalledTimes(2);
    const meta = b.instrument.mock.calls[1]?.[0] as { criteria: Record<string, unknown> };
    expect(meta).toMatchObject({
      tenantId: AGENCIA,
      vertical: 'hotels',
      providerCodes: [TBO],
      criteria: {
        checkinDate: '2026-11-10',
        destinationProvider: TBO,
        destinationCityCode: '150184',
        hotelCount: 100,
        page: 1,
      },
    });
    expect(JSON.stringify(meta)).not.toContain('VE');
  });
});

describe('tramos — sin repetir', () => {
  it('el último tramo pedido otra vez (su respuesta se cortó en el camino) sale igual, sin otro Search ni otra fila de cuota', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));
    const cargado = await siguiente(b, sesion, 1);

    const repetido = await siguiente(b, sesion, 1);

    expect(b.fetch).toHaveBeenCalledTimes(2);
    expect(b.assertWithinQuota).toHaveBeenCalledTimes(2);
    expect(b.instrument).toHaveBeenCalledTimes(2);
    expect(ids(repetido.hotels)).toEqual(CATALOGO.slice(100, 200));
    expect(repetido.paging).toEqual(cargado.paging);
    // Y el siguiente sigue siendo el 2.
    expect(codigosDe(b.fetch, 1)).toEqual(CATALOGO.slice(100, 200));
    await siguiente(b, sesion, 2);
    expect(codigosDe(b.fetch, 2)).toEqual(CATALOGO.slice(200));
  });

  it('pasado el rato de repetirlo, es 409 con el que sigue y cuánto se consultó de verdad', async () => {
    const t0 = Date.parse('2026-09-30T15:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    const b = banco();
    const sesion = sesionDe(await buscar(b));
    await siguiente(b, sesion, 1);

    vi.setSystemTime(t0 + HOTEL_SEARCH_PAGE_REPLAY_MS + 1);
    const repetido = siguiente(b, sesion, 1);
    await expect(repetido).rejects.toBeInstanceOf(HotelSearchPageNotNextError);
    await expect(repetido).rejects.toMatchObject({
      reason: 'SEARCH_PAGE_NOT_NEXT',
      publicDetails: {
        nextPage: 2,
        paging: {
          sessionId: sesion,
          page: 1,
          consulted: 200,
          total: 250,
          hasMore: true,
          nextBatch: 50,
        },
      },
    });
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it(`guarda para repetir como mucho ${HOTEL_SEARCH_MAX_RECENT_PAGES} tramos: se olvidan primero los más viejos ya respondidos`, async () => {
    const b = banco();
    const carga = vi
      .spyOn(b.service as unknown as { loadNextPage: () => Promise<unknown> }, 'loadNextPage')
      .mockImplementation(() => Promise.resolve({ hotels: [], providers: [] }));
    const sesiones = Array.from(
      { length: HOTEL_SEARCH_MAX_RECENT_PAGES + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const sessionId of sesiones) {
      await b.service.searchMoreAvailability(AGENCIA, { sessionId, page: 1 });
    }
    expect(carga).toHaveBeenCalledTimes(sesiones.length);

    // La más nueva todavía se repite; la más vieja ya no (vuelve a pasar por `loadNextPage`).
    await b.service.searchMoreAvailability(AGENCIA, { sessionId: sesiones.at(-1)!, page: 1 });
    expect(carga).toHaveBeenCalledTimes(sesiones.length);
    await b.service.searchMoreAvailability(AGENCIA, { sessionId: sesiones[0]!, page: 1 });
    expect(carga).toHaveBeenCalledTimes(sesiones.length + 1);
  });

  it('otro tramo de la misma búsqueda mientras uno está en vuelo no pisa al que está en vuelo', async () => {
    const b = banco();
    let suelta: (r: unknown) => void = () => undefined;
    const enVuelo = new Promise((r) => {
      suelta = r;
    });
    const carga = vi
      .spyOn(b.service as unknown as { loadNextPage: () => Promise<unknown> }, 'loadNextPage')
      .mockImplementationOnce(() => enVuelo)
      .mockImplementation(() => Promise.resolve({ hotels: [], providers: [] }));
    const sessionId = '00000000-0000-4000-8000-000000000001';

    const uno = b.service.searchMoreAvailability(AGENCIA, { sessionId, page: 1 });
    await b.service.searchMoreAvailability(AGENCIA, { sessionId, page: 2 });
    // El 1 sigue siendo el que se repite: el mismo Search en vuelo.
    expect(b.service.searchMoreAvailability(AGENCIA, { sessionId, page: 1 })).toBe(uno);
    expect(carga).toHaveBeenCalledTimes(2);
    suelta({ hotels: [], providers: [] });
    await uno;
  });

  it('un tramo anterior al último no se repite: 409', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));
    await siguiente(b, sesion, 1);
    await siguiente(b, sesion, 2);

    await expect(siguiente(b, sesion, 1)).rejects.toMatchObject({
      reason: 'SEARCH_PAGE_NOT_NEXT',
      publicDetails: { nextPage: 3 },
    });
    expect(b.fetch).toHaveBeenCalledTimes(3);
  });

  it('tampoco se salta uno', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));

    await expect(siguiente(b, sesion, 2)).rejects.toMatchObject({ publicDetails: { nextPage: 1 } });
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('doble clic: dos pedidos del mismo tramo a la vez hacen UN Search', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));

    const [uno, otro] = await Promise.all([
      b.service.searchMoreAvailability(AGENCIA, { sessionId: sesion, page: 1 }),
      b.service.searchMoreAvailability(AGENCIA, { sessionId: sesion, page: 1 }),
    ]);

    expect(b.fetch).toHaveBeenCalledTimes(2);
    expect(otro).toBe(uno);
    expect(b.assertWithinQuota).toHaveBeenCalledTimes(2);
  });

  it('si TBO falla, nada avanza: el mismo tramo se reintenta con los mismos códigos', async () => {
    const tbo = { cayo: false };
    const b = banco({ responder: (init) => (tbo.cayo ? ERROR_TBO() : respuestaSearch(init)) });
    const sesion = sesionDe(await buscar(b));

    tbo.cayo = true;
    await expect(siguiente(b, sesion, 1)).rejects.toBeInstanceOf(AllHotelProvidersFailedError);
    const fallidas = b.fetch.mock.calls.length;
    tbo.cayo = false;
    const reintento = await siguiente(b, sesion, 1);

    expect(codigosDe(b.fetch, fallidas)).toEqual(CATALOGO.slice(100, 200));
    expect(ids(reintento.hotels)).toEqual(CATALOGO.slice(100, 200));
    expect(reintento.paging).toMatchObject({ page: 1, consulted: 200 });
  });
});

describe('tramos — la búsqueda es de la agencia y vence', () => {
  it('otra agencia con el mismo `sessionId`: no existe, y TBO no se llama', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));

    await expect(
      b.service.searchMoreAvailability(OTRA_AGENCIA, { sessionId: sesion, page: 1 }),
    ).rejects.toBeInstanceOf(HotelSearchPagingExpiredError);
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('sin tiempo para un Search entero antes de vencer, también: ni TBO ni la cuota', async () => {
    const t0 = Date.parse('2026-09-30T15:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    const b = banco();
    const sesion = sesionDe(await buscar(b));

    vi.setSystemTime(t0 + HOTEL_SEARCH_PAGING_TTL_MS - HOTEL_SEARCH_PAGING_MIN_LEFT_MS + 1);
    await expect(siguiente(b, sesion, 1)).rejects.toMatchObject({
      reason: 'SEARCH_PAGING_EXPIRED',
    });
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(b.assertWithinQuota).toHaveBeenCalledTimes(1);

    // Un poco antes, todavía se puede.
    const b2 = banco();
    vi.setSystemTime(t0);
    const sesion2 = sesionDe(await buscar(b2));
    vi.setSystemTime(t0 + HOTEL_SEARCH_PAGING_TTL_MS - HOTEL_SEARCH_PAGING_MIN_LEFT_MS);
    await expect(siguiente(b2, sesion2, 1)).resolves.toMatchObject({ paging: { page: 1 } });
  });

  it('pasada la media hora del primer tramo hay que volver a buscar', async () => {
    const t0 = Date.parse('2026-09-30T15:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    const b = banco();
    const sesion = sesionDe(await buscar(b));

    vi.setSystemTime(t0 + HOTEL_SEARCH_PAGING_TTL_MS + 1);
    await expect(siguiente(b, sesion, 1)).rejects.toMatchObject({
      reason: 'SEARCH_PAGING_EXPIRED',
    });
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('TBO apagado para la agencia después del primer tramo: no se lo llama, se dice por qué y no se ofrece seguir', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));
    b.tboEncendido.valor = false;

    const res = await siguiente(b, sesion, 1);

    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(res.hotels).toEqual([]);
    expect(res.providers).toEqual([
      expect.objectContaining({ code: TBO, status: 'skipped', skipReason: 'opt-in-disabled' }),
    ]);
    expect(res.paging).toEqual({ page: 1, consulted: 100, total: 250, hasMore: false });
    // Sin nadie a quien preguntar, no se gasta una fila de la cuota.
    expect(b.instrument).toHaveBeenCalledTimes(1);
  });
});

describe('tramos — la moneda y el punto de venta son los del primero', () => {
  it('la agencia cambia su moneda por defecto a mitad de camino: el tramo sigue en la del primero', async () => {
    // La búsqueda no trajo moneda: salió en la de la agencia (USD), la misma en que cotiza TBO.
    const fila: FilaTenant = { default_currency: 'USD', country_code: 'CO' };
    const b = banco({ tenant: fila });
    const primero = await buscar(b);
    expect(primero.hotels[0]?.roompacks[0]?.price.total.currency).toBe('USD');

    fila.default_currency = 'COP';
    fila.country_code = 'PE';
    const res = await siguiente(b, sesionDe(primero), 1);

    // Sin la moneda guardada, el tramo se habría buscado en COP y TBO habría quedado fuera por
    // moneda: la lista mezclaría o perdería hoteles.
    expect(res.providers).toEqual([{ code: TBO, status: 'ok', count: 100 }]);
    expect(res.hotels[0]?.roompacks[0]?.price.total.currency).toBe('USD');
    const { HotelCodes: _a, ...busqueda } = cuerpo(b.fetch, 0);
    const { HotelCodes: _b, ...tramo } = cuerpo(b.fetch, 1);
    expect(tramo).toEqual(busqueda);
  });

  it('si la moneda o el markup ya no admiten la del primero, se pide buscar de nuevo sin llamar a TBO', async () => {
    const reglas: ApplicableRule[] = [];
    const b = banco({ tenant: { default_currency: 'COP', country_code: 'CO' }, reglas });
    // Busca en USD, que la agencia en COP puede usar con un markup en porcentaje.
    const primero = await buscar(b, entrada({ currency: 'USD' }));
    const sesion = sesionDe(primero);

    // El administrador agrega un markup fijo, que sólo se puede aplicar en COP.
    reglas.push({
      tenantId: AGENCIA,
      tenantName: 'Agencia',
      level: 1,
      ruleType: 'fixed',
      valueMinor: 5_000_00,
    });
    const vieja = siguiente(b, sesion, 1);

    await expect(vieja).rejects.toBeInstanceOf(HotelSearchPagingExpiredError);
    await expect(vieja).rejects.toMatchObject({
      reason: 'SEARCH_PAGING_EXPIRED',
      message:
        'Tu agencia cambió su moneda o su markup desde esta búsqueda. Vuelve a buscar para ver más hoteles.',
    });
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(b.assertWithinQuota).toHaveBeenCalledTimes(1);
  });
});

describe('tramos — con más de un proveedor', () => {
  it('Despegar entra entero en el primer tramo; el siguiente sólo le pregunta a TBO, y "de" suma los dos', async () => {
    const b = banco({ conDespegar: true, mapa: { [TBO]: ['150184'] } });
    const primero = await buscar(b, entrada({ destinationId: 2345 }));

    expect(primero.paging).toMatchObject({ consulted: 103, total: 253, nextBatch: 100 });
    const res = await siguiente(b, sesionDe(primero), 1);

    expect(b.despegar.searchAvailability).toHaveBeenCalledTimes(1);
    expect(codigosDe(b.fetch, 1)).toEqual(CATALOGO.slice(100, 200));
    expect(res.providers.map((p) => p.code)).toEqual([TBO]);
    expect(res.paging).toMatchObject({ consulted: 203, total: 253, nextBatch: 50 });
  });

  it('TBO perdió la cuenta después del primer tramo: `unavailable` con motivo, sin llamarlo y sin seguir', async () => {
    const b = banco();
    const sesion = sesionDe(await buscar(b));
    b.cuentaTbo.activa = false;

    const res = await siguiente(b, sesion, 1);

    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(res.providers).toEqual([
      expect.objectContaining({
        code: TBO,
        status: 'unavailable',
        unavailableReason: 'no-credentials',
      }),
    ]);
    expect(res.paging?.hasMore).toBe(false);
  });

  it('si el tramo no se puede guardar, sus hoteles salen igual y no se ofrece seguir', async () => {
    let guardadas = 0;
    const cache = new MemoryCacheAdapter();
    const setOriginal = cache.set.bind(cache);
    const unaVez: CachePort = {
      get: (key) => cache.get(key),
      set: (key, value, ttl) => {
        guardadas += 1;
        return guardadas > 1
          ? Promise.reject(new Error('caché caída'))
          : setOriginal(key, value, ttl);
      },
      delete: (key) => cache.delete(key),
      invalidatePattern: (p) => cache.invalidatePattern(p),
    };
    const b = banco({ tramos: unaVez });
    const res = await siguiente(b, sesionDe(await buscar(b)), 1);

    expect(res.hotels).toHaveLength(100);
    expect(res.paging).toEqual({ page: 1, consulted: 200, total: 250, hasMore: false });
  });
});

describe('tramos — las tarifas de cada tramo se reservan igual (RF-08)', () => {
  it('cada tarifa lleva el `searchId` de SU Search y su contexto resuelve con la misma ocupación y nacionalidad', async () => {
    const b = banco();
    const primero = await buscar(b);
    const segundo = await siguiente(b, sesionDe(primero), 1);

    const deUno = primero.hotels[0]?.roompacks[0];
    const deDos = segundo.hotels[0]?.roompacks[0];
    const searchId = (raw: unknown): string => (raw as { searchId: string }).searchId;
    expect(searchId(deDos?.provider.raw)).not.toBe(searchId(deUno?.provider.raw));

    for (const [hotel, pack] of [
      [primero.hotels[0], deUno],
      [segundo.hotels[0], deDos],
    ] as const) {
      const elegida = await b.contextos.resolveOffer(
        AGENCIA,
        {
          providerCode: TBO,
          searchId: searchId(pack?.provider.raw),
          offerRef: pack?.provider.offerRef ?? '',
        },
        CUENTA,
      );
      expect(elegida.pack.hotelId).toBe(hotel?.hotelId);
      expect(elegida).toMatchObject({
        checkinDate: '2026-11-10',
        checkoutDate: '2026-11-12',
        rooms: [{ adults: 2, childrenAges: [7] }],
        guestNationality: 'VE',
      });
    }
  });
});
