import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, Logger, RequestMethod } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { DespegarApiError, type BookRequest } from '@sales-travel/despegar-hotels';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import type { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb } from './__fixtures__/fake-hotels-db.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { DespegarHotelsExceptionFilter } from './despegar-hotels-exception.filter.js';
import { humanizeDespegarError } from './despegar-hotels-errors.js';
import type { HotelBookResponse, HotelBookingService } from './hotel-booking.service.js';
import { HotelContentService } from './hotel-content.service.js';
import { HotelPrebookSnapshotStore } from './hotel-prebook-snapshot.store.js';
import { HotelPrebookService } from './hotel-prebook.service.js';
import {
  AllHotelProvidersFailedError,
  HotelProviderCapabilityError,
} from './hotel-provider-errors.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import {
  CancelBodySchema,
  HotelAvailabilityInputSchema,
  HotelBookBodySchema,
  HotelContentParamsSchema,
  HotelContentQuerySchema,
  HotelDetailInputSchema,
  HotelPrebookBodySchema,
  HotelSuggestQuerySchema,
  PaymentOptionsQuerySchema,
  RecoveryBodySchema,
  isNeutralHotelBook,
  type HotelAvailabilityInput,
  type HotelBookInput,
} from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';

/**
 * Red de seguridad de `HotelsController` (PR-0.1 del plan de hoteles multi-proveedor, RNF-14
 * punto 3).
 *
 * El controller se arma con los servicios REALES, el registry REAL y el envoltorio neutral REAL
 * sobre un ACL falso de Despegar, así que lo que se afirma es lo que sale por HTTP. El snapshot
 * `__fixtures__/availability.snapshot.json` es la referencia de "contenido idéntico" de PR-0.5:
 * no se toca; lo que PR-0.5 añadió se quita antes de comparar y se afirma aparte.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const USUARIO = 'u-vendedor-1';

/** El catálogo de la ciudad 2345; `412` no tiene cupo en la respuesta grabada de Despegar. */
const CATALOGO = ['101', '205', '350', '412'];

/** Las reglas que ve la agencia: el 10 % de su consolidador y 25,00 fijos propios. */
const REGLAS: ApplicableRule[] = [
  {
    tenantId: CONSOLIDADOR,
    tenantName: 'Consolidador',
    level: 0,
    ruleType: 'percentage',
    valueMinor: 1000,
  },
  { tenantId: TENANT, tenantName: 'Agencia', level: 1, ruleType: 'fixed', valueMinor: 2500 },
];

/**
 * La forma del cuerpo que arma `apps/web-b2b/src/app/(app)/hoteles/actions.ts` para buscar por
 * ciudad. La web siempre manda `childrenAges`; la segunda habitación lo omite para que el default
 * del esquema quede dentro del snapshot.
 */
const PEDIDO_WEB: unknown = {
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-13',
  rooms: [{ adults: 2, childrenAges: [7] }, { adults: 1 }],
  destinationId: 2345,
};

const SNAPSHOT = join(__dirname, '__fixtures__', 'availability.snapshot.json');

interface Banco {
  controller: HotelsController;
  adapter: FakeDespegarHotelsAdapter;
  resolve: ReturnType<typeof vi.fn>;
  prebooks: HotelPrebookService;
  bookings: { book: ReturnType<typeof vi.fn> };
}

/** Lo que responde la saga de reserva con órdenes cuando el Book sigue en curso. */
const RESERVA_EN_CURSO: HotelBookResponse = {
  httpStatus: 202,
  body: {
    orderId: '33333333-3333-4333-8333-333333333333',
    orderNumber: 7,
    status: 'pending',
    providerCode: 'tbo-hotels',
    providerBookingId: null,
    bookingReference: 'STT0123456789ABCDEFGH',
    total: { amountMinor: 32_134, currency: 'USD' },
    reason: 'book-in-progress',
    warnings: [],
  },
};

