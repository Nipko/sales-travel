import { Logger, NotFoundException } from '@nestjs/common';
import type { HotelOffer, HotelSearchCriteria } from '@sales-travel/canonical';
import type { SearchContext } from '@sales-travel/domain';
import type { TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantType } from '../database/database.types.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type { TboHotelProviderAdapter } from '../providers-tbo/tbo-hotel-provider.adapter.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import {
  StubHotelProviderFactory,
  stubHotelOffer,
  type StubHotelAdapter,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelProviderAccountFingerprint,
  HotelProviderFactory,
  HotelSearchPackContext,
  HotelSearchWithContext,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  fakeDespegarFactory,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb } from './__fixtures__/fake-hotels-db.js';
import {
  HotelSearchAccountChangedError,
  HotelSearchContextExpiredError,
  HotelSearchContextStore,
} from './hotel-search-context.store.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import type { HotelAvailabilityInput, HotelDetailInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * `HotelsService` guarda el contexto de cada búsqueda de un proveedor que lo necesita
 * (docs/tbo/09 PR-2.3; 08 RF-08, RF-06 CA-4, RNF-06 punto 2).
 *
 * Dos bancos: el stub anónimo con el puerto de contexto, para la regla general del servicio, y
 * TBO de punta a punta (registry, factory y ACL reales; sólo el `fetch` y la bóveda son dobles),
 * por el detalle de un hotel, que es el camino que hoy llega a TBO.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';
const CIUDAD = 2345;
const DESPEGAR = 'despegar-hotels';
const STUB = 'stub-hotels';
const SEARCH_ID = 'b7c1d2e3-0000-4000-8000-00000000abcd';
const MIN = 60_000;
const T0 = Date.parse('2026-09-25T15:00:00Z');

