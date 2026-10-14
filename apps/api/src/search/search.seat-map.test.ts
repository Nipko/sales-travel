import { BadRequestException } from '@nestjs/common';
import type { Offer, SeatMap } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import type { PricingService } from '../pricing/pricing.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  ProviderDisabledByPlatformError,
  SeatSelectionNotAvailableError,
  type ProviderCapabilities,
} from '../providers/provider.types.js';
import type { ProviderEnvironment } from '../providers/provider-environment.js';
import { StubProviderFactory, stubOffer } from '../providers/__fixtures__/stub-provider.factory.js';
import { apagadoPara, providerFlags } from '../providers/__fixtures__/provider-flags.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import type { SearchTelemetryService } from './search-telemetry.service.js';
import { SearchService } from './search.service.js';

/**
 * `SearchService.seatMap` (SAB-16): el mapa de asientos de la oferta que el vendedor está por
 * reservar. Es venta —se corta con el proveedor apagado— y sólo se consulta con la capacidad
 * `seatMap` encendida y un adapter que sepa pintarlo: cada consulta es una llamada que se factura.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';
const CODE = 'seat-air';

const MAPA: SeatMap = { segments: [], warnings: ['seat-price-undetermined'] };

function criteria(): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-11-10',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  };
}

interface BancoOpts {
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** `false`: el adapter no implementa `getSeatMap`. */
  readonly pinta?: boolean;
  readonly environment?: ProviderEnvironment;
  readonly apagado?: boolean;
}

function banco(opts: BancoOpts = {}) {
  const factory = new StubProviderFactory({
    code: CODE,
    capabilities: { seatMap: true, ...opts.capabilities },
    ...(opts.environment === undefined ? {} : { providerEnvironment: opts.environment }),
  });
  const adapter = factory.adapterFor(TENANT);
  const getSeatMap = vi.fn((_o: Offer, _c: FlightSearchCriteria, _ctx: SearchContext) =>
    Promise.resolve(MAPA),
  );
  if (opts.pinta !== false) Object.assign(adapter, { getSeatMap });
  const registry = new FlightProviderRegistry(
    [factory],
    providerFlags((tenantId) => (opts.apagado === true ? apagadoPara(tenantId) : undefined)),
  );
  const service = new SearchService(
    registry,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    {} as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
    new MemoryCacheAdapter(),
  );
  return { service, getSeatMap, factory };
}

describe('SearchService.seatMap', () => {
  it('con la capacidad: el mapa del proveedor de la oferta, y lo que la pantalla no puede adivinar', async () => {
    const b = banco();
    const offer = stubOffer(CODE, TENANT);
    const response = await b.service.seatMap(offer, criteria(), TENANT);

    expect(response).toEqual({
      seatMap: MAPA,
      // P-16: precios del proveedor, sin markup; y sólo los asientos sin cargo se reservan (D1).
      prices: 'provider',
      paidSeatsBookable: false,
      testContent: false,
    });
    expect(b.getSeatMap).toHaveBeenCalledTimes(1);
    const [enviada, enviados, ctx] = b.getSeatMap.mock.calls[0]!;
    expect(enviada.id).toBe(offer.id);
    expect(enviados).toEqual(criteria());
    expect(ctx).toEqual({ tenantId: TENANT });
  });

  it('sin la capacidad no se consulta a nadie: el vendedor reserva sin asiento', async () => {
    for (const capabilities of [{ seatMap: false }, { seatMap: undefined }]) {
      const b = banco({ capabilities });
      await expect(
        b.service.seatMap(stubOffer(CODE, TENANT), criteria(), TENANT),
      ).rejects.toBeInstanceOf(SeatSelectionNotAvailableError);
      expect(b.getSeatMap).not.toHaveBeenCalled();
    }
  });

  it('con la capacidad pero sin un adapter que pinte el mapa, tampoco', async () => {
    const b = banco({ pinta: false });
    await expect(
      b.service.seatMap(stubOffer(CODE, TENANT), criteria(), TENANT),
    ).rejects.toBeInstanceOf(SeatSelectionNotAvailableError);
  });

  it('una oferta de otra agencia no se consulta con la cuenta de ésta', async () => {
    const b = banco();
    await expect(
      b.service.seatMap(stubOffer(CODE, OTRO_TENANT), criteria(), TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.factory.resolveCalls).toEqual([]);
  });

  it('es venta: con el proveedor apagado por la plataforma no se abre', async () => {
    const b = banco({ apagado: true });
    await expect(
      b.service.seatMap(stubOffer(CODE, TENANT), criteria(), TENANT),
    ).rejects.toBeInstanceOf(ProviderDisabledByPlatformError);
    expect(b.getSeatMap).not.toHaveBeenCalled();
  });

  it('el entorno sale de la cuenta: una cuenta de pruebas marca el mapa, y el navegador no lo quita', async () => {
    const prueba = banco({ environment: 'test' });
    const response = await prueba.service.seatMap(stubOffer(CODE, TENANT), criteria(), TENANT);
    expect(response.testContent).toBe(true);
    expect(prueba.getSeatMap.mock.calls[0]![0].provider.environment).toBe('test');

    // Y al revés: una oferta que el navegador marca de prueba contra una cuenta real no lo es.
    const real = banco({ environment: 'live' });
    const disfrazada = stubOffer(CODE, TENANT);
    const marcada: Offer = {
      ...disfrazada,
      provider: { ...disfrazada.provider, environment: 'test' },
    };
    const vivo = await real.service.seatMap(marcada, criteria(), TENANT);
    expect(vivo.testContent).toBe(false);
    expect(real.getSeatMap.mock.calls[0]![0].provider.environment).toBeUndefined();
  });

  it('seatSelectionAvailable dice la capacidad del proveedor, sin tocar credenciales', () => {
    expect(banco().service.seatSelectionAvailable(CODE)).toBe(true);
    const b = banco({ capabilities: { seatMap: false } });
    expect(b.service.seatSelectionAvailable(CODE)).toBe(false);
    expect(b.service.seatSelectionAvailable('desconocido')).toBe(false);
    expect(b.factory.resolveCalls).toEqual([]);
  });
});
