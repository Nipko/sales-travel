import { ForbiddenException, HttpStatus, Logger } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  AllFlightProvidersFailedError,
  ProviderNotAvailableError,
} from '../providers/provider.types.js';
import {
  StubProviderFactory,
  type StubFactoryOptions,
} from '../providers/__fixtures__/stub-provider.factory.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import type { SearchTelemetryService } from './search-telemetry.service.js';
import { SearchService } from './search.service.js';

/**
 * Red de seguridad de `SearchService`.
 *
 * La escribió PR-1 contra el código de un solo proveedor; PR-2 la actualizó al registry
 * multi-proveedor. Lo que se fija acá sigue siendo el comportamiento REAL, no el deseado:
 * donde el comportamiento es discutible, el test lo fija igual y lo dice en el comentario.
 *
 * El segundo proveedor es un stub ANÓNIMO in-repo: nada de esto depende de qué proveedor
 * real entre segundo, ni de que entre alguno.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = 'latam-ndc';

function criteria(overrides: Partial<FlightSearchCriteria> = {}): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-11-10',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
    ...overrides,
  };
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: PRINCIPAL, offerRef: 'OFFER-1' },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
    ...overrides,
  };
}

/** Oferta atribuida a otro proveedor, para probar el enrutado por `provider.name`. */
function offerDe(code: string, overrides: Partial<Offer> = {}): Offer {
  return offer({ provider: { name: code, offerRef: `${code}-1` }, ...overrides });
}

interface Banco {
  service: SearchService;
  registry: FlightProviderRegistry;
  factories: Map<string, StubProviderFactory>;
  assertWithinQuota: ReturnType<typeof vi.fn>;
  instrument: ReturnType<typeof vi.fn>;
  getApplicableRules: ReturnType<typeof vi.fn>;
  cache: MemoryCacheAdapter;
  /** Traza de llamadas, para afirmar ORDEN y no sólo cantidad. */
  orden: string[];
  /** Búsquedas que llegaron al proveedor. */
  llamadas: (code?: string) => number;
  adapter: (code?: string, tenantId?: string) => ReturnType<StubProviderFactory['adapterFor']>;
}

function banco(
  opts: {
    /** Por defecto, un solo proveedor con el code del que se vende hoy. */
    providers?: StubFactoryOptions[];
    rules?: ApplicableRule[];
    quotaImpl?: () => Promise<void>;
    /** Gobierno de `callPolicy: 'opt-in'` por tenant. */
    flags?: (tenantId: string, code: string) => boolean;
  } = {},
): Banco {
  const orden: string[] = [];
  const llamadas = new Map<string, number>();
  const factories = new Map<string, StubProviderFactory>();

  for (const spec of opts.providers ?? [{ code: PRINCIPAL }]) {
    const code = spec.code ?? PRINCIPAL;
    const impl = spec.searchImpl;
    const factory = new StubProviderFactory({
      ...spec,
      code,
      searchImpl: (c: FlightSearchCriteria, ctx: SearchContext) => {
        llamadas.set(code, (llamadas.get(code) ?? 0) + 1);
        orden.push('search');
        return impl ? impl(c, ctx) : Promise.resolve(spec.offers ?? [offerDe(code)]);
      },
    });

    // El registry resuelve credenciales por tenant; se traza para poder afirmar que la cuota
    // se comprueba ANTES de tocar la bóveda y el proveedor.
    const original = factory.resolveForTenant.bind(factory);
    vi.spyOn(factory, 'resolveForTenant').mockImplementation((tenantId: string) => {
      orden.push('forTenant');
      return original(tenantId);
    });

    factories.set(code, factory);
  }

  const registry = new FlightProviderRegistry([...factories.values()], {
    isEnabledForTenant: (tenantId, code) => Promise.resolve(opts.flags?.(tenantId, code) ?? false),
  });

  const assertWithinQuota = vi.fn(() => {
    orden.push('quota');
    return opts.quotaImpl ? opts.quotaImpl() : Promise.resolve();
  });

  const getApplicableRules = vi.fn(() => Promise.resolve(opts.rules ?? []));

  const instrument = vi.fn((_meta: unknown, run: () => Promise<unknown>) => run());

  const telemetry = { assertWithinQuota, instrument } as unknown as SearchTelemetryService;

  const cache = new MemoryCacheAdapter();

  const service = new SearchService(
    registry,
    { getApplicableRules } as unknown as PricingService,
    telemetry,
    new CircuitBreakerService(),
    cache,
  );

  return {
    service,
    registry,
    factories,
    assertWithinQuota,
    instrument,
    getApplicableRules,
    cache,
    orden,
    llamadas: (code = PRINCIPAL) => llamadas.get(code) ?? 0,
    adapter: (code = PRINCIPAL, tenantId = TENANT) => factories.get(code)!.adapterFor(tenantId),
  };
}

