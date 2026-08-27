import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { SearchController } from '../search/search.controller.js';
import type { FlightSearchResponse, SearchService } from '../search/search.service.js';
import type { ProviderDisclosureService } from './provider-disclosure.service.js';

/**
 * El límite que este ajuste NO puede cruzar.
 *
 * Ocultar de QUIÉN es una tarifa no puede ocultar que la tarifa es INVENTADA. La pantalla
 * marca las ofertas simuladas cruzando `providers[].simulated` con `offer.provider.name`
 * (cotizaciones/page.tsx): si alguien implementara "ocultar proveedor" borrando o
 * anonimizando esos campos en la respuesta, el aviso "tarifa simulada · no cotizable"
 * desaparecería en silencio y un vendedor le pasaría un precio falso a un cliente. Además
 * `SearchService.priceOffer` enruta por `offer.provider.name`: sin él no hay reserva.
 *
 * Por eso el ajuste viaja como un booleano APARTE y la carga sale intacta.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function offer(providerCode: string): Offer {
  return {
    id: `oferta-${providerCode}`,
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: providerCode, offerRef: `${providerCode}-1` },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
  };
}

const RESPUESTA: FlightSearchResponse = {
  offers: [offer('sabre'), offer('latam-ndc')],
  simulated: false,
  providers: [
    { code: 'latam-ndc', status: 'simulated', count: 1, simulated: true },
    { code: 'sabre', status: 'ok', count: 1, simulated: false },
  ],
};

function criteria(): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-11-10',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  };
}

function controllerCon(muestraProveedor: boolean): SearchController {
  const search = {
    searchFlights: () => Promise.resolve(RESPUESTA),
  } as unknown as SearchService;

  const db = {
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () =>
              Promise.resolve({ default_currency: 'USD', country_code: 'CO', name: 'Agencia' }),
          }),
        }),
      }),
    },
  } as unknown as DatabaseService;

  const activeTenant = { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService;
  const disclosure = {
    effective: () => Promise.resolve(muestraProveedor),
  } as unknown as ProviderDisclosureService;

  return new SearchController(search, db, activeTenant, disclosure);
}

describe('sobre de búsqueda con la divulgación de proveedor apagada', () => {
  it('el parte por proveedor y sus banderas de simulado siguen viajando', async () => {
    const out = await controllerCon(false).flights('u1', criteria());

    expect(out.showProviderInResults).toBe(false);
    expect(out.providers.map((p) => p.code)).toEqual(['latam-ndc', 'sabre']);
    expect(out.providers.find((p) => p.code === 'latam-ndc')?.simulated).toBe(true);
  });

  it('cada oferta sigue diciendo de qué proveedor es: sin eso no hay marca de simulada', async () => {
    const out = await controllerCon(false).flights('u1', criteria());

    // El cruce EXACTO que hace la pantalla para decidir si pinta "tarifa simulada".
    const simulados = new Set(out.providers.filter((p) => p.simulated).map((p) => p.code));
    const marcadas = out.offers.filter((o) => simulados.has(o.provider.name));

    expect(marcadas).toHaveLength(1);
    expect(marcadas[0]?.provider.offerRef).toBe('latam-ndc-1');
  });

  it('con el ajuste encendido el sobre es el mismo, salvo el booleano', async () => {
    const oculto = await controllerCon(false).flights('u1', criteria());
    const visible = await controllerCon(true).flights('u1', criteria());

    expect(visible.showProviderInResults).toBe(true);
    expect({ ...visible, showProviderInResults: false }).toEqual(oculto);
  });

  it('`simulated` global conserva su semántica vieja', async () => {
    const out = await controllerCon(false).flights('u1', criteria());
    expect(out.simulated).toBe(false);
  });
});
