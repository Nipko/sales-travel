import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NotFoundException } from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
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
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type {
  ProviderSearchSlice,
  SearchTelemetryService,
} from '../search/search-telemetry.service.js';
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
} from './__fixtures__/fake-hotels-db.js';
import type { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import type { HotelBookingService } from './hotel-booking.service.js';
import type { BookingPermissionsService } from '../booking-permissions/booking-permissions.service.js';
import type { HotelContentService } from './hotel-content.service.js';
import type { HotelPrebookService } from './hotel-prebook.service.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import type { HotelAvailabilityInput, HotelDetailInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * TBO en la búsqueda de `/hotels` (docs/tbo/09 PR-2.6; 08 RF-14, RF-33, RF-34, RF-40, RNF-13).
 *
 * Todo es real salvo los bordes: el factory de TBO, su ACL, su cliente HTTP y su mapper, el
 * registry, el servicio y el controlador. Se doblan la bóveda (la cuenta del consolidador,
 * heredada), el `fetch` —que responde con los ejemplos del PDF de PR-1.4, con los `HotelCode` que
 * se pidieron— y la base, con el compilador real de Postgres. El mismo recorrido contra Postgres
 * sembrado está en `hotels.tbo-search.integration.test.ts`, que sólo corre en CI.
 */

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CIUDAD = 2345;
const DESPEGAR = 'despegar-hotels';
const TBO = 'tbo-hotels';

/** Catálogo de Despegar en la ciudad: 101, 205 y 350 tienen cupo en la respuesta grabada. */
const CATALOGO_DESPEGAR = ['101', '205', '350', '412'];
/** Catálogo de TBO en sus ciudades del destino, ya en orden de relevancia. */
const CATALOGO_TBO = ['1120548', '1402689'];
const CIUDADES_TBO = ['150184'];

/** 101 de Despegar y 1120548 de TBO son el mismo hotel (equivalencia aceptada). */
const EQUIVALENCIAS = [
  { canonical_hotel_id: 'canon-andino', provider_code: DESPEGAR, hotel_id: '101' },
  { canonical_hotel_id: 'canon-andino', provider_code: TBO, hotel_id: '1120548' },
];

const FICHAS_TBO = {
  [TBO]: {
    '1120548': {
      name: 'Andino Plaza Bogotá',
      stars: '4.0',
      address: 'Carrera 12 # 93-45 ',
      latitude: 4.6768,
      longitude: -74.0492,
    },
    '1402689': {
      name: 'Hotel Chicó Real',
      stars: '3.5',
      address: 'Calle 94 # 11-20',
      latitude: 4.6781,
      longitude: -74.0455,
    },
  },
};

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

/** El body JSON de una llamada a TBO: el cliente siempre manda texto. */
function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** Lo que salió hacia TBO en esa llamada. */
function cuerpo(fetch: Mock<TboFetch>, llamada = 0): Record<string, unknown> {
  return cuerpoDe(fetch.mock.calls[llamada]?.[1]);
}

/**
 * El ejemplo de una habitación del PDF (p. 15, `search-single-room.p15.json`), con UN hotel por
 * código pedido: TBO responde por los códigos que recibe. Cada `BookingCode` se reescribe con el
 * código del hotel para que no se repitan entre hoteles.
 */
function respuestaSearch(init: RequestInit, extra: Record<string, unknown> = {}): Response {
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
      ...extra,
      BookingCode: `${code}!TB!${i + 1}!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b`,
    })),
  }));
  return json({ Status: base.Status, HotelResult });
}

/**
 * La cuenta TBO del consolidador, heredada por su agencia (D-TBO-03 A). `consultas` anota a nombre
 * de qué tenant se abrió la bóveda.
 */
function boveda(cuentaTbo: boolean, consultas: string[] = []): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    consultas.push(tenantId);
    if (!cuentaTbo || ![CONSOLIDADOR, AGENCIA].includes(tenantId)) {
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

function entrada(overrides: Partial<HotelAvailabilityInput> = {}): HotelAvailabilityInput {
  return {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 2, childrenAges: [] }],
    destinationId: CIUDAD,
    guestNationality: 'CO',
    ...overrides,
  };
}

interface Banco {
  service: HotelsService;
  controller: HotelsController;
  despegar: FakeDespegarHotelsAdapter;
  fetch: Mock<TboFetch>;
  db: FakeHotelsDb;
  breaker: CircuitBreakerService;
  assertWithinQuota: Mock;
  instrument: Mock;
  filas: ProviderSearchSlice[][];
  /** Tenants a cuyo nombre el factory de TBO abrió la bóveda. */
  consultasBoveda: string[];
}

