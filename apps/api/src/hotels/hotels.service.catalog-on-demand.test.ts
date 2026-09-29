import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
import { TBO_BASE_URLS, TBO_OPERATIONS, type TboFetch } from '@sales-travel/tbo-hotels';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import type { TenantType } from '../database/database.types.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { ProviderFlagsPort } from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  fakeDespegarFactory,
  FakeDespegarHotelsAdapter,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import {
  fakeHotelsDb,
  type CatalogoBajoDemanda,
  type FakeHotelsDb,
  type FilaCiudad,
} from './__fixtures__/fake-hotels-db.js';
import { HOTEL_IMAGE_PROXY_PATH } from './hotel-image-proxy.js';
import { mergeProviderOffers } from './hotel-search.aggregate.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { HotelAvailabilityInputSchema } from './hotels.schemas.js';
import {
  CITY_LOAD_FAILED_MESSAGE,
  CITY_WITHOUT_HOTELS_MESSAGE,
  HotelsService,
} from './hotels.service.js';

// El nombre del campo va en CAMPO y el valor de prueba en una constante: el detector de secretos
// de GitGuardian marca como contraseña real cualquier línea que ponga un valor al lado de ese
// nombre, aunque sea un texto de prueba.
const CAMPO = { clave: 'password' } as const;
const CLAVE_DEMO = 'clave-de-prueba';

/**
 * Cobertura global y fotos en la búsqueda (estrategia del 2026-09-29):
 *
 * - Una ciudad del catálogo local que el sync bajó sin hoteles (E2A) se sugiere "se carga al
 *   buscar" y, la primera vez que se busca, el API trae sus `HotelCodes` con UNA llamada a
 *   `TBOHotelCodeList`, los guarda por la función de 0054 y sigue con la búsqueda.
 * - La respuesta de disponibilidad trae la foto principal de cada hotel que el catálogo ya tiene,
 *   por el proxy propio.
 *
 * Todo es real salvo los bordes: el factory, el ACL y el cliente de TBO, el registry y el servicio.
 * Se doblan la bóveda, el `fetch` de TBO y la base (con el compilador real de Postgres).
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const DESPEGAR = 'despegar-hotels';
const TBO = 'tbo-hotels';
const CIUDAD = '130452';
const DESTINO = `${TBO}:${CIUDAD}`;
const IMPORTADOS = ['1010099'];
const STUB = 'stub-hotels';

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
  'pdf',
);

function fixture(nombre: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, nombre), 'utf8')) as Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** El body JSON de una llamada a TBO: el cliente siempre manda texto. */
function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** El ejemplo de p. 15 con UN hotel por código pedido. */
function respuestaSearch(init: RequestInit): Response {
  const pedido = cuerpoDe(init) as { HotelCodes: string };
  const ejemplo = fixture('search-single-room.p15.json') as {
    Status: unknown;
    HotelResult: Array<{ HotelCode: string; Rooms: Array<Record<string, unknown>> }>;
  };
  const [modelo] = ejemplo.HotelResult;
  if (modelo === undefined) throw new Error('el ejemplo de p. 15 no trae HotelResult');
  return json({
    Status: ejemplo.Status,
    HotelResult: pedido.HotelCodes.split(',').map((code) => ({
      ...modelo,
      HotelCode: code,
      Rooms: modelo.Rooms.map((room, i) => ({
        ...room,
        BookingCode: `${code}!TB!${i + 1}!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b`,
      })),
    })),
  });
}

type CodeList = 'hoteles' | 'sin-hoteles' | 'cae';

function tboFetch(codeList: CodeList): Mock<TboFetch> {
  return vi.fn<TboFetch>((url, init) => {
    const path = url.slice(TBO_BASE_URLS.test.length);
    if (path === TBO_OPERATIONS.tboHotelCodeList.path) {
      if (codeList === 'sin-hoteles') {
        return Promise.resolve(json({ Status: { Code: 500, Description: 'No Hotels Found' } }));
      }
      if (codeList === 'cae') {
        return Promise.resolve(json({ Status: { Code: 500, Description: 'Unexpected Error' } }));
      }
      const lista = fixture('tbo-hotel-code-list.p67.json') as {
        Status: unknown;
        Hotels: Record<string, unknown>[];
      };
      const [modelo] = lista.Hotels;
      // Un segundo hotel sin coordenadas legibles (`0|0`): se guarda sin ubicación.
      return Promise.resolve(
        json({ ...lista, Hotels: [modelo, { ...modelo, HotelCode: '1010100', Map: '0|0' }] }),
      );
    }
    return Promise.resolve(respuestaSearch(init ?? {}));
  });
}

