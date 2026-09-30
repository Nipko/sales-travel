import type { CarOffer, Money } from '../actions';
import {
  CAR_CLASSES,
  CAR_CLASS_LABELS,
  TRANSMISSION_LABELS,
  carClassOf,
  formatMoney,
  hasUnlimitedKm,
  saleOf,
  transmissionOf,
  type CarClass,
  type Transmission,
} from './car-format';

/*
 * Filtros y orden de los resultados de autos, sin React, con las mismas reglas que los de hoteles:
 * corren sobre lo que ya se cargó (cambiar un filtro no le vuelve a preguntar nada a AgentCars) y el
 * estado vive en la URL (`?orden=precio-desc&clase=suv&transmision=automatica`), así que sobrevive a
 * recargar. La búsqueda misma no viaja por la URL: sólo cómo se miran los resultados.
 */

export type CarSort = 'precio-asc' | 'precio-desc' | 'pasajeros';
export const CAR_SORTS: readonly { value: CarSort; label: string }[] = [
  { value: 'precio-asc', label: 'Menor precio' },
  { value: 'precio-desc', label: 'Mayor precio' },
  { value: 'pasajeros', label: 'Más pasajeros' },
];

/** Plazas mínimas que se ofrecen como filtro: pareja, familia, grupo. */
export const SEAT_OPTIONS: readonly number[] = [4, 5, 7];

const TRANSMISSIONS: readonly Transmission[] = ['automatica', 'manual'];

export interface CarFilters {
  /** Precio de VENTA máximo por el alquiler completo, en la moneda de los resultados. */
  readonly maxTotal?: Money;
  /** Clases aceptadas. Vacío: todas. */
  readonly classes: readonly CarClass[];
  /** Arrendadoras aceptadas, por código. Vacío: todas. */
  readonly companies: readonly string[];
  /** Transmisiones aceptadas. Vacío: las dos. */
  readonly transmissions: readonly Transmission[];
  /** Pasajeros mínimos. */
  readonly minSeats?: number;
  readonly airOnly: boolean;
  readonly unlimitedKmOnly: boolean;
}

export interface CarResultsState {
  readonly filters: CarFilters;
  readonly sort: CarSort;
}

export const NO_FILTERS: CarFilters = Object.freeze({
  classes: [],
  companies: [],
  transmissions: [],
  airOnly: false,
  unlimitedKmOnly: false,
});

export const DEFAULT_RESULTS_STATE: CarResultsState = Object.freeze({
  filters: NO_FILTERS,
  sort: 'precio-asc',
});

// ───────────────────────── La URL ─────────────────────────

const PARAMS = {
  sort: 'orden',
  maxTotal: 'precioMax',
  classes: 'clase',
  companies: 'arrendadora',
  transmissions: 'transmision',
  seats: 'plazas',
  air: 'ac',
  km: 'km',
} as const;

const MAX_TOTAL_RE = /^([A-Z]{3})-(\d{1,15})$/;
const COMPANY_CODE_RE = /^[A-Z0-9]{1,4}$/;

