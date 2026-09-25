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
import { fakeHotelsDb, type FakeHotelsDb, type FilaTenant } from './__fixtures__/fake-hotels-db.js';
import {
  AllHotelProvidersFailedError,
  HotelOperationUnavailableError,
  HotelProviderCapabilityError,
} from './hotel-provider-errors.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

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
  } = {},
): Banco {
  const despegar = new FakeDespegarHotelsAdapter();
  const factories: HotelProviderFactory[] = [...(opts.stubs ?? [])];
  if (opts.conDespegar ?? true) factories.push(fakeDespegarFactory(despegar).factory);

  const db = fakeHotelsDb({
    catalogo: opts.catalogo ?? { [DESPEGAR]: CATALOGO_DESPEGAR, [STUB]: CATALOGO_STUB },
    tenant: opts.tenant,
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

  const service = new HotelsService(
    hotelRegistry(factories, opts.flags ?? hotelFlags()),
    db.service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    { assertWithinQuota, instrument } as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
  );
  return { service, despegar, db, assertWithinQuota, instrument, filas };
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
    const b = banco();
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

  it('destino y un proveedor con ciudades propias: `skipped` sin consultar su catálogo (mapa en PR-2.6)', async () => {
    const s = stub({ searchProfile: { idSpace: 'provider' } });
    const b = banco({ stubs: [s] });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(b.db.consultasA('hotel_inventory').map((q) => q.parameters[0])).toEqual([DESPEGAR]);
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
