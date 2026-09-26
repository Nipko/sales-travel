import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import type { HotelOffer, HotelRoompack } from '@sales-travel/canonical';
import type { CachePort } from '@sales-travel/core';
import type { SearchContext } from '@sales-travel/domain';
import { TboApiError, type TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantType } from '../database/database.types.js';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import {
  humanizeTboError,
  tboErrorReason,
  tboErrorStatus,
} from '../providers-tbo/tbo-hotels-errors.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import {
  StubHotelProviderFactory,
  type StubHotelAdapter,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelOfferInvalidation,
  HotelPrebookContextRequest,
  HotelPrebookWithContext,
  HotelProviderAccountFingerprint,
  HotelProviderFactory,
} from '../providers/hotel-provider.types.js';
import { ProviderNotAvailableError } from '../providers/provider.types.js';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb } from './__fixtures__/fake-hotels-db.js';
import { HOTEL_EVENTS } from './hotel-events.js';
import {
  HotelPrebookSnapshotStore,
  HotelPrebookSnapshotUnavailableError,
} from './hotel-prebook-snapshot.store.js';
import { HotelPrebookService } from './hotel-prebook.service.js';
import { HotelProviderCapabilityError } from './hotel-provider-errors.js';
import {
  HotelOfferNotInSearchError,
  HotelOfferUnavailableError,
  HotelSearchAccountChangedError,
  HotelSearchContextExpiredError,
  HotelSearchContextStore,
  HotelSearchNationalityMissingError,
  type HotelSearchContext,
  type HotelSearchContextPack,
} from './hotel-search-context.store.js';
import type { HotelDetailInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * PreBook en la API con revalidación y snapshot (docs/tbo/09 PR-4.5; 08 RF-15 CA 1 a 4, RF-12 con
 * el valor de PreBook, RF-09 CA-2).
 *
 * Dos bancos. El primero, con el proveedor de hoteles ANÓNIMO de los tests y el registry, los
 * almacenes y el breaker REALES: prueba el orden de las puertas y lo que el servicio hace con lo
 * que el proveedor responde, sin apostar por TBO. El segundo, con el factory y el ACL de TBO
 * REALES y sólo el `fetch` y la bóveda como dobles: prueba que por el cable sale el PreBook de
 * Postman y que los ejemplos del PDF (búsqueda de p. 16, PreBook de p. 28) dan lo que dice 03.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const USUARIO = '55555555-5555-4555-8555-555555555555';
const STUB = 'stub-hotels';
const SEARCH_ID = '6110a41c-558c-405c-a0d3-6bdd3e131146';
const TARIFA = `${STUB}-S-1-REF`;
const OTRA_TARIFA = `${STUB}-S-1-REF-2`;
const TARIFA_DEL_PREBOOK = `${STUB}-S-1-REF-PB`;

const T0 = Date.parse('2026-09-25T15:00:00Z');
const MIN = 60_000;
const VENCE = T0 + 27 * MIN;

const CUENTA: HotelProviderAccountFingerprint = {
  accountId: 'acc-consolidador',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const NETO = 30_575;
const PISO = 32_134;

const MAS_3_CONSOLIDADOR: ApplicableRule = {
  tenantId: CONSOLIDADOR,
  tenantName: 'Consolidador',
  level: 1,
  ruleType: 'percentage',
  valueMinor: 300,
};
const MAS_1_AGENCIA: ApplicableRule = {
  tenantId: AGENCIA,
  tenantName: 'Agencia',
  level: 2,
  ruleType: 'percentage',
  valueMinor: 100,
};

const CARGO_EN_HOTEL = {
  roomIndex: 1,
  description: 'Impuesto obligatorio',
  descriptionRaw: 'mandatory_tax',
  amount: { amountMinor: 2000, currency: 'AED' },
};

function tarifaBuscada(offerRef: string): HotelSearchContextPack {
  return {
    hotelId: 'S-1',
    offerRef,
    totalText: '305.750',
    currency: 'USD',
    seen: {
      total: { amountMinor: NETO, currency: 'USD' },
      refundable: false,
      board: 'RO',
      mealTypeRaw: 'Room_Only',
      atPropertyCharges: [CARGO_EN_HOTEL],
    },
  };
}

function contexto(overrides: Partial<HotelSearchContext> = {}): HotelSearchContext {
  return {
    tenantId: AGENCIA,
    providerCode: STUB,
    searchId: SEARCH_ID,
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 2, childrenAges: [7] }],
    guestNationality: 'AR',
    searchSentAt: T0,
    expiresAt: VENCE,
    account: CUENTA,
    packs: [tarifaBuscada(TARIFA), tarifaBuscada(OTRA_TARIFA)],
    ...overrides,
  };
}

function referencia(offerRef = TARIFA): {
  providerCode: string;
  searchId: string;
  offerRef: string;
} {
  return { providerCode: STUB, searchId: SEARCH_ID, offerRef };
}

interface Revalidada {
  netoMinor?: number;
  pisoMinor?: number;
  moneda?: string;
  comparacion?: Partial<HotelPrebookWithContext['comparison']>;
}

