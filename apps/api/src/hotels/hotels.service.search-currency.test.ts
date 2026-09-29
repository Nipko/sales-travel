import { HttpStatus, Logger } from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import type { HotelProviderFactory } from '../providers/hotel-provider.types.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb, type FilaTenant } from './__fixtures__/fake-hotels-db.js';
import {
  HotelRatesCurrencyMismatchError,
  HotelSearchCurrencyMarkupError,
  HotelSearchCurrencyNotAllowedError,
} from './hotel-search-currency.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import type { HotelAvailabilityInput, HotelDetailInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * La moneda de la búsqueda de hoteles de punta a punta (docs/tbo/08 D-TBO-15, selector de moneda
 * del 2026-09-29): el vendedor elige entre la moneda de su agencia y USD, sin conversión. La moneda
 * elegida es la del criterio, la de la puerta, la del precio de venta y la del detalle.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const CIUDAD = 2345;
const DESPEGAR = 'despegar-hotels';
const EN_COP = 'alfa-hotels';
const EN_USD = 'zeta-hotels';

const AGENCIA_COP: FilaTenant = { default_currency: 'COP', country_code: 'CO' };

const PORCENTAJE: ApplicableRule = {
  tenantId: CONSOLIDADOR,
  tenantName: 'Consolidador',
  level: 0,
  ruleType: 'percentage',
  valueMinor: 1000,
};
const FIJO: ApplicableRule = {
  tenantId: TENANT,
  tenantName: 'Agencia',
  level: 1,
  ruleType: 'fixed',
  valueMinor: 5_000_000,
};

function busqueda(overrides: Partial<HotelAvailabilityInput> = {}): HotelAvailabilityInput {
  return {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    rooms: [{ adults: 2, childrenAges: [] }],
    destinationId: CIUDAD,
    ...overrides,
  };
}

function detalle(overrides: Partial<HotelDetailInput> = {}): HotelDetailInput {
  return {
    hotelId: '101',
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    rooms: [{ adults: 2, childrenAges: [] }],
    ...overrides,
  };
}

function banco(opts: { tenant?: FilaTenant | null; reglas?: ApplicableRule[] } = {}) {
  const cop = new StubHotelProviderFactory({ code: EN_COP, currency: 'COP' });
  const usd = new StubHotelProviderFactory({ code: EN_USD, currency: 'USD' });
  const despegar = new FakeDespegarHotelsAdapter();
  const factories: HotelProviderFactory[] = [cop, usd, fakeDespegarFactory(despegar).factory];
  const db = fakeHotelsDb({
    catalogo: { [EN_COP]: ['A-1'], [EN_USD]: ['Z-1'], [DESPEGAR]: ['101'] },
    tenant: opts.tenant === undefined ? AGENCIA_COP : opts.tenant,
  });
  const assertWithinQuota = vi.fn(() => Promise.resolve());
  const instrument = vi.fn((_meta: unknown, run: () => Promise<unknown>) => run());
  const getApplicableRules = vi.fn(() => Promise.resolve(opts.reglas ?? []));
  const service = new HotelsService(
    hotelRegistry(factories),
    db.service,
    { getApplicableRules } as unknown as PricingService,
    { assertWithinQuota, instrument } as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  return { service, cop, usd, despegar, assertWithinQuota };
}

function parteDe(providers: readonly HotelProviderOutcome[], code: string): HotelProviderOutcome {
  const p = providers.find((o) => o.code === code);
  if (!p) throw new Error(`no hay parte de ${code}`);
  return p;
}

function proveedoresDe(hotels: readonly HotelOffer[]): string[] {
  return [...new Set(hotels.flatMap((o) => o.roompacks.map((rp) => rp.provider.name)))];
}

async function rechazo(promesa: Promise<unknown>): Promise<Error & { getStatus(): number }> {
  try {
    await promesa;
  } catch (err) {
    return err as Error & { getStatus(): number };
  }
  throw new Error('se esperaba un rechazo');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HotelsService.searchCurrencies — el selector de la web', () => {
  it('la moneda de la agencia, elegida por defecto, y USD', async () => {
    const b = banco();
    await expect(b.service.searchCurrencies(TENANT)).resolves.toEqual({
      defaultCurrency: 'COP',
      currencies: ['COP', 'USD'],
    });
  });

  it('una agencia en USD tiene una sola', async () => {
    const b = banco({ tenant: { default_currency: 'usd ', country_code: 'US' } });
    await expect(b.service.searchCurrencies(TENANT)).resolves.toEqual({
      defaultCurrency: 'USD',
      currencies: ['USD'],
    });
  });

  it('una agencia con la moneda rota cae a USD, como la búsqueda', async () => {
    const b = banco({ tenant: { default_currency: 'C0P', country_code: 'CO' } });
    await expect(b.service.searchCurrencies(TENANT)).resolves.toEqual({
      defaultCurrency: 'USD',
      currencies: ['USD'],
    });
  });
});

