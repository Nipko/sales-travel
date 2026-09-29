import { Logger } from '@nestjs/common';
import type { HotelOffer, HotelSearchCriteria } from '@sales-travel/canonical';
import type { HotelSuggestPort } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricingService } from '../pricing/pricing.service.js';
import type { HotelProviderFactory } from '../providers/hotel-provider.types.js';
import { ProviderNotAvailableError, type ProviderFlagsPort } from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type {
  ProviderSearchSlice,
  SearchTelemetryService,
} from '../search/search-telemetry.service.js';
import {
  StubHotelProviderFactory,
  stubHotelOffer,
  type StubHotelFactoryOptions,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import {
  fakeHotelsDb,
  type FakeHotelsDb,
  type FakeHotelsDbOptions,
  type FilaTenant,
} from './__fixtures__/fake-hotels-db.js';
import {
  AllHotelProvidersFailedError,
  HotelOperationUnavailableError,
  HotelProviderCapabilityError,
} from './hotel-provider-errors.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';

/**
 * La búsqueda de hoteles con MÁS DE UN proveedor (PR-0.5; RF-13, RF-14, RNF-09, RNF-13).
 *
 * El segundo proveedor es el stub anónimo de `providers/__fixtures__`: estos casos siguen valiendo
 * el día que entre uno real. Despegar entra con su factory real sobre el ACL falso, porque lo que
 * se protege es que siga saliendo igual al lado de otro.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CIUDAD = 2345;
const DESPEGAR = 'despegar-hotels';
const STUB = 'stub-hotels';

/** Catálogo de Despegar en la ciudad: 3 de 4 tienen cupo en la respuesta grabada. */
const CATALOGO_DESPEGAR = ['101', '205', '350', '412'];
const CATALOGO_STUB = ['S-1', 'S-2'];

function entrada(overrides: Partial<HotelAvailabilityInput> = {}): HotelAvailabilityInput {
  return {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    rooms: [
      { adults: 2, childrenAges: [7] },
      { adults: 1, childrenAges: [] },
    ],
    destinationId: CIUDAD,
    ...overrides,
  };
}

interface Banco {
  service: HotelsService;
  despegar: FakeDespegarHotelsAdapter;
  db: FakeHotelsDb;
  breaker: CircuitBreakerService;
  assertWithinQuota: ReturnType<typeof vi.fn>;
  instrument: ReturnType<typeof vi.fn>;
  /** Las filas de telemetría que dejó cada búsqueda que terminó bien. */
  filas: ProviderSearchSlice[][];
}

function banco(
  opts: {
    stubs?: StubHotelProviderFactory[];
    conDespegar?: boolean;
    catalogo?: Record<string, readonly string[]>;
    tenant?: FilaTenant | null;
    flags?: ProviderFlagsPort;
  } & Pick<FakeHotelsDbOptions, 'mapa' | 'fichas' | 'equivalencias' | 'equivalenciasFallan'> = {},
): Banco {
  const despegar = new FakeDespegarHotelsAdapter();
  const factories: HotelProviderFactory[] = [...(opts.stubs ?? [])];
  if (opts.conDespegar ?? true) factories.push(fakeDespegarFactory(despegar).factory);

  const db = fakeHotelsDb({
    catalogo: opts.catalogo ?? { [DESPEGAR]: CATALOGO_DESPEGAR, [STUB]: CATALOGO_STUB },
    tenant: opts.tenant,
    mapa: opts.mapa,
    fichas: opts.fichas,
    equivalencias: opts.equivalencias,
    equivalenciasFallan: opts.equivalenciasFallan,
  });
  const filas: ProviderSearchSlice[][] = [];
  const assertWithinQuota = vi.fn(() => Promise.resolve());
  const instrument = vi.fn(
    async (
      _meta: unknown,
      run: () => Promise<unknown>,
      _countOf: unknown,
      _simulatedOf: unknown,
      breakdownOf: (r: unknown) => ProviderSearchSlice[],
    ) => {
      const r = await run();
      filas.push(breakdownOf(r));
      return r;
    },
  );

  const breaker = new CircuitBreakerService();
  const service = new HotelsService(
    hotelRegistry(factories, opts.flags ?? hotelFlags()),
    db.service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    { assertWithinQuota, instrument } as unknown as SearchTelemetryService,
    breaker,
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  return { service, despegar, db, breaker, assertWithinQuota, instrument, filas };
}

function stub(opts: StubHotelFactoryOptions = {}): StubHotelProviderFactory {
  return new StubHotelProviderFactory({ code: STUB, ...opts });
}

/** El criterio con que el registry le preguntó al stub. */
function criterioDe(f: StubHotelProviderFactory): HotelSearchCriteria {
  const c = vi.mocked(f.adapterFor(TENANT).searchAvailability).mock.calls[0]?.[0];
  if (!c) throw new Error(`${f.code} no recibió ninguna búsqueda`);
  return c;
}

function parteDe(providers: readonly HotelProviderOutcome[], code: string): HotelProviderOutcome {
  const p = providers.find((o) => o.code === code);
  if (!p) throw new Error(`no hay parte de ${code}`);
  return p;
}

function proveedoresDe(hotels: readonly HotelOffer[]): string[] {
  return [...new Set(hotels.flatMap((o) => o.roompacks.map((rp) => rp.provider.name)))];
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('búsqueda combinada — cada proveedor con su catálogo', () => {
  it('cada uno recibe los IDs de SU catálogo, con SU límite', async () => {
    const s = stub();
    const b = banco({ stubs: [s] });
    await b.service.searchAvailability(TENANT, entrada());

    const consultas = b.db.consultasA('hotel_inventory').map((q) => q.parameters);
    expect(consultas).toEqual(
      expect.arrayContaining([
        [DESPEGAR, CIUDAD, true, 50],
        [STUB, CIUDAD, true, 100],
      ]),
    );
    expect(b.despegar.searchAvailability.mock.calls[0]?.[0].hotelIds).toEqual(CATALOGO_DESPEGAR);
    expect(criterioDe(s).hotelIds).toEqual(CATALOGO_STUB);
  });

  it('los hoteles de los dos, en el orden estable del registry, cada tarifa con su proveedor', async () => {
    const b = banco({ stubs: [stub()] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350', 'H-1']);
    expect(proveedoresDe(res.hotels)).toEqual([DESPEGAR, STUB]);
    expect(res.providers).toEqual([
      { code: DESPEGAR, status: 'ok', count: 3 },
      { code: STUB, status: 'ok', count: 1 },
    ]);
  });

  it('RNF-09: dos proveedores → la búsqueda cuenta UNA vez en la cuota, con una fila por proveedor', async () => {
    const b = banco({ stubs: [stub()] });
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.assertWithinQuota).toHaveBeenCalledTimes(1);
    expect(b.instrument).toHaveBeenCalledTimes(1);
    expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({
      providerCodes: [DESPEGAR, STUB],
      criteria: { hotelCount: CATALOGO_DESPEGAR.length + CATALOGO_STUB.length },
    });
    expect(b.filas[0]?.map((f) => [f.providerCode, f.outcome, f.resultCount])).toEqual([
      [DESPEGAR, 'ok', 3],
      [STUB, 'ok', 1],
    ]);
  });

  it('el criterio neutral: moneda de venta, nacionalidad, punto de venta e idioma en minúsculas', async () => {
    const s = stub();
    const b = banco({ stubs: [s], tenant: { default_currency: 'USD', country_code: 'CO' } });
    const rooms = entrada().rooms;
    await b.service.searchAvailability(
      TENANT,
      entrada({ guestNationality: 'AR', language: 'ES', refundableOnly: true, rooms }),
    );

    expect(criterioDe(s)).toEqual({
      hotelIds: CATALOGO_STUB,
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      rooms: [
        { adults: 2, childrenAges: [7] },
        { adults: 1, childrenAges: [] },
      ],
      currency: 'USD',
      guestNationality: 'AR',
      pointOfSaleCountry: 'CO',
      language: 'es',
      refundableOnly: true,
    });
    // Copias: un proveedor que muta su criterio no le cambia la ocupación al siguiente.
    expect(criterioDe(s).rooms[0]).not.toBe(rooms[0]);
  });
});

describe('búsqueda combinada — degradación visible (RNF-13)', () => {
  it('el stub falla → los hoteles de Despegar y el stub en `error` con el motivo de SU factory', async () => {
    const s = stub({ searchImpl: () => Promise.reject(new Error('timeout del stub')) });
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(proveedoresDe(res.hotels)).toEqual([DESPEGAR]);
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'error',
      count: 0,
      reason: `[${STUB}] timeout del stub`,
    });
    expect(parteDe(res.providers, DESPEGAR).status).toBe('ok');
    expect(b.filas[0]?.find((f) => f.providerCode === STUB)).toMatchObject({
      outcome: 'error',
      errorCode: 'ProviderCallError',
    });
  });

  it('fallan todos → 502 con el motivo de cada uno', async () => {
    const s = stub({ searchImpl: () => Promise.reject(new Error('caído')) });
    const b = banco({ stubs: [s] });
    b.despegar.searchAvailability.mockRejectedValue(new Error('también caído'));

    const err = await b.service.searchAvailability(TENANT, entrada()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllHotelProvidersFailedError);
    expect((err as AllHotelProvidersFailedError).failures.map((f) => f.code)).toEqual([
      DESPEGAR,
      STUB,
    ]);
    expect((err as AllHotelProvidersFailedError).getStatus()).toBe(502);
  });

  it('uno falla y el otro responde sin hoteles: no es 502, es una lista vacía EXPLICADA', async () => {
    const s = stub({ offers: [] });
    const b = banco({ stubs: [s] });
    b.despegar.searchAvailability.mockRejectedValue(new Error('caído'));

    const res = await b.service.searchAvailability(TENANT, entrada());
    expect(res.hotels).toEqual([]);
    expect(res.providers.map((p) => [p.code, p.status])).toEqual([
      [DESPEGAR, 'error'],
      [STUB, 'empty'],
    ]);
  });

  it('stub `opt-in` con el flag apagado → `skipped` sin llamarlo ni resolver su cuenta', async () => {
    const s = stub({ callPolicy: 'opt-in' });
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(s.resolveCalls).toEqual([]);
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'skipped',
      count: 0,
      skipReason: 'opt-in-disabled',
      reason: 'Este proveedor no está activado para esta agencia.',
    });
    expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({ providerCodes: [DESPEGAR] });
    expect(b.filas[0]?.map((f) => f.providerCode)).toEqual([DESPEGAR]);
  });

  it('stub `opt-in` con el flag encendido para el tenant → se lo llama', async () => {
    const s = stub({ callPolicy: 'opt-in' });
    const b = banco({ stubs: [s], flags: hotelFlags((t, c) => t === TENANT && c === STUB) });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(parteDe(res.providers, STUB).status).toBe('ok');
  });

  it('un proveedor sin cuenta aparece `unavailable` con el motivo para el vendedor', async () => {
    const b = banco({ stubs: [stub({ failResolve: true })] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    const parte = parteDe(res.providers, STUB);
    expect(parte).toMatchObject({ status: 'unavailable', unavailableReason: 'no-credentials' });
    expect(parte.reason).toContain('Mi Red → Credenciales');
  });

  it('sin nadie a quien llamar: 200 sin hoteles, con el motivo de cada uno, y la búsqueda se registra', async () => {
    const b = banco({ stubs: [stub({ callPolicy: 'opt-in' })], conDespegar: false });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res).toEqual({
      hotels: [],
      providers: [expect.objectContaining({ code: STUB, skipReason: 'opt-in-disabled' })],
    });
    expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({ providerCodes: [] });
    expect(b.filas).toEqual([[]]);
  });
});

describe('búsqueda combinada — circuito por cuenta y destinatario del motivo (RNF-03)', () => {
  /** Un rechazo de la CUENTA con la forma que declaran los ACL en `failure.circuit`. */
  function cuentaRechazada(): Error {
    return Object.assign(new Error('credencial rechazada'), {
      failure: { circuit: 'OPEN_ACCOUNT', kind: 'CREDENTIALS_INVALID' },
    });
  }

  /*
   * MUTACIÓN: sin `provider.circuit` en la llamada del fan-out, el rechazo cuenta como caída del
   * código y la segunda búsqueda vuelve a salir al proveedor con la misma cuenta rechazada.
   */
  it('lo que el factory declara para el breaker llega a la búsqueda: el rechazo pausa SU cuenta y Despegar sigue', async () => {
    const s = stub({
      circuit: { accountRef: 'acct-1' },
      searchImpl: () => Promise.reject(cuentaRechazada()),
    });
    const b = banco({ stubs: [s] });

    await b.service.searchAvailability(TENANT, entrada());
    const segunda = await b.service.searchAvailability(TENANT, entrada());

    expect(s.adapterFor(TENANT).searchAvailability).toHaveBeenCalledTimes(1);
    expect(parteDe(segunda.providers, STUB)).toMatchObject({ status: 'error' });
    expect(parteDe(segunda.providers, STUB).reason).toContain('rechazó la cuenta');
    expect(parteDe(segunda.providers, DESPEGAR).status).toBe('ok');
  });

  it('el motivo se humaniza sabiendo de quién es la credencial: heredada no es propia', async () => {
    const s = stub({
      credentialSource: 'inherited',
      searchImpl: () => Promise.reject(new Error('rechazo')),
    });
    const humanize = vi.spyOn(s, 'humanizeError');
    const b = banco({ stubs: [s] });

    await b.service.searchAvailability(TENANT, entrada());

    expect(humanize).toHaveBeenCalledWith(expect.any(Error), { credentialSource: 'inherited' });
  });
});

describe('búsqueda combinada — puerta de moneda (RF-13)', () => {
  const COP = 'alfa-hotels';
  const USD = 'zeta-hotels';

  function dosMonedas(): Banco {
    return banco({
      conDespegar: false,
      stubs: [
        new StubHotelProviderFactory({ code: COP, currency: 'COP' }),
        new StubHotelProviderFactory({ code: USD, currency: 'USD' }),
      ],
      catalogo: { [COP]: ['A-1'], [USD]: ['Z-1'] },
      // Una agencia en COP: puede buscar en COP o en USD (D-TBO-15, selector de moneda).
      tenant: { default_currency: 'COP', country_code: 'CO' },
    });
  }

  it('CA 1: el stub en USD con búsqueda en COP → `skipped` con el motivo de moneda', async () => {
    const b = dosMonedas();
    const res = await b.service.searchAvailability(TENANT, entrada({ currency: 'COP' }));

    expect(proveedoresDe(res.hotels)).toEqual([COP]);
    const parte = parteDe(res.providers, USD);
    expect(parte).toMatchObject({
      status: 'skipped',
      skipReason: 'currency-mismatch',
      droppedForCurrency: 1,
    });
    expect(parte.reason).toContain('Cotiza en USD y esta búsqueda es en COP');
    // Se le llamó: su fila de telemetría existe y no dice "sin hoteles".
    expect(b.filas[0]?.find((f) => f.providerCode === USD)).toMatchObject({
      outcome: 'error',
      errorCode: 'CurrencyMismatch',
    });
  });

  it('CA 2: al cambiar la búsqueda a USD, sus tarifas aparecen', async () => {
    const b = dosMonedas();
    const res = await b.service.searchAvailability(TENANT, entrada({ currency: 'USD' }));

    expect(proveedoresDe(res.hotels)).toEqual([USD]);
    expect(parteDe(res.providers, USD).status).toBe('ok');
  });

  it('sin moneda en la búsqueda manda la del tenant, normalizada', async () => {
    const b = banco({
      conDespegar: false,
      stubs: [new StubHotelProviderFactory({ code: COP, currency: 'COP' })],
      catalogo: { [COP]: ['A-1'] },
      tenant: { default_currency: 'cop ', country_code: 'CO' },
    });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(parteDe(res.providers, COP).status).toBe('ok');
  });

  it('un pack de Despegar en otra moneda ahora se explica en `providers[]` (cambio declarado)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco({ tenant: { default_currency: 'COP', country_code: 'CO' } });
    const res = await b.service.searchAvailability(TENANT, entrada({ currency: 'COP' }));

    // La respuesta grabada de Despegar viene en USD: con una búsqueda en COP no hay nada que
    // mostrar, y el vendedor lo lee como moneda, no como "sin disponibilidad".
    expect(res.hotels).toEqual([]);
    expect(parteDe(res.providers, DESPEGAR)).toMatchObject({
      status: 'skipped',
      skipReason: 'currency-mismatch',
      droppedForCurrency: 3,
    });
    expect(warn).toHaveBeenCalledWith(
      'hotels.currency_mismatch provider=despegar-hotels expected=COP dropped=3',
    );
  });
});

