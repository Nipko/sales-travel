import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TenantType } from '../database/database.types.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import type { HotelProviderFactory } from '../providers/hotel-provider.types.js';
import type { ProviderFlagsPort } from '../providers/provider.types.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb, type FakeHotelsDb, type FilaCiudad } from './__fixtures__/fake-hotels-db.js';
import type { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import type { HotelBookingService } from './hotel-booking.service.js';
import type { HotelContentService } from './hotel-content.service.js';
import {
  CATALOG_SUGGESTION_LIMIT,
  CATALOG_SUGGESTION_MIN_SIMILARITY,
} from './hotel-destination.js';
import type { HotelPrebookService } from './hotel-prebook.service.js';
import { HotelOperationUnavailableError } from './hotel-provider-errors.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import { HotelAvailabilityInputSchema } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * Destinos desde el catálogo local cuando la agencia no tiene autocompletado de la plataforma
 * (docs/tbo/05 §8.5; 07 U-02 y Anexo B condición 1).
 *
 * El caso que lo motiva es el stack de certificación: sólo hay credenciales de TBO, Despegar queda
 * `opt-in` apagado y `GET /hotels/suggestions` respondía 503, así que el vendedor no podía elegir
 * destino. Ahora las sugerencias salen de `hotel_provider_city` de los proveedores activos con ids
 * propios, con un id `tbo-hotels:<CityCode>` que la búsqueda resuelve directo a esa ciudad.
 *
 * Todo es real salvo los bordes, como en `hotels.service.tbo-search.test.ts`: el factory, el ACL,
 * el cliente y el mapper de TBO, el registry, el servicio y el controlador. Se doblan la bóveda, el
 * `fetch` de TBO y la base, con el compilador real de Postgres. El orden y el filtro por nombre
 * contra Postgres están en `hotels.catalog-destinations.integration.test.ts`.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const DESPEGAR = 'despegar-hotels';
const TBO = 'tbo-hotels';
const CIUDAD_TBO = '150184';
const DESTINO_TBO = `${TBO}:${CIUDAD_TBO}`;
const CATALOGO_TBO = ['1120548', '1402689'];

const BOGOTA: FilaCiudad = {
  provider_code: TBO,
  provider_city_code: CIUDAD_TBO,
  name: 'Bogota',
  country_code: 'CO',
};

const EJEMPLO_P15 = join(
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
  'search-single-room.p15.json',
);

/** El body JSON de una llamada a TBO: el cliente siempre manda texto. */
function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** El ejemplo de p. 15 con UN hotel por código pedido, cada `BookingCode` distinto. */
function respuestaSearch(init: RequestInit): Response {
  const pedido = cuerpoDe(init) as { HotelCodes: string };
  const ejemplo = JSON.parse(readFileSync(EJEMPLO_P15, 'utf8')) as {
    Status: unknown;
    HotelResult: Array<{ HotelCode: string; Rooms: Array<Record<string, unknown>> }>;
  };
  const [modelo] = ejemplo.HotelResult;
  if (modelo === undefined) throw new Error('el ejemplo de p. 15 no trae HotelResult');
  const HotelResult = pedido.HotelCodes.split(',').map((code) => ({
    ...modelo,
    HotelCode: code,
    Rooms: modelo.Rooms.map((room, i) => ({
      ...room,
      BookingCode: `${code}!TB!${i + 1}!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b`,
    })),
  }));
  return new Response(JSON.stringify({ Status: ejemplo.Status, HotelResult }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** La cuenta TBO del consolidador, heredada por su agencia, o ninguna. */
function boveda(cuentaTbo: boolean): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    if (!cuentaTbo || providerCode !== TBO || ![CONSOLIDADOR, AGENCIA].includes(tenantId)) {
      return Promise.reject(new NotFoundException('sin cuenta'));
    }
    return Promise.resolve({
      id: 'acc-tbo-consolidador',
      ownerTenantId: CONSOLIDADOR,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'usuario-de-test', password: 'Pa55w0rd' },
      inherited: tenantId !== CONSOLIDADOR,
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
  };
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(id === CONSOLIDADOR ? 'consolidator' : 'agency');
  return { resolve, ownerTenantType } as unknown as ProviderCredentialsService;
}

/**
 * Cómo está Despegar para la agencia:
 * - `certificacion`: `opt-in` y apagado, como en `docker-compose.cert.yml` (no toca ni la bóveda);
 * - `sin-cuenta`: habilitado, pero sin cuenta resoluble (`unavailable`);
 * - `activo`: como en producción.
 */
type Despegar = 'certificacion' | 'sin-cuenta' | 'activo';

interface Banco {
  service: HotelsService;
  controller: HotelsController;
  despegar: FakeDespegarHotelsAdapter;
  fetch: Mock<TboFetch>;
  db: FakeHotelsDb;
  instrument: Mock;
}

function banco(
  opts: {
    despegar?: Despegar;
    cuentaTbo?: boolean;
    flagTbo?: boolean;
    ciudades?: readonly FilaCiudad[];
    catalogoTbo?: readonly string[];
  } = {},
): Banco {
  const modo = opts.despegar ?? 'certificacion';
  // El registry lee las políticas al construirse: van antes.
  if (modo === 'certificacion') vi.stubEnv('HOTEL_PROVIDER_CALL_POLICIES', `${DESPEGAR}:opt-in`);

  const despegar = new FakeDespegarHotelsAdapter();
  const fakeDespegar = fakeDespegarFactory(despegar);
  if (modo === 'sin-cuenta') {
    fakeDespegar.resolveForTenant.mockRejectedValue(new NotFoundException('sin cuenta'));
  }
  const fetch = vi.fn<TboFetch>((_url, init) => Promise.resolve(respuestaSearch(init ?? {})));
  const factories: HotelProviderFactory[] = [
    fakeDespegar.factory,
    new TboHotelsProviderFactory(boveda(opts.cuentaTbo ?? true), fetch),
  ];
  const flags: ProviderFlagsPort = hotelFlags(
    (_tenant, code) => code === TBO && (opts.flagTbo ?? true),
  );

  const db = fakeHotelsDb({
    catalogo: { [TBO]: opts.catalogoTbo ?? CATALOGO_TBO },
    ciudades: opts.ciudades ?? [BOGOTA],
  });
  const instrument = vi.fn(async (_meta: unknown, run: () => Promise<unknown>) => run());
  const service = new HotelsService(
    hotelRegistry(factories, flags),
    db.service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    {
      assertWithinQuota: () => Promise.resolve(),
      instrument,
    } as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  const controller = new HotelsController(
    service,
    {} as DespegarHotelReservationsService,
    { resolve: () => Promise.resolve(AGENCIA) } as unknown as ActiveTenantService,
    { effective: () => Promise.resolve(false) } as unknown as ProviderDisclosureService,
    {} as HotelPrebookService,
    {} as HotelBookingService,
    {} as HotelContentService,
  );
  return { service, controller, despegar, fetch, db, instrument };
}

/** `POST /hotels/availability` con el Zod del endpoint, como lo manda la web. */
function buscar(b: Banco, destinationId: string | number): Promise<HotelSearchEnvelope> {
  const body = HotelAvailabilityInputSchema.parse({
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 2, childrenAges: [] }],
    destinationId,
    guestNationality: 'CO',
  });
  return b.controller.availability('user-1', body);
}

function parteDe(res: HotelSearchEnvelope, code: string): HotelProviderOutcome | undefined {
  return res.providers.find((p) => p.code === code);
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  vi.stubEnv('PROVIDERS_DISABLED', '');
  vi.stubEnv('HOTEL_PROVIDER_CALL_POLICIES', '');
  vi.stubEnv('PLATFORM_DEFAULT_HOTEL_PROVIDERS', DESPEGAR);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GET /hotels/suggestions — sin autocompletado de la plataforma, el catálogo local', () => {
  it('U-02: en el stack de certificación sugiere las ciudades de TBO, con id del proveedor y sin llamar a nadie', async () => {
    const b = banco();
    const res = await b.controller.suggestions('user-1', { q: 'Bogotá', locale: 'es_CO' });

    expect(res.items).toEqual([
      { id: DESTINO_TBO, gid: DESTINO_TBO, type: 0, display: 'Bogota', country: 'Colombia' },
    ]);
    expect(b.fetch).not.toHaveBeenCalled();
    expect(b.despegar.suggest).not.toHaveBeenCalled();
  });

  it('la consulta: sólo sus proveedores activos, sólo ciudades con hoteles, por nombre normalizado', async () => {
    const b = banco();
    await b.service.suggest(AGENCIA, '  BOGOTÁ ');

    const [consulta, ...otras] = b.db.consultasA('hotel_provider_city');
    expect(otras).toEqual([]);
    expect(consulta?.sql).toContain('"provider_code" in ($1)');
    expect(consulta?.sql).toContain('"hotel_count" > $2');
    expect(consulta?.sql).toContain('"name_norm" like $3');
    expect(consulta?.sql).toContain('similarity(name_norm, $4) >= $5');
    expect(consulta?.parameters.slice(0, 5)).toEqual([
      TBO,
      0,
      '%bogota%',
      'bogota',
      CATALOG_SUGGESTION_MIN_SIMILARITY,
    ]);
    // Exacta, prefijo, palabra, contiene, parecida; y desempates estables.
    expect(consulta?.parameters.slice(5, 9)).toEqual([
      'bogota',
      'bogota%',
      '% bogota%',
      '%bogota%',
    ]);
    expect(consulta?.sql).toMatch(
      /order by case when name_norm = \$6 then 0\s+when name_norm like \$7 then 1\s+when name_norm like \$8 then 2\s+when name_norm like \$9 then 3\s+else 4 end, similarity\(name_norm, \$10\) desc, "hotel_count" desc, "name", "provider_code", "provider_city_code" limit \$11$/,
    );
    expect(consulta?.parameters.at(-1)).toBe(CATALOG_SUGGESTION_LIMIT);
  });

  it('el país sale en el idioma del vendedor', async () => {
    const lima: FilaCiudad = {
      ...BOGOTA,
      provider_city_code: '1',
      name: 'Lima',
      country_code: 'PE',
    };
    const b = banco({ ciudades: [lima] });

    expect((await b.service.suggest(AGENCIA, 'lima', 'es_PE'))[0]?.country).toBe('Perú');
    expect((await b.service.suggest(AGENCIA, 'lima', 'en_US'))[0]?.country).toBe('Peru');
    expect((await b.service.suggest(AGENCIA, 'lima'))[0]?.country).toBe('Perú');
  });

  it('Despegar habilitado pero sin cuenta resoluble cuenta como ausente: también del catálogo', async () => {
    const b = banco({ despegar: 'sin-cuenta' });

    expect((await b.service.suggest(AGENCIA, 'bogo')).map((s) => s.id)).toEqual([DESTINO_TBO]);
    expect(b.despegar.suggest).not.toHaveBeenCalled();
  });

  it('lo escrito sin letras ni números no consulta nada', async () => {
    const b = banco();

    expect(await b.service.suggest(AGENCIA, '...')).toEqual([]);
    expect(b.db.consultas).toEqual([]);
  });

  it('sin proveedor de la plataforma y TBO sin cuenta → 503 que lo dice, sin tocar el catálogo', async () => {
    const b = banco({ cuentaTbo: false });

    const err = await b.service.suggest(AGENCIA, 'bogo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelOperationUnavailableError);
    expect((err as HotelOperationUnavailableError).message).toContain('sugerencias de destino');
    expect(b.db.consultasA('hotel_provider_city')).toEqual([]);
  });

  it('TBO apagado para la agencia (`opt-in`) no aporta sus ciudades → 503', async () => {
    const b = banco({ flagTbo: false });

    await expect(b.service.suggest(AGENCIA, 'bogo')).rejects.toBeInstanceOf(
      HotelOperationUnavailableError,
    );
    expect(b.db.consultasA('hotel_provider_city')).toEqual([]);
  });
});

describe('GET /hotels/suggestions — con Despegar activo, nada cambia', () => {
  it('las sirve Despegar, con sus ids, y el catálogo local no se consulta aunque TBO esté activo', async () => {
    const b = banco({ despegar: 'activo' });
    const res = await b.service.suggest(AGENCIA, 'bogo', 'es_CO');

    expect(b.despegar.suggest).toHaveBeenCalledWith('bogo', 'es_CO');
    expect(res).toBe(await b.despegar.suggest.mock.results[0]?.value);
    expect(b.db.consultasA('hotel_provider_city')).toEqual([]);
  });

  it('si Despegar está apagado por kill-switch la sugerencia falla con él: no cambia de espacio de ids', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', DESPEGAR);
    const b = banco({ despegar: 'activo' });

    const err = await b.service.suggest(AGENCIA, 'bogo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BreakerRejectionError);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(b.db.consultasA('hotel_provider_city')).toEqual([]);
  });
});

describe('POST /hotels/availability — una ciudad del catálogo local', () => {
  it('U-02: va directo al catálogo de TBO por esa ciudad, sin mapa de destinos, y TBO recibe esos códigos', async () => {
    const b = banco();
    const res = await buscar(b, DESTINO_TBO);

    expect(b.db.consultasA('hotel_destination_map')).toEqual([]);
    const catalogos = b.db.consultasA('hotel_inventory');
    expect(catalogos.map((q) => q.parameters)).toEqual([[TBO, CIUDAD_TBO, true, 100]]);
    expect(catalogos[0]?.sql).toContain('"provider_city_code" in ($2)');
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(cuerpoDe(b.fetch.mock.calls[0]?.[1])).toMatchObject({
      HotelCodes: CATALOGO_TBO.join(','),
    });
    expect(parteDe(res, TBO)).toEqual({ code: TBO, status: 'ok', count: 2 });
    expect(parteDe(res, DESPEGAR)).toMatchObject({
      status: 'skipped',
      skipReason: 'opt-in-disabled',
    });
  });

  it('en search_logs queda el proveedor y su ciudad, nunca como `destinationId` de la plataforma', async () => {
    const b = banco();
    await buscar(b, DESTINO_TBO);

    const { criteria } = b.instrument.mock.calls[0]?.[0] as { criteria: Record<string, unknown> };
    expect(criteria).toMatchObject({
      destinationProvider: TBO,
      destinationCityCode: CIUDAD_TBO,
      hotelCount: CATALOGO_TBO.length,
    });
    expect(criteria).not.toHaveProperty('destinationId');
  });

  it('con Despegar activo, la ciudad de TBO no se le pide a Despegar: `skipped` sin mapeo y sin llamada', async () => {
    const b = banco({ despegar: 'activo' });
    const res = await buscar(b, DESTINO_TBO);

    expect(b.despegar.searchAvailability).not.toHaveBeenCalled();
    expect(parteDe(res, DESPEGAR)).toMatchObject({
      status: 'skipped',
      skipReason: 'no-destination-map',
    });
    expect(parteDe(res, TBO)?.status).toBe('ok');
  });

  it('una ciudad de TBO sin hoteles activos → el 503 de catálogo sin sincronizar, sin llamar', async () => {
    const b = banco({ catalogoTbo: [] });

    await expect(buscar(b, DESTINO_TBO)).rejects.toThrow(/todavía no está sincronizado/);
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('un id con el código de un proveedor de la plataforma no se busca en nadie → 503', async () => {
    const b = banco({ despegar: 'activo' });

    await expect(buscar(b, `${DESPEGAR}:2345`)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(b.db.consultasA('hotel_inventory')).toEqual([]);
    expect(b.despegar.searchAvailability).not.toHaveBeenCalled();
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('un destino numérico sigue siendo de la plataforma: TBO lo traduce por el mapa, como siempre', async () => {
    const b = banco({ despegar: 'activo' });
    await buscar(b, 2345).catch(() => undefined);

    expect(b.db.consultasA('hotel_destination_map').map((q) => q.parameters)).toEqual([
      [DESPEGAR, '2345', TBO, 'accepted'],
    ]);
  });
});
