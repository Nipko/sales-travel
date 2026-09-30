import { describe, expect, it } from 'vitest';
import type { CarOffer } from '../actions';
import {
  DEFAULT_RESULTS_STATE,
  NO_FILTERS,
  activeFilterChips,
  activeFilterCount,
  applyCarFilters,
  carFacets,
  effectiveFilters,
  parseResultsQuery,
  queryWithResults,
  resultCarsOf,
  sortCars,
  wideningSuggestions,
  withMaxTotal,
  type CarFilters,
} from './car-results-filters';

function auto(sippCode: string, saleMajor: number, extra: Partial<CarOffer> = {}): CarOffer {
  const money = { amountMinor: saleMajor * 100, currency: 'USD' };
  return {
    category: 'Economy',
    sippCode,
    companyCode: 'ZE',
    companyName: 'Hertz',
    rateAmount: money,
    paymentOption: 'ppd',
    carModel: 'Kia Rio',
    doors: 4,
    passengers: 5,
    bags: 2,
    trans: '',
    air: true,
    kmIncluded: 'Unlimited',
    base: money,
    tax: { amountMinor: 0, currency: 'USD' },
    ...extra,
  };
}

const OFERTAS: CarOffer[] = [
  auto('ECAR', 210),
  auto('ECMR', 180, { companyCode: 'ZI', companyName: 'Avis', air: false }),
  auto('CCAR', 260, { kmIncluded: '200 km/day' }),
  auto('IFAR', 420, { passengers: 5, companyCode: 'ZI', companyName: 'Avis' }),
  auto('MVAR', 610, { passengers: 7 }),
];
const CARS = resultCarsOf(OFERTAS);

function filtros(extra: Partial<CarFilters>): CarFilters {
  return { ...NO_FILTERS, ...extra };
}

describe('resultCarsOf', () => {
  it('claves únicas aunque se repita el SIPP de la misma arrendadora', () => {
    const cars = resultCarsOf([auto('ECAR', 100), auto('ECAR', 100)]);
    expect(new Set(cars.map((c) => c.key)).size).toBe(2);
  });

  it('el precio es el de venta', () => {
    const [car] = resultCarsOf([
      auto('ECAR', 100, {
        pricing: { costMinor: 100_00, finalMinor: 120_00, ownMarkupMinor: 20_00, currency: 'USD' },
      }),
    ]);
    expect(car?.sale.amountMinor).toBe(120_00);
  });
});

describe('filtros', () => {
  it('sin filtros, todos', () => {
    expect(applyCarFilters(CARS, NO_FILTERS)).toHaveLength(5);
  });

  it('por clase, transmisión, plazas, aire y kilometraje', () => {
    const sipps = (f: CarFilters) => applyCarFilters(CARS, f).map((c) => c.offer.sippCode);
    expect(sipps(filtros({ classes: ['economico'] }))).toEqual(['ECAR', 'ECMR']);
    expect(sipps(filtros({ transmissions: ['manual'] }))).toEqual(['ECMR']);
    expect(sipps(filtros({ minSeats: 7 }))).toEqual(['MVAR']);
    expect(sipps(filtros({ airOnly: true }))).not.toContain('ECMR');
    expect(sipps(filtros({ unlimitedKmOnly: true }))).not.toContain('CCAR');
    expect(sipps(filtros({ companies: ['ZI'] }))).toEqual(['ECMR', 'IFAR']);
  });

  it('el tope de precio es por el alquiler completo, en venta', () => {
    const f = filtros({ maxTotal: { amountMinor: 260_00, currency: 'USD' } });
    expect(applyCarFilters(CARS, f).map((c) => c.offer.sippCode)).toEqual(['ECAR', 'ECMR', 'CCAR']);
  });

  it('un tope en otra moneda no se aplica', () => {
    const f = filtros({ maxTotal: { amountMinor: 1, currency: 'COP' } });
    expect(effectiveFilters(f, 'USD').maxTotal).toBeUndefined();
    expect(effectiveFilters(f, 'COP')).toBe(f);
  });
});

describe('orden', () => {
  it('menor precio por defecto, mayor precio y más pasajeros', () => {
    const order = (s: Parameters<typeof sortCars>[1]) =>
      sortCars(CARS, s).map((c) => c.offer.sippCode);
    expect(order('precio-asc')).toEqual(['ECMR', 'ECAR', 'CCAR', 'IFAR', 'MVAR']);
    expect(order('precio-desc')).toEqual(['MVAR', 'IFAR', 'CCAR', 'ECAR', 'ECMR']);
    expect(order('pasajeros')[0]).toBe('MVAR');
  });
});