const CUENTA_STUB: HotelProviderAccountFingerprint = {
  accountId: 'acc-stub',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function entrada(overrides: Partial<HotelAvailabilityInput> = {}): HotelAvailabilityInput {
  return {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    rooms: [
      { adults: 2, childrenAges: [7] },
      { adults: 1, childrenAges: [] },
    ],
    destinationId: CIUDAD,
    guestNationality: 'AR',
    ...overrides,
  };
}

/** Lo que el stub informa por tarifa; por defecto, todas las que devuelve, con su total. */
function contextosDe(offers: readonly HotelOffer[]): HotelSearchPackContext[] {
  return offers.flatMap((o) =>
    o.roompacks.map((p) => ({
      hotelId: o.hotelId,
      offerRef: p.provider.offerRef,
      totalText: (p.price.total.amountMinor / 100).toFixed(2),
      currency: p.price.total.currency,
    })),
  );
}

interface OpcionesContexto {
  offers?: HotelOffer[];
  packs?: (offers: readonly HotelOffer[]) => HotelSearchPackContext[];
  expiresAt?: number;
}

/** Le da al adapter del stub el puerto de contexto, como lo tiene TBO. */
function conContexto(
  adapter: StubHotelAdapter,
  opts: OpcionesContexto = {},
): ReturnType<typeof vi.fn> {
  const offers = opts.offers ?? [stubHotelOffer(STUB, { hotelId: 'S-1' })];
  const withContext = vi.fn(
    (_criteria: HotelSearchCriteria, _ctx: SearchContext): Promise<HotelSearchWithContext> =>
      Promise.resolve({
        searchId: SEARCH_ID,
        searchSentAt: T0,
        expiresAt: opts.expiresAt ?? T0 + 27 * MIN,
        packs: (opts.packs ?? contextosDe)(offers),
        offers,
      }),
  );
  Object.assign(adapter, {
    searchAccount: CUENTA_STUB,
    searchAvailabilityWithContext: withContext,
  });
  return withContext;
}

interface Banco {
  service: HotelsService;
  store: HotelSearchContextStore;
  breaker: CircuitBreakerService;
  instrument: ReturnType<typeof vi.fn>;
}

function banco(factories: HotelProviderFactory[], flags = hotelFlags(true)): Banco {
  const store = new HotelSearchContextStore(new MemoryCacheAdapter());
  const breaker = new CircuitBreakerService();
  const instrument = vi.fn((_meta: unknown, run: () => Promise<unknown>) => run());
  const service = new HotelsService(
    hotelRegistry(factories, flags),
    fakeHotelsDb({ catalogo: { [DESPEGAR]: ['101', '205'], [STUB]: ['S-1', 'S-2'] } }).service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    { assertWithinQuota: () => Promise.resolve(), instrument } as unknown as SearchTelemetryService,
    breaker,
    store,
  );
  return { service, store, breaker, instrument };
}

function parteDe(providers: readonly HotelProviderOutcome[], code: string): HotelProviderOutcome {
  const p = providers.find((o) => o.code === code);
  if (!p) throw new Error(`no hay parte de ${code}`);
  return p;
}

let warn: ReturnType<typeof vi.spyOn>;
/** Todos los niveles del `Logger` de Nest, para buscar en lo que se escribió. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  logs = [
    warn,
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  ];
  vi.stubEnv('PROVIDERS_DISABLED', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('búsqueda: el proveedor con contexto lo deja en el servidor antes de mostrar sus tarifas', () => {
  it('guarda la estadía que armó el servidor, la cuenta que buscó y cada tarifa con su total', async () => {
    const s = new StubHotelProviderFactory({ code: STUB });
    const withContext = conContexto(s.adapterFor(TENANT));
    const b = banco([s]);

    await b.service.searchAvailability(TENANT, entrada());

    expect(withContext).toHaveBeenCalledTimes(1);
    expect(s.adapterFor(TENANT).searchAvailability).not.toHaveBeenCalled();
    await expect(b.store.get(TENANT, SEARCH_ID)).resolves.toEqual({
      tenantId: TENANT,
      providerCode: STUB,
      searchId: SEARCH_ID,
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      rooms: [
        { adults: 2, childrenAges: [7] },
        { adults: 1, childrenAges: [] },
      ],
      guestNationality: 'AR',
      searchSentAt: T0,
      expiresAt: T0 + 27 * MIN,
      account: CUENTA_STUB,
      packs: [
        {
          hotelId: 'S-1',
          offerRef: `${STUB}-S-1-REF`,
          totalText: '1000.00',
          currency: 'USD',
        },
      ],
    });
  });

  /*
   * MUTACIÓN: sin la reescritura de `provider.raw` en el servicio, lo que el ACL ponga ahí —aquí,
   * un nombre— viaja al navegador y este caso se pone en rojo.
   */
  it('RF-08 CA-5: cada tarifa sale con `provider.raw = { searchId }` y nada más', async () => {
    const offer = stubHotelOffer(STUB, { hotelId: 'S-1' });
    const pack = offer.roompacks[0];
    if (pack === undefined) throw new Error('el stub no trajo tarifa');
    pack.provider = { ...pack.provider, raw: { searchId: 'otro', leadGuest: 'Ana Pérez' } };
    const s = new StubHotelProviderFactory({ code: STUB });
    conContexto(s.adapterFor(TENANT), { offers: [offer] });
    const b = banco([s]);

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.flatMap((h) => h.roompacks.map((p) => p.provider))).toEqual([
      { name: STUB, offerRef: `${STUB}-S-1-REF`, raw: { searchId: SEARCH_ID } },
    ]);
  });

  it('una tarifa sin contexto no se muestra; un hotel que se queda sin tarifas no se lista', async () => {
    const offers = [
      stubHotelOffer(STUB, { hotelId: 'S-1' }),
      stubHotelOffer(STUB, { hotelId: 'S-2' }),
    ];
    const s = new StubHotelProviderFactory({ code: STUB });
    conContexto(s.adapterFor(TENANT), {
      offers,
      // S-1 informado en otro hotel; S-2 sin informar.
      packs: (o) => contextosDe(o.slice(0, 1)).map((c) => ({ ...c, hotelId: 'S-9' })),
    });
    const b = banco([s]);

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels).toEqual([]);
    expect(parteDe(res.providers, STUB)).toMatchObject({ status: 'empty' });
    await expect(b.store.get(TENANT, SEARCH_ID)).resolves.toBeUndefined();
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(
      `hotels.search_context.packs_sin_contexto provider=${STUB} dropped=2`,
    );
    expect(logueado).not.toContain('REF');
  });

  it('RF-06 CA-4: la nacionalidad queda en el contexto y NO en `search_logs.criteria`', async () => {
    const s = new StubHotelProviderFactory({ code: STUB });
    conContexto(s.adapterFor(TENANT));
    const b = banco([s]);

    await b.service.searchAvailability(TENANT, entrada({ guestNationality: 'AR' }));

    const meta = b.instrument.mock.calls[0]?.[0] as { criteria: Record<string, unknown> };
    expect(meta.criteria).not.toHaveProperty('guestNationality');
    expect(meta.criteria).not.toHaveProperty('rooms');
    expect(JSON.stringify(meta)).not.toContain('AR');
    expect((await b.store.get(TENANT, SEARCH_ID))?.guestNationality).toBe('AR');
  });

  /*
   * MUTACIÓN: sin la validación pack por pack, el literal con exponente —que el decimal del ACL de
   * TBO acepta— hace fallar el guardado del contexto entero y S-1 desaparece con S-2.
   */
  it('una tarifa cuyo contexto no cabe en el registro se descarta sola; las demás salen y se guardan', async () => {
    const offers = [
      stubHotelOffer(STUB, { hotelId: 'S-1' }),
      stubHotelOffer(STUB, { hotelId: 'S-2' }),
    ];
    const s = new StubHotelProviderFactory({ code: STUB });
    conContexto(s.adapterFor(TENANT), {
      offers,
      packs: (o) =>
        contextosDe(o).map((c) => (c.hotelId === 'S-2' ? { ...c, totalText: '3.0575E2' } : c)),
    });
    const b = banco([s]);

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.map((h) => h.hotelId)).toEqual(['S-1']);
    expect(parteDe(res.providers, STUB).status).toBe('ok');
    expect((await b.store.get(TENANT, SEARCH_ID))?.packs.map((p) => p.hotelId)).toEqual(['S-1']);
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(
      `hotels.search_context.packs_sin_contexto provider=${STUB} dropped=1`,
    );
    expect(logueado).not.toContain('3.0575E2');
  });

  it('una referencia repetida no se ofrece dos veces: la segunda se descarta y el contexto se guarda', async () => {
    const offer = stubHotelOffer(STUB, { hotelId: 'S-1' });
    const pack = offer.roompacks[0];
    if (pack === undefined) throw new Error('el stub no trajo tarifa');
    const s = new StubHotelProviderFactory({ code: STUB });
    conContexto(s.adapterFor(TENANT), {
      offers: [{ ...offer, roompacks: [pack, { ...pack, id: `${pack.id}-bis` }] }],
    });
    const b = banco([s]);

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.flatMap((h) => h.roompacks.map((p) => p.id))).toEqual([pack.id]);
    expect((await b.store.get(TENANT, SEARCH_ID))?.packs).toHaveLength(1);
  });

  it('si el contexto no se puede guardar, las tarifas de ESE proveedor no salen, su circuito no se entera y Despegar sigue', async () => {
    const s = new StubHotelProviderFactory({ code: STUB });
    // Un vencimiento más allá del techo del registro: el contexto entero no se guarda.
    conContexto(s.adapterFor(TENANT), { expiresAt: T0 + 3 * 60 * MIN });
    const b = banco([s, fakeDespegarFactory().factory]);

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.flatMap((h) => h.roompacks.map((p) => p.provider.name))).not.toContain(STUB);
    expect(parteDe(res.providers, STUB)).toMatchObject({ status: 'error' });
    expect(parteDe(res.providers, STUB).reason).toContain('No pudimos preparar la reserva');
    expect(parteDe(res.providers, DESPEGAR).status).toBe('ok');
    expect(b.breaker.snapshot()[STUB]?.failures ?? 0).toBe(0);
  });

  it('un proveedor sin puerto de contexto (Despegar) no deja contexto ni cambia sus tarifas', async () => {
    const despegar = fakeDespegarFactory();
    const b = banco([despegar.factory]);
    const save = vi.spyOn(b.store, 'save');
    const antes = await banco([fakeDespegarFactory().factory]).service.searchAvailability(
      TENANT,
      entrada(),
    );

    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(save).not.toHaveBeenCalled();
    expect(res.hotels).toEqual(antes.hotels);
  });

  it('RNF-06: el contexto es del tenant que buscó, aunque otro opere con la misma cuenta', async () => {
    const s = new StubHotelProviderFactory({ code: STUB });
    conContexto(s.adapterFor(TENANT));
    conContexto(s.adapterFor(OTRO_TENANT));
    const b = banco([s]);

    await b.service.searchAvailability(TENANT, entrada());
    const ref = { providerCode: STUB, searchId: SEARCH_ID, offerRef: `${STUB}-S-1-REF` };

    await expect(b.store.resolveOffer(TENANT, ref, CUENTA_STUB)).resolves.toBeDefined();
    await expect(b.store.resolveOffer(OTRO_TENANT, ref, CUENTA_STUB)).rejects.toBeInstanceOf(
      HotelSearchContextExpiredError,
    );
  });
});