describe('búsqueda combinada — a quién se le pregunta', () => {
  it('un proveedor sin catálogo para el destino queda `skipped` y el otro busca', async () => {
    const s = stub();
    const b = banco({ stubs: [s], catalogo: { [DESPEGAR]: CATALOGO_DESPEGAR } });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(s.resolveCalls).toEqual([TENANT]);
    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toMatchObject({
      status: 'skipped',
      skipReason: 'catalog-empty',
    });
    expect(parteDe(res.providers, DESPEGAR).status).toBe('ok');
  });

  it('IDs escritos a mano: van a los de la plataforma y NO a uno con ids propios', async () => {
    const s = stub({ searchProfile: { idSpace: 'provider' } });
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada({ hotelIds: ['101'] }));

    expect(b.despegar.searchAvailability.mock.calls[0]?.[0].hotelIds).toEqual(['101']);
    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toMatchObject({
      status: 'skipped',
      skipReason: 'foreign-hotel-ids',
    });
  });

  it('PR-2.6: destino sin mapeo a las ciudades de un proveedor con ids propios → `skipped` sin consultar su catálogo', async () => {
    const s = stub({ searchProfile: { idSpace: 'provider' } });
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(b.db.consultasA('hotel_destination_map').map((q) => q.parameters[2])).toEqual([STUB]);
    expect(b.db.consultasA('hotel_inventory').map((q) => q.parameters[0])).toEqual([DESPEGAR]);
    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toMatchObject({
      status: 'skipped',
      skipReason: 'no-destination-map',
    });
  });

  it('topes de ocupación: el que no admite la ocupación queda fuera con motivo y Despegar responde', async () => {
    const s = stub({ searchProfile: { occupancy: { maxChildrenPerRoom: 0 } } });
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'skipped',
      count: 0,
      skipReason: 'occupancy-limits',
      reason: 'Admite hasta 0 niños por habitación.',
    });
    expect(parteDe(res.providers, DESPEGAR).status).toBe('ok');
  });
});