function banco(reglas: ApplicableRule[] = REGLAS): Banco {
  const adapter = new FakeDespegarHotelsAdapter();
  const { factory } = fakeDespegarFactory(adapter);
  const registry = hotelRegistry([factory]);
  const breaker = new CircuitBreakerService();
  const db = fakeHotelsDb({
    catalogo: CATALOGO,
    tenant: { default_currency: 'USD', country_code: 'CO' },
  });
  const telemetry = {
    assertWithinQuota: () => Promise.resolve(),
    instrument: (_meta: unknown, run: () => Promise<unknown>) => run(),
  } as unknown as SearchTelemetryService;
  const pricing = {
    getApplicableRules: () => Promise.resolve(reglas),
  } as unknown as PricingService;

  const cache = new MemoryCacheAdapter();
  const contexts = new HotelSearchContextStore(cache);
  const service = new HotelsService(registry, db.service, pricing, telemetry, breaker, contexts);
  const reservations = new DespegarHotelReservationsService(registry, factory, breaker);
  const prebooks = new HotelPrebookService(
    registry,
    contexts,
    new HotelPrebookSnapshotStore(cache),
    pricing,
    breaker,
    { emit: () => Promise.resolve() } as unknown as AuditService,
  );
  const resolve = vi.fn((_userId: string) => Promise.resolve(TENANT));
  const disclosure = {
    effective: () => Promise.resolve(false),
  } as unknown as ProviderDisclosureService;
  const bookings = { book: vi.fn(() => Promise.resolve(RESERVA_EN_CURSO)) };
  const content = new HotelContentService(registry, db.service, breaker, new MemoryCacheAdapter());
  const controller = new HotelsController(
    service,
    reservations,
    { resolve } as unknown as ActiveTenantService,
    disclosure,
    prebooks,
    bookings as unknown as HotelBookingService,
    content,
  );

  return { controller, adapter, resolve, prebooks, bookings };
}

/** El cuerpo tal como lo entrega el pipe de la ruta: validado y con los defaults aplicados. */
function pedidoValidado(): HotelAvailabilityInput {
  // El pipe tipa su salida con la ENTRADA del esquema, pero en runtime devuelve
  // `safeParse().data`, que es la salida (con `childrenAges` ya en []).
  return new ZodValidationPipe(HotelAvailabilityInputSchema).transform(
    PEDIDO_WEB,
  ) as HotelAvailabilityInput;
}

/** Lo que el browser recibe: la respuesta después de pasar por `JSON.stringify`. */
function porElCable(valor: unknown): unknown {
  return JSON.parse(JSON.stringify(valor)) as unknown;
}

/** El sobre sin lo que PR-0.5 AÑADIÓ: `providers`, el booleano y el `provider` de cada tarifa. */
function comoAntes(sobre: HotelSearchEnvelope): unknown {
  return {
    hotels: sobre.hotels.map((o) => ({
      ...o,
      roompacks: o.roompacks.map(({ provider: _provider, ...resto }) => resto),
    })),
  };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /hotels/availability — snapshot', () => {
  it('contenido idéntico: sin lo añadido, el cuerpo coincide con `availability.snapshot.json`', async () => {
    // Se compara contra un JSON leído, no con `toMatchSnapshot`: un `vitest -u` no puede
    // "arreglar" la referencia sin que el diff lo muestre. PR-0.5 no toca el snapshot: cada
    // campo de `hotels[]` que existía coincide, y lo nuevo se afirma en el caso siguiente.
    const b = banco();
    const body = pedidoValidado();
    const res = await b.controller.availability(USUARIO, body);

    const esperado = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as unknown;
    expect(porElCable(comoAntes(res))).toEqual(esperado);
  });

  it('lo añadido: cada tarifa dice de qué proveedor es, el parte por proveedor y el booleano', async () => {
    const b = banco();
    const res = await b.controller.availability(USUARIO, pedidoValidado());

    const packs = res.hotels.flatMap((o) => o.roompacks);
    expect(packs.map((rp) => rp.provider)).toEqual(
      packs.map((rp) => ({ name: 'despegar-hotels', offerRef: rp.id })),
    );
    expect(res.providers).toEqual([{ code: 'despegar-hotels', status: 'ok', count: 3 }]);
    expect(res.showProviderInResults).toBe(false);
  });

  it('Despegar recibió la búsqueda que arma el servicio con los defaults del tenant', async () => {
    const b = banco();
    const body = pedidoValidado();
    await b.controller.availability(USUARIO, body);

    expect(b.adapter.searchAvailability).toHaveBeenCalledWith({
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      currency: 'USD',
      hotelIds: CATALOGO,
      rooms: [
        { adults: 2, childrenAges: [7] },
        { adults: 1, childrenAges: [] },
      ],
      countryCode: 'CO',
      language: undefined,
      refundableOnly: undefined,
    });
  });

  it('PR-0.5: el sobre CRECE: `{ hotels, providers, showProviderInResults }`', async () => {
    const b = banco();
    const body = pedidoValidado();
    const res = await b.controller.availability(USUARIO, body);

    expect(Object.keys(res)).toEqual(['hotels', 'providers', 'showProviderInResults']);
  });

  it('PR-0.5: un error de Despegar sale como 502 con el texto que antes ponía el filtro', async () => {
    // El fan-out humaniza el error con el mismo traductor del filtro; el 502 lo arma el servicio.
    const b = banco();
    const caido = new DespegarApiError(503, 'Service Unavailable', '/hotels-api/availability');
    b.adapter.searchAvailability.mockRejectedValueOnce(caido);
    const body = pedidoValidado();

    const err = await b.controller.availability(USUARIO, body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllHotelProvidersFailedError);
    expect((err as AllHotelProvidersFailedError).failures).toEqual([
      { code: 'despegar-hotels', reason: humanizeDespegarError(503, 'Service Unavailable') },
    ]);
  });
});