function boveda(): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    if (providerCode !== TBO || ![CONSOLIDADOR, AGENCIA].includes(tenantId)) {
      return Promise.reject(new NotFoundException('sin cuenta'));
    }
    return Promise.resolve({
      id: 'acc-tbo-consolidador',
      ownerTenantId: CONSOLIDADOR,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'usuario-de-test', [CAMPO.clave]: CLAVE_DEMO },
      inherited: tenantId !== CONSOLIDADOR,
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
  };
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(id === CONSOLIDADOR ? 'consolidator' : 'agency');
  return { resolve, ownerTenantType } as unknown as ProviderCredentialsService;
}

interface Banco {
  service: HotelsService;
  fetch: Mock<TboFetch>;
  db: FakeHotelsDb;
  instrument: Mock;
}

function banco(
  opts: {
    codeList?: CodeList;
    flagTbo?: boolean;
    /** Un segundo proveedor de ids propios SIN el puerto de ciudades (el stub anónimo). */
    conStub?: boolean;
    catalogo?: readonly string[];
    bajo?: CatalogoBajoDemanda;
    ciudades?: readonly FilaCiudad[];
  } = {},
): Banco {
  vi.stubEnv('HOTEL_PROVIDER_CALL_POLICIES', `${DESPEGAR}:opt-in`);
  const fetch = tboFetch(opts.codeList ?? 'hoteles');
  const flags: ProviderFlagsPort = hotelFlags(
    (_tenant, code) => (code === TBO && (opts.flagTbo ?? true)) || code === STUB,
  );
  const db = fakeHotelsDb({
    catalogo: { [TBO]: opts.catalogo ?? [] },
    ...(opts.ciudades === undefined ? {} : { ciudades: opts.ciudades }),
    catalogoBajoDemanda: {
      ciudad: { country_code: 'US', hotel_count: null },
      catalogoTrasImportar: { [TBO]: IMPORTADOS },
      ...opts.bajo,
    },
  });
  const instrument = vi.fn(async (_meta: unknown, run: () => Promise<unknown>) => run());
  const service = new HotelsService(
    hotelRegistry(
      [
        fakeDespegarFactory(new FakeDespegarHotelsAdapter()).factory,
        new TboHotelsProviderFactory(boveda(), fetch),
        ...(opts.conStub === true
          ? [new StubHotelProviderFactory({ code: STUB, searchProfile: { idSpace: 'provider' } })]
          : []),
      ],
      flags,
    ),
    db.service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    { assertWithinQuota: () => Promise.resolve(), instrument } as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  return { service, fetch, db, instrument };
}

function buscar(b: Banco, destinationId: string = DESTINO) {
  return b.service.searchAvailability(
    AGENCIA,
    HotelAvailabilityInputSchema.parse({
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: [{ adults: 2, childrenAges: [] }],
      destinationId,
      guestNationality: 'CO',
    }),
  );
}

function llamadasA(fetch: Mock<TboFetch>, path: string): number {
  return fetch.mock.calls.filter(([url]) => url.slice(TBO_BASE_URLS.test.length) === path).length;
}

let warn: MockInstance<Logger['warn']>;
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  vi.stubEnv('PROVIDERS_DISABLED', '');
  vi.stubEnv('PLATFORM_DEFAULT_HOTEL_PROVIDERS', DESPEGAR);
  vi.stubEnv('DESPEGAR_API_KEY', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('una ciudad que el sync nunca cargó se carga al buscarla', () => {
  it('UNA llamada a TBOHotelCodeList, se guarda por la función de 0054 y la búsqueda sigue', async () => {
    const b = banco();

    const res = await buscar(b);

    expect(llamadasA(b.fetch, TBO_OPERATIONS.tboHotelCodeList.path)).toBe(1);
    const [codeList] = b.fetch.mock.calls;
    expect(cuerpoDe(codeList?.[1])).toMatchObject({ CityCode: CIUDAD });
    // Guardada por la función SECURITY DEFINER, con los hoteles del ACL.
    const [importar] = b.db.consultasMarcadas('import-city');
    expect(importar?.parameters.slice(0, 2)).toEqual([TBO, CIUDAD]);
    expect(JSON.parse(String(importar?.parameters[2]))).toEqual([
      expect.objectContaining({ hotelId: '1010099', countryCode: 'US', stars: 3 }),
      expect.objectContaining({ hotelId: '1010100', latitude: null, longitude: null }),
    ]);
    // El texto en inglés que llegó de paso, como `listing`.
    const [listado] = b.db.consultasMarcadas('store-contents');
    expect(JSON.parse(String(listado?.parameters[1]))).toEqual([
      expect.objectContaining({ hotelId: '1010099', lang: 'en', source: 'listing' }),
      expect.objectContaining({ hotelId: '1010100', lang: 'en', source: 'listing' }),
    ]);
    // Y la búsqueda sale con los códigos recién guardados.
    const search = b.fetch.mock.calls.find(
      ([url]) => url.slice(TBO_BASE_URLS.test.length) === TBO_OPERATIONS.search.path,
    );
    expect(cuerpoDe(search?.[1])).toMatchObject({ HotelCodes: '1010099' });
    expect(res.hotels.map((h) => h.hotelId)).toEqual(['1010099']);
    // La demanda del sync cuenta esta ciudad por las claves del catálogo local.
    expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({
      criteria: { destinationProvider: TBO, destinationCityCode: CIUDAD, hotelCount: 1 },
    });
  });

  it('TBO la contesta vacía: 503 que lo dice, sin buscar', async () => {
    const b = banco({
      codeList: 'sin-hoteles',
      bajo: { importar: { outcome: 'empty', active_hotels: 0 } },
    });

    await expect(buscar(b)).rejects.toThrow(CITY_WITHOUT_HOTELS_MESSAGE);
    expect(llamadasA(b.fetch, TBO_OPERATIONS.search.path)).toBe(0);
    // Igual se guarda: la ciudad queda marcada vacía y no se vuelve a sugerir.
    expect(JSON.parse(String(b.db.consultasMarcadas('import-city')[0]?.parameters[2]))).toEqual([]);
  });

  it('TBOHotelCodeList cae: 503 para probar en un rato, sin guardar ni buscar', async () => {
    const b = banco({ codeList: 'cae' });

    const err = await buscar(b).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe(CITY_LOAD_FAILED_MESSAGE);
    expect(b.db.consultasMarcadas('import-city')).toEqual([]);
    expect(llamadasA(b.fetch, TBO_OPERATIONS.search.path)).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.catalog.ciudad_no_cargada',
    );
  });

  it.each([
    ['que TBO ya dio vacía', { country_code: 'US', hotel_count: 0 }],
    ['que el catálogo no conoce', undefined],
  ])('una ciudad %s no se pide: el 503 de siempre', async (_caso, ciudad) => {
    const b = banco({ bajo: { ciudad } });

    await expect(buscar(b)).rejects.toThrow(/todavía no está sincronizado/);
    expect(b.fetch).not.toHaveBeenCalled();
    expect(b.db.consultasMarcadas('import-city')).toEqual([]);
  });

  it('guardada pero sin hoteles activos que buscar: 503 para probar en un rato', async () => {
    const b = banco({ bajo: { catalogoTrasImportar: { [TBO]: [] } } });

    await expect(buscar(b)).rejects.toThrow(CITY_LOAD_FAILED_MESSAGE);
    expect(llamadasA(b.fetch, TBO_OPERATIONS.search.path)).toBe(0);
  });

  it('un proveedor que no sabe listar ciudades no se carga: 503 para probar en un rato', async () => {
    const b = banco({ conStub: true });

    await expect(buscar(b, `${STUB}:C1`)).rejects.toThrow(CITY_LOAD_FAILED_MESSAGE);
    expect(b.db.consultasMarcadas('import-city')).toEqual([]);
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('si guardar la ciudad falla, 503 para probar en un rato y sin buscar', async () => {
    const b = banco({ bajo: { fallan: { 'import-city': new Error('db caída') } } });

    await expect(buscar(b)).rejects.toThrow(CITY_LOAD_FAILED_MESSAGE);
    expect(llamadasA(b.fetch, TBO_OPERATIONS.search.path)).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.catalog.ciudad_no_guardada',
    );
  });

  it('una respuesta de la función que no se entiende cuenta como ciudad desconocida', async () => {
    const b = banco({ bajo: { importar: { outcome: 'raro', active_hotels: 9 } } });
    await expect(buscar(b)).rejects.toThrow(CITY_LOAD_FAILED_MESSAGE);
  });

  it('si el texto en inglés no se puede guardar, la búsqueda sigue igual', async () => {
    const b = banco({ bajo: { fallan: { 'store-contents': new Error('db lenta') } } });

    const res = await buscar(b);

    expect(res.hotels.map((h) => h.hotelId)).toEqual(['1010099']);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.catalog.listing_no_guardado',
    );
  });

  it('si la ciudad no se puede consultar, no se carga: el 503 de siempre', async () => {
    const b = banco({ bajo: { fallan: { city: new Error('db caída') } } });

    await expect(buscar(b)).rejects.toThrow(/todavía no está sincronizado/);
    expect(b.fetch).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.catalog.ciudad_no_consultada',
    );
  });

  it('con TBO apagado para la agencia no se carga nada y la búsqueda dice por qué', async () => {
    const b = banco({ flagTbo: false });

    const res = await buscar(b);

    expect(b.fetch).not.toHaveBeenCalled();
    expect(res.hotels).toEqual([]);
    expect(res.providers.find((p) => p.code === TBO)?.status).toBe('skipped');
  });

  it('dos búsquedas simultáneas de la misma ciudad nueva hacen UNA llamada', async () => {
    const b = banco();
    await Promise.all([buscar(b), buscar(b)]);
    expect(llamadasA(b.fetch, TBO_OPERATIONS.tboHotelCodeList.path)).toBe(1);
  });

  it('una ciudad con hoteles no pasa por nada de esto', async () => {
    const b = banco({ catalogo: ['1120548'] });
    await buscar(b);
    expect(b.db.consultasMarcadas('city')).toEqual([]);
    expect(llamadasA(b.fetch, TBO_OPERATIONS.tboHotelCodeList.path)).toBe(0);
  });
});

