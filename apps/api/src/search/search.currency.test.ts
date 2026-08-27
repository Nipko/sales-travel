import { Logger } from '@nestjs/common';
import type { Offer, Segment } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { PricingService } from '../pricing/pricing.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { AllFlightProvidersFailedError } from '../providers/provider.types.js';
import {
  StubProviderFactory,
  type StubFactoryOptions,
} from '../providers/__fixtures__/stub-provider.factory.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import type { SearchTelemetryService } from './search-telemetry.service.js';
import { SearchService } from './search.service.js';

/**
 * La puerta de moneda del fan-out.
 *
 * El fallo que arregla se vio en producción: en la misma lista de resultados convivían
 * `BRL 1.286` y `$ 859.100`. `1.286` se lee como más barato y son ~1,1 millones de pesos.
 *
 * Este es el ÚNICO punto del sistema que ve las ofertas de todos los proveedores juntas, así
 * que es el único que puede afirmar que la lista sale en una sola moneda. Cada ACL pide la
 * moneda del tenant y el de Sabre además descarta lo que no encaje, pero un proveedor puede
 * ignorar lo que se le pide y no todos los ACL se defienden: sin esta puerta, basta uno.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCAL = 'COP';
const AJENA = 'BRL';

function criteria(currency: string = LOCAL): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-11-10',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency,
  };
}

function segment(flightNumber = '2437'): Segment {
  return {
    carrier: 'LA',
    flightNumber,
    origin: 'BOG',
    destination: 'LIM',
    departureAt: '2026-11-10T08:00:00-05:00',
    arrivalAt: '2026-11-10T11:30:00-05:00',
    durationMinutes: 210,
    cabin: 'economy',
    bookingClass: 'Y',
  };
}

interface OfferSpec {
  provider: string;
  currency: string;
  amountMinor?: number;
  flightNumber?: string;
  ref?: string;
}

function offer(spec: OfferSpec): Offer {
  const amountMinor = spec.amountMinor ?? 100_000;
  const currency = spec.currency;
  return {
    id: `${spec.provider}-${spec.ref ?? amountMinor}`,
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: spec.provider, offerRef: `${spec.provider}-${spec.ref ?? amountMinor}` },
    total: { amountMinor, currency },
    baseFare: { amountMinor: Math.round(amountMinor * 0.8), currency },
    taxes: { amountMinor: Math.round(amountMinor * 0.2), currency },
    itineraries: [{ segments: [segment(spec.flightNumber)], totalDurationMinutes: 210, stops: 0 }],
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
  };
}

interface Banco {
  service: SearchService;
  cache: MemoryCacheAdapter;
  llamadas: (code: string) => number;
}

/** Espía del logger de Nest, capturado en `beforeEach` para poder leer lo que se avisó. */
let warnSpy: MockInstance<(...args: unknown[]) => void>;

/** Sólo los avisos de descuadre de moneda, en orden. */
function avisos(): string[] {
  return warnSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith('search.currency_mismatch'));
}

function banco(providers: StubFactoryOptions[]): Banco {
  const llamadas = new Map<string, number>();
  const factories = providers.map((spec) => {
    const code = spec.code ?? 'stub-air';
    return new StubProviderFactory({
      ...spec,
      code,
      searchImpl: () => {
        llamadas.set(code, (llamadas.get(code) ?? 0) + 1);
        return Promise.resolve(spec.offers ?? []);
      },
    });
  });

  const registry = new FlightProviderRegistry(factories, {
    isEnabledForTenant: () => Promise.resolve(false),
  });

  const telemetry = {
    assertWithinQuota: vi.fn(() => Promise.resolve()),
    instrument: vi.fn((_meta: unknown, run: () => Promise<unknown>) => run()),
  } as unknown as SearchTelemetryService;

  const cache = new MemoryCacheAdapter();
  const service = new SearchService(
    registry,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    telemetry,
    new CircuitBreakerService(),
    cache,
  );

  return {
    service,
    cache,
    llamadas: (code) => llamadas.get(code) ?? 0,
  };
}