/** Lo que devuelve el PreBook del stub: la tarifa con políticas finales y lo que el Book reenvía. */
function revalidada(opts: Revalidada = {}): HotelPrebookWithContext {
  const moneda = opts.moneda ?? 'USD';
  const total = { amountMinor: opts.netoMinor ?? NETO, currency: moneda };
  const roompack: HotelRoompack = {
    id: TARIFA_DEL_PREBOOK,
    provider: {
      name: STUB,
      offerRef: TARIFA_DEL_PREBOOK,
      // Lo que ponga el ACL no viaja: el servicio deja sólo la clave de la búsqueda.
      raw: { searchId: 'otra', leadGuest: 'Ana Pérez' },
    },
    board: 'RO',
    mealTypeRaw: 'Room_Only',
    rooms: [{ name: 'Doble estándar', reference: 0, bedOptions: [] }],
    cancellation: {
      refundable: false,
      status: 'non_refundable',
      rules: [
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-11-01T00:00:00' },
      ],
      policySource: 'prebook-final',
    },
    price: {
      total,
      taxesDetail: [],
      ...(opts.pisoMinor === undefined
        ? {}
        : { minimumSellingPrice: { amountMinor: opts.pisoMinor, currency: 'USD' } }),
    },
    atPropertyCharges: [CARGO_EN_HOTEL],
  };
  return {
    result: {
      total,
      expiresAt: new Date(VENCE).toISOString(),
      roompack,
      rateConditions: [
        {
          category: 'other',
          text: 'Tarifa especial: sólo se vende con un billete aéreo como parte de un paquete.',
          raw: '&lt;b&gt;Tarifa especial&lt;/b&gt;: sólo se vende con un billete aéreo como parte de un paquete.',
        },
        { category: 'checkOut', text: 'CheckOut Time: 12:00 PM', raw: 'CheckOut Time: 12:00 PM' },
      ],
      signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
      providerStatus: '200',
      warnings: ['BOOKING_CODE_CHANGED'],
    },
    pack: { hotelId: 'S-1', offerRef: TARIFA_DEL_PREBOOK, totalText: '305.75', currency: moneda },
    rateConditionsHash: 'a'.repeat(64),
    comparison: {
      stage: 'C1',
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: { amountMinor: NETO, currency: 'USD' },
      currentTotal: total,
      ...opts.comparacion,
    },
    requestId: 'req-prebook-1',
  };
}

/** Un error que, según el proveedor, deja inservible la tarifa o la búsqueda. */
class InvalidaError extends Error {
  constructor(readonly scope: HotelOfferInvalidation) {
    super(`invalida ${scope}`);
  }
}

interface PuertoPrebook {
  prebookWithContext: Mock<
    (req: HotelPrebookContextRequest, ctx: SearchContext) => Promise<HotelPrebookWithContext>
  >;
  offerInvalidatedBy: Mock<(err: unknown) => HotelOfferInvalidation | undefined>;
}

/** Le da al adapter del stub el PreBook por contexto, como lo tiene TBO. */
function conPrebook(adapter: StubHotelAdapter, cuenta = CUENTA): PuertoPrebook {
  const puerto: PuertoPrebook = {
    prebookWithContext: vi.fn(() => Promise.resolve(revalidada())),
    offerInvalidatedBy: vi.fn((err: unknown) =>
      err instanceof InvalidaError ? err.scope : undefined,
    ),
  };
  Object.assign(adapter, { searchAccount: cuenta, ...puerto });
  return puerto;
}

interface Banco {
  service: HotelPrebookService;
  contexts: HotelSearchContextStore;
  snapshots: HotelPrebookSnapshotStore;
  cache: CachePort;
  stub: StubHotelProviderFactory;
  puerto: PuertoPrebook;
  emit: Mock;
  breaker: CircuitBreakerService;
}

interface OpcionesBanco {
  reglas?: ApplicableRule[];
  requiresGuestNationality?: boolean;
  callPolicy?: 'always' | 'opt-in';
  flags?: boolean;
  cache?: CachePort;
}

function banco(opts: OpcionesBanco = {}): Banco {
  const stub = new StubHotelProviderFactory({
    code: STUB,
    callPolicy: opts.callPolicy ?? 'always',
    searchProfile: { requiresGuestNationality: opts.requiresGuestNationality ?? true },
    circuit: { accountRef: 'huella-de-la-cuenta' },
  });
  const puerto = conPrebook(stub.adapterFor(AGENCIA));
  const cache = opts.cache ?? new MemoryCacheAdapter();
  const contexts = new HotelSearchContextStore(cache);
  const snapshots = new HotelPrebookSnapshotStore(cache);
  const emit = vi.fn(() => Promise.resolve());
  const breaker = new CircuitBreakerService();
  const service = new HotelPrebookService(
    hotelRegistry([stub], hotelFlags(opts.flags ?? true)),
    contexts,
    snapshots,
    { getApplicableRules: () => Promise.resolve(opts.reglas ?? []) } as unknown as PricingService,
    breaker,
    { emit } as unknown as AuditService,
  );
  return { service, contexts, snapshots, cache, stub, puerto, emit, breaker };
}

