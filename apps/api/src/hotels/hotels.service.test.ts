import {
  ForbiddenException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
import {
  DespegarApiError,
  type AvailabilityQuery,
  type HotelOffer as DespegarHotelOffer,
} from '@sales-travel/despegar-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  FakeDespegarHotelsAdapter,
  HOTELES_CON_CUPO,
  fakeDespegarFactory,
  hotelRegistry,
  ofertasDespegar,
  type FakeDespegarFactory,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb, type FakeHotelsDb, type FilaTenant } from './__fixtures__/fake-hotels-db.js';
import { humanizeDespegarError } from './despegar-hotels-errors.js';
import { AllHotelProvidersFailedError } from './hotel-provider-errors.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';

/**
 * Red de seguridad de `HotelsService` (PR-0.1 del plan de hoteles multi-proveedor, RNF-14
 * punto 3), con Despegar como único proveedor.
 *
 * PR-0.5 pasó la búsqueda por el registry de proveedores. Los casos siguen siendo los de PR-0.1;
 * donde el comportamiento cambió a propósito, el caso lo dice ("PR-0.5:") y el diff lo muestra.
 * Lo que es de varios proveedores vive en `hotels.service.multi-provider.test.ts`, y las rutas de
 * reserva de Despegar en `despegar-hotel-reservations.service.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';
const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const CIUDAD = 2345;
const CODIGO = 'despegar-hotels';

/** Lo que devuelve el catálogo de la ciudad. `412` está en el catálogo pero no tiene cupo. */
const CATALOGO = ['101', '205', '350', '412'];

const REGLA_CONSOLIDADOR: ApplicableRule = {
  tenantId: CONSOLIDADOR,
  tenantName: 'Consolidador',
  level: 0,
  ruleType: 'percentage',
  valueMinor: 1000,
};

/** Las reglas que ve la agencia: el 10 % de su consolidador y 25,00 fijos propios. */
const REGLAS: ApplicableRule[] = [
  REGLA_CONSOLIDADOR,
  { tenantId: TENANT, tenantName: 'Agencia', level: 1, ruleType: 'fixed', valueMinor: 2500 },
];

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
  adapter: FakeDespegarHotelsAdapter;
  resolveForTenant: FakeDespegarFactory['resolveForTenant'];
  db: FakeHotelsDb;
  breaker: CircuitBreakerService;
  assertWithinQuota: Mock<(tenantId: string) => Promise<void>>;
  instrument: Mock;
  getApplicableRules: Mock<(tenantId: string, vertical: string) => Promise<ApplicableRule[]>>;
  /** Lo que `countOf` de la telemetría contó en cada búsqueda que terminó bien. */
  conteos: number[];
}

function banco(
  opts: {
    catalogo?: readonly string[];
    tenant?: FilaTenant | null;
    reglas?: ApplicableRule[];
    cuota?: () => Promise<void>;
  } = {},
): Banco {
  const adapter = new FakeDespegarHotelsAdapter();
  const { factory, resolveForTenant } = fakeDespegarFactory(adapter);
  const db = fakeHotelsDb({ catalogo: opts.catalogo ?? CATALOGO, tenant: opts.tenant });
  const breaker = new CircuitBreakerService();
  const conteos: number[] = [];

  const assertWithinQuota = vi.fn((_tenantId: string) =>
    opts.cuota ? opts.cuota() : Promise.resolve(),
  );
  const instrument = vi.fn(
    (_meta: unknown, run: () => Promise<unknown>, countOf: (r: unknown) => number) =>
      run().then((r) => {
        conteos.push(countOf(r));
        return r;
      }),
  );
  const getApplicableRules = vi.fn((_tenantId: string, _vertical: string) =>
    Promise.resolve(opts.reglas ?? []),
  );

  const service = new HotelsService(
    hotelRegistry([factory]),
    db.service,
    { getApplicableRules } as unknown as PricingService,
    { assertWithinQuota, instrument } as unknown as SearchTelemetryService,
    breaker,
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );

  return {
    service,
    adapter,
    resolveForTenant,
    db,
    breaker,
    assertWithinQuota,
    instrument,
    getApplicableRules,
    conteos,
  };
}