describe('HotelsController — superficie HTTP', () => {
  /** El handler como función, sin desligarlo del prototipo (`unbound-method`). */
  function handler(nombre: string): object {
    const d = Object.getOwnPropertyDescriptor(HotelsController.prototype, nombre);
    if (typeof d?.value !== 'function') throw new Error(`HotelsController no tiene ${nombre}`);
    return d.value as object;
  }

  /** Los esquemas Zod de los pipes de parámetros de un handler. */
  function esquemasDe(nombre: string): unknown[] {
    const args: unknown = Reflect.getMetadata(ROUTE_ARGS_METADATA, HotelsController, nombre);
    return Object.values((args ?? {}) as Record<string, { pipes?: unknown[] }>)
      .flatMap((a) => a.pipes ?? [])
      .filter((p) => p instanceof ZodValidationPipe)
      .map((p) => (p as unknown as { schema: unknown }).schema);
  }

  it('cuelga de `/hotels`, sólo para roles que venden, con el filtro de cada proveedor', () => {
    const ruta: unknown = Reflect.getMetadata(PATH_METADATA, HotelsController);
    const roles: unknown = Reflect.getMetadata(ROLES_KEY, HotelsController);
    const filtros: unknown = Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, HotelsController);

    expect(ruta).toBe('hotels');
    expect(roles).toEqual([...SELLING_ROLES]);
    // Un error de TBO sin su filtro saldría como 500 del filtro global (06 §5.1, A8).
    expect(filtros).toEqual([DespegarHotelsExceptionFilter, TboHotelsExceptionFilter]);
  });

  it.each([
    ['suggestions', RequestMethod.GET, 'suggestions', [HotelSuggestQuerySchema]],
    ['availability', RequestMethod.POST, 'availability', [HotelAvailabilityInputSchema]],
    ['detail', RequestMethod.POST, 'detail', [HotelDetailInputSchema]],
    ['prebook', RequestMethod.POST, 'prebook', [HotelPrebookBodySchema]],
    ['payments', RequestMethod.GET, 'payments', [PaymentOptionsQuerySchema]],
    ['book', RequestMethod.POST, 'book', [HotelBookBodySchema]],
    ['getReservation', RequestMethod.GET, 'reservations/:id', []],
    [
      'content',
      RequestMethod.GET,
      'content/:providerCode/:hotelId',
      // Nest registra los parámetros del último al primero: el query antes que la ruta.
      [HotelContentQuerySchema, HotelContentParamsSchema],
    ],
    ['cancel', RequestMethod.POST, 'reservations/:id/cancel', [CancelBodySchema]],
    ['recovery', RequestMethod.POST, 'reservations/:id/recovery', [RecoveryBodySchema]],
  ])('%s → %s /hotels/%s, validado con su esquema', (nombre, metodo, ruta, esquemas) => {
    const fn = handler(nombre);
    const metodoDeclarado: unknown = Reflect.getMetadata(METHOD_METADATA, fn);
    const rutaDeclarada: unknown = Reflect.getMetadata(PATH_METADATA, fn);

    expect(metodoDeclarado).toBe(metodo);
    expect(rutaDeclarada).toBe(ruta);
    expect(esquemasDe(nombre)).toEqual(esquemas);
  });

  it('no hay más rutas que esas diez', () => {
    const rutas = Object.getOwnPropertyNames(HotelsController.prototype).filter(
      (nombre) =>
        nombre !== 'constructor' &&
        Reflect.getMetadata(METHOD_METADATA, handler(nombre)) !== undefined,
    );
    expect(rutas.sort()).toEqual(
      [
        'availability',
        'book',
        'cancel',
        'content',
        'detail',
        'getReservation',
        'payments',
        'prebook',
        'recovery',
        'suggestions',
      ].sort(),
    );
  });

  it('ningún handler fija `@HttpCode`: los POST contestan 201, como Nest por defecto', () => {
    for (const nombre of ['availability', 'detail', 'prebook', 'book', 'cancel', 'recovery']) {
      const codigo: unknown = Reflect.getMetadata(HTTP_CODE_METADATA, handler(nombre));
      expect(codigo).toBeUndefined();
    }
  });
});