async function bancoConBusqueda(opts: OpcionesBanco = {}, ctx = contexto()): Promise<Banco> {
  const b = banco(opts);
  await b.contexts.save(ctx);
  return b;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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

describe('PreBook de una tarifa buscada: lo que llega al proveedor sale del servidor', () => {
  it('revalida con la búsqueda guardada y compara C1 contra lo que se mostró', async () => {
    const b = await bancoConBusqueda();

    await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
    expect(b.puerto.prebookWithContext).toHaveBeenCalledWith(
      {
        searchId: SEARCH_ID,
        hotelId: 'S-1',
        offerRef: TARIFA,
        searchSentAt: T0,
        rooms: [{ adults: 2, childrenAges: [7] }],
        baseline: { stage: 'C1', totalText: '305.750', seen: tarifaBuscada(TARIFA).seen },
      },
      { tenantId: AGENCIA },
    );
  });

  it('responde la tarifa revalidada con `prebookRef`, el vencimiento de la búsqueda y las condiciones sin el original', async () => {
    const b = await bancoConBusqueda();

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(res.prebookRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(res).toMatchObject({
      providerCode: STUB,
      hotelId: 'S-1',
      // El PreBook no renueva el reloj (Q-29): es el de la búsqueda.
      expiresAt: new Date(VENCE).toISOString(),
      signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
      warnings: ['BOOKING_CODE_CHANGED'],
      repricing: {
        outcome: 'UNCHANGED',
        price: 'SAME',
        changes: [],
        previousTotal: { amountMinor: NETO, currency: 'USD' },
        currentTotal: { amountMinor: NETO, currency: 'USD' },
      },
    });
    expect(res.roompack.cancellation.policySource).toBe('prebook-final');
    // RF-16: al navegador va el texto saneado; el original no sale del servidor.
    expect(res.rateConditions).toEqual([
      {
        category: 'other',
        text: 'Tarifa especial: sólo se vende con un billete aéreo como parte de un paquete.',
      },
      { category: 'checkOut', text: 'CheckOut Time: 12:00 PM' },
    ]);
    expect(JSON.stringify(res)).not.toContain('&lt;');
  });

  /*
   * MUTACIÓN: sin la reescritura de `provider.raw`, lo que el ACL ponga ahí —aquí, un nombre—
   * viaja al navegador.
   */
  it('RF-08 CA-5: la tarifa sale con `provider.raw = { searchId }` y nada más', async () => {
    const b = await bancoConBusqueda();

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(res.roompack.provider).toEqual({
      name: STUB,
      offerRef: TARIFA_DEL_PREBOOK,
      raw: { searchId: SEARCH_ID },
    });
  });

  it('el snapshot aceptable queda en el servidor con lo que el Book reenvía: la referencia y el literal DEL PreBook (Q-30)', async () => {
    const b = await bancoConBusqueda();

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);
    const snapshot = await b.snapshots.get(AGENCIA, res.prebookRef);

    expect(snapshot).toMatchObject({
      prebookRef: res.prebookRef,
      tenantId: AGENCIA,
      providerCode: STUB,
      searchId: SEARCH_ID,
      account: CUENTA,
      hotelId: 'S-1',
      offerRef: TARIFA_DEL_PREBOOK,
      totalText: '305.75',
      currency: 'USD',
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: [{ adults: 2, childrenAges: [7] }],
      guestNationality: 'AR',
      searchSentAt: T0,
      expiresAt: VENCE,
      signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
      rateConditionsHash: 'a'.repeat(64),
      comparison: { stage: 'C1', outcome: 'UNCHANGED' },
      createdAt: T0,
    });
    expect(snapshot?.roompack).toEqual(res.roompack);
    // Las dos versiones de cada condición, para disputas (03 §2.4 punto 9).
    expect(snapshot?.rateConditions[0]?.raw).toContain('&lt;b&gt;');
    // Sólo el tenant que revalidó lo resuelve.
    await expect(b.snapshots.get(OTRA_AGENCIA, res.prebookRef)).resolves.toBeUndefined();
  });

  it('una búsqueda sin nacionalidad de un proveedor que no la necesita se revalida igual', async () => {
    const { guestNationality: _nacionalidad, ...sinNacionalidad } = contexto();
    const b = await bancoConBusqueda({ requiresGuestNationality: false }, sinNacionalidad);

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect((await b.snapshots.get(AGENCIA, res.prebookRef))?.guestNationality).toBeUndefined();
  });

  it('PR-2.1: el proveedor ya emitió la tarifa, así que un `opt-in` apagado después no deja el PreBook a medio camino', async () => {
    const b = await bancoConBusqueda({ callPolicy: 'opt-in', flags: false });

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).resolves.toBeDefined();
  });
});