function banco(
  opts: {
    responder?: (init: RequestInit) => Response;
    cuentaTbo?: boolean;
    conTbo?: boolean;
    flags?: ProviderFlagsPort;
  } & Pick<FakeHotelsDbOptions, 'mapa' | 'catalogo' | 'equivalencias' | 'fichas'> = {},
): Banco {
  const fetch = vi.fn<TboFetch>((_url, init) =>
    Promise.resolve((opts.responder ?? respuestaSearch)(init)),
  );
  const despegar = new FakeDespegarHotelsAdapter();
  const factories: HotelProviderFactory[] = [fakeDespegarFactory(despegar).factory];
  const consultasBoveda: string[] = [];
  if (opts.conTbo ?? true) {
    factories.push(
      new TboHotelsProviderFactory(boveda(opts.cuentaTbo ?? true, consultasBoveda), fetch),
    );
  }

  const db = fakeHotelsDb({
    catalogo: opts.catalogo ?? { [DESPEGAR]: CATALOGO_DESPEGAR, [TBO]: CATALOGO_TBO },
    mapa: 'mapa' in opts ? opts.mapa : { [TBO]: CIUDADES_TBO },
    equivalencias: opts.equivalencias ?? EQUIVALENCIAS,
    fichas: opts.fichas ?? FICHAS_TBO,
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
    // TBO es `opt-in`: el flag está encendido salvo que el caso diga otra cosa.
    hotelRegistry(factories, opts.flags ?? hotelFlags(true)),
    db.service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    { assertWithinQuota, instrument } as unknown as SearchTelemetryService,
    breaker,
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  const controller = new HotelsController(
    service,
    {} as DespegarHotelReservationsService,
    { resolve: () => Promise.resolve(AGENCIA) } as unknown as ActiveTenantService,
    // La divulgación en "Ocultar" (el default): RF-40 exige el proveedor igual.
    { effective: () => Promise.resolve(false) } as unknown as ProviderDisclosureService,
    {} as HotelPrebookService,
    {} as HotelBookingService,
    {} as HotelContentService,
    {} as BookingPermissionsService,
  );
  return {
    service,
    controller,
    despegar,
    fetch,
    db,
    breaker,
    assertWithinQuota,
    instrument,
    filas,
    consultasBoveda,
  };
}

function buscar(b: Banco, input: HotelAvailabilityInput = entrada()): Promise<HotelSearchEnvelope> {
  return b.controller.availability('user-1', input);
}

function parteDe(providers: readonly HotelProviderOutcome[], code: string): HotelProviderOutcome {
  const p = providers.find((o) => o.code === code);
  if (!p) throw new Error(`no hay parte de ${code}`);
  return p;
}

function hotelDe(hotels: readonly HotelOffer[], hotelId: string): HotelOffer {
  const h = hotels.find((o) => o.hotelId === hotelId);
  if (!h) throw new Error(`no está el hotel ${hotelId}`);
  return h;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.stubEnv('PROVIDERS_DISABLED', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('TBO en /hotels/availability — a quién y qué se le pide (RF-33, RF-14 CA 1)', () => {
  it('Despegar y TBO consultan el catálogo con SU provider_code; TBO por sus ciudades del mapa', async () => {
    const b = banco();
    await buscar(b);

    const catalogos = b.db.consultasA('hotel_inventory');
    expect(catalogos.map((q) => q.parameters)).toEqual([
      [DESPEGAR, CIUDAD, true, 50],
      [TBO, ...CIUDADES_TBO, true, 100],
    ]);
    expect(catalogos[1]?.sql).toContain('order by "stars" desc nulls last, "hotel_id"');
  });

  it('a TBO le llegan sus códigos del catálogo, en una llamada, con la nacionalidad del vendedor', async () => {
    const b = banco();
    await buscar(b, entrada({ guestNationality: 'VE' }));

    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(cuerpo(b.fetch)).toMatchObject({
      HotelCodes: CATALOGO_TBO.join(','),
      GuestNationality: 'VE',
      IsDetailedResponse: false,
      CheckIn: '2026-11-10',
      CheckOut: '2026-11-12',
    });
  });

  it('RF-33: sin mapeo aceptado TBO queda `skipped` con motivo, sin cable, sin breaker y sin fila de telemetría', async () => {
    const b = banco({ mapa: {} });
    const res = await buscar(b);

    expect(b.fetch).not.toHaveBeenCalled();
    expect(parteDe(res.providers, TBO)).toMatchObject({
      status: 'skipped',
      skipReason: 'no-destination-map',
    });
    expect(parteDe(res.providers, DESPEGAR)).toEqual({ code: DESPEGAR, status: 'ok', count: 3 });
    expect(b.breaker.snapshot()[TBO]).toBeUndefined();
    expect(b.filas[0]?.map((f) => f.providerCode)).toEqual([DESPEGAR]);
  });

  it('RF-33 CA: con TBO sin mapeo, lo de Despegar es idéntico a una plataforma sin TBO', async () => {
    const conTbo = await buscar(banco({ mapa: {} }));
    const sinTbo = await buscar(banco({ conTbo: false }));

    expect(conTbo.hotels).toEqual(sinTbo.hotels);
  });
});

describe('TBO en /hotels/availability — la respuesta combinada (RF-14 CA 2, RF-34, RF-40)', () => {
  /*
   * MUTACIÓN: sin la agrupación, 101 y 1120548 salen como dos tarjetas; sin `provider` por tarifa,
   * la tarjeta atribuye el hotel entero a Despegar.
   */
  it('RF-40 CA 1 y 5: la tarjeta agrupada trae las dos tarifas, cada una con su proveedor, con la divulgación apagada', async () => {
    const res = await buscar(banco());

    expect(res.showProviderInResults).toBe(false);
    const tarjeta = hotelDe(res.hotels, '101');
    expect(new Set(tarjeta.roompacks.map((rp) => rp.provider.name))).toEqual(
      new Set([DESPEGAR, TBO]),
    );
    expect(tarjeta.providerHotels).toEqual([
      { provider: DESPEGAR, hotelId: '101' },
      { provider: TBO, hotelId: '1120548' },
    ]);
    // La tarjeta es de Despegar en sus datos: su nombre, no el del catálogo de TBO.
    expect(tarjeta.name).toBe('Hotel Andino Plaza');
    // El hotel de TBO agrupado no se repite como tarjeta suelta.
    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350', '1402689']);
  });

  it('un hotel sólo de TBO sale con nombre, estrellas, dirección y ubicación de SU catálogo', async () => {
    const res = await buscar(banco());

    const chico = hotelDe(res.hotels, '1402689');
    expect(chico).toMatchObject({
      name: 'Hotel Chicó Real',
      stars: 3.5,
      address: 'Calle 94 # 11-20',
      location: { lat: 4.6781, lng: -74.0455 },
    });
    expect(chico.roompacks.every((rp) => rp.provider.name === TBO)).toBe(true);
    expect(chico.providerHotels).toBeUndefined();
  });

  it('cada tarifa de TBO lleva sólo el `searchId` en `raw` y su piso de precio aplicado', async () => {
    const res = await buscar(banco());

    const tarifa = hotelDe(res.hotels, '1402689').roompacks[0];
    expect(Object.keys(tarifa?.provider.raw ?? {})).toEqual(['searchId']);
    // `RecommendedSellingRate` 160.67 sobre un neto de 152.88 (p. 15): el piso sube la venta.
    expect(tarifa?.price.total).toEqual({ amountMinor: 15_288, currency: 'USD' });
    expect(tarifa?.pricing?.finalMinor).toBe(16_067);
  });

  it('parte por proveedor: los dos `ok` y el booleano de divulgación fuera de la carga', async () => {
    const res = await buscar(banco());

    expect(res.providers).toEqual([
      { code: DESPEGAR, status: 'ok', count: 3 },
      { code: TBO, status: 'ok', count: 2 },
    ]);
  });

  it('RF-14 CA 2: `201` de TBO → `empty`, y los hoteles de Despegar se muestran igual', async () => {
    const b = banco({ responder: () => json(fixture('pdf/search-no-availability.p18.json')) });
    const res = await buscar(b);

    expect(parteDe(res.providers, TBO)).toEqual({ code: TBO, status: 'empty', count: 0 });
    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350']);
    expect(b.breaker.snapshot()[TBO]).toEqual({ state: 'closed', failures: 0 });
  });

  it('RF-14 CA 2: un error de TBO → `error` con motivo humanizado, sin eco, y Despegar igual', async () => {
    const error = fixture('envelope/83-500-unexpected-error.json') as {
      response: { bodyJson: unknown };
    };
    const b = banco({ responder: () => json(error.response.bodyJson) });
    const res = await buscar(b);

    const parte = parteDe(res.providers, TBO);
    expect(parte.status).toBe('error');
    expect(parte.reason).toEqual(expect.any(String));
    expect(parte.reason).not.toContain('Unexpected Error');
    expect(parteDe(res.providers, DESPEGAR)).toEqual({ code: DESPEGAR, status: 'ok', count: 3 });
    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350']);
  });

  it('RNF-09: la búsqueda cuenta UNA vez en la cuota, con una fila por proveedor', async () => {
    const b = banco();
    await buscar(b);

    expect(b.assertWithinQuota).toHaveBeenCalledTimes(1);
    expect(b.instrument).toHaveBeenCalledTimes(1);
    expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({
      providerCodes: [DESPEGAR, TBO],
      criteria: { hotelCount: CATALOGO_DESPEGAR.length + CATALOGO_TBO.length },
    });
    // La nacionalidad no entra en el criterio que se registra (RF-06, RNF-07).
    expect(JSON.stringify(b.instrument.mock.calls[0]?.[0])).not.toContain('guestNationality');
    expect(b.filas[0]?.map((f) => [f.providerCode, f.outcome, f.resultCount])).toEqual([
      [DESPEGAR, 'ok', 3],
      [TBO, 'ok', 2],
    ]);
  });
});

describe('TBO en /hotels/availability — en producción, sin cuenta TBO, no cambia nada', () => {
  it('sin el flag de `opt-in`: TBO `skipped`, ni bóveda ni cable, y Despegar idéntico', async () => {
    const apagado = banco({ flags: hotelFlags(false) });
    const res = await buscar(apagado);
    const sinTbo = await buscar(banco({ conTbo: false }));

    expect(apagado.fetch).not.toHaveBeenCalled();
    // MUTACIÓN: si el registry resolviera la cuenta antes de mirar el flag, esto dejaría de ser [].
    expect(apagado.consultasBoveda).toEqual([]);
    expect(parteDe(res.providers, TBO)).toMatchObject({ skipReason: 'opt-in-disabled' });
    expect(res.hotels).toEqual(sinTbo.hotels);
    expect(parteDe(res.providers, DESPEGAR)).toEqual(parteDe(sinTbo.providers, DESPEGAR));
    // Un solo proveedor aportó: no hay nada que agrupar ni se consultan equivalencias.
    expect(apagado.db.consultasA('hotel_match')).toEqual([]);
  });

  it('con el flag pero sin cuenta en la bóveda: TBO `unavailable` con motivo y ninguna llamada', async () => {
    const b = banco({ cuentaTbo: false });
    const res = await buscar(b);

    // Se buscó la cuenta —el flag está encendido— y no había: no hay escalón de plataforma.
    expect(b.consultasBoveda).toEqual([AGENCIA]);
    expect(b.fetch).not.toHaveBeenCalled();
    expect(parteDe(res.providers, TBO)).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'no-credentials',
    });
    expect(res.hotels.map((o) => o.hotelId)).toEqual(['101', '205', '350']);
  });
});

describe('TBO en /hotels/detail — un Search de un solo código (D-TBO-19 A)', () => {
  const DETALLE: HotelDetailInput = {
    provider: TBO,
    hotelId: '1402689',
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 2, childrenAges: [] }],
    guestNationality: 'CO',
  };

  /** Tramos como los de PreBook (p. 24 y p. 28), que Search sólo manda con el detalle (p. 11). */
  const CON_POLITICAS = (init: RequestInit): Response =>
    respuestaSearch(init, {
      IsRefundable: true,
      CancelPolicies: [
        { FromDate: '01-11-2026 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
        { FromDate: '08-11-2026 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100 },
      ],
    });

  it('pide UN código con respuesta detallada y las políticas salen "sujetas a confirmación"', async () => {
    const b = banco({ responder: CON_POLITICAS });
    const oferta = await b.controller.detail('user-1', DETALLE);

    expect(cuerpo(b.fetch)).toMatchObject({ HotelCodes: '1402689', IsDetailedResponse: true });
    expect(oferta.roompacks.length).toBeGreaterThan(0);
    for (const rp of oferta.roompacks) {
      expect(rp.provider.name).toBe(TBO);
      expect(rp.cancellation.policySource).toBe('search-indicative');
    }
  });

  it('con los datos del hotel del proveedor que vende la tarifa, desde SU catálogo (RF-34)', async () => {
    const b = banco({ responder: CON_POLITICAS });
    const oferta = await b.controller.detail('user-1', { ...DETALLE, hotelId: '1120548' });

    // El nombre es el de TBO, no el de la tarjeta agrupada con Despegar.
    expect(oferta).toMatchObject({
      hotelId: '1120548',
      name: 'Andino Plaza Bogotá',
      stars: 4,
      address: 'Carrera 12 # 93-45',
    });
    expect(b.db.consultasDeFichas().map((q) => q.parameters)).toEqual([[TBO, '1120548']]);
  });
});