/** La búsqueda tal como la recibió Despegar. */
function consultaEnviada(b: Banco): AvailabilityQuery {
  const q = b.adapter.searchAvailability.mock.calls[0]?.[0];
  if (!q) throw new Error('Despegar no recibió ninguna búsqueda');
  return q;
}

function roompack(ofertas: HotelOffer[], hotelId: string, roompackId: string) {
  const pack = ofertas
    .find((o) => o.hotelId === hotelId)
    ?.roompacks.find((rp) => rp.id === roompackId);
  if (!pack) throw new Error(`no está el roompack ${hotelId}/${roompackId}`);
  return pack;
}

/** Las ofertas sin lo que PR-0.5 añadió a cada tarifa: con eso quitado, tienen que ser las de hoy. */
function sinProveedor(ofertas: readonly HotelOffer[]): unknown[] {
  return ofertas.map((o) => ({
    ...o,
    roompacks: o.roompacks.map(({ provider: _provider, ...resto }) => resto),
  }));
}

/** El 502 de "todos los proveedores fallaron", con el motivo de cada uno. */
async function fallaCon(p: Promise<unknown>): Promise<AllHotelProvidersFailedError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AllHotelProvidersFailedError);
  return err as AllHotelProvidersFailedError;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('HotelsService.searchAvailability — catálogo ciudad → IDs', () => {
  it('con destino y sin IDs, pregunta a Despegar por los IDs del catálogo, en el orden en que llegan', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.db.consultasA('hotel_inventory')).toHaveLength(1);
    expect(consultaEnviada(b).hotelIds).toEqual(CATALOGO);
  });

  it('con IDs explícitos no consulta el catálogo aunque también llegue un destino', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada({ hotelIds: ['205', '101'] }));

    expect(b.db.consultasA('hotel_inventory')).toHaveLength(0);
    expect(consultaEnviada(b).hotelIds).toEqual(['205', '101']);
  });

  it('una lista de IDs vacía cuenta como ausente: resuelve por destino', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada({ hotelIds: [] }));

    expect(consultaEnviada(b).hotelIds).toEqual(CATALOGO);
  });

  it('catálogo vacío → 503 con un mensaje que no dice "no hay hoteles"', async () => {
    const b = banco({ catalogo: [] });
    const err = await b.service.searchAvailability(TENANT, entrada()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const http = err as ServiceUnavailableException;
    expect(http.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(http.message).toBe(
      'El catálogo de hoteles de ese destino todavía no está sincronizado. Probá con otra ciudad o avisá al administrador.',
    );
  });

  it('catálogo vacío: no gasta cuota, no resuelve credenciales y no llega a Despegar', async () => {
    const b = banco({ catalogo: [] });
    await expect(b.service.searchAvailability(TENANT, entrada())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(b.assertWithinQuota).not.toHaveBeenCalled();
    expect(b.resolveForTenant).not.toHaveBeenCalled();
    expect(b.instrument).not.toHaveBeenCalled();
    expect(b.adapter.searchAvailability).not.toHaveBeenCalled();
  });

  it('sin IDs ni destino (el esquema lo impide) también es 503 y no toca la base', async () => {
    const b = banco();
    await expect(
      b.service.searchAvailability(TENANT, entrada({ destinationId: undefined })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(b.db.consultas).toHaveLength(0);
  });
});

describe('HotelsService.resolveCityHotelIds', () => {
  it('PR-0.5: filtra por proveedor, ciudad y hoteles ACTIVOS, ordena por hotel_id y corta en el límite', async () => {
    // `active` es la baja lógica de 0041. Las filas de Despegar nacen activas y su baja sigue
    // siendo el borrado, así que para Despegar el resultado es el mismo que antes del filtro.
    const b = banco();
    await b.service.resolveCityHotelIds(CODIGO, CIUDAD, 50);

    const [q] = b.db.consultasA('hotel_inventory');
    expect(q?.sql).toBe(
      'select "hotel_id" from "hotel_inventory" where "provider_code" = $1 and "city_id" = $2 and "active" = $3 order by "hotel_id" limit $4',
    );
    expect(q?.parameters).toEqual([CODIGO, CIUDAD, true, 50]);
  });

  it('el límite se puede pedir más chico', async () => {
    const b = banco();
    await b.service.resolveCityHotelIds(CODIGO, CIUDAD, 10);

    expect(b.db.consultasA('hotel_inventory')[0]?.parameters).toEqual([CODIGO, CIUDAD, true, 10]);
  });

  it('PR-0.5: la búsqueda usa el límite que declara Despegar, 50', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.db.consultasA('hotel_inventory')[0]?.parameters).toEqual([CODIGO, CIUDAD, true, 50]);
  });

  it('no reordena en JS: devuelve los IDs tal como los ordenó Postgres', async () => {
    // `hotel_id` es TEXT (db/migrations/0022_hotel_inventory.sql:8): el orden es de texto y
    // '10' va antes que '9'. El servicio confía en el SQL y no lo rehace.
    const b = banco({ catalogo: ['10', '9', '100'] });

    expect(await b.service.resolveCityHotelIds(CODIGO, CIUDAD, 50)).toEqual(['10', '9', '100']);
  });
});

describe('HotelsService.searchAvailability — cuota', () => {
  it('se comprueba con el tenant, antes de resolver credenciales y antes de llamar a Despegar', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.assertWithinQuota).toHaveBeenCalledWith(TENANT);
    const [cuota] = b.assertWithinQuota.mock.invocationCallOrder;
    const [credenciales] = b.resolveForTenant.mock.invocationCallOrder;
    const [despegar] = b.adapter.searchAvailability.mock.invocationCallOrder;
    expect(cuota).toBeLessThan(credenciales ?? 0);
    expect(credenciales).toBeLessThan(despegar ?? 0);
  });

  it('cuota agotada: el 403 sale tal cual y Despegar no se consulta', async () => {
    const agotada = new ForbiddenException('Se alcanzó el límite de búsquedas por hora.');
    const b = banco({ cuota: () => Promise.reject(agotada) });

    await expect(b.service.searchAvailability(TENANT, entrada())).rejects.toBe(agotada);
    expect(b.resolveForTenant).not.toHaveBeenCalled();
    expect(b.adapter.searchAvailability).not.toHaveBeenCalled();
  });

  it('una búsqueda cuenta una vez', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.assertWithinQuota).toHaveBeenCalledTimes(1);
    expect(b.instrument).toHaveBeenCalledTimes(1);
  });
});