describe('SearchService — la lista sale en UNA sola moneda', () => {
  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dos proveedores con monedas distintas: sólo sobrevive la del tenant', async () => {
    // El caso EXACTO de producción: `BRL 1.286` junto a `COP 859.100`.
    const b = banco([
      { code: 'alfa-air', offers: [offer({ provider: 'alfa-air', currency: AJENA })] },
      { code: 'beta-air', offers: [offer({ provider: 'beta-air', currency: LOCAL })] },
    ]);

    const res = await b.service.searchFlights(criteria(), TENANT);

    expect(new Set(res.offers.map((o) => o.total.currency))).toEqual(new Set([LOCAL]));
    expect(res.offers.map((o) => o.provider.name)).toEqual(['beta-air']);
  });

  it('al proveedor que quedó sin nada cotizable NO se le dice `empty`', async () => {
    // `empty` afirma que no había vuelos, y sí los había: se los estamos escondiendo al
    // vendedor por un motivo que él puede arreglar. El motivo tiene que decir cuál.
    const b = banco([
      { code: 'alfa-air', offers: [offer({ provider: 'alfa-air', currency: AJENA })] },
      { code: 'beta-air', offers: [offer({ provider: 'beta-air', currency: LOCAL })] },
    ]);

    const res = await b.service.searchFlights(criteria(), TENANT);
    const alfa = res.providers.find((p) => p.code === 'alfa-air');

    expect(alfa?.status).toBe('error');
    expect(alfa?.count).toBe(0);
    expect(alfa?.reason).toContain(AJENA);
    expect(alfa?.reason).toContain(LOCAL);
  });

  it('el proveedor que sí aportó sigue OK y su `count` es lo cotizable', async () => {
    const b = banco([
      { code: 'alfa-air', offers: [offer({ provider: 'alfa-air', currency: AJENA })] },
      { code: 'beta-air', offers: [offer({ provider: 'beta-air', currency: LOCAL })] },
    ]);

    const res = await b.service.searchFlights(criteria(), TENANT);
    const beta = res.providers.find((p) => p.code === 'beta-air');

    expect(beta?.status).toBe('ok');
    expect(beta?.count).toBe(1);
  });

  it('descarte PARCIAL: no se tumba el producto vendible del mismo proveedor', async () => {
    // Un proveedor multi-PCC puede devolver mezcla. Tirar sus 2 ofertas buenas porque una
    // hermana vino descuadrada le borra al vendedor inventario que sí puede cotizar.
    const b = banco([
      {
        code: 'alfa-air',
        offers: [
          offer({ provider: 'alfa-air', currency: LOCAL, ref: 'a', flightNumber: '1' }),
          offer({ provider: 'alfa-air', currency: AJENA, ref: 'b', flightNumber: '2' }),
          offer({ provider: 'alfa-air', currency: LOCAL, ref: 'c', flightNumber: '3' }),
        ],
      },
    ]);

    const res = await b.service.searchFlights(criteria(), TENANT);
    const alfa = res.providers.find((p) => p.code === 'alfa-air');

    expect(res.offers).toHaveLength(2);
    expect(alfa?.status).toBe('ok');
    // El conteo cuenta lo que se muestra, no lo que llegó del cable.
    expect(alfa?.count).toBe(2);
  });

  it('un descarte parcial no se calla: queda en el log con proveedor, monedas y conteos', async () => {
    const b = banco([
      {
        code: 'alfa-air',
        offers: [
          offer({ provider: 'alfa-air', currency: LOCAL, ref: 'a' }),
          offer({ provider: 'alfa-air', currency: AJENA, ref: 'b', flightNumber: '2' }),
        ],
      },
    ]);

    await b.service.searchFlights(criteria(), TENANT);

    expect(avisos()).toEqual([
      `search.currency_mismatch provider=alfa-air expected=${LOCAL} dropped=1 kept=1`,
    ]);
  });

  it('TODO en otra moneda: 502, no una lista vacía', async () => {
    // Una lista vacía se lee como "no hay vuelos" y el vendedor se lo dice a su cliente.
    const b = banco([
      { code: 'alfa-air', offers: [offer({ provider: 'alfa-air', currency: AJENA })] },
      { code: 'beta-air', offers: [offer({ provider: 'beta-air', currency: 'USD' })] },
    ]);

    await expect(b.service.searchFlights(criteria(), TENANT)).rejects.toBeInstanceOf(
      AllFlightProvidersFailedError,
    );
  });

  it('la puerta compara contra la moneda del CRITERIO, no contra una constante', async () => {
    // Con la moneda quemada en el código, la red entera cotizaría en la unidad del primero
    // que se configuró. Las mismas ofertas, dos tenants con monedas distintas.
    const ofertas = [
      offer({ provider: 'alfa-air', currency: AJENA, ref: 'br' }),
      offer({ provider: 'alfa-air', currency: LOCAL, ref: 'co', flightNumber: '2' }),
    ];

    const enCop = banco([{ code: 'alfa-air', offers: ofertas }]);
    const enBrl = banco([{ code: 'alfa-air', offers: ofertas }]);

    const resCop = await enCop.service.searchFlights(criteria(LOCAL), TENANT);
    const resBrl = await enBrl.service.searchFlights(criteria(AJENA), TENANT);

    expect(resCop.offers.map((o) => o.total.currency)).toEqual([LOCAL]);
    expect(resBrl.offers.map((o) => o.total.currency)).toEqual([AJENA]);
  });

  it('un resultado con descartes no se cachea: la credencial se puede estar arreglando ahora', async () => {
    const b = banco([
      { code: 'alfa-air', offers: [offer({ provider: 'alfa-air', currency: AJENA })] },
      { code: 'beta-air', offers: [offer({ provider: 'beta-air', currency: LOCAL })] },
    ]);

    await b.service.searchFlights(criteria(), TENANT);
    await b.service.searchFlights(criteria(), TENANT);

    expect(b.llamadas('alfa-air')).toBe(2);
  });

  it('sin descartes, todo sigue igual: nada se filtra y el resultado se cachea', async () => {
    const b = banco([
      { code: 'alfa-air', offers: [offer({ provider: 'alfa-air', currency: LOCAL, ref: 'a' })] },
      {
        code: 'beta-air',
        offers: [offer({ provider: 'beta-air', currency: LOCAL, ref: 'b', flightNumber: '9' })],
      },
    ]);

    const res = await b.service.searchFlights(criteria(), TENANT);
    await b.service.searchFlights(criteria(), TENANT);

    expect(res.offers).toHaveLength(2);
    expect(res.providers.every((p) => p.status === 'ok')).toBe(true);
    expect(b.llamadas('alfa-air')).toBe(1);
    expect(avisos()).toEqual([]);
  });

  it('con la puerta, el dedupe VUELVE a funcionar: el mismo vuelo deja de salir dos veces', async () => {
    // `dedupeFlightOffers` no colapsa nada mientras haya más de una moneda en el conjunto. Ese
    // era el tercer síntoma: el sistema ya sabía que la mezcla podía pasar y se rendía.
    const b = banco([
      {
        code: 'alfa-air',
        offers: [
          offer({ provider: 'alfa-air', currency: LOCAL, amountMinor: 120_000 }),
          offer({ provider: 'alfa-air', currency: AJENA, ref: 'ajena' }),
        ],
      },
      {
        code: 'beta-air',
        offers: [offer({ provider: 'beta-air', currency: LOCAL, amountMinor: 90_000 })],
      },
    ]);

    const res = await b.service.searchFlights(criteria(), TENANT);

    // Mismo vuelo, mismo equipaje, mismas políticas: un solo producto, el más barato.
    expect(res.offers).toHaveLength(1);
    expect(res.offers[0]?.total).toEqual({ amountMinor: 90_000, currency: LOCAL });
  });
});