describe('RF-12 con el valor de PreBook: la cascada y el piso sobre el neto revalidado', () => {
  it('el piso del PreBook sube el precio de venta por encima de la cascada, atribuido a quien vende', async () => {
    const b = await bancoConBusqueda({ reglas: [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA] });
    b.puerto.prebookWithContext.mockResolvedValue(revalidada({ pisoMinor: PISO }));

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    // 305.75 + 3 % + 1 % = 318.07 < 321.34: el piso, y los 3.27 que faltan son de la agencia.
    expect(res.roompack.pricing).toEqual({
      costMinor: NETO + 917,
      finalMinor: PISO,
      ownMarkupMinor: 315 + 327,
      currency: 'USD',
    });
    // El neto no se muta.
    expect(res.roompack.price.total).toEqual({ amountMinor: NETO, currency: 'USD' });
  });

  it('un neto nuevo en el PreBook es el que paga la cascada, no el de la búsqueda', async () => {
    const b = await bancoConBusqueda({ reglas: [MAS_1_AGENCIA] });
    b.puerto.prebookWithContext.mockResolvedValue(revalidada({ netoMinor: 40_000 }));

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(res.roompack.pricing?.finalMinor).toBe(40_400);
  });

  it('sin reglas ni piso, la tarifa sale como la mapeó el proveedor, sin `pricing`', async () => {
    const b = await bancoConBusqueda();

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(res.roompack.pricing).toBeUndefined();
  });
});

describe('RF-15 CA-3: un cambio se informa y deja rastro, sin PII ni texto del proveedor', () => {
  it('UNCHANGED no emite `HotelOfferRepriced`', async () => {
    const b = await bancoConBusqueda();

    await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(b.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['INCREASED', { outcome: 'INCREASED', price: 'UP' }],
    ['DECREASED', { outcome: 'DECREASED', price: 'DOWN' }],
    [
      'CONDITIONS_CHANGED',
      { outcome: 'CONDITIONS_CHANGED', price: 'SAME', changes: ['REFUNDABLE'] },
    ],
  ] as const)('%s emite `HotelOfferRepriced` con códigos y netos', async (_caso, comparacion) => {
    const b = await bancoConBusqueda();
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({ netoMinor: 31_000, comparacion: { ...comparacion } }),
    );

    const res = await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(res.repricing.outcome).toBe(comparacion.outcome);
    expect(b.emit).toHaveBeenCalledTimes(1);
    const evento = b.emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(evento).toEqual({
      eventType: HOTEL_EVENTS.offerRepriced,
      tenantId: AGENCIA,
      actorUserId: USUARIO,
      aggregateType: 'hotel_prebook',
      aggregateId: res.prebookRef,
      payload: {
        vertical: 'hotels',
        provider: STUB,
        hotelId: 'S-1',
        stage: 'C1',
        outcome: comparacion.outcome,
        price: comparacion.price,
        changes: 'changes' in comparacion ? [...comparacion.changes] : [],
        previousTotal: { amountMinor: NETO, currency: 'USD' },
        currentTotal: { amountMinor: 31_000, currency: 'USD' },
      },
    });
    const volcado = JSON.stringify(evento);
    for (const dato of ['AR', 'Tarifa especial', 'CheckOut', 'Ana', TARIFA, SEARCH_ID]) {
      expect(volcado).not.toContain(dato);
    }
  });
});