describe('HotelsService.searchAvailability — telemetría', () => {
  it('registra la vertical, el código del proveedor y un criterio reducido, sin ocupación ni edades', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada({ guestNationality: 'AR' }));

    // Tampoco la nacionalidad del huésped: es un dato personal (RNF-07).
    expect(b.instrument.mock.calls[0]?.[0]).toEqual({
      tenantId: TENANT,
      vertical: 'hotels',
      providerCodes: [CODIGO],
      criteria: {
        checkinDate: '2026-11-10',
        checkoutDate: '2026-11-13',
        destinationId: CIUDAD,
        hotelCount: CATALOGO.length,
      },
    });
  });

  it('cuenta hoteles devueltos, no IDs pedidos', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    // Se piden 4; `412` no tiene cupo y Despegar no lo devuelve.
    expect(b.conteos).toEqual([3]);
  });

  it('PR-0.5: la fila del proveedor sale del desglose, con su resultado y su conteo', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    const [, , , simulatedOf, breakdownOf] = b.instrument.mock.calls[0] as unknown[];
    const resultado = (await b.instrument.mock.results[0]?.value) as unknown;
    expect(simulatedOf).toBeUndefined();
    const filas = (breakdownOf as (r: unknown) => { durationMs: number }[])(resultado);
    expect(filas.map(({ durationMs: _d, ...resto }) => resto)).toEqual([
      { providerCode: CODIGO, resultCount: 3, outcome: 'ok' },
    ]);
    expect(filas[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('PR-0.5: un error de Despegar pasa por la telemetría y sale como 502 con el texto del filtro', async () => {
    // Antes salía el `DespegarApiError` crudo y el filtro lo traducía a 502. Ahora el fan-out lo
    // humaniza con el MISMO traductor y el servicio lanza el 502 de "todos fallaron".
    const b = banco();
    const caido = new DespegarApiError(500, '{"message":"boom"}', '/hotels-api/availability');
    b.adapter.searchAvailability.mockRejectedValueOnce(caido);

    const err = await fallaCon(b.service.searchAvailability(TENANT, entrada()));
    expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(err.failures).toEqual([
      { code: CODIGO, reason: humanizeDespegarError(500, '{"message":"boom"}') },
    ]);
    expect(err.message).not.toContain('boom');
    expect(b.instrument).toHaveBeenCalledTimes(1);
  });
});

describe('HotelsService.searchAvailability — breaker', () => {
  it('la búsqueda va por el circuito del código `despegar-hotels`', async () => {
    const b = banco();
    const execute = vi.spyOn(b.breaker, 'execute');
    await b.service.searchAvailability(TENANT, entrada());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe(CODIGO);
  });

  it('PR-0.5: kill-switch (PROVIDERS_DISABLED) → 502 con el motivo, sin llamar a Despegar', async () => {
    // Antes era el 503 del breaker tal cual; ahora es un fallo del único proveedor llamado.
    // La cuota se sigue comprobando antes, y no se gasta: la fila queda como `error`.
    vi.stubEnv('PROVIDERS_DISABLED', 'agent-cars, despegar-hotels');
    const b = banco();

    const err = await fallaCon(b.service.searchAvailability(TENANT, entrada()));
    expect(err.failures[0]?.reason).toContain('temporalmente deshabilitado');
    expect(b.adapter.searchAvailability).not.toHaveBeenCalled();
    expect(b.assertWithinQuota).toHaveBeenCalledTimes(1);
    expect(b.instrument).toHaveBeenCalledTimes(1);
    expect(b.conteos).toEqual([]);
  });

  it('cinco fallos seguidos abren el circuito: la sexta búsqueda no llega a Despegar', async () => {
    const b = banco();
    b.adapter.searchAvailability.mockRejectedValue(
      new DespegarApiError(0, 'timeout', '/hotels-api/availability'),
    );

    for (let i = 0; i < 5; i += 1) {
      await fallaCon(b.service.searchAvailability(TENANT, entrada()));
    }
    const sexta = await fallaCon(b.service.searchAvailability(TENANT, entrada()));
    expect(sexta.failures[0]?.reason).toContain('no está respondiendo');
    expect(b.adapter.searchAvailability).toHaveBeenCalledTimes(5);
  });

  it('el circuito es uno por código de proveedor: los fallos de un tenant cortan a los demás', async () => {
    // El circuito por cuenta de PR-0.6 sólo aplica a errores que declaran `OPEN_ACCOUNT` en
    // `failure.circuit`. `DespegarApiError` no declara nada y cuenta como antes: una cuenta rota
    // de un tenant sigue abriendo el circuito de toda la red.
    const b = banco();
    b.adapter.searchAvailability.mockRejectedValue(
      new DespegarApiError(401, 'unauthorized', '/hotels-api/availability'),
    );
    for (let i = 0; i < 5; i += 1) {
      await b.service.searchAvailability(TENANT, entrada()).catch(() => undefined);
    }

    const err = await fallaCon(b.service.searchAvailability(OTRO_TENANT, entrada()));
    expect(err.failures[0]?.reason).toContain('no está respondiendo');
  });

  it('PR-0.5: sugerencias y detalle TAMBIÉN pasan por el circuito: el kill-switch los frena', async () => {
    // Antes sólo la búsqueda estaba protegida. Las rutas de reserva de Despegar tienen su propio
    // caso en `despegar-hotel-reservations.service.test.ts`.
    vi.stubEnv('PROVIDERS_DISABLED', CODIGO);
    const b = banco();

    await expect(b.service.suggest(TENANT, 'bogo')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      b.service.getHotelDetail(TENANT, { ...entrada(), hotelId: '101' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(b.adapter.suggest).not.toHaveBeenCalled();
    expect(b.adapter.getHotelDetail).not.toHaveBeenCalled();
  });

  it('PR-0.6: búsqueda, sugerencias y detalle son venta: `despegar-hotels:ventas` los frena', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', `${CODIGO}:ventas`);
    const b = banco();

    const err = await fallaCon(b.service.searchAvailability(TENANT, entrada()));
    expect(err.failures[0]?.reason).toContain('temporalmente deshabilitado');
    await expect(b.service.suggest(TENANT, 'bogo')).rejects.toMatchObject({
      reason: 'kill-switch',
    });
    await expect(
      b.service.getHotelDetail(TENANT, { ...entrada(), hotelId: '101' }),
    ).rejects.toMatchObject({ reason: 'kill-switch' });

    expect(b.adapter.searchAvailability).not.toHaveBeenCalled();
    expect(b.adapter.suggest).not.toHaveBeenCalled();
    expect(b.adapter.getHotelDetail).not.toHaveBeenCalled();
  });
});

describe('HotelsService.searchAvailability — criterio que recibe Despegar', () => {
  it('sin moneda ni país en la entrada, usa los del tenant', async () => {
    const b = banco({ tenant: { default_currency: 'COP', country_code: 'CO' } });
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.adapter.searchAvailability).toHaveBeenCalledWith({
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      currency: 'COP',
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

  it('la moneda y el país de la entrada ganan a los del tenant', async () => {
    const b = banco({ tenant: { default_currency: 'COP', country_code: 'CO' } });
    await b.service.searchAvailability(TENANT, entrada({ currency: 'USD', countryCode: 'PE' }));

    const q = consultaEnviada(b);
    expect(q.currency).toBe('USD');
    expect(q.countryCode).toBe('PE');
  });

  it('PR-0.5: idioma y "sólo reembolsables" viajan tal cual; el TTL ya no es parte del borde', async () => {
    // El TTL era un parámetro de Despegar que la web nunca mandó y que el contrato neutral no
    // tiene: el esquema lo descarta como cualquier clave desconocida.
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada({ language: 'PT', refundableOnly: true }));

    const q = consultaEnviada(b);
    expect(q.language).toBe('PT');
    expect(q.refundableOnly).toBe(true);
    expect(q.ttl).toBeUndefined();
  });

  it('PR-0.5: la moneda del tenant se recorta Y se pasa a mayúsculas', async () => {
    // Antes salía `cop`, como estaba guardada. La puerta de moneda compara contra la de cada
    // tarifa, que llega en mayúsculas: sin normalizar las descartaría todas.
    const b = banco({ tenant: { default_currency: ' cop ', country_code: 'CO' } });
    await b.service.searchAvailability(TENANT, entrada());

    expect(consultaEnviada(b).currency).toBe('COP');
  });

  it('PR-0.5: una moneda del tenant que no es ISO 4217 cae a USD y deja aviso con el tenant', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco({ tenant: { default_currency: 'C0P', country_code: 'CO' } });
    await b.service.searchAvailability(TENANT, entrada());

    expect(consultaEnviada(b).currency).toBe('USD');
    expect(warn).toHaveBeenCalledWith(`hotels.tenant_currency_invalida tenant=${TENANT}`);
  });

  it('tenant sin fila: USD y sin país', async () => {
    const b = banco({ tenant: null });
    await b.service.searchAvailability(TENANT, entrada());

    const q = consultaEnviada(b);
    expect(q.currency).toBe('USD');
    expect(q.countryCode).toBeUndefined();
  });

  it('el tenant sin país no manda país aunque tenga moneda', async () => {
    const b = banco({ tenant: { default_currency: 'USD', country_code: null } });
    await b.service.searchAvailability(TENANT, entrada());

    expect(consultaEnviada(b).countryCode).toBeUndefined();
  });

  it('resuelve el adapter con el tenant de la búsqueda', async () => {
    const b = banco();
    await b.service.searchAvailability(OTRO_TENANT, entrada());

    expect(b.resolveForTenant).toHaveBeenCalledWith(OTRO_TENANT);
  });
});

describe('HotelsService.searchAvailability — contenido', () => {
  it('PR-0.5: la respuesta es `{ hotels, providers }` y Despegar sale `ok` con sus hoteles', async () => {
    const b = banco();
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.providers).toEqual([{ code: CODIGO, status: 'ok', count: 3 }]);
  });

  it('PR-0.5: cada tarifa dice de qué proveedor es, con el id del roompack como referencia', async () => {
    const b = banco();
    const res = await b.service.searchAvailability(TENANT, entrada());

    const packs = res.hotels.flatMap((o) => o.roompacks);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      expect(pack.provider).toEqual({ name: CODIGO, offerRef: pack.id });
    }
  });

  it('PR-0.5: la nacionalidad del huésped no llega a Despegar, que no la usa', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada({ guestNationality: 'AR' }));

    expect(consultaEnviada(b)).not.toHaveProperty('guestNationality');
  });
});