describe('búsqueda combinada — proveedor con ciudades propias (RF-33, RF-14; PR-2.6)', () => {
  /** Un proveedor con el perfil de TBO en lo que importa aquí, sin su nacionalidad obligatoria. */
  function propio(opts: StubHotelFactoryOptions = {}): StubHotelProviderFactory {
    return stub({
      searchProfile: { idSpace: 'provider', catalogOrder: 'relevance', contentFromCatalog: true },
      ...opts,
    });
  }

  const MAPA = { [STUB]: ['C-150184', 'C-150185'] };

  it('RF-33: el destino se traduce con las filas ACEPTADAS del mapa, desde el espacio de Despegar', async () => {
    const b = banco({ stubs: [propio()], mapa: MAPA });
    await b.service.searchAvailability(TENANT, entrada());

    const [mapa] = b.db.consultasA('hotel_destination_map');
    expect(mapa?.sql).toBe(
      'select "target_city_code" from "hotel_destination_map" where "source_provider_code" = $1 and "source_city_id" = $2 and "target_provider_code" = $3 and "status" = $4 order by "target_city_code"',
    );
    expect(mapa?.parameters).toEqual([DESPEGAR, String(CIUDAD), STUB, 'accepted']);
  });

  it('RF-14 CA 1: sus hoteles salen de SU catálogo por SUS ciudades, hasta 100 y por relevancia', async () => {
    const s = propio();
    const b = banco({ stubs: [s], mapa: MAPA });
    await b.service.searchAvailability(TENANT, entrada());

    const suyas = b.db.consultasA('hotel_inventory').filter((q) => q.parameters[0] === STUB);
    expect(suyas.map((q) => q.sql)).toEqual([
      'select "hotel_id" from "hotel_inventory" where "provider_code" = $1 and "provider_city_code" in ($2, $3) and "active" = $4 order by "stars" desc nulls last, "hotel_id" limit $5',
    ]);
    expect(suyas[0]?.parameters).toEqual([STUB, 'C-150184', 'C-150185', true, 100]);
    expect(criterioDe(s).hotelIds).toEqual(CATALOGO_STUB);
    // Despegar sigue con su ciudad, su orden por id y su límite de 50.
    expect(b.db.consultasA('hotel_inventory').map((q) => q.parameters)).toContainEqual([
      DESPEGAR,
      CIUDAD,
      true,
      50,
    ]);
  });

  /*
   * MUTACIÓN: sin la consulta del mapa, el proveedor quedaría `skipped` para siempre; con el mapa
   * sin filtrar por `status`, una fila `ambiguous` mezclaría ciudades vecinas.
   */
  it('RF-33 CA: sin mapeo aceptado no se le pregunta, queda `skipped` con motivo y el breaker no se entera', async () => {
    const s = propio();
    const b = banco({ stubs: [s] });
    const execute = vi.spyOn(b.breaker, 'execute');

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'skipped',
      count: 0,
      skipReason: 'no-destination-map',
      reason: 'Este destino todavía no está vinculado con las ciudades de este proveedor.',
    });
    expect(execute.mock.calls.map(([code]) => code)).toEqual([DESPEGAR]);
    expect(b.breaker.snapshot()[STUB]).toBeUndefined();
    // No es un fallo: no deja fila de telemetría ni cuenta como consultado.
    expect(b.filas[0]?.map((f) => f.providerCode)).toEqual([DESPEGAR]);
  });

  it('RF-33 CA: un destino sólo de Despegar no cambia', async () => {
    const conPropio = await banco({ stubs: [propio()] }).service.searchAvailability(
      TENANT,
      entrada(),
    );
    const soloDespegar = await banco().service.searchAvailability(TENANT, entrada());

    expect(conPropio.hotels).toEqual(soloDespegar.hotels);
    expect(parteDe(conPropio.providers, DESPEGAR)).toEqual(
      parteDe(soloDespegar.providers, DESPEGAR),
    );
  });

  it('con orden por id, sus ciudades se leen igual que el catálogo de Despegar: por `hotel_id`', async () => {
    const b = banco();
    await b.service.resolveProviderCityHotelIds(STUB, ['C-1'], 10);

    const [q] = b.db.consultasA('hotel_inventory');
    expect(q?.sql).toBe(
      'select "hotel_id" from "hotel_inventory" where "provider_code" = $1 and "provider_city_code" in ($2) and "active" = $3 order by "hotel_id" limit $4',
    );
    expect(q?.parameters).toEqual([STUB, 'C-1', true, 10]);
  });

  it('un proveedor de la plataforma con orden por relevancia lo aplica sobre `city_id`', async () => {
    const b = banco();
    await b.service.resolveCityHotelIds(STUB, CIUDAD, 100, 'relevance');

    expect(b.db.consultasA('hotel_inventory')[0]?.sql).toBe(
      'select "hotel_id" from "hotel_inventory" where "provider_code" = $1 and "city_id" = $2 and "active" = $3 order by "stars" desc nulls last, "hotel_id" limit $4',
    );
  });

  it('un hotel que el catálogo todavía no tiene sale como llegó, y el log cuenta cuántos', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco({ stubs: [propio()], mapa: MAPA });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.find((o) => o.hotelId === 'H-1')).not.toHaveProperty('name');
    expect(warn).toHaveBeenCalledWith(`hotels.catalog_content.sin_nombre provider=${STUB} count=1`);
  });

  it('mapeo aceptado pero ciudades sin hoteles activos → `catalog-empty`, no "sin mapeo"', async () => {
    const b = banco({ stubs: [propio()], mapa: MAPA, catalogo: { [DESPEGAR]: CATALOGO_DESPEGAR } });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(parteDe(res.providers, STUB)).toMatchObject({
      status: 'skipped',
      skipReason: 'catalog-empty',
    });
  });

  it('sólo el proveedor con ids propios tiene el destino: busca él y no hay 503', async () => {
    const b = banco({ stubs: [propio()], mapa: MAPA, catalogo: { [STUB]: CATALOGO_STUB } });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(parteDe(res.providers, STUB).status).toBe('ok');
    expect(parteDe(res.providers, DESPEGAR).skipReason).toBe('catalog-empty');
  });

  it('nombre, estrellas, dirección y ubicación de SU fila del catálogo; Despegar no se completa', async () => {
    const b = banco({
      stubs: [propio()],
      mapa: MAPA,
      fichas: {
        [STUB]: {
          'H-1': {
            name: 'Hotel Del Stub',
            stars: '4.5',
            address: 'Calle 5 # 10-20   ',
            latitude: 4.6,
            longitude: -74.07,
          },
        },
      },
    });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.find((o) => o.hotelId === 'H-1')).toMatchObject({
      name: 'Hotel Del Stub',
      stars: 4.5,
      address: 'Calle 5 # 10-20',
      location: { lat: 4.6, lng: -74.07 },
    });
    expect(b.db.consultasDeFichas().map((q) => q.parameters)).toEqual([[STUB, 'H-1']]);
    expect(b.db.consultasDeFichas()[0]?.sql).toBe(
      'select "hotel_id", "name", "stars", "address", "latitude", "longitude" from "hotel_inventory" where "provider_code" = $1 and "hotel_id" in ($2)',
    );
  });
});

