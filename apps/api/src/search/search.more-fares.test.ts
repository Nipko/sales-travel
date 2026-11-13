import { BadRequestException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { FlightMoreFaresRequest, FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import type { PricingService } from '../pricing/pricing.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import type { SearchTelemetryService } from './search-telemetry.service.js';
import { SearchService } from './search.service.js';

/**
 * Más tarifas de un vuelo (docs/platform/18): sólo los proveedores que saben hacerlo, cada uno con
 * sus ofertas y su moneda, con caché y sin mezclar agencias.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const criteria: FlightSearchCriteria = {
  origin: 'CTG',
  destination: 'MIA',
  departureDate: '2026-12-09',
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'COP',
};

function offer(id: string, provider: string, currency: string, tenantId = TENANT): Offer {
  return {
    id,
    tenantId,
    products: ['flight'],
    provider: { name: provider, offerRef: id },
    total: { amountMinor: 100, currency },
    baseFare: { amountMinor: 80, currency },
    taxes: { amountMinor: 20, currency },
    fetchedAt: '2026-11-12T00:00:00Z',
    expiresAt: '2026-11-12T01:00:00Z',
  } as unknown as Offer;
}

function banco() {
  const seen: { code: string; criteria: FlightSearchCriteria; request: FlightMoreFaresRequest }[] =
    [];
  const adapters: Record<string, unknown> = {
    sabre: {
      searchMoreFares: (c: FlightSearchCriteria, r: FlightMoreFaresRequest) => {
        seen.push({ code: 'sabre', criteria: c, request: r });
        return Promise.resolve([offer('nueva', 'sabre', 'COP')]);
      },
    },
    'latam-ndc': {},
  };
  const registry = {
    byCodeForOffer: (_tenant: string, code: string) =>
      Promise.resolve({ code, environment: 'live', adapter: adapters[code] }),
  } as unknown as FlightProviderRegistry;
  const telemetry = {
    assertWithinQuota: vi.fn(() => Promise.resolve()),
    providerStatusRows: vi.fn(() =>
      Promise.resolve([
        {
          provider_code: 'sabre',
          vertical: 'flights',
          recent_searches: 5,
          recent_with_results: 0,
          provider_errors: 0,
          internal_errors: 0,
          last_result_at: null,
        },
      ]),
    ),
    priceCalendar: vi.fn(() => Promise.resolve({ currency: 'COP', days: [] })),
  } as unknown as SearchTelemetryService;
  const service = new SearchService(
    registry,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    telemetry,
    new CircuitBreakerService(),
    new MemoryCacheAdapter(),
  );
  return { service, seen, telemetry };
}

describe('SearchService.searchMoreFares', () => {
  it('reparte por proveedor: sólo consulta al que sabe, en la moneda de sus ofertas', async () => {
    const b = banco();
    const res = await b.service.searchMoreFares(
      criteria,
      {
        carrier: 'LA',
        leg: 0,
        known: [offer('a', 'latam-ndc', 'BRL'), offer('b', 'sabre', 'COP')],
      },
      TENANT,
    );
    expect(res.supported).toBe(true);
    expect(res.offers.map((o) => o.id)).toEqual(['nueva']);
    expect(b.seen).toHaveLength(1);
    expect(b.seen[0]?.request.known.map((o) => o.id)).toEqual(['b']);
    expect(b.seen[0]?.criteria.currency).toBe('COP');
  });

  it('la segunda vez sale de la caché, sin otra llamada al proveedor', async () => {
    const b = banco();
    const request = { carrier: 'AA', leg: 0, known: [offer('b', 'sabre', 'COP')] };
    await b.service.searchMoreFares(criteria, request, TENANT);
    await b.service.searchMoreFares(criteria, request, TENANT);
    expect(b.seen).toHaveLength(1);
  });

  it('sólo proveedores sin la capacidad: no soportado, sin llamar a nadie', async () => {
    const b = banco();
    const res = await b.service.searchMoreFares(
      criteria,
      { carrier: 'LA', leg: 0, known: [offer('a', 'latam-ndc', 'BRL')] },
      TENANT,
    );
    expect(res).toEqual({ supported: false, offers: [] });
  });

  it('ofertas de otra agencia: rechazo', async () => {
    const b = banco();
    await expect(
      b.service.searchMoreFares(
        criteria,
        { carrier: 'AA', leg: 0, known: [offer('x', 'sabre', 'COP', 'otra')] },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sin ofertas de partida no hay nada que pedir', async () => {
    const b = banco();
    expect(
      await b.service.searchMoreFares(criteria, { carrier: 'AA', leg: 0, known: [] }, TENANT),
    ).toEqual({ supported: true, offers: [] });
  });
});

describe('SearchService: estado de proveedores y calendario', () => {
  it('el estado sale de la telemetría, con la regla del fold', async () => {
    const b = banco();
    const [estado] = await b.service.providerStatus(TENANT);
    expect(estado?.status).toBe('provider');
  });

  it('el calendario se delega a la telemetría', async () => {
    const b = banco();
    const q = {
      origin: 'CTG',
      destination: 'MIA',
      departureDate: '2026-12-09',
      cabin: 'economy',
      currency: 'COP',
      paxCount: { adults: 1, children: 0, infants: 0 },
    };
    expect(await b.service.priceCalendar(TENANT, q)).toEqual({ currency: 'COP', days: [] });
  });
});