describe('HotelsController — tenant', () => {
  const BOOK: BookRequest = {
    prebookId: 'PB-0001',
    externalBookingReference: 'ISO-0001',
    contact: { email: 'reservas@agencia.example' },
    travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
    payment: { optionType: 'ONE_CARD', units: [{ planId: 'PL-1', secureToken: 'tok_hosted' }] },
  };

  const HANDLERS: [string, (c: HotelsController, u: string | undefined) => Promise<unknown>][] = [
    ['suggestions', (c, u) => c.suggestions(u, { q: 'bogo' })],
    ['availability', (c, u) => c.availability(u, pedidoValidado())],
    [
      'detail',
      (c, u) =>
        c.detail(u, {
          hotelId: '101',
          checkinDate: '2026-11-10',
          checkoutDate: '2026-11-13',
          rooms: [{ adults: 2, childrenAges: [] }],
        }),
    ],
    ['prebook', (c, u) => c.prebook(u, { choiceId: 'CH-1' })],
    [
      'prebook neutral',
      (c, u) =>
        c
          .prebook(u, { providerCode: 'despegar-hotels', searchId: 'busqueda-1', offerRef: 'CH-1' })
          .catch((e: unknown) => {
            // Despegar no revalida por contexto: basta con que el tenant se haya resuelto.
            if (e instanceof HotelProviderCapabilityError) return undefined;
            throw e;
          }),
    ],
    ['payments', (c, u) => c.payments(u, { prebookId: 'PB-0001' })],
    ['book', (c, u) => c.book(u, BOOK)],
    ['getReservation', (c, u) => c.getReservation(u, 'RES-0001')],
    [
      'content',
      (c, u) => c.content(u, { providerCode: 'despegar-hotels', hotelId: '101' }, { lang: 'es' }),
    ],
    ['cancel', (c, u) => c.cancel(u, 'RES-0001', {})],
    [
      'recovery',
      (c, u) =>
        c.recovery(u, 'RES-0001', {
          messageType: 'PRICE_JUMP',
          confirmations: [{ flavorId: 'H0', confirm: true }],
        }),
    ],
  ];

  it.each(HANDLERS)('%s sin usuario → 403 y no llega a Despegar', async (_nombre, llamar) => {
    const b = banco();
    await expect(llamar(b.controller, undefined)).rejects.toBeInstanceOf(ForbiddenException);

    expect(b.resolve).not.toHaveBeenCalled();
    const tocados = Object.values(b.adapter).filter(
      (m) => vi.isMockFunction(m) && m.mock.calls.length > 0,
    );
    expect(tocados).toEqual([]);
  });

  it.each(HANDLERS)('%s resuelve el tenant activo del usuario', async (_nombre, llamar) => {
    const b = banco();
    await llamar(b.controller, USUARIO);

    expect(b.resolve).toHaveBeenCalledWith(USUARIO);
  });
});