describe('búsqueda combinada — el mismo hotel en dos proveedores (RF-34, RF-40; PR-2.6)', () => {
  const EQUIVALENCIAS = [
    { canonical_hotel_id: 'canon-101', provider_code: DESPEGAR, hotel_id: '101' },
    { canonical_hotel_id: 'canon-101', provider_code: STUB, hotel_id: 'H-1' },
  ];

  it('una tarjeta con las tarifas de los dos, cada una con su `provider.name`', async () => {
    const b = banco({ stubs: [stub()], equivalencias: EQUIVALENCIAS });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350']);
    const tarjeta = res.hotels[0] as HotelOffer;
    expect(tarjeta.name).toBe('Hotel Andino Plaza');
    expect(tarjeta.roompacks.map((rp) => rp.provider.name)).toEqual([DESPEGAR, DESPEGAR, STUB]);
    expect(tarjeta.providerHotels).toEqual([
      { provider: DESPEGAR, hotelId: '101' },
      { provider: STUB, hotelId: 'H-1' },
    ]);
    // `providers[]` sigue contando lo que aportó cada uno.
    expect(res.providers).toEqual([
      { code: DESPEGAR, status: 'ok', count: 3 },
      { code: STUB, status: 'ok', count: 1 },
    ]);
  });

  it('pide sólo equivalencias aceptadas de los hoteles de esta respuesta', async () => {
    const b = banco({ stubs: [stub()], equivalencias: EQUIVALENCIAS });
    await b.service.searchAvailability(TENANT, entrada());

    const [q] = b.db.consultasA('hotel_match');
    expect(q?.sql).toBe(
      'select "provider_code", "hotel_id", "canonical_hotel_id" from "hotel_match" where "status" = $1 and (("provider_code" = $2 and "hotel_id" in ($3, $4, $5)) or ("provider_code" = $6 and "hotel_id" in ($7)))',
    );
    expect(q?.parameters).toEqual(['accepted', DESPEGAR, '101', '205', '350', STUB, 'H-1']);
  });

  it('con hoteles de un solo proveedor no hay nada que agrupar: no se consultan equivalencias', async () => {
    const b = banco({ stubs: [stub({ callPolicy: 'opt-in' })], equivalencias: EQUIVALENCIAS });
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.db.consultasA('hotel_match')).toEqual([]);
  });

  it('si las equivalencias no se pueden leer, responde sin agrupar y lo avisa en el log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco({ stubs: [stub()], equivalenciasFallan: new Error('conexión perdida') });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350', 'H-1']);
    expect(warn).toHaveBeenCalledWith('hotels.hotel_match.no_disponible: se responde sin agrupar');
    // Nada del error del driver, que puede citar los parámetros de la consulta.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('conexión perdida');
  });
});

