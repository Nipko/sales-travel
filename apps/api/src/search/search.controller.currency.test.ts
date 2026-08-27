import { Logger } from '@nestjs/common';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { SearchController } from './search.controller.js';
import type { FlightSearchResponse, SearchService } from './search.service.js';

/**
 * De dónde sale la moneda con la que se le pregunta a los proveedores.
 *
 * `tenants.default_currency` es `CHAR(3)` (`db/migrations/0001_init.sql:13`) y se inyecta en el
 * criterio DESPUÉS de que `ZodValidationPipe` validó el body, o sea que entra sin borde. Lo que
 * salga de aquí viaja tal cual a `PriceRequestInformation.CurrencyCode` de Sabre y al POS de
 * LATAM, y se compara luego contra `offer.total.currency`, que llega en mayúsculas: un `'cop '`
 * no descuadraría una oferta, las descuadraría TODAS y vaciaría la búsqueda.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const RESPUESTA: FlightSearchResponse = { offers: [], simulated: false, providers: [] };

function criteria(): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-11-10',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  };
}

interface Banco {
  controller: SearchController;
  /** El criterio tal como lo recibió `SearchService`. */
  visto: () => FlightSearchCriteria | undefined;
}

function banco(defaultCurrency: unknown): Banco {
  let visto: FlightSearchCriteria | undefined;

  const search = {
    searchFlights: (c: FlightSearchCriteria) => {
      visto = c;
      return Promise.resolve(RESPUESTA);
    },
    priceOffer: (_offer: unknown, c: FlightSearchCriteria) => {
      visto = c;
      return Promise.resolve({ offer: {}, priceChanged: false, warnings: [] });
    },
  } as unknown as SearchService;

  const db = {
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () =>
              Promise.resolve({
                default_currency: defaultCurrency,
                country_code: 'CO',
                name: 'Agencia',
              }),
          }),
        }),
      }),
    },
  } as unknown as DatabaseService;

  const activeTenant = { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService;
  const disclosure = {
    effective: () => Promise.resolve(true),
  } as unknown as ProviderDisclosureService;

  return {
    controller: new SearchController(search, db, activeTenant, disclosure),
    visto: () => visto,
  };
}

describe('moneda del tenant → criterio de búsqueda', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('la moneda del tenant reemplaza la del body', async () => {
    const b = banco('COP');
    await b.controller.flights('u1', criteria());

    expect(b.visto()?.currency).toBe('COP');
  });

  it.each([
    ['CHAR(3) con relleno de Postgres', 'COP  '],
    ['minúsculas', 'cop'],
    ['ambas', ' cop '],
  ])('%s se normaliza a COP antes de salir al proveedor', async (_caso, guardado) => {
    const b = banco(guardado);
    await b.controller.flights('u1', criteria());

    expect(b.visto()?.currency).toBe('COP');
  });

  it.each([['XXXX'], ['CO'], [''], ['12']])(
    'un `%s` guardado no se manda: el criterio conserva su default',
    async (guardado) => {
      // Mandarle a un proveedor un código que no entiende es una búsqueda tirada a la basura,
      // o peor: una que vuelve en la moneda del PCC y descuadra la lista entera.
      const b = banco(guardado);
      await b.controller.flights('u1', criteria());

      expect(b.visto()?.currency).toBe('USD');
    },
  );

  it('la revalidación de precio pide la MISMA moneda que la búsqueda', async () => {
    // Pedir otra devolvería un precio en otra unidad justo antes de reservar.
    const b = banco(' cop ');
    await b.controller.offerPrice('u1', {
      offer: {} as never,
      searchCriteria: criteria(),
    });

    expect(b.visto()?.currency).toBe('COP');
  });
});