describe('facetas', () => {
  it('cada clase con cuántos autos quedan y desde cuánto, con el resto de los filtros puestos', () => {
    const facets = carFacets(CARS, filtros({ airOnly: true }));
    const eco = facets.classes.find((c) => c.value === 'economico');
    expect(eco?.count).toBe(1);
    expect(eco?.from).toEqual({ amountMinor: 210_00, currency: 'USD' });
    expect(facets.classes.map((c) => c.value)).toEqual(['economico', 'compacto', 'suv', 'van']);
  });

  it('la faceta de una dimensión no se filtra a sí misma', () => {
    const facets = carFacets(CARS, filtros({ classes: ['suv'] }));
    expect(facets.classes.find((c) => c.value === 'economico')?.count).toBe(2);
    expect(facets.companies.find((c) => c.value === 'ZI')?.count).toBe(1);
  });

  it('rango de precio en la moneda de los resultados; con dos monedas, sin tope', () => {
    expect(carFacets(CARS, NO_FILTERS).price).toEqual({ min: 180_00, max: 610_00 });
    const mixed = resultCarsOf([
      auto('ECAR', 100),
      auto('CCAR', 100, { rateAmount: { amountMinor: 1, currency: 'COP' } }),
    ]);
    expect(carFacets(mixed, NO_FILTERS).price).toBeUndefined();
  });

  it('el deslizador en su último paso quita el tope', () => {
    const facets = carFacets(CARS, NO_FILTERS);
    expect(withMaxTotal(NO_FILTERS, 610_00, facets).maxTotal).toBeUndefined();
    expect(withMaxTotal(NO_FILTERS, 300_00, facets).maxTotal).toEqual({
      amountMinor: 300_00,
      currency: 'USD',
    });
  });
});

describe('pastillas y cómo ampliar', () => {
  const f = filtros({
    classes: ['suv'],
    companies: ['ZE'],
    minSeats: 7,
    maxTotal: { amountMinor: 200_00, currency: 'USD' },
  });

  it('una pastilla por filtro, cada una sabe quitarse sola', () => {
    const chips = activeFilterChips(f, carFacets(CARS, f));
    expect(chips.map((c) => c.label)).toEqual(
      expect.arrayContaining(['SUV', 'Hertz', '7+ pasajeros']),
    );
    const seats = chips.find((c) => c.id === 'plazas');
    expect(seats?.without.minSeats).toBeUndefined();
    expect(seats?.without.maxTotal).toEqual(f.maxTotal);
    expect(activeFilterCount(f)).toBe(4);
  });

  it('propone quitar lo que muestra autos, lo que más muestra primero', () => {
    const suggestions = wideningSuggestions(CARS, filtros({ classes: ['lujo'], airOnly: true }));
    expect(suggestions[0]?.id).toBe('clase');
    expect(suggestions[0]?.count).toBe(4);
    expect(suggestions.every((s) => s.count > 0)).toBe(true);
  });
});

describe('la URL', () => {
  it('ida y vuelta sin perder nada', () => {
    const state = {
      sort: 'precio-desc' as const,
      filters: filtros({
        classes: ['suv', 'economico'],
        companies: ['ZI'],
        transmissions: ['automatica'],
        minSeats: 5,
        airOnly: true,
        unlimitedKmOnly: true,
        maxTotal: { amountMinor: 300_00, currency: 'USD' },
      }),
    };
    const query = queryWithResults('?moneda=USD', state);
    expect(query).toContain('moneda=USD');
    expect(query).toContain('clase=economico%2Csuv');
    const back = parseResultsQuery(query);
    expect(back.sort).toBe('precio-desc');
    expect(back.filters).toEqual({ ...state.filters, classes: ['economico', 'suv'] });
  });

  it('lo que está por defecto no se escribe; lo que no se entiende se ignora', () => {
    expect(queryWithResults('', DEFAULT_RESULTS_STATE)).toBe('');
    const parsed = parseResultsQuery('?orden=raro&clase=tanque,suv&plazas=3&arrendadora=<x>');
    expect(parsed.sort).toBe('precio-asc');
    expect(parsed.filters.classes).toEqual(['suv']);
    expect(parsed.filters.minSeats).toBeUndefined();
    expect(parsed.filters.companies).toEqual([]);
  });
});