describe('búsqueda combinada — respuesta parcial de un proveedor (RF-14 CA 3; PR-2.6)', () => {
  const SEARCH_ID = '6110a41c-558c-405c-a0d3-6bdd3e131146';

  /** El stub con búsqueda con contexto que avisa que un tramo no respondió. */
  function parcial(causa: unknown): StubHotelProviderFactory {
    const s = stub();
    const oferta = stubHotelOffer(STUB);
    Object.assign(s.adapterFor(TENANT), {
      searchAccount: { accountId: 'acc-1', updatedAt: '2026-09-01T00:00:00.000Z' },
      searchAvailabilityWithContext: vi.fn(() =>
        Promise.resolve({
          searchId: SEARCH_ID,
          searchSentAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          packs: [
            {
              hotelId: 'H-1',
              offerRef: `${STUB}-H-1-REF`,
              totalText: '1000.00',
              currency: 'USD',
            },
          ],
          offers: [oferta],
          partial: { cause: causa },
        }),
      ),
    });
    return s;
  }

  it('lo que respondió se muestra y la parte dice qué faltó, con el motivo de SU factory', async () => {
    const b = banco({ stubs: [parcial(new Error('lote 2 sin tiempo'))] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(proveedoresDe(res.hotels)).toEqual([DESPEGAR, STUB]);
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'ok',
      count: 1,
      partial: true,
      reason: `Parte de sus hoteles no se pudo consultar: [${STUB}] lote 2 sin tiempo`,
    });
  });

  it('una respuesta completa no lleva `partial`', async () => {
    const b = banco({ stubs: [stub()] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(parteDe(res.providers, STUB)).not.toHaveProperty('partial');
  });
});

describe('búsqueda combinada — nacionalidad y topes de un proveedor como TBO (RF-06, PR-2.4)', () => {
  /** El perfil que declara TBO, en el espacio de ids de la plataforma para llegar hasta aquí. */
  function comoTbo(opts: StubHotelFactoryOptions = {}): StubHotelProviderFactory {
    return stub({
      searchProfile: { requiresGuestNationality: true, occupancy: { maxChildrenPerRoom: 4 } },
      ...opts,
    });
  }

  it('RF-06 CA 1: sin nacionalidad → `skipped` con motivo, sin llamarlo, y Despegar responde igual', async () => {
    const s = comoTbo();
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'skipped',
      count: 0,
      skipReason: 'guest-nationality-missing',
      reason:
        'Cotiza según la nacionalidad del pasajero principal: indicala en la búsqueda para ver sus tarifas.',
    });
    expect(parteDe(res.providers, DESPEGAR)).toEqual({ code: DESPEGAR, status: 'ok', count: 3 });
    expect(proveedoresDe(res.hotels)).toEqual([DESPEGAR]);
    // No se le preguntó nada: ni cuenta en la cuota como consultado ni deja fila de telemetría.
    expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({ providerCodes: [DESPEGAR] });
    expect(b.filas[0]?.map((f) => f.providerCode)).toEqual([DESPEGAR]);
  });

  it('nunca un valor por defecto: el país de la agencia no la reemplaza', async () => {
    const s = comoTbo();
    const b = banco({ stubs: [s], tenant: { default_currency: 'USD', country_code: 'CO' } });
    const res = await b.service.searchAvailability(TENANT, entrada({ countryCode: 'CO' }));

    expect(parteDe(res.providers, STUB).skipReason).toBe('guest-nationality-missing');
    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
  });

  it('con nacionalidad, busca y recibe exactamente la que indicó el vendedor', async () => {
    const s = comoTbo();
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada({ guestNationality: 'VE' }));

    expect(parteDe(res.providers, STUB).status).toBe('ok');
    expect(criterioDe(s).guestNationality).toBe('VE');
  });

  it('habitación con 5 niños → `skipped` "hasta 4 niños" y Despegar responde con la ocupación entera', async () => {
    const s = comoTbo();
    const b = banco({ stubs: [s] });
    const rooms = [{ adults: 2, childrenAges: [1, 3, 5, 7, 9] }];
    const res = await b.service.searchAvailability(
      TENANT,
      entrada({ rooms, guestNationality: 'CO' }),
    );

    expect(vi.mocked(s.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, STUB)).toEqual({
      code: STUB,
      status: 'skipped',
      count: 0,
      skipReason: 'occupancy-limits',
      reason: 'Admite hasta 4 niños por habitación.',
    });
    expect(parteDe(res.providers, DESPEGAR).status).toBe('ok');
    // No se trunca ni se reparte: Despegar cotiza los cinco niños.
    expect(b.despegar.searchAvailability.mock.calls[0]?.[0].rooms).toEqual(rooms);
  });

  it('el único proveedor activo exige nacionalidad y no la hay: 200 explicado, no 502', async () => {
    const b = banco({ stubs: [comoTbo()], conDespegar: false });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res).toEqual({
      hotels: [],
      providers: [expect.objectContaining({ code: STUB, skipReason: 'guest-nationality-missing' })],
    });
  });
});