describe('detalle: el mismo contrato que la búsqueda', () => {
  it('un detalle cuyas tarifas llegan sin contexto devuelve el hotel sin tarifas, no tarifas que no se pueden reservar', async () => {
    const s = new StubHotelProviderFactory({ code: STUB });
    const offer = stubHotelOffer(STUB, { hotelId: 'S-1' });
    const getHotelRates = vi.fn(() => Promise.resolve(offer));
    Object.assign(s.adapterFor(TENANT), {
      searchAccount: CUENTA_STUB,
      getHotelRates,
      getHotelRatesWithContext: vi.fn(() =>
        Promise.resolve({
          searchId: SEARCH_ID,
          searchSentAt: T0,
          expiresAt: T0 + 27 * MIN,
          packs: [],
          offer,
        }),
      ),
    });
    const b = banco([s]);
    const save = vi.spyOn(b.store, 'save');

    const detalle = await b.service.getHotelDetail(TENANT, {
      provider: STUB,
      hotelId: 'S-1',
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      rooms: [{ adults: 2, childrenAges: [] }],
    });

    expect(detalle).toEqual({ ...offer, roompacks: [] });
    expect(getHotelRates).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

// ───────────────────────── TBO de punta a punta ─────────────────────────

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const AGENCIA = '44444444-4444-4444-8444-444444444444';
const BOOKING_CODE = '1120548!TB!2!TB!9a47646b-1bba-4746-91d5-969149db1185';

const DETALLE: HotelDetailInput = {
  provider: 'tbo-hotels',
  hotelId: '1120548',
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [5] }],
  guestNationality: 'CO',
};

/** Search con detalle de un hotel: un pack, con el `TotalFare` como texto (p. 13 admite los dos). */
function respuestaTbo(): Response {
  const body = {
    Status: { Code: 200, Description: 'Successful' },
    HotelResult: [
      {
        HotelCode: '1120548',
        Currency: 'USD',
        Rooms: [
          {
            Name: ['Luxury Room, 1 King Bed'],
            BookingCode: BOOKING_CODE,
            Inclusion: 'Free WiFi',
            TotalFare: '305.750',
            TotalTax: 56.24,
            MealType: 'Room_Only',
            IsRefundable: false,
            WithTransfers: false,
          },
        ],
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** La cuenta TBO del consolidador, heredada por su agencia. `version` se puede rotar. */
function boveda(version: () => Date): ProviderCredentialsService {
  const tipos: Readonly<Record<string, TenantType>> = { [CONSOLIDADOR]: 'consolidator' };
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    if (tenantId !== CONSOLIDADOR && tenantId !== AGENCIA) {
      return Promise.reject(new NotFoundException('sin cuenta'));
    }
    return Promise.resolve({
      id: `acc-${CONSOLIDADOR}`,
      ownerTenantId: CONSOLIDADOR,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'consolidador-demo', password: 'Pa55w0rd' },
      inherited: tenantId !== CONSOLIDADOR,
      updatedAt: version(),
    });
  };
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(tipos[id]);
  return { resolve, ownerTenantType } as unknown as ProviderCredentialsService;
}

/** El `searchId` que el navegador recibe en la tarifa: lo único con que la vuelve a nombrar. */
function searchIdDe(oferta: HotelOffer): string {
  const searchId = oferta.roompacks[0]?.provider.raw?.['searchId'];
  if (typeof searchId !== 'string') throw new Error('la tarifa no trae `searchId` en `raw`');
  return searchId;
}

describe('TBO: el detalle de un hotel deja su contexto en el servidor', () => {
  function bancoTbo(version: () => Date): Banco & { factory: TboHotelsProviderFactory } {
    const fetch = vi.fn<TboFetch>(() => Promise.resolve(respuestaTbo()));
    const factory = new TboHotelsProviderFactory(boveda(version), fetch);
    return { ...banco([factory]), factory };
  }

  async function cuentaVigente(
    factory: TboHotelsProviderFactory,
    tenantId: string,
  ): Promise<HotelProviderAccountFingerprint> {
    const { adapter } = await factory.resolveForTenant(tenantId);
    return (adapter as TboHotelProviderAdapter).searchAccount;
  }

  it('`BookingCode`, literal de `TotalFare`, ocupación, nacionalidad y cuenta quedan en el servidor; al navegador va sólo `searchId`', async () => {
    const b = bancoTbo(() => new Date('2026-09-01T00:00:00Z'));

    const oferta = await b.service.getHotelDetail(AGENCIA, DETALLE);

    const pack = oferta.roompacks[0];
    expect(oferta.roompacks).toHaveLength(1);
    const searchId = searchIdDe(oferta);
    expect(pack?.provider).toEqual({
      name: 'tbo-hotels',
      offerRef: BOOKING_CODE,
      raw: { searchId },
    });

    const contexto = await b.store.get(AGENCIA, searchId);
    expect(contexto).toMatchObject({
      tenantId: AGENCIA,
      providerCode: 'tbo-hotels',
      checkinDate: DETALLE.checkinDate,
      checkoutDate: DETALLE.checkoutDate,
      rooms: [{ adults: 2, childrenAges: [5] }],
      guestNationality: 'CO',
      account: { accountId: `acc-${CONSOLIDADOR}`, updatedAt: '2026-09-01T00:00:00.000Z' },
      packs: [
        { hotelId: '1120548', offerRef: BOOKING_CODE, totalText: '305.750', currency: 'USD' },
      ],
    });
    // Un solo reloj: el vencimiento del contexto es el de la tarifa, 27 min desde el envío.
    expect(contexto?.searchSentAt).toBe(T0);
    expect(contexto?.expiresAt).toBe(T0 + 27 * MIN);
    expect(Date.parse(pack?.expiresAt ?? '')).toBe(contexto?.expiresAt);

    // La credencial no sale de la bóveda: ni en el contexto, ni en la tarifa, ni en un log.
    const lineas = logs.flatMap((spy) =>
      spy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')),
    );
    expect(lineas.some((l) => l.includes('tbo.http.ok'))).toBe(true);
    const volcado = [JSON.stringify(contexto), JSON.stringify(oferta), ...lineas].join('\n');
    const basic = Buffer.from('consolidador-demo:Pa55w0rd').toString('base64');
    for (const secreto of ['Pa55w0rd', 'consolidador-demo', basic]) {
      expect(volcado).not.toContain(secreto);
    }
  });

  it('RF-08 CA-3: la tarifa resuelve con la cuenta que buscó; tras rotar la credencial, pide volver a buscar', async () => {
    let version = new Date('2026-09-01T00:00:00Z');
    const b = bancoTbo(() => version);
    const oferta = await b.service.getHotelDetail(AGENCIA, DETALLE);
    const ref = {
      providerCode: 'tbo-hotels',
      searchId: searchIdDe(oferta),
      offerRef: BOOKING_CODE,
    };

    await expect(
      b.store.resolveOffer(AGENCIA, ref, await cuentaVigente(b.factory, AGENCIA)),
    ).resolves.toMatchObject({ pack: { offerRef: BOOKING_CODE, totalText: '305.750' } });

    version = new Date('2026-09-25T14:00:00Z');
    await expect(
      b.store.resolveOffer(AGENCIA, ref, await cuentaVigente(b.factory, AGENCIA)),
    ).rejects.toBeInstanceOf(HotelSearchAccountChangedError);
  });

  it('RF-08 CA-1: el consolidador, con la MISMA cuenta, no resuelve la búsqueda de su agencia', async () => {
    const b = bancoTbo(() => new Date('2026-09-01T00:00:00Z'));
    const oferta = await b.service.getHotelDetail(AGENCIA, DETALLE);
    const ref = {
      providerCode: 'tbo-hotels',
      searchId: searchIdDe(oferta),
      offerRef: BOOKING_CODE,
    };

    await expect(
      b.store.resolveOffer(CONSOLIDADOR, ref, await cuentaVigente(b.factory, CONSOLIDADOR)),
    ).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
  });
});