describe('HotelsService.searchAvailability — moneda elegida por el vendedor', () => {
  it('en la moneda de la agencia se ven las tarifas en COP y las de USD quedan fuera con motivo', async () => {
    const b = banco();
    const res = await b.service.searchAvailability(TENANT, busqueda());

    expect(proveedoresDe(res.hotels)).toEqual([EN_COP]);
    expect(parteDe(res.providers, EN_USD)).toMatchObject({
      status: 'skipped',
      skipReason: 'currency-mismatch',
      droppedCurrencies: ['USD'],
    });
  });

  it('en USD, la moneda viaja en el criterio y se ven las tarifas en USD', async () => {
    const b = banco();
    const res = await b.service.searchAvailability(TENANT, busqueda({ currency: 'USD' }));

    expect(vi.mocked(b.usd.adapterFor(TENANT).searchAvailability).mock.calls[0]?.[0]).toMatchObject(
      { currency: 'USD' },
    );
    expect(proveedoresDe(res.hotels)).toEqual(expect.arrayContaining([EN_USD]));
    expect(res.hotels.flatMap((o) => o.roompacks.map((rp) => rp.price.total.currency))).toEqual(
      expect.not.arrayContaining(['COP']),
    );
    expect(parteDe(res.providers, EN_COP)).toMatchObject({
      skipReason: 'currency-mismatch',
      droppedCurrencies: ['COP'],
    });
  });

  it('una moneda fuera de la lista es 400 y no gasta cuota ni llama a nadie', async () => {
    const b = banco();
    const err = await rechazo(b.service.searchAvailability(TENANT, busqueda({ currency: 'EUR' })));

    expect(err).toBeInstanceOf(HotelSearchCurrencyNotAllowedError);
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.message).toContain('COP o USD');
    expect(b.assertWithinQuota).not.toHaveBeenCalled();
    expect(b.usd.resolveCalls).toEqual([]);
    expect(b.despegar.searchAvailability).not.toHaveBeenCalled();
  });

  it('el precio de venta sale en la moneda de la búsqueda con un markup porcentual', async () => {
    const b = banco({ reglas: [PORCENTAJE] });
    const res = await b.service.searchAvailability(TENANT, busqueda({ currency: 'USD' }));

    const pack = res.hotels.flatMap((o) => o.roompacks).find((rp) => rp.provider.name === EN_USD);
    expect(pack?.price.total).toEqual({ amountMinor: 100_000, currency: 'USD' });
    expect(pack?.pricing).toMatchObject({ finalMinor: 110_000, currency: 'USD' });
  });

  it('con un markup FIJO, buscar en otra moneda es 409 antes de gastar cuota', async () => {
    const b = banco({ reglas: [PORCENTAJE, FIJO] });
    const err = await rechazo(b.service.searchAvailability(TENANT, busqueda({ currency: 'USD' })));

    expect(err).toBeInstanceOf(HotelSearchCurrencyMarkupError);
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(b.assertWithinQuota).not.toHaveBeenCalled();
    expect(b.usd.resolveCalls).toEqual([]);
  });

  it('con un markup fijo, en la moneda de la agencia busca y lo suma como siempre', async () => {
    const b = banco({ reglas: [FIJO] });
    const res = await b.service.searchAvailability(TENANT, busqueda());

    const pack = res.hotels.flatMap((o) => o.roompacks).find((rp) => rp.provider.name === EN_COP);
    expect(pack?.pricing).toMatchObject({ finalMinor: 5_100_000, currency: 'COP' });
  });
});