describe('las puertas: todo rechazo ocurre ANTES de llamar al proveedor', () => {
  it('RF-08 CA-1: un `searchId` de otro tenant → 409, como una búsqueda vencida, sin llamar al proveedor', async () => {
    const b = await bancoConBusqueda();
    conPrebook(b.stub.adapterFor(OTRA_AGENCIA));

    const err: unknown = await b.service
      .prebook(OTRA_AGENCIA, referencia(), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelSearchContextExpiredError);
    expect((err as HotelSearchContextExpiredError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as HotelSearchContextExpiredError).reason).toBe('SEARCH_CONTEXT_EXPIRED');
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(
      (b.stub.adapterFor(OTRA_AGENCIA) as unknown as PuertoPrebook).prebookWithContext,
    ).not.toHaveBeenCalled();
  });

  it('RF-08 CA-2: una referencia que la búsqueda no emitió → 400 sin llamar al proveedor', async () => {
    const b = await bancoConBusqueda();

    const err: unknown = await b.service
      .prebook(AGENCIA, referencia('inventada'), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelOfferNotInSearchError);
    expect((err as HotelOfferNotInSearchError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
  });

  it('RF-08 CA-3: la cuenta cambió desde la búsqueda → 409 sin llamar al proveedor', async () => {
    const b = await bancoConBusqueda();
    Object.assign(b.stub.adapterFor(AGENCIA), {
      searchAccount: { ...CUENTA, updatedAt: '2026-09-25T14:00:00.000Z' },
    });

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).rejects.toBeInstanceOf(
      HotelSearchAccountChangedError,
    );
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
  });

  it('RF-09: pasado el vencimiento de la oferta → 409 sin llamar al proveedor', async () => {
    const b = await bancoConBusqueda();
    vi.setSystemTime(VENCE);

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).rejects.toBeInstanceOf(
      HotelSearchContextExpiredError,
    );
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
  });

  it('una búsqueda sin la nacionalidad que el proveedor necesita no es reservable → 409, sin llamarlo', async () => {
    const { guestNationality: _nacionalidad, ...sinNacionalidad } = contexto();
    const b = await bancoConBusqueda({}, sinNacionalidad);

    const err: unknown = await b.service
      .prebook(AGENCIA, referencia(), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelSearchNationalityMissingError);
    expect((err as HotelSearchNationalityMissingError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as HotelSearchNationalityMissingError).reason).toBe('GUEST_NATIONALITY_MISSING');
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
  });

  it('un proveedor que la plataforma no conoce → 400', async () => {
    const b = await bancoConBusqueda();

    await expect(
      b.service.prebook(AGENCIA, { ...referencia(), providerCode: 'otro-proveedor' }, USUARIO),
    ).rejects.toBeInstanceOf(ProviderNotAvailableError);
  });

  it('D-TBO-08 A: un proveedor sin PreBook por contexto (Despegar) → 400, sin tocar su PreBook ni el contexto', async () => {
    const stub = new StubHotelProviderFactory({ code: STUB });
    const contexts = new HotelSearchContextStore(new MemoryCacheAdapter());
    const resolveOffer = vi.spyOn(contexts, 'resolveOffer');
    const service = new HotelPrebookService(
      hotelRegistry([stub], hotelFlags(true)),
      contexts,
      new HotelPrebookSnapshotStore(new MemoryCacheAdapter()),
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      new CircuitBreakerService(),
      { emit: vi.fn() } as unknown as AuditService,
    );

    const err: unknown = await service
      .prebook(AGENCIA, referencia(), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelProviderCapabilityError);
    expect((err as HotelProviderCapabilityError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(stub.adapterFor(AGENCIA).prebook).not.toHaveBeenCalled();
    expect(resolveOffer).not.toHaveBeenCalled();
  });
});

describe('RF-15 CA-4 y RF-09 CA-2: lo que el proveedor dice de la tarifa o de la búsqueda', () => {
  it('sesión vencida (TBO 315): se olvida la búsqueda, el error sale tal cual y el siguiente intento no llama', async () => {
    const b = await bancoConBusqueda();
    const vencida = new InvalidaError('search');
    b.puerto.prebookWithContext.mockRejectedValueOnce(vencida);

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).rejects.toBe(vencida);
    await expect(
      b.service.prebook(AGENCIA, referencia(OTRA_TARIFA), USUARIO),
    ).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
  });

  it('tarifa no disponible (TBO 201/207): se marca esa tarifa; las demás de la búsqueda siguen', async () => {
    const b = await bancoConBusqueda();
    const agotada = new InvalidaError('offer');
    b.puerto.prebookWithContext.mockRejectedValueOnce(agotada);

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).rejects.toBe(agotada);
    const err: unknown = await b.service
      .prebook(AGENCIA, referencia(), USUARIO)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelOfferUnavailableError);
    expect((err as HotelOfferUnavailableError).reason).toBe('OFFER_UNAVAILABLE');
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);

    await b.service.prebook(AGENCIA, referencia(OTRA_TARIFA), USUARIO);
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(2);
  });

  it('un fallo que no dice nada de la tarifa deja todo como estaba, y el servidor no suma reintentos', async () => {
    const b = await bancoConBusqueda();
    const caida = new Error('500 del proveedor');
    b.puerto.prebookWithContext.mockRejectedValueOnce(caida);

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).rejects.toBe(caida);
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
    expect(b.puerto.offerInvalidatedBy).toHaveBeenCalledWith(caida);

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).resolves.toBeDefined();
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(2);
  });

  it('si la marca no se puede guardar, el vendedor ve igual lo que dijo el proveedor', async () => {
    const memoria = new MemoryCacheAdapter();
    const cache: CachePort = {
      get: (k) => memoria.get(k),
      set: (k, v, ttl) => memoria.set(k, v, ttl),
      delete: () => Promise.reject(new Error(`almacén caído: ${SEARCH_ID}`)),
      invalidatePattern: (p) => memoria.invalidatePattern(p),
    };
    const b = await bancoConBusqueda({ cache });
    const vencida = new InvalidaError('search');
    b.puerto.prebookWithContext.mockRejectedValueOnce(vencida);

    await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).rejects.toBe(vencida);

    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(`hotels.prebook.invalidation_failed provider=${STUB} scope=search`);
    expect(logueado).not.toContain(SEARCH_ID);
  });
});