describe('HotelsController — sobres y paso de parámetros', () => {
  it('suggestions devuelve `{ items }` con el texto y el locale del query', async () => {
    const b = banco();
    const res = await b.controller.suggestions(USUARIO, { q: 'bogo', locale: 'es_CO' });

    expect(b.adapter.suggest).toHaveBeenCalledWith('bogo', 'es_CO');
    expect(Object.keys(res)).toEqual(['items']);
    expect(res.items).toBe(await b.adapter.suggest.mock.results[0]?.value);
  });

  it('payments devuelve `{ modalities }`', async () => {
    const b = banco();
    const query = { prebookId: 'PB-0001', inputPoints: 0 };
    const res = await b.controller.payments(USUARIO, query);

    expect(b.adapter.getPaymentOptions.mock.calls[0]?.[0]).toBe(query);
    expect(res).toEqual({ modalities: [] });
  });

  it('PR-0.5: detail devuelve la oferta sin sobre, con cada tarifa atribuida a su proveedor', async () => {
    const b = banco([]);
    const res = await b.controller.detail(USUARIO, {
      hotelId: '101',
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      rooms: [{ adults: 2, childrenAges: [] }],
    });

    const delAcl = (await b.adapter.getHotelDetail.mock.results[0]?.value) as {
      roompacks: { id: string }[];
    };
    expect(res.hotelId).toBe('101');
    expect(res.roompacks.map((rp) => [rp.id, rp.provider.name])).toEqual(
      delAcl.roompacks.map((rp) => [rp.id, 'despegar-hotels']),
    );
  });

  it('PR-3.6: content devuelve la ficha sin sobre; sin contenido, sin imágenes y sin error', async () => {
    const b = banco();
    const res = await b.controller.content(
      USUARIO,
      { providerCode: 'despegar-hotels', hotelId: '101' },
      { lang: 'pt' },
    );

    expect(res).toMatchObject({
      providerCode: 'despegar-hotels',
      hotelId: '101',
      requestedLang: 'pt',
      lang: null,
      origin: 'none',
      images: [],
      descriptionHtml: null,
    });
    // La ficha no sale a Despegar: su contenido llega con la disponibilidad.
    const tocados = Object.values(b.adapter).filter(
      (m) => vi.isMockFunction(m) && m.mock.calls.length > 0,
    );
    expect(tocados).toEqual([]);
  });

  it('PR-3.6: la ruta valida el proveedor, el código de hotel y el idioma, y el idioma por defecto es español', () => {
    const rutas = new ZodValidationPipe(HotelContentParamsSchema);
    const query = new ZodValidationPipe(HotelContentQuerySchema);

    expect(rutas.transform({ providerCode: 'tbo-hotels', hotelId: '1000000' })).toEqual({
      providerCode: 'tbo-hotels',
      hotelId: '1000000',
    });
    expect(() => rutas.transform({ providerCode: 'TBO Hotels', hotelId: '1' })).toThrow();
    expect(() => rutas.transform({ providerCode: 'tbo-hotels', hotelId: '1,2' })).toThrow();
    expect(() =>
      rutas.transform({ providerCode: 'tbo-hotels', hotelId: 'x'.repeat(65) }),
    ).toThrow();
    expect(query.transform({})).toEqual({ lang: 'es' });
    expect(query.transform({ lang: 'PT' })).toEqual({ lang: 'pt' });
    expect(() => query.transform({ lang: 'fr' })).toThrow();
  });

  it('prebook, book y getReservation devuelven lo del adapter sin sobre', async () => {
    const b = banco();
    const prebook = await b.controller.prebook(USUARIO, { choiceId: 'CH-1' });
    const book = await b.controller.book(USUARIO, {
      prebookId: 'PB-0001',
      externalBookingReference: 'ISO-0001',
      contact: { email: 'reservas@agencia.example' },
      travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
      payment: { optionType: 'ONE_CARD', units: [{ planId: 'PL-1', secureToken: 'tok_hosted' }] },
    });
    const reserva = await b.controller.getReservation(USUARIO, 'RES-0042');

    expect(prebook).toBe(await b.adapter.prebook.mock.results[0]?.value);
    expect(book).toBe(await b.adapter.book.mock.results[0]?.value);
    expect(b.adapter.getReservation).toHaveBeenCalledWith('RES-0042');
    expect(reserva).toBe(await b.adapter.getReservation.mock.results[0]?.value);
  });

  it('PR-4.5: el cuerpo de Despegar va a su flujo; el neutral, al PreBook con contexto, con el usuario como actor', async () => {
    const b = banco();
    const respuesta = {
      prebookRef: 'pb',
    } as unknown as Awaited<ReturnType<HotelPrebookService['prebook']>>;
    const neutral = vi.spyOn(b.prebooks, 'prebook').mockResolvedValue(respuesta);
    const referencia = {
      providerCode: 'tbo-hotels',
      searchId: 'busqueda-1',
      offerRef: '1120548!TB!2!TB!x',
    };

    const deDespegar = await b.controller.prebook(USUARIO, { choiceId: 'CH-1' });
    const delNeutral = await b.controller.prebook(USUARIO, referencia);

    expect(deDespegar).toBe(await b.adapter.prebook.mock.results[0]?.value);
    expect(b.adapter.prebook).toHaveBeenCalledTimes(1);
    expect(neutral).toHaveBeenCalledTimes(1);
    expect(neutral).toHaveBeenCalledWith(TENANT, referencia, USUARIO);
    expect(delNeutral).toBe(respuesta);
  });

  it('PR-4.5: el cuerpo neutral con un proveedor sin PreBook por contexto → 400, sin llegar a Despegar', async () => {
    const b = banco();

    const err = await b.controller
      .prebook(USUARIO, {
        providerCode: 'despegar-hotels',
        searchId: 'busqueda-1',
        offerRef: 'CH-1',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelProviderCapabilityError);
    expect((err as HotelProviderCapabilityError).getStatus()).toBe(400);
    expect(b.adapter.prebook).not.toHaveBeenCalled();
  });

  it('cancel arma la petición con el id de la ruta y el motivo del cuerpo', async () => {
    const b = banco();
    await b.controller.cancel(USUARIO, 'RES-0042', { reason: 'ILLNESS' });

    expect(b.adapter.cancelReservation).toHaveBeenCalledWith({
      reservationId: 'RES-0042',
      reason: 'ILLNESS',
    });
  });

  it('cancel sin motivo no inventa uno', async () => {
    const b = banco();
    await b.controller.cancel(USUARIO, 'RES-0042', {});

    expect(b.adapter.cancelReservation.mock.calls[0]?.[0].reason).toBeUndefined();
  });

  it('recovery arma la petición con el id de la ruta y los campos del cuerpo', async () => {
    const b = banco();
    await b.controller.recovery(USUARIO, 'RES-0042', {
      messageType: 'PRICE_JUMP',
      confirmations: [{ flavorId: 'H0', confirm: false }],
      testCase: 'pricejump',
    });

    expect(b.adapter.recoverBooking).toHaveBeenCalledWith({
      reservationId: 'RES-0042',
      messageType: 'PRICE_JUMP',
      confirmations: [{ flavorId: 'H0', confirm: false }],
      testCase: 'pricejump',
    });
  });
});

describe('PR-4.6: POST /hotels/book con el cuerpo neutral reserva con orden detrás', () => {
  const NEUTRAL: HotelBookInput = {
    providerCode: 'tbo-hotels',
    prebookRef: '44444444-4444-4444-8444-444444444444',
    acceptedTotal: { amountMinor: 32_134, currency: 'USD' },
    atPropertyAcknowledged: true,
    rooms: [{ guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'Juan', lastName: 'Pérez' }] }],
    contact: { email: 'cliente@example.com', phone: { countryCode: '57', number: '3001234567' } },
  };
  const CLAVE = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

  it('va a la saga con el tenant, el usuario como actor y la clave, y responde con el estado que decidió', async () => {
    const b = banco();
    const status = vi.fn();

    const res = await b.controller.book(USUARIO, NEUTRAL, CLAVE, {
      status,
    } as unknown as Response);

    expect(b.bookings.book).toHaveBeenCalledTimes(1);
    expect(b.bookings.book).toHaveBeenCalledWith(TENANT, USUARIO, CLAVE, NEUTRAL);
    expect(status).toHaveBeenCalledWith(202);
    expect(res).toBe(RESERVA_EN_CURSO.body);
    expect(b.adapter.book).not.toHaveBeenCalled();
  });

  it('llamado sin la respuesta de Express (fuera de Nest) devuelve el cuerpo igual', async () => {
    const b = banco();

    await expect(b.controller.book(USUARIO, NEUTRAL, CLAVE)).resolves.toBe(RESERVA_EN_CURSO.body);
  });

  it('D-TBO-08 A: el cuerpo de Despegar sigue yendo a su flujo, sin saga ni orden', async () => {
    const b = banco();
    const status = vi.fn();

    const res = await b.controller.book(
      USUARIO,
      {
        prebookId: 'PB-0001',
        externalBookingReference: 'ISO-0001',
        contact: { email: 'reservas@agencia.example' },
        travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
        payment: {
          optionType: 'ONE_CARD',
          units: [{ planId: 'PL-1', secureToken: 'tok_hosted' }],
        },
      },
      CLAVE,
      { status } as unknown as Response,
    );

    expect(res).toBe(await b.adapter.book.mock.results[0]?.value);
    expect(b.bookings.book).not.toHaveBeenCalled();
    // Despegar contesta como siempre: 201 de Nest, sin tocar el estado.
    expect(status).not.toHaveBeenCalled();
  });

  it('sin usuario → 403, sin llegar a la saga', async () => {
    const b = banco();

    await expect(b.controller.book(undefined, NEUTRAL, CLAVE)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(b.bookings.book).not.toHaveBeenCalled();
    expect(b.resolve).not.toHaveBeenCalled();
  });

  it('el esquema distingue los dos cuerpos por su forma; el neutral no acepta campos de más', () => {
    const neutral = HotelBookBodySchema.safeParse(NEUTRAL);
    const conImporte = HotelBookBodySchema.safeParse({ ...NEUTRAL, totalFare: '305.75' });
    const sinHuespedes = HotelBookBodySchema.safeParse({ ...NEUTRAL, rooms: [] });
    const conDr = HotelBookBodySchema.safeParse({
      ...NEUTRAL,
      rooms: [{ guests: [{ paxType: 'ADT', title: 'Dr', firstName: 'Juan', lastName: 'Perez' }] }],
    });

    expect(neutral.success && 'prebookRef' in neutral.data).toBe(true);
    // El navegador no aporta ningún importe que llegue al proveedor (RF-08 CA-4).
    expect(conImporte.success).toBe(false);
    expect(sinHuespedes.success).toBe(false);
    // RF-18 CA-2: `Dr` no, hasta que TBO lo confirme.
    expect(conDr.success).toBe(false);
  });

  it('D-TBO-08 A: un 400 sigue nombrando el campo que falta, en el cuerpo de Despegar y en el neutral', () => {
    const rutas = (body: unknown): string[] => {
      const parsed = HotelBookBodySchema.safeParse(body);
      return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
    };
    const { contact: _contacto, ...neutralSinContacto } = NEUTRAL;

    // Con `z.union` los dos salían como un único `(general): Invalid input`.
    expect(
      rutas({
        prebookId: 'PB-0001',
        contact: { email: 'reservas@agencia.example' },
        travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
        payment: { optionType: 'ONE_CARD', units: [{ planId: 'PL-1', secureToken: 'tok' }] },
      }),
    ).toEqual(['externalBookingReference']);
    expect(rutas(neutralSinContacto)).toEqual(['contact']);
    expect(rutas({ ...NEUTRAL, totalFare: '305.75' })).toEqual(['']);
    expect(rutas('texto')).toEqual(['']);
  });

  it('D-TBO-08 A: un cuerpo de Despegar con campos de más sigue yendo a Despegar, sin ellos', () => {
    const parsed = HotelBookBodySchema.safeParse({
      prebookId: 'PB-0001',
      externalBookingReference: 'ISO-0001',
      providerCode: 'despegar-hotels',
      contact: { email: 'reservas@agencia.example' },
      travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
      payment: { optionType: 'ONE_CARD', units: [{ planId: 'PL-1', secureToken: 'tok' }] },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && isNeutralHotelBook(parsed.data)).toBe(false);
    expect(parsed.success && 'providerCode' in parsed.data).toBe(false);
  });
});