describe('SearchService.searchFlights', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('caché', () => {
    it('miss: consulta al proveedor y devuelve sus ofertas', async () => {
      const b = banco();
      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(b.llamadas()).toBe(1);
      expect(res.offers).toHaveLength(1);
      expect(res.simulated).toBe(false);
    });

    it('hit: el mismo criterio y tenant no vuelve a golpear al proveedor', async () => {
      const b = banco();
      const primera = await b.service.searchFlights(criteria(), TENANT);
      const segunda = await b.service.searchFlights(criteria(), TENANT);

      expect(b.llamadas()).toBe(1);
      expect(segunda).toEqual(primera);
    });

    it('la cuota SÍ se comprueba en el hit de caché (no es un atajo gratis)', async () => {
      const b = banco();
      await b.service.searchFlights(criteria(), TENANT);
      await b.service.searchFlights(criteria(), TENANT);

      expect(b.assertWithinQuota).toHaveBeenCalledTimes(2);
    });

    it('criterios distintos son claves distintas', async () => {
      const b = banco();
      await b.service.searchFlights(criteria(), TENANT);
      await b.service.searchFlights(criteria({ destination: 'GRU' }), TENANT);

      expect(b.llamadas()).toBe(2);
    });

    it('la clave lleva el tenant: otro tenant no ve el resultado cacheado', async () => {
      const b = banco();
      await b.service.searchFlights(criteria(), TENANT);
      await b.service.searchFlights(criteria(), OTRO_TENANT);

      expect(b.llamadas()).toBe(2);
    });

    it('la clave lleva el SET de proveedores: activar uno invalida lo cacheado', async () => {
      // Sin los codes en la clave, el resultado "sin el proveedor B" se seguiría sirviendo
      // 90 s después de habilitar B, y nadie vería sus tarifas.
      let activo = false;
      const b = banco({
        providers: [{ code: PRINCIPAL }, { code: 'alfa-air', callPolicy: 'opt-in' }],
        flags: () => activo,
      });

      await b.service.searchFlights(criteria(), TENANT);
      expect(b.llamadas('alfa-air')).toBe(0);

      activo = true;
      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(b.llamadas('alfa-air')).toBe(1);
      expect(res.offers).toHaveLength(2);
    });

    it('el TTL de caché de búsqueda es de 90 s', async () => {
      vi.useFakeTimers();
      const b = banco();

      await b.service.searchFlights(criteria(), TENANT);
      vi.advanceTimersByTime(89_999);
      await b.service.searchFlights(criteria(), TENANT);
      expect(b.llamadas()).toBe(1);

      vi.advanceTimersByTime(1);
      await b.service.searchFlights(criteria(), TENANT);
      expect(b.llamadas()).toBe(2);
    });

    it('un resultado SIMULADO no se cachea nunca', async () => {
      const b = banco({ providers: [{ code: PRINCIPAL, isMock: true }] });

      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(res.simulated).toBe(true);

      await b.service.searchFlights(criteria(), TENANT);
      expect(b.llamadas()).toBe(2);
    });

    it('un resultado DEGRADADO tampoco se cachea', async () => {
      // Cachear una degradación congela 90 s la ausencia de un proveedor que quizá ya volvió.
      const b = banco({
        providers: [
          { code: PRINCIPAL },
          { code: 'alfa-air', searchImpl: () => Promise.reject(new Error('HTTP 503')) },
        ],
      });

      await b.service.searchFlights(criteria(), TENANT);
      await b.service.searchFlights(criteria(), TENANT);

      expect(b.llamadas(PRINCIPAL)).toBe(2);
    });
  });

  describe('cuota', () => {
    it('una búsqueda a N proveedores se instrumenta UNA vez, declarando los N códigos', async () => {
      // Una sola llamada = un solo `search_group_id` = una búsqueda en la cuota. Los códigos
      // van SUELTOS y no concatenados: la telemetría escribe una fila por cada uno.
      const b = banco({ providers: [{ code: PRINCIPAL }, { code: 'alfa-air' }] });
      await b.service.searchFlights(criteria(), TENANT);

      expect(b.instrument).toHaveBeenCalledTimes(1);
      expect(b.instrument.mock.calls[0]?.[0]).toMatchObject({
        vertical: 'flights',
        providerCodes: ['alfa-air', PRINCIPAL], // orden estable del registry
      });
    });

    it('el desglose por proveedor sale del parte de daños, con su latencia y sin los salteados', async () => {
      // Es lo que hace real la telemetría por proveedor: sin esto, la fila de cada uno
      // llevaría la duración y el conteo de la búsqueda entera.
      const b = banco({
        providers: [
          { code: PRINCIPAL },
          { code: 'alfa-air', searchImpl: () => Promise.reject(new Error('HTTP 503')) },
          { code: 'beta-air', callPolicy: 'opt-in' }, // no activado por el tenant => skipped
        ],
      });
      const res = await b.service.searchFlights(criteria(), TENANT);

      const breakdownOf = b.instrument.mock.calls[0]?.[4] as (r: unknown) => unknown[];
      const slices = breakdownOf(res) as {
        providerCode: string;
        durationMs: number;
        outcome: string;
        errorCode?: string;
      }[];

      expect(slices.map((s) => s.providerCode).sort()).toEqual(['alfa-air', PRINCIPAL]);
      expect(slices.find((s) => s.providerCode === PRINCIPAL)).toMatchObject({ outcome: 'ok' });
      expect(slices.find((s) => s.providerCode === 'alfa-air')).toMatchObject({
        outcome: 'error',
        errorCode: 'ProviderCallError',
      });
      // Medido por proveedor, también en el camino de error.
      for (const s of slices) expect(s.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('se comprueba ANTES de resolver el adapter y de llamar al proveedor', async () => {
      const b = banco();
      await b.service.searchFlights(criteria(), TENANT);

      expect(b.orden).toEqual(['quota', 'forTenant', 'search']);
    });

    it('si la cuota se excedió no se toca al proveedor y se propaga el 403', async () => {
      const b = banco({
        quotaImpl: () => Promise.reject(new ForbiddenException('límite alcanzado')),
      });

      await expect(b.service.searchFlights(criteria(), TENANT)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(b.orden).toEqual(['quota']);
      expect(b.llamadas()).toBe(0);
    });
  });

  describe('apagón del proveedor', () => {
    it('con todos los proveedores caídos propaga un 502 tipado, no una lista vacía', async () => {
      const b = banco({
        providers: [{ code: PRINCIPAL, searchImpl: () => Promise.reject(new Error('HTTP 503')) }],
      });

      let err: unknown;
      try {
        await b.service.searchFlights(criteria(), TENANT);
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(AllFlightProvidersFailedError);
      const fallo = err as AllFlightProvidersFailedError;
      expect(fallo.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(fallo.failures).toEqual([{ code: PRINCIPAL, reason: `[${PRINCIPAL}] HTTP 503` }]);
    });

    it('un fallo no se cachea: la siguiente búsqueda vuelve a intentar', async () => {
      let falla = true;
      const b = banco({
        providers: [
          {
            code: PRINCIPAL,
            searchImpl: () => (falla ? Promise.reject(new Error('HTTP 503')) : Promise.resolve([])),
          },
        ],
      });

      await expect(b.service.searchFlights(criteria(), TENANT)).rejects.toThrow('HTTP 503');
      falla = false;
      await expect(b.service.searchFlights(criteria(), TENANT)).resolves.toEqual({
        offers: [],
        simulated: false,
        providers: [{ code: PRINCIPAL, status: 'empty', count: 0, simulated: false }],
      });
      expect(b.llamadas()).toBe(2);
    });

    it('cero ofertas SIN fallo no es apagón: devuelve lista vacía', async () => {
      const b = banco({ providers: [{ code: PRINCIPAL, offers: [] }] });

      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(res.offers).toEqual([]);
      expect(res.providers).toEqual([
        { code: PRINCIPAL, status: 'empty', count: 0, simulated: false },
      ]);
    });

    it('sin ningún proveedor habilitado no hay apagón ni error: la lista viene vacía', async () => {
      const b = banco({ providers: [{ code: PRINCIPAL, failResolve: true }] });

      await expect(b.service.searchFlights(criteria(), TENANT)).resolves.toEqual({
        offers: [],
        simulated: false,
        providers: [],
      });
    });

    it('tras 5 fallos el circuito abre y la 6ª búsqueda no llega al proveedor', async () => {
      const b = banco({
        providers: [{ code: PRINCIPAL, searchImpl: () => Promise.reject(new Error('HTTP 503')) }],
      });

      for (let i = 0; i < 5; i++) {
        await expect(b.service.searchFlights(criteria(), TENANT)).rejects.toThrow('HTTP 503');
      }
      expect(b.llamadas()).toBe(5);

      await expect(b.service.searchFlights(criteria(), TENANT)).rejects.toThrow(
        /latam-ndc.*no está respondiendo/,
      );
      expect(b.llamadas()).toBe(5);
    });
  });

  describe('degradación parcial', () => {
    it('un proveedor caído no tumba la búsqueda y aparece en `providers` con su motivo', async () => {
      // Antes, el array `failed` del fan-out se descartaba: el vendedor veía una lista más
      // corta y ninguna señal de que faltaba media oferta.
      const b = banco({
        providers: [
          { code: 'alfa-air', searchImpl: () => Promise.reject(new Error('HTTP 503')) },
          { code: PRINCIPAL },
        ],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(res.offers).toHaveLength(1);
      expect(res.offers[0]?.provider.name).toBe(PRINCIPAL);
      expect(res.providers).toEqual([
        {
          code: 'alfa-air',
          status: 'error',
          count: 0,
          simulated: false,
          reason: '[alfa-air] HTTP 503',
        },
        { code: PRINCIPAL, status: 'ok', count: 1, simulated: false },
      ]);
    });

    it('los proveedores se consultan en PARALELO, no uno después del otro', async () => {
      // El paralelismo se prueba por dependencia mutua y no por reloj: alfa sólo puede
      // terminar después de que el principal haya arrancado. Si el fan-out fuera secuencial,
      // esto se queda colgado en vez de dar un flake.
      let arrancoPrincipal: () => void = () => undefined;
      const principalArranco = new Promise<void>((resolve) => {
        arrancoPrincipal = resolve;
      });

      const b = banco({
        providers: [
          {
            code: 'alfa-air',
            searchImpl: async () => {
              await principalArranco;
              return [offerDe('alfa-air')];
            },
          },
          {
            code: PRINCIPAL,
            searchImpl: () => {
              arrancoPrincipal();
              return Promise.resolve([offer()]);
            },
          },
        ],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(res.offers).toHaveLength(2);
    });

    it('`simulated` conserva la semántica vieja: true sólo si TODO el resultado es falso', async () => {
      const b = banco({
        providers: [{ code: 'alfa-air', isMock: true }, { code: PRINCIPAL }],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);

      // `apps/web-b2b` lee este booleano hoy. La semántica nueva —hay al menos una tarifa
      // falsa— viaja por proveedor, sin cambiarle el significado al campo viejo.
      expect(res.simulated).toBe(false);
      expect(res.providers).toEqual([
        { code: 'alfa-air', status: 'simulated', count: 1, simulated: true },
        { code: PRINCIPAL, status: 'ok', count: 1, simulated: false },
      ]);
    });

    it('con todos los proveedores en mock, `simulated` global sigue siendo true', async () => {
      const b = banco({
        providers: [
          { code: 'alfa-air', isMock: true },
          { code: PRINCIPAL, isMock: true },
        ],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(res.simulated).toBe(true);
    });
  });

  describe('callPolicy', () => {
    it("'opt-in' con el flag apagado no recibe NINGUNA llamada y sale como 'skipped'", async () => {
      const b = banco({
        providers: [{ code: PRINCIPAL }, { code: 'alfa-air', callPolicy: 'opt-in' }],
        flags: () => false,
      });

      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(b.llamadas('alfa-air')).toBe(0);
      expect(res.providers).toContainEqual({
        code: 'alfa-air',
        status: 'skipped',
        count: 0,
        simulated: false,
        skipReason: 'opt-in-disabled',
      });
    });

    it("'fallback' no se llama si la primera ola ya trajo suficientes ofertas", async () => {
      const muchas = [1, 2, 3, 4, 5].map((n) => offer({ id: `offer-${n}` }));
      const b = banco({
        providers: [
          { code: PRINCIPAL, offers: muchas },
          { code: 'alfa-air', callPolicy: 'fallback' },
        ],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(b.llamadas('alfa-air')).toBe(0);
      expect(res.providers).toContainEqual({
        code: 'alfa-air',
        status: 'skipped',
        count: 0,
        simulated: false,
        skipReason: 'fallback-not-needed',
      });
    });

    it("'fallback' SÍ se llama cuando la primera ola trae poco", async () => {
      const b = banco({
        providers: [
          { code: PRINCIPAL, offers: [offer()] },
          { code: 'alfa-air', callPolicy: 'fallback' },
        ],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(b.llamadas('alfa-air')).toBe(1);
      expect(res.offers).toHaveLength(2);
    });

    it('si la ola de fallback también falla, el error queda visible en `providers`', async () => {
      const b = banco({
        providers: [
          { code: PRINCIPAL, offers: [offer()] },
          {
            code: 'alfa-air',
            callPolicy: 'fallback',
            searchImpl: () => Promise.reject(new Error('HTTP 500')),
          },
        ],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(res.offers).toHaveLength(1);
      expect(res.providers[0]).toMatchObject({ code: 'alfa-air', status: 'error' });
    });
  });

  describe('regresión cero de contenido', () => {
    it('(a) con un solo proveedor, `offers[]` es exactamente el de antes del refactor', async () => {
      const b = banco({ rules: [regla(1_000)] });
      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(res.offers).toEqual([
        {
          id: '33333333-3333-4333-8333-333333333333',
          tenantId: TENANT,
          products: ['flight'],
          provider: { name: PRINCIPAL, offerRef: `${PRINCIPAL}-1` },
          total: { amountMinor: 100_000, currency: 'USD' },
          baseFare: { amountMinor: 80_000, currency: 'USD' },
          taxes: { amountMinor: 20_000, currency: 'USD' },
          fetchedAt: '2026-08-26T12:00:00.000Z',
          expiresAt: '2026-08-26T12:30:00.000Z',
          pricing: {
            costMinor: 100_000,
            finalMinor: 110_000,
            ownMarkupMinor: 10_000,
            currency: 'USD',
          },
        },
      ]);
    });

    it('(b) el sobre CRECE de forma aditiva: `offers` y `simulated` siguen, `providers` se suma', async () => {
      const b = banco();
      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(Object.keys(res).sort()).toEqual(['offers', 'providers', 'simulated']);
      expect(typeof res.simulated).toBe('boolean');
      expect(Array.isArray(res.offers)).toBe(true);
    });

    it('`providers[]` sale en orden estable, alfabético por code', async () => {
      const b = banco({
        providers: [{ code: 'zeta-air' }, { code: PRINCIPAL }, { code: 'alfa-air' }],
      });

      const res = await b.service.searchFlights(criteria(), TENANT);
      expect(res.providers.map((p) => p.code)).toEqual(['alfa-air', 'latam-ndc', 'zeta-air']);
    });
  });

  describe('withPricing', () => {
    it('sin reglas aplicables devuelve las ofertas intactas (sin `pricing`)', async () => {
      const b = banco();
      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(res.offers[0]?.pricing).toBeUndefined();
      expect(res.offers[0]?.total.amountMinor).toBe(100_000);
    });

    it('con reglas adjunta la vista acotada al tenant y NO muta `total`', async () => {
      const b = banco({ rules: [regla(1_000)] });
      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(res.offers[0]?.pricing).toEqual({
        costMinor: 100_000,
        finalMinor: 110_000,
        ownMarkupMinor: 10_000,
        currency: 'USD',
      });
      // `total` sigue siendo el NETO del proveedor: es lo que se reserva.
      expect(res.offers[0]?.total.amountMinor).toBe(100_000);
    });

    it('el markup de un ancestro va a `costMinor`, no al margen propio', async () => {
      const b = banco({
        rules: [
          {
            tenantId: 'consolidador',
            tenantName: 'cons',
            level: 1,
            ruleType: 'fixed',
            valueMinor: 5_000,
          },
          regla(1_000),
        ],
      });
      const res = await b.service.searchFlights(criteria(), TENANT);

      expect(res.offers[0]?.pricing).toEqual({
        costMinor: 105_000,
        finalMinor: 115_500,
        ownMarkupMinor: 10_500,
        currency: 'USD',
      });
    });

    it('las reglas se piden UNA vez por búsqueda, no una por oferta ni una por proveedor', async () => {
      const b = banco({
        rules: [regla(1_000)],
        providers: [
          {
            code: PRINCIPAL,
            offers: [offer(), offer({ id: '44444444-4444-4444-8444-444444444444' })],
          },
          { code: 'alfa-air' },
        ],
      });
      await b.service.searchFlights(criteria(), TENANT);

      expect(b.getApplicableRules).toHaveBeenCalledTimes(1);
      expect(b.getApplicableRules).toHaveBeenCalledWith(TENANT, 'flights');
    });
  });
});

describe('SearchService.priceOffer', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('revalida contra el proveedor y aplica el waterfall al resultado', async () => {
    const b = banco({ rules: [regla(1_000)] });

    const res = await b.service.priceOffer(offer(), criteria(), TENANT);

    expect(b.adapter().priceOffer).toHaveBeenCalledTimes(1);
    expect(res.priceChanged).toBe(false);
    expect(res.offer.pricing?.finalMinor).toBe(110_000);
    expect(res.offer.total.amountMinor).toBe(100_000);
  });

  it('enruta por `provider.name`: la oferta de un proveedor NO se revalida contra otro', async () => {
    // Bug R-07: antes iba siempre al único proveedor inyectado, así que con dos proveedores
    // se revalidaba la oferta de uno contra el otro.
    const b = banco({ providers: [{ code: PRINCIPAL }, { code: 'alfa-air' }] });

    await b.service.priceOffer(offerDe('alfa-air'), criteria(), TENANT);

    expect(b.adapter('alfa-air').priceOffer).toHaveBeenCalledTimes(1);
    expect(b.adapter(PRINCIPAL).priceOffer).not.toHaveBeenCalled();
  });

  it('una oferta de un proveedor no habilitado es 400 con mensaje, no un 500', async () => {
    const b = banco();

    await expect(
      b.service.priceOffer(offerDe('proveedor-fantasma'), criteria(), TENANT),
    ).rejects.toBeInstanceOf(ProviderNotAvailableError);
  });

  it('sin reglas devuelve la oferta del proveedor tal cual', async () => {
    const b = banco();
    const res = await b.service.priceOffer(offer(), criteria(), TENANT);

    expect(res.offer.pricing).toBeUndefined();
  });

  it('NO pasa por cuota, por caché ni por el circuito (comportamiento actual)', async () => {
    const b = banco();
    await b.service.priceOffer(offer(), criteria(), TENANT);

    // La revalidación de precio no consume cuota ni está protegida por el breaker: es una
    // asimetría real respecto de `searchFlights`, documentada acá para que el refactor la
    // vea. Ver `discrepancies` del PR-1.
    expect(b.assertWithinQuota).not.toHaveBeenCalled();
    expect(b.orden).toEqual(['forTenant']);
  });
});

function regla(valueMinor: number): ApplicableRule {
  return { tenantId: TENANT, tenantName: 'agencia', level: 1, ruleType: 'percentage', valueMinor };
}