describe('el breaker: el PreBook es venta', () => {
  it('pasa por el circuito del proveedor con lo que declaró su factory', async () => {
    const b = await bancoConBusqueda();
    const execute = vi.spyOn(b.breaker, 'execute');

    await b.service.prebook(AGENCIA, referencia(), USUARIO);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe(STUB);
    expect(execute.mock.calls[0]?.[2]).toEqual({ accountRef: 'huella-de-la-cuenta' });
  });

  it.each([STUB, `${STUB}:ventas`])(
    '`PROVIDERS_DISABLED=%s` → 503 sin llamar al proveedor y sin tocar la búsqueda',
    async (apagado) => {
      const b = await bancoConBusqueda();
      vi.stubEnv('PROVIDERS_DISABLED', apagado);

      const err: unknown = await b.service
        .prebook(AGENCIA, referencia(), USUARIO)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BreakerRejectionError);
      expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
      vi.stubEnv('PROVIDERS_DISABLED', '');
      await expect(b.service.prebook(AGENCIA, referencia(), USUARIO)).resolves.toBeDefined();
    },
  );
});

describe('sin snapshot no hay tarifa que aceptar', () => {
  it('un PreBook que no se puede guardar → 503, sin evento', async () => {
    const b = await bancoConBusqueda();
    // El total que se reenviaría y el precio que se aceptaría serían de monedas distintas.
    const rota = revalidada({ comparacion: { outcome: 'INCREASED', price: 'UP' } });
    b.puerto.prebookWithContext.mockResolvedValue({
      ...rota,
      pack: { ...rota.pack, currency: 'EUR' },
    });

    const err: unknown = await b.service
      .prebook(AGENCIA, referencia(), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelPrebookSnapshotUnavailableError);
    expect((err as HotelPrebookSnapshotUnavailableError).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(b.emit).not.toHaveBeenCalled();
  });
});

// ───────────────────────── TBO de punta a punta ─────────────────────────

const TBO = 'tbo-hotels';
const RAIZ = join(__dirname, '..', '..', '..', '..');
const FIXTURES_TBO = join(RAIZ, 'providers', 'tbo-hotels', 'src', '__fixtures__');

/** Los dos packs del ejemplo de búsqueda de p. 16; el segundo es el del PreBook de p. 28. */
const BC_2 = '1120548!TB!2!TB!9a47646b-1bba-4746-91d5-969149db1185';
const BC_4 = '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185';

const DETALLE_TBO: HotelDetailInput = {
  provider: TBO,
  hotelId: '1120548',
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-11',
  rooms: [
    { adults: 2, childrenAges: [] },
    { adults: 2, childrenAges: [] },
  ],
  guestNationality: 'CO',
};

function fixture(ruta: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_TBO, ruta), 'utf8')) as Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** El `bodyJson` de un fixture de sobre (`envelope/83-*.json`). */
function sobre(ruta: string): unknown {
  return (fixture(ruta) as { response: { bodyJson: unknown } }).response.bodyJson;
}

/** La cuenta TBO del consolidador, heredada por su agencia (D-TBO-03 A). */
function boveda(): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    if (tenantId !== CONSOLIDADOR && tenantId !== AGENCIA) {
      return Promise.reject(new NotFoundException('sin cuenta'));
    }
    return Promise.resolve({
      id: 'acc-tbo-consolidador',
      ownerTenantId: CONSOLIDADOR,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'consolidador-demo', password: 'Pa55w0rd' },
      inherited: tenantId !== CONSOLIDADOR,
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
  };
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(id === CONSOLIDADOR ? 'consolidator' : 'agency');
  return { resolve, ownerTenantType } as unknown as ProviderCredentialsService;
}

interface BancoTbo {
  hotels: HotelsService;
  prebooks: HotelPrebookService;
  snapshots: HotelPrebookSnapshotStore;
  fetch: Mock<TboFetch>;
  emit: Mock;
}

/** `prebook` responde el PreBook; la búsqueda, siempre el ejemplo de p. 16. */
function bancoTbo(
  prebook: () => unknown = () => fixture('pdf/prebook-limit-multi-room.p28.json'),
): BancoTbo {
  const fetch = vi.fn<TboFetch>((url) =>
    Promise.resolve(
      json(
        String(url).endsWith('/PreBook') ? prebook() : fixture('pdf/search-multi-room.p16.json'),
      ),
    ),
  );
  const factories: HotelProviderFactory[] = [new TboHotelsProviderFactory(boveda(), fetch)];
  const registry = hotelRegistry(factories, hotelFlags(true));
  const cache = new MemoryCacheAdapter();
  const contexts = new HotelSearchContextStore(cache);
  const snapshots = new HotelPrebookSnapshotStore(cache);
  const pricing = {
    getApplicableRules: () => Promise.resolve([MAS_3_CONSOLIDADOR, MAS_1_AGENCIA]),
  } as unknown as PricingService;
  const breaker = new CircuitBreakerService();
  const emit = vi.fn(() => Promise.resolve());
  const hotels = new HotelsService(
    registry,
    fakeHotelsDb().service,
    pricing,
    {} as unknown as SearchTelemetryService,
    breaker,
    contexts,
  );
  const prebooks = new HotelPrebookService(registry, contexts, snapshots, pricing, breaker, {
    emit,
  } as unknown as AuditService);
  return { hotels, prebooks, snapshots, fetch, emit };
}