describe('la foto principal en la respuesta de disponibilidad', () => {
  const FOTO = 'https://api.tbotechnology.in/imageresource.aspx?img=abc';

  it('la que el catálogo ya tiene, por el proxy propio; sin foto, no viene el campo', async () => {
    const b = banco({
      catalogo: ['1120548', '1402689'],
      bajo: {
        fotos: [
          {
            want_provider: TBO,
            want_hotel: '1120548',
            provider_code: TBO,
            image_count: 7,
            first_images: [FOTO],
          },
        ],
      },
    });

    const res = await buscar(b);

    const [conFoto, sinFoto] = res.hotels;
    expect(conFoto?.mainImage).toEqual({
      url: `${HOTEL_IMAGE_PROXY_PATH}${Buffer.from(FOTO).toString('base64url')}`,
    });
    expect(sinFoto).not.toHaveProperty('mainImage');
    // Nunca la URL del proveedor: en la respuesta no aparece su host.
    expect(JSON.stringify(res)).not.toContain('tbotechnology');
    const [consulta] = b.db.consultasMarcadas('main-images');
    expect(consulta?.parameters.slice(0, 2)).toEqual([
      [TBO, TBO],
      ['1120548', '1402689'],
    ]);
  });

  it('una foto de un proveedor que la plataforma no conoce no sale', async () => {
    const b = banco({
      catalogo: ['1120548'],
      bajo: {
        fotos: [
          {
            want_provider: TBO,
            want_hotel: '1120548',
            provider_code: 'nadie-hotels',
            image_count: 1,
            first_images: [FOTO],
          },
        ],
      },
    });

    const res = await buscar(b);

    expect(res.hotels[0]).not.toHaveProperty('mainImage');
  });

  it('si la consulta de fotos falla, la búsqueda sale igual, sin fotos', async () => {
    const b = banco({
      catalogo: ['1120548'],
      bajo: { fallan: { 'main-images': new Error('db lenta') } },
    });

    const res = await buscar(b);

    expect(res.hotels).toHaveLength(1);
    expect(res.hotels[0]).not.toHaveProperty('mainImage');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.main_images.no_disponible',
    );
  });

  it('en una tarjeta que reúne el mismo hotel de dos proveedores, la foto del que la tenga', () => {
    const sinFoto: HotelOffer = { hotelId: 'D-1', roompacks: [] };
    const conFoto = { hotelId: 'T-1', roompacks: [], mainImage: { url: '/api/hotels/images/x' } };
    const [tarjeta] = mergeProviderOffers(
      [
        { code: DESPEGAR, offers: [sinFoto] },
        { code: TBO, offers: [conFoto] },
      ],
      () => 'canon-1',
    );
    expect(tarjeta?.mainImage).toEqual({ url: '/api/hotels/images/x' });
    expect(tarjeta?.providerHotels).toHaveLength(2);
  });
});

describe('sugerencias: las ciudades sin hoteles cargados salen "se cargan al buscar"', () => {
  it('`hotel_count` en NULL → `loadsOnSearch`; con hoteles, sin la marca', async () => {
    const b = banco({
      ciudades: [
        {
          provider_code: TBO,
          provider_city_code: '1',
          name: 'Oranjestad',
          country_code: 'AW',
          hotel_count: null,
        } as FilaCiudad,
        {
          provider_code: TBO,
          provider_city_code: '2',
          name: 'Bogota',
          country_code: 'CO',
          hotel_count: 40,
        } as FilaCiudad,
      ],
    });

    const items = await b.service.suggest(AGENCIA, 'o');

    expect(items.map((i) => [i.display, i.loadsOnSearch])).toEqual([
      ['Oranjestad', true],
      ['Bogota', undefined],
    ]);
  });
});