function listParam(params: URLSearchParams, name: string): string[] {
  const raw = params.get(name);
  if (raw === null) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

/** Cómo se miran los resultados según la URL. Lo que no se entiende se ignora, no rompe nada. */
export function parseResultsQuery(search: string): CarResultsState {
  const params = new URLSearchParams(search);
  const sortRaw = params.get(PARAMS.sort);
  const sort = CAR_SORTS.some((s) => s.value === sortRaw) ? (sortRaw as CarSort) : 'precio-asc';

  const max = MAX_TOTAL_RE.exec(params.get(PARAMS.maxTotal) ?? '');
  const maxAmount = max ? Number(max[2]) : Number.NaN;
  const seats = Number(params.get(PARAMS.seats));

  return {
    sort,
    filters: {
      ...(max && Number.isSafeInteger(maxAmount)
        ? { maxTotal: { currency: max[1] ?? '', amountMinor: maxAmount } }
        : {}),
      classes: listParam(params, PARAMS.classes).filter((v): v is CarClass =>
        CAR_CLASSES.includes(v as CarClass),
      ),
      companies: listParam(params, PARAMS.companies)
        .map((v) => v.toUpperCase())
        .filter((v) => COMPANY_CODE_RE.test(v))
        .slice(0, 12),
      transmissions: listParam(params, PARAMS.transmissions).filter((v): v is Transmission =>
        TRANSMISSIONS.includes(v as Transmission),
      ),
      ...(SEAT_OPTIONS.includes(seats) ? { minSeats: seats } : {}),
      airOnly: params.get(PARAMS.air) === '1',
      unlimitedKmOnly: params.get(PARAMS.km) === '1',
    },
  };
}

/**
 * La URL con el estado de los resultados, sin tocar los demás parámetros. Lo que está en su valor
 * por defecto no se escribe.
 */
export function queryWithResults(search: string, state: CarResultsState): string {
  const params = new URLSearchParams(search);
  const set = (name: string, value: string | undefined) => {
    if (value === undefined || value === '') params.delete(name);
    else params.set(name, value);
  };
  const f = state.filters;
  set(PARAMS.sort, state.sort === 'precio-asc' ? undefined : state.sort);
  set(
    PARAMS.maxTotal,
    f.maxTotal ? `${f.maxTotal.currency}-${Math.max(0, Math.round(f.maxTotal.amountMinor))}` : '',
  );
  set(PARAMS.classes, CAR_CLASSES.filter((c) => f.classes.includes(c)).join(','));
  set(PARAMS.companies, [...f.companies].sort().join(','));
  set(PARAMS.transmissions, TRANSMISSIONS.filter((t) => f.transmissions.includes(t)).join(','));
  set(PARAMS.seats, f.minSeats === undefined ? undefined : String(f.minSeats));
  set(PARAMS.air, f.airOnly ? '1' : undefined);
  set(PARAMS.km, f.unlimitedKmOnly ? '1' : undefined);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

// ───────────────────────── El modelo ─────────────────────────

/** Un auto de los resultados con lo que los filtros necesitan saber de él. */
export interface ResultCar {
  /** Único en la lista: un mismo SIPP de la misma arrendadora puede venir con dos tarifas. */
  readonly key: string;
  readonly offer: CarOffer;
  /** Precio de venta. */
  readonly sale: Money;
  readonly carClass: CarClass;
  readonly transmission?: Transmission;
  readonly unlimitedKm: boolean;
}

export function resultCarsOf(offers: readonly CarOffer[]): ResultCar[] {
  return offers.map((offer, i) => {
    const transmission = transmissionOf(offer);
    return {
      key: `${offer.companyCode}:${offer.sippCode}:${offer.rateType ?? ''}:${i}`,
      offer,
      sale: saleOf(offer),
      carClass: carClassOf(offer.sippCode),
      ...(transmission ? { transmission } : {}),
      unlimitedKm: hasUnlimitedKm(offer.kmIncluded),
    };
  });
}

/** La moneda de los precios, si es una sola. Con varias, el tope de precio no se ofrece. */
export function resultsCurrency(cars: readonly ResultCar[]): string | undefined {
  const currencies = new Set(cars.map((c) => c.sale.currency));
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

/** Los filtros que valen para estos resultados: un tope en otra moneda no se aplica. */
export function effectiveFilters(filters: CarFilters, currency: string | undefined): CarFilters {
  if (filters.maxTotal === undefined || filters.maxTotal.currency === currency) return filters;
  const { maxTotal: _drop, ...rest } = filters;
  return rest;
}

type Dimension = 'price' | 'classes' | 'companies' | 'transmissions' | 'seats' | 'air' | 'km';

/** ¿Cumple los filtros? `except` deja afuera una dimensión: así se cuentan las opciones de esa. */
function matches(car: ResultCar, f: CarFilters, except?: Dimension): boolean {
  if (except !== 'price' && f.maxTotal && car.sale.amountMinor > f.maxTotal.amountMinor) {
    return false;
  }
  if (except !== 'classes' && f.classes.length > 0 && !f.classes.includes(car.carClass)) {
    return false;
  }
  if (
    except !== 'companies' &&
    f.companies.length > 0 &&
    !f.companies.includes(car.offer.companyCode.toUpperCase())
  ) {
    return false;
  }
  if (
    except !== 'transmissions' &&
    f.transmissions.length > 0 &&
    (car.transmission === undefined || !f.transmissions.includes(car.transmission))
  ) {
    return false;
  }
  if (except !== 'seats' && f.minSeats !== undefined && car.offer.passengers < f.minSeats) {
    return false;
  }
  if (except !== 'air' && f.airOnly && !car.offer.air) return false;
  if (except !== 'km' && f.unlimitedKmOnly && !car.unlimitedKm) return false;
  return true;
}

export function applyCarFilters(cars: readonly ResultCar[], f: CarFilters): ResultCar[] {
  return cars.filter((c) => matches(c, f));
}

export function sortCars(cars: readonly ResultCar[], sort: CarSort): ResultCar[] {
  const byPrice = (a: ResultCar, b: ResultCar) => a.sale.amountMinor - b.sale.amountMinor;
  const out = [...cars];
  switch (sort) {
    case 'precio-desc':
      return out.sort((a, b) => byPrice(b, a));
    case 'pasajeros':
      return out.sort((a, b) => b.offer.passengers - a.offer.passengers || byPrice(a, b));
    default:
      return out.sort(byPrice);
  }
}

// ───────────────────────── Facetas ─────────────────────────

export interface FacetOption<T> {
  readonly value: T;
  readonly label: string;
  /** Autos que quedarían con esta opción, con el resto de los filtros puestos. */
  readonly count: number;
}

export interface ClassOption extends FacetOption<CarClass> {
  /** El más barato de la clase, con el resto de los filtros puestos. */
  readonly from?: Money;
}

export interface CarFacets {
  readonly currency?: string;
  /** Precio de venta mínimo y máximo, en la moneda de los resultados. */
  readonly price?: { readonly min: number; readonly max: number };
  readonly classes: readonly ClassOption[];
  readonly companies: readonly FacetOption<string>[];
  readonly transmissions: readonly FacetOption<Transmission>[];
  readonly seats: readonly FacetOption<number>[];
  readonly air: number;
  readonly unlimitedKm: number;
}

export function carFacets(cars: readonly ResultCar[], f: CarFilters): CarFacets {
  const currency = resultsCurrency(cars);
  const pool = (d: Dimension) => cars.filter((c) => matches(c, f, d));

  const priced = pool('price').map((c) => c.sale.amountMinor);
  const price =
    currency !== undefined && priced.length > 0
      ? { min: Math.min(...priced), max: Math.max(...priced) }
      : undefined;

  const classPool = pool('classes');
  const present = new Set(cars.map((c) => c.carClass));
  const classes: ClassOption[] = CAR_CLASSES.filter((c) => present.has(c)).map((value) => {
    const inClass = classPool.filter((c) => c.carClass === value);
    const cheapest = inClass.reduce<ResultCar | undefined>(
      (best, c) => (best === undefined || c.sale.amountMinor < best.sale.amountMinor ? c : best),
      undefined,
    );
    return {
      value,
      label: CAR_CLASS_LABELS[value],
      count: inClass.length,
      ...(cheapest && currency !== undefined ? { from: cheapest.sale } : {}),
    };
  });

  const companyPool = pool('companies');
  const companyNames = new Map<string, string>();
  for (const c of cars) {
    const code = c.offer.companyCode.toUpperCase();
    if (code && !companyNames.has(code)) companyNames.set(code, c.offer.companyName || code);
  }
  const companies = [...companyNames.entries()]
    .map(([value, label]) => ({
      value,
      label,
      count: companyPool.filter((c) => c.offer.companyCode.toUpperCase() === value).length,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));

  const transPool = pool('transmissions');
  const transmissions = TRANSMISSIONS.filter((t) => cars.some((c) => c.transmission === t)).map(
    (value) => ({
      value,
      label: TRANSMISSION_LABELS[value],
      count: transPool.filter((c) => c.transmission === value).length,
    }),
  );

  const seatPool = pool('seats');
  const seats = SEAT_OPTIONS.filter((n) => cars.some((c) => c.offer.passengers >= n)).map(
    (value) => ({
      value,
      label: `${value} o más pasajeros`,
      count: seatPool.filter((c) => c.offer.passengers >= value).length,
    }),
  );

  return {
    ...(currency !== undefined ? { currency } : {}),
    ...(price ? { price } : {}),
    classes,
    companies,
    transmissions,
    seats,
    air: pool('air').filter((c) => c.offer.air).length,
    unlimitedKm: pool('km').filter((c) => c.unlimitedKm).length,
  };
}

/** Cuántos filtros hay puestos (el tope de precio y las plazas cuentan como uno cada uno). */
export function activeFilterCount(f: CarFilters): number {
  return (
    (f.maxTotal === undefined ? 0 : 1) +
    f.classes.length +
    f.companies.length +
    f.transmissions.length +
    (f.minSeats === undefined ? 0 : 1) +
    (f.airOnly ? 1 : 0) +
    (f.unlimitedKmOnly ? 1 : 0)
  );
}

/** Un paso redondo del deslizador de precio, cercano a la centésima parte del rango. */
export function priceStep(range: { min: number; max: number }): number {
  const span = Math.max(0, range.max - range.min);
  if (span === 0) return 1;
  const raw = span / 100;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v >= raw) ?? 10 * magnitude;
  return Math.max(1, Math.round(nice));
}

/** El tope elegido en el deslizador. En su último paso no hay tope: no esconde el auto más caro. */
export function withMaxTotal(
  filters: CarFilters,
  amountMinor: number,
  facets: Pick<CarFacets, 'currency' | 'price'>,
): CarFilters {
  const { maxTotal: _drop, ...rest } = filters;
  if (facets.currency === undefined || facets.price === undefined) return rest;
  if (amountMinor > facets.price.max - priceStep(facets.price)) return rest;
  return {
    ...rest,
    maxTotal: {
      currency: facets.currency,
      amountMinor: Math.max(facets.price.min, Math.round(amountMinor)),
    },
  };
}

export function toggleIn<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

// ───────────────────────── Lo que está puesto, y cómo ampliar ─────────────────────────

export interface FilterChip {
  readonly id: string;
  readonly label: string;
  /** Los filtros sin este. */
  readonly without: CarFilters;
}

/** Cada filtro puesto, con cómo quitarlo: las pastillas encima de la lista. */
export function activeFilterChips(
  filters: CarFilters,
  facets: Pick<CarFacets, 'companies'>,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const { maxTotal, minSeats, ...rest } = filters;
  if (maxTotal !== undefined) {
    chips.push({
      id: 'precio',
      label: `Hasta ${formatMoney(maxTotal)}`,
      without: { ...rest, ...(minSeats === undefined ? {} : { minSeats }) },
    });
  }
  for (const c of filters.classes) {
    chips.push({
      id: `clase-${c}`,
      label: CAR_CLASS_LABELS[c],
      without: { ...filters, classes: filters.classes.filter((v) => v !== c) },
    });
  }
  for (const t of filters.transmissions) {
    chips.push({
      id: `transmision-${t}`,
      label: TRANSMISSION_LABELS[t],
      without: { ...filters, transmissions: filters.transmissions.filter((v) => v !== t) },
    });
  }
  if (minSeats !== undefined) {
    chips.push({
      id: 'plazas',
      label: `${minSeats}+ pasajeros`,
      without: { ...rest, ...(maxTotal === undefined ? {} : { maxTotal }) },
    });
  }
  for (const code of filters.companies) {
    chips.push({
      id: `arrendadora-${code}`,
      label: facets.companies.find((o) => o.value === code)?.label ?? code,
      without: { ...filters, companies: filters.companies.filter((v) => v !== code) },
    });
  }
  if (filters.airOnly) {
    chips.push({
      id: 'ac',
      label: 'Con aire acondicionado',
      without: { ...filters, airOnly: false },
    });
  }
  if (filters.unlimitedKmOnly) {
    chips.push({
      id: 'km',
      label: 'Kilometraje ilimitado',
      without: { ...filters, unlimitedKmOnly: false },
    });
  }
  return chips;
}

export interface Widening {
  readonly id: 'precio' | 'clase' | 'arrendadora' | 'transmision' | 'plazas' | 'ac' | 'km';
  readonly label: string;
  /** Autos que aparecerían. */
  readonly count: number;
  readonly next: CarFilters;
}

/**
 * Sin resultados por los filtros: qué quitar para ver autos, lo que más muestra primero. Cada
 * propuesta quita UNA dimensión entera; las que no muestran ninguno no se proponen.
 */
export function wideningSuggestions(cars: readonly ResultCar[], filters: CarFilters): Widening[] {
  const { maxTotal, minSeats, ...base } = filters;
  const candidates: Omit<Widening, 'count'>[] = [];
  if (maxTotal !== undefined) {
    candidates.push({
      id: 'precio',
      label: 'Quitar el tope de precio',
      next: { ...base, ...(minSeats === undefined ? {} : { minSeats }) },
    });
  }
  if (filters.classes.length > 0) {
    candidates.push({ id: 'clase', label: 'Cualquier clase', next: { ...filters, classes: [] } });
  }
  if (filters.companies.length > 0) {
    candidates.push({
      id: 'arrendadora',
      label: 'Todas las arrendadoras',
      next: { ...filters, companies: [] },
    });
  }
  if (filters.transmissions.length > 0) {
    candidates.push({
      id: 'transmision',
      label: 'Cualquier transmisión',
      next: { ...filters, transmissions: [] },
    });
  }
  if (minSeats !== undefined) {
    candidates.push({
      id: 'plazas',
      label: 'Cualquier capacidad',
      next: { ...base, ...(maxTotal === undefined ? {} : { maxTotal }) },
    });
  }
  if (filters.airOnly) {
    candidates.push({ id: 'ac', label: 'Incluir sin aire', next: { ...filters, airOnly: false } });
  }
  if (filters.unlimitedKmOnly) {
    candidates.push({
      id: 'km',
      label: 'Incluir kilometraje limitado',
      next: { ...filters, unlimitedKmOnly: false },
    });
  }
  return candidates
    .map((c) => ({ ...c, count: applyCarFilters(cars, c.next).length }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}