/** Lo que el navegador tiene de la tarifa después del detalle: proveedor, búsqueda y referencia. */
function referenciaTbo(
  oferta: HotelOffer,
  offerRef: string,
): {
  providerCode: string;
  searchId: string;
  offerRef: string;
} {
  const pack = oferta.roompacks.find((p) => p.provider.offerRef === offerRef);
  const searchId = pack?.provider.raw?.['searchId'];
  if (typeof searchId !== 'string') throw new Error(`la tarifa ${offerRef} no trae su búsqueda`);
  return { providerCode: pack?.provider.name ?? '', searchId, offerRef };
}

/** Las llamadas a `/PreBook` y el cuerpo de cada una: el cliente siempre manda texto. */
function prebooksDe(fetch: Mock<TboFetch>): Record<string, unknown>[] {
  return fetch.mock.calls
    .filter(([url]) => String(url).endsWith('/PreBook'))
    .map(([, init]) => {
      if (typeof init?.body !== 'string') throw new Error('el PreBook no llevó un body de texto');
      return JSON.parse(init.body) as Record<string, unknown>;
    });
}

describe('TBO de punta a punta: búsqueda de p. 16 y PreBook de p. 28', () => {
  it('RF-15 CA-1: por el cable sale exactamente el PreBook de Postman: `BookingCode` y `PaymentMode: "Limit"`', async () => {
    const b = bancoTbo();
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    await b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO);

    const postman = fixture('pdf/prebook-request-limit.p19.json');
    const [cuerpo] = prebooksDe(b.fetch);
    expect(cuerpo).toEqual({ BookingCode: BC_4, PaymentMode: 'Limit' });
    expect(Object.keys(cuerpo ?? {}).sort()).toEqual(Object.keys(postman).sort());
  });

  it('C1 del ejemplo: mismo total, mismo régimen, mismos cargos en el hotel → UNCHANGED, con políticas finales y la señal de paquete', async () => {
    const b = bancoTbo();
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const res = await b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO);

    expect(res.repricing).toEqual({
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: { amountMinor: NETO, currency: 'USD' },
      currentTotal: { amountMinor: NETO, currency: 'USD' },
    });
    expect(res.roompack.cancellation.policySource).toBe('prebook-final');
    expect(res.signals).toContain('PACKAGE_WITH_FLIGHT_ONLY');
    // RF-16: nada de HTML del proveedor llega al navegador.
    const textos = res.rateConditions.map((c) => c.text).join('\n');
    expect(textos).not.toMatch(/&lt;|<ul>|<li>/);
    expect(res.rateConditions.every((c) => !('raw' in c))).toBe(true);
    expect(b.emit).not.toHaveBeenCalled();
  });

  it('RF-12 CA-1 con el valor de PreBook: neto 305.75, +3 % y +1 % → 318.07, piso 321.34 → 321.34', async () => {
    const b = bancoTbo();
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const res = await b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO);

    expect(res.roompack.price.minimumSellingPrice).toEqual({ amountMinor: PISO, currency: 'USD' });
    expect(res.roompack.pricing).toEqual({
      costMinor: NETO + 917,
      finalMinor: PISO,
      ownMarkupMinor: 315 + 327,
      currency: 'USD',
    });
  });

  it('el snapshot guarda el `BookingCode` y el literal de `TotalFare` que el Book reenvía', async () => {
    const b = bancoTbo();
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const res = await b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO);

    await expect(b.snapshots.get(AGENCIA, res.prebookRef)).resolves.toMatchObject({
      providerCode: TBO,
      hotelId: '1120548',
      offerRef: BC_4,
      totalText: '305.75',
      currency: 'USD',
      account: { accountId: 'acc-tbo-consolidador', updatedAt: '2026-09-01T00:00:00.000Z' },
    });
  });

  it('RF-09 CA-2: un 315 muestra "La cotización venció", invalida el contexto y el siguiente PreBook no sale', async () => {
    const b = bancoTbo(() => sobre('envelope/83-315-bookingcode-expired.json'));
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const err: unknown = await b.prebooks
      .prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TboApiError);
    expect((err as TboApiError).kind).toBe('OFFER_EXPIRED');
    expect(tboErrorStatus(err)).toBe(HttpStatus.CONFLICT);
    expect(tboErrorReason(err)).toBe('OFFER_EXPIRED');
    expect(humanizeTboError(err)).toContain('La cotización venció');

    await expect(
      b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_2), USUARIO),
    ).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
    expect(prebooksDe(b.fetch)).toHaveLength(1);
  });

  it('RF-23: un 300 en el PreBook avisa al consolidador, dueño de la cuenta, y no a la agencia', async () => {
    const b = bancoTbo(() => sobre('envelope/83-300-insufficient-balance.json'));
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const err: unknown = await b.prebooks
      .prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO)
      .catch((e: unknown) => e);

    expect((err as TboApiError).kind).toBe('INSUFFICIENT_BALANCE');
    expect(humanizeTboError(err, { credentialSource: 'inherited' })).toBe(
      'La cuenta de TBO del consolidador no tiene saldo suficiente para esta reserva. Avisale al consolidador.',
    );
    expect(b.emit.mock.calls).toEqual([
      [
        {
          eventType: 'ProviderAccountIssueDetected',
          tenantId: CONSOLIDADOR,
          actorUserId: USUARIO,
          aggregateType: 'provider_account',
          aggregateId: 'acc-tbo-consolidador',
          payload: {
            provider: 'tbo-hotels',
            vertical: 'hotels',
            reason: 'insufficient-balance',
            stage: 'prebook',
            credentialSource: 'inherited',
            sellerTenantId: AGENCIA,
            providerAccountId: 'acc-tbo-consolidador',
          },
        },
      ],
    ]);
    expect(JSON.stringify(b.emit.mock.calls)).not.toMatch(/insufficient funds/i);
  });

  it('RF-23: si el aviso no se puede escribir, el vendedor ve igual el error de TBO', async () => {
    const b = bancoTbo(() => sobre('envelope/83-300-insufficient-balance.json'));
    b.emit.mockRejectedValue(new Error('auditoría caída'));
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const err: unknown = await b.prebooks
      .prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TboApiError);
    expect((err as TboApiError).kind).toBe('INSUFFICIENT_BALANCE');
  });

  it.each([
    ['207', 'envelope/83-207-rate-unavailable.json', 'RATE_UNAVAILABLE'],
    ['201', 'envelope/83-201-no-availability-prebook.json', 'NO_AVAILABILITY'],
  ])(
    'RF-15 CA-4: un %s invalida esa tarifa; otra de la misma búsqueda se revalida',
    async (_codigo, ruta, kind) => {
      const b = bancoTbo(() => sobre(ruta));
      const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

      const err: unknown = await b.prebooks
        .prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO)
        .catch((e: unknown) => e);
      expect((err as TboApiError).kind).toBe(kind);
      expect(tboErrorStatus(err)).toBe(HttpStatus.CONFLICT);

      await expect(
        b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO),
      ).rejects.toBeInstanceOf(HotelOfferUnavailableError);
      expect(prebooksDe(b.fetch)).toHaveLength(1);

      await b.prebooks
        .prebook(AGENCIA, referenciaTbo(oferta, BC_2), USUARIO)
        .catch(() => undefined);
      expect(prebooksDe(b.fetch)).toHaveLength(2);
    },
  );

  it('RF-08 CA-1: el consolidador, con la MISMA cuenta heredada, no revalida la búsqueda de su agencia → 409 sin llamar a TBO', async () => {
    const b = bancoTbo();
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    await expect(
      b.prebooks.prebook(CONSOLIDADOR, referenciaTbo(oferta, BC_4), USUARIO),
    ).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
    expect(prebooksDe(b.fetch)).toHaveLength(0);
  });

  it('RF-09 CA-1: pasados los 27 minutos desde el Search no sale ningún PreBook', async () => {
    const b = bancoTbo();
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);
    vi.setSystemTime(T0 + 27 * MIN + 1_000);

    await expect(
      b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO),
    ).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
    expect(prebooksDe(b.fetch)).toHaveLength(0);
  });

  it('RF-15 CA-2: si el PreBook trae otro `BookingCode`, el snapshot guarda el del PreBook y la respuesta avisa', async () => {
    const otro = '1120548!TB!7!TB!9a47646b-1bba-4746-91d5-969149db1185';
    const b = bancoTbo(() => {
      const base = fixture('pdf/prebook-limit-multi-room.p28.json') as {
        HotelResult: { Rooms: Record<string, unknown>[] }[];
      };
      const [room] = base.HotelResult[0]?.Rooms ?? [];
      if (room !== undefined) room['BookingCode'] = otro;
      return base;
    });
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const res = await b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO);

    expect(prebooksDe(b.fetch)).toEqual([{ BookingCode: BC_4, PaymentMode: 'Limit' }]);
    expect(res.warnings).toContain('BOOKING_CODE_CHANGED');
    expect(res.roompack.provider.offerRef).toBe(otro);
    await expect(b.snapshots.get(AGENCIA, res.prebookRef)).resolves.toMatchObject({
      offerRef: otro,
    });
  });

  it('un PreBook con otro total que el buscado → INCREASED, con el evento', async () => {
    const b = bancoTbo(() => {
      const base = fixture('pdf/prebook-limit-multi-room.p28.json') as {
        HotelResult: { Rooms: Record<string, unknown>[] }[];
      };
      const [hotel] = base.HotelResult;
      const [room] = hotel?.Rooms ?? [];
      if (room !== undefined) room['TotalFare'] = 310.1;
      return base;
    });
    const oferta = await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO);

    const res = await b.prebooks.prebook(AGENCIA, referenciaTbo(oferta, BC_4), USUARIO);

    expect(res.repricing).toMatchObject({
      outcome: 'INCREASED',
      price: 'UP',
      previousTotal: { amountMinor: NETO, currency: 'USD' },
      currentTotal: { amountMinor: 31_010, currency: 'USD' },
    });
    expect(b.emit).toHaveBeenCalledTimes(1);
  });
});
