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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import type { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
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
import { AllHotelProvidersFailedError } from './hotel-provider-errors.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import {
  BookSchema,
  CancelBodySchema,
  HotelAvailabilityInputSchema,
  HotelDetailInputSchema,
  HotelSuggestQuerySchema,
  PaymentOptionsQuerySchema,
  PrebookSchema,
  RecoveryBodySchema,
  type HotelAvailabilityInput,
} from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

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
}

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

  const service = new HotelsService(registry, db.service, pricing, telemetry, breaker);
  const reservations = new DespegarHotelReservationsService(registry, factory, breaker);
  const resolve = vi.fn((_userId: string) => Promise.resolve(TENANT));
  const disclosure = {
    effective: () => Promise.resolve(false),
  } as unknown as ProviderDisclosureService;
  const controller = new HotelsController(
    service,
    reservations,
    { resolve } as unknown as ActiveTenantService,
    disclosure,
  );

  return { controller, adapter, resolve };
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

  it('cuelga de `/hotels`, sólo para roles que venden, con el filtro de Despegar', () => {
    const ruta: unknown = Reflect.getMetadata(PATH_METADATA, HotelsController);
    const roles: unknown = Reflect.getMetadata(ROLES_KEY, HotelsController);
    const filtros: unknown = Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, HotelsController);

    expect(ruta).toBe('hotels');
    expect(roles).toEqual([...SELLING_ROLES]);
    expect(filtros).toEqual([DespegarHotelsExceptionFilter]);
  });

  it.each([
    ['suggestions', RequestMethod.GET, 'suggestions', [HotelSuggestQuerySchema]],
    ['availability', RequestMethod.POST, 'availability', [HotelAvailabilityInputSchema]],
    ['detail', RequestMethod.POST, 'detail', [HotelDetailInputSchema]],
    ['prebook', RequestMethod.POST, 'prebook', [PrebookSchema]],
    ['payments', RequestMethod.GET, 'payments', [PaymentOptionsQuerySchema]],
    ['book', RequestMethod.POST, 'book', [BookSchema]],
    ['getReservation', RequestMethod.GET, 'reservations/:id', []],
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

  it('no hay más rutas que esas nueve', () => {
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
    ['payments', (c, u) => c.payments(u, { prebookId: 'PB-0001' })],
    ['book', (c, u) => c.book(u, BOOK)],
    ['getReservation', (c, u) => c.getReservation(u, 'RES-0001')],
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