describe('HotelsService.searchAvailability — pricing waterfall', () => {
  it('pide las reglas del tenant para la vertical `hotels`', async () => {
    const b = banco();
    await b.service.searchAvailability(TENANT, entrada());

    expect(b.getApplicableRules).toHaveBeenCalledWith(TENANT, 'hotels');
  });

  it('sin reglas, las ofertas salen como las mapeó el ACL: sin `pricing`', async () => {
    const b = banco();
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(sinProveedor(res.hotels)).toEqual(ofertasDespegar(CATALOGO));
    expect(res.hotels.flatMap((o) => o.roompacks).some((rp) => 'pricing' in rp)).toBe(false);
  });

  it('con reglas, cada roompack lleva su precio de venta y el neto no se toca', async () => {
    const b = banco({ reglas: REGLAS });
    const res = await b.service.searchAvailability(TENANT, entrada());

    // 41 237 neto → +10 % del consolidador (4 124) → +25,00 fijos de la agencia.
    const pack = roompack(res.hotels, '101', 'RP-101-A');
    expect(pack.price.total).toEqual({ amountMinor: 41_237, currency: 'USD' });
    expect(pack.pricing).toEqual({
      costMinor: 45_361,
      finalMinor: 47_861,
      ownMarkupMinor: 2_500,
      currency: 'USD',
    });
  });

  it('la vista del tenant no expone el neto ni el desglose de sus ancestros', async () => {
    const b = banco({ reglas: REGLAS });
    const res = await b.service.searchAvailability(TENANT, entrada());

    for (const pack of res.hotels.flatMap((o) => o.roompacks)) {
      expect(Object.keys(pack.pricing ?? {}).sort()).toEqual([
        'costMinor',
        'currency',
        'finalMinor',
        'ownMarkupMinor',
      ]);
    }
  });

  it('el margen propio es el del tenant que busca: el consolidador ve el suyo', async () => {
    const b = banco({ reglas: [REGLA_CONSOLIDADOR] });
    const res = await b.service.searchAvailability(CONSOLIDADOR, entrada());

    expect(roompack(res.hotels, '101', 'RP-101-A').pricing).toEqual({
      costMinor: 41_237,
      finalMinor: 45_361,
      ownMarkupMinor: 4_124,
      currency: 'USD',
    });
  });

  it('un hotel sin roompacks se devuelve igual, vacío: el servicio no filtra', async () => {
    const b = banco({ reglas: REGLAS });
    const res = await b.service.searchAvailability(TENANT, entrada());

    expect(res.hotels.map((o) => o.hotelId)).toEqual([...HOTELES_CON_CUPO]);
    expect(res.hotels.find((o) => o.hotelId === '350')?.roompacks).toEqual([]);
  });
});