describe('búsqueda combinada — proveedores de respaldo', () => {
  const RESPALDO = 'zz-fallback-hotels';

  function respaldo(): StubHotelProviderFactory {
    return new StubHotelProviderFactory({ code: RESPALDO, callPolicy: 'fallback' });
  }

  it('la primera ola trajo menos de 5 hoteles → se llama al de respaldo', async () => {
    const r = respaldo();
    const b = banco({
      stubs: [r],
      catalogo: { [DESPEGAR]: CATALOGO_DESPEGAR, [RESPALDO]: ['F-1'] },
    });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(parteDe(res.providers, RESPALDO).status).toBe('ok');
    // Después de la primera ola: sus hoteles van al final.
    expect(res.hotels.at(-1)?.roompacks[0]?.provider.name).toBe(RESPALDO);
  });

  it('la primera ola trajo suficiente → el de respaldo queda `skipped` sin llamarlo', async () => {
    const r = respaldo();
    const cinco = ['1', '2', '3', '4', '5'].map((id) => stubHotelOffer(STUB, { hotelId: id }));
    const b = banco({
      stubs: [stub({ offers: cinco }), r],
      conDespegar: false,
      catalogo: { [STUB]: ['1'], [RESPALDO]: ['F-1'] },
    });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(vi.mocked(r.adapterFor(TENANT).searchAvailability)).not.toHaveBeenCalled();
    expect(parteDe(res.providers, RESPALDO)).toMatchObject({
      status: 'skipped',
      skipReason: 'fallback-not-needed',
    });
    expect(b.filas[0]?.map((f) => f.providerCode)).toEqual([STUB]);
  });

  it('si la primera ola falló entera y el respaldo responde, no es 502', async () => {
    const r = respaldo();
    const b = banco({
      stubs: [r],
      catalogo: { [DESPEGAR]: CATALOGO_DESPEGAR, [RESPALDO]: ['F-1'] },
    });
    b.despegar.searchAvailability.mockRejectedValue(new Error('caído'));

    const res = await b.service.searchAvailability(TENANT, entrada());
    expect(res.providers.map((p) => [p.code, p.status])).toEqual([
      [DESPEGAR, 'error'],
      [RESPALDO, 'ok'],
    ]);
  });
});

