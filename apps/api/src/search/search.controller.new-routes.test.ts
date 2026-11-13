import { ForbiddenException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { SearchController } from './search.controller.js';
import type { SearchService } from './search.service.js';

/**
 * Las rutas de docs/platform/18: más tarifas de un vuelo, el calendario de precios y el estado de
 * los proveedores. Lo que se fija acá es lo que pone el controlador: la agencia activa y su moneda.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function criteria(): FlightSearchCriteria {
  return {
    origin: 'CTG',
    destination: 'MIA',
    departureDate: '2026-12-09',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  };
}

function offer(currency = 'COP'): Offer {
  return {
    id: 'o1',
    tenantId: TENANT,
    provider: { name: 'sabre', offerRef: 'r' },
    total: { amountMinor: 100, currency },
  } as unknown as Offer;
}

function banco() {
  const calls: Record<string, unknown[]> = {};
  const search = {
    searchMoreFares: (...args: unknown[]) => {
      calls['fares'] = args;
      return Promise.resolve({ supported: true, offers: [] });
    },
    priceCalendar: (...args: unknown[]) => {
      calls['calendar'] = args;
      return Promise.resolve({ currency: 'COP', days: [] });
    },
    providerStatus: (...args: unknown[]) => {
      calls['status'] = args;
      return Promise.resolve([]);
    },
  } as unknown as SearchService;
  const db = {
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () =>
              Promise.resolve({ default_currency: 'COP', country_code: 'CO', name: 'Agencia' }),
          }),
        }),
      }),
    },
  } as unknown as DatabaseService;
  const activeTenant = { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService;
  const disclosure = {
    effective: () => Promise.resolve(false),
  } as unknown as ProviderDisclosureService;
  return { controller: new SearchController(search, db, activeTenant, disclosure), calls };
}

describe('rutas de búsqueda sin escalera, calendario y estado', () => {
  it('más tarifas: la agencia activa, su moneda y la ida elegida si viene', async () => {
    const b = banco();
    await b.controller.flightMoreFares('u1', {
      searchCriteria: criteria(),
      carrier: 'AA',
      leg: 1,
      known: [offer()],
      outbound: offer(),
    });
    const [crit, request, tenant, home] = b.calls['fares'] as [
      FlightSearchCriteria,
      { carrier: string; leg: number; outbound?: Offer },
      string,
      string,
    ];
    expect(crit.currency).toBe('COP');
    expect(request.carrier).toBe('AA');
    expect(request.outbound?.id).toBe('o1');
    expect(tenant).toBe(TENANT);
    expect(home).toBe('COP');
  });

  it('calendario: en la moneda de venta de la agencia', async () => {
    const b = banco();
    await b.controller.flightPriceCalendar('u1', {
      origin: 'CTG',
      destination: 'MIA',
      departureDate: '2026-12-09',
      cabin: 'economy',
      paxCount: { adults: 1, children: 0, infants: 0 },
    });
    const [tenant, q] = b.calls['calendar'] as [string, { currency: string }];
    expect(tenant).toBe(TENANT);
    expect(q.currency).toBe('COP');
  });

  it('estado de proveedores: de la agencia activa', async () => {
    const b = banco();
    expect(await b.controller.providerStatus('u1')).toEqual({ providers: [] });
    expect(b.calls['status']).toEqual([TENANT]);
  });

  it('sin usuario no responde nada', async () => {
    const b = banco();
    await expect(b.controller.providerStatus(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