describe('HotelsService.getHotelDetail', () => {
  const detalle = { ...entrada(), hotelId: '101', roompackId: 'RP-101-A' };

  it('pasa el criterio con los defaults del tenant y el roompack pedido', async () => {
    const b = banco({ tenant: { default_currency: 'COP', country_code: 'CO' } });
    // El ACL falso responde en USD: con la búsqueda en COP, la puerta del detalle lo rechaza
    // (ver `HotelsService — moneda de la búsqueda`). Acá sólo importa lo que se le pidió.
    await b.service.getHotelDetail(TENANT, detalle).catch(() => undefined);

    expect(b.adapter.getHotelDetail).toHaveBeenCalledWith({
      hotelId: '101',
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      currency: 'COP',
      rooms: detalle.rooms,
      roompackId: 'RP-101-A',
      countryCode: 'CO',
      language: undefined,
      refundableOnly: undefined,
    });
  });

  it('PR-0.5: sin reglas devuelve la oferta del adapter, con cada tarifa atribuida a Despegar', async () => {
    // Antes era el mismo objeto del ACL. Ahora pasa por el envoltorio neutral, que sólo suma
    // `provider` a cada tarifa: con el token de reserva, porque el detalle es desde donde se reserva.
    const b = banco();
    const res = await b.service.getHotelDetail(TENANT, detalle);

    const delAcl = (await b.adapter.getHotelDetail.mock.results[0]?.value) as DespegarHotelOffer;
    expect(sinProveedor([res])).toEqual([delAcl]);
    expect(res.roompacks.map((rp) => rp.provider.name)).toEqual(delAcl.roompacks.map(() => CODIGO));
  });

  it('aplica el waterfall: es la pantalla desde la que se reserva', async () => {
    const b = banco({ reglas: REGLAS });
    const res = await b.service.getHotelDetail(TENANT, detalle);

    expect(b.getApplicableRules).toHaveBeenCalledWith(TENANT, 'hotels');
    expect(roompack([res], '101', 'RP-101-A').pricing?.finalMinor).toBe(47_861);
  });

  it('no gasta cuota ni deja telemetría', async () => {
    const b = banco();
    await b.service.getHotelDetail(TENANT, detalle);

    expect(b.assertWithinQuota).not.toHaveBeenCalled();
    expect(b.instrument).not.toHaveBeenCalled();
  });

  it('PR-0.5: nombrar a Despegar como proveedor da lo mismo que no nombrar a nadie', async () => {
    const b = banco();
    const sinNombre = await b.service.getHotelDetail(TENANT, detalle);
    const conNombre = await b.service.getHotelDetail(TENANT, { ...detalle, provider: CODIGO });

    expect(conNombre).toEqual(sinNombre);
  });
});

describe('HotelsService.suggest', () => {
  it('pasa el texto y el locale y devuelve las sugerencias del adapter', async () => {
    const b = banco();
    const res = await b.service.suggest(TENANT, 'bogo', 'es_CO');

    expect(b.adapter.suggest).toHaveBeenCalledWith('bogo', 'es_CO');
    expect(res).toBe(await b.adapter.suggest.mock.results[0]?.value);
    expect(b.assertWithinQuota).not.toHaveBeenCalled();
  });
});