describe('HotelsService.getHotelDetail — la misma moneda que el listado', () => {
  it('en USD responde las tarifas en USD del proveedor', async () => {
    const b = banco();
    const res = await b.service.getHotelDetail(TENANT, detalle({ currency: 'USD' }));

    expect(b.despegar.getHotelDetail.mock.calls[0]?.[0]).toMatchObject({ currency: 'USD' });
    expect(res.roompacks.length).toBeGreaterThan(0);
    expect(new Set(res.roompacks.map((rp) => rp.price.total.currency))).toEqual(new Set(['USD']));
  });

  it('sólo algunas tarifas en otra moneda: salen las cotizables y el descarte queda en el log', async () => {
    const b = banco();
    const grabado = new FakeDespegarHotelsAdapter();
    let enUsd = 0;
    b.despegar.getHotelDetail.mockImplementationOnce(async (q) => {
      const offer = await grabado.getHotelDetail(q);
      const [pack] = offer.roompacks;
      if (pack === undefined) throw new Error('el hotel grabado no tiene tarifas');
      enUsd = offer.roompacks.length;
      const enEur = {
        ...pack,
        id: `${pack.id}-eur`,
        price: { ...pack.price, total: { ...pack.price.total, currency: 'EUR' } },
      };
      return { ...offer, roompacks: [...offer.roompacks, enEur] };
    });

    const res = await b.service.getHotelDetail(TENANT, detalle({ currency: 'USD' }));

    expect(enUsd).toBeGreaterThan(0);
    expect(res.roompacks).toHaveLength(enUsd);
    expect(new Set(res.roompacks.map((rp) => rp.price.total.currency))).toEqual(new Set(['USD']));
    expect(res.roompacks.some((rp) => rp.id.endsWith('-eur'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'hotels.detail.currency_mismatch provider=despegar-hotels expected=USD dropped=1',
    );
  });

  it('todas las tarifas en otra moneda: 409 con el mismo motivo que el listado, no un hotel vacío', async () => {
    const b = banco();
    const err = await rechazo(b.service.getHotelDetail(TENANT, detalle({ currency: 'COP' })));

    expect(err).toBeInstanceOf(HotelRatesCurrencyMismatchError);
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toContain('Cotiza en USD y esta búsqueda es en COP');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^hotels\.detail\.currency_mismatch provider=despegar-hotels expected=COP dropped=\d+$/,
      ),
    );
  });

  it('una moneda fuera de la lista es 400 sin llamar al proveedor', async () => {
    const b = banco();
    const err = await rechazo(b.service.getHotelDetail(TENANT, detalle({ currency: 'BRL' })));

    expect(err).toBeInstanceOf(HotelSearchCurrencyNotAllowedError);
    expect(b.despegar.getHotelDetail).not.toHaveBeenCalled();
  });

  it('con un markup fijo, el detalle en otra moneda es 409 sin llamar al proveedor', async () => {
    const b = banco({ reglas: [FIJO] });
    const err = await rechazo(b.service.getHotelDetail(TENANT, detalle({ currency: 'USD' })));

    expect(err).toBeInstanceOf(HotelSearchCurrencyMarkupError);
    expect(b.despegar.getHotelDetail).not.toHaveBeenCalled();
  });
});