describe('sugerencias y detalle — por capacidad', () => {
  it('las sugerencias las da el primer proveedor de la plataforma que sabe darlas', async () => {
    // `alfa` va antes que Despegar pero no sugiere; `beta` sugiere pero tiene ids propios.
    const beta = stub({ code: 'beta-hotels', searchProfile: { idSpace: 'provider' } });
    const sugerirBeta = vi.fn(() => Promise.resolve([]));
    Object.assign(beta.adapterFor(TENANT), {
      suggestDestinations: sugerirBeta,
    } satisfies HotelSuggestPort);
    const b = banco({ stubs: [stub({ code: 'alfa-hotels' }), beta] });

    await b.service.suggest(TENANT, 'bogo');

    expect(b.despegar.suggest).toHaveBeenCalledWith('bogo', undefined);
    expect(sugerirBeta).not.toHaveBeenCalled();
  });

  it('sin ningún proveedor que sugiera → 503 que lo dice', async () => {
    const b = banco({ stubs: [stub()], conDespegar: false });

    const err = await b.service.suggest(TENANT, 'bogo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelOperationUnavailableError);
    expect((err as HotelOperationUnavailableError).getStatus()).toBe(503);
    expect((err as HotelOperationUnavailableError).message).toContain('sugerencias de destino');
  });

  const detalle = {
    hotelId: 'S-1',
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    rooms: [{ adults: 2, childrenAges: [] }],
  };

  it('detalle de un proveedor nombrado que no da tarifas por hotel → 400', async () => {
    const b = banco({ stubs: [stub()] });

    const err = await b.service
      .getHotelDetail(TENANT, { ...detalle, provider: STUB })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelProviderCapabilityError);
    expect((err as HotelProviderCapabilityError).message).toBe(
      `El proveedor '${STUB}' no ofrece el detalle de tarifas de un hotel.`,
    );
  });

  it('detalle de un proveedor que la agencia no tiene → 400 del registry', async () => {
    const b = banco();

    await expect(
      b.service.getHotelDetail(TENANT, { ...detalle, provider: 'otro-hotels' }),
    ).rejects.toBeInstanceOf(ProviderNotAvailableError);
  });
});
