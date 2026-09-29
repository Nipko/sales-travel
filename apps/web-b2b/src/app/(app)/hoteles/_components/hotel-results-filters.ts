import type { HotelOffer, HotelRoompack, Money } from '../actions';
import { boardLabel, formatMoney } from './hotel-format';
import { rateProviderLabel } from './hotel-provider-view';
import { hotelRateRows, type HotelRateRow } from './hotel-rate-view';
import { rateRefundability, type RateRefundability } from './rate-refundability';

/*
 * Filtros y orden de la pantalla de resultados de hoteles (propuesta aprobada del 2026-09-29), sin
 * React. Corren del lado del cliente sobre lo que ya se cargó: cambiar un filtro no vuelve a
 * preguntarle nada a ningún proveedor, así que es instantáneo y no gasta cupo.
 *
 * El estado vive en la URL (`?orden=precio-asc&estrellas=4,5&reembolsable=1`): sobrevive a recargar
 * y a volver atrás desde otra pestaña. No lleva datos del pasajero —la búsqueda misma no viaja por la
 * URL, la nacionalidad es un dato suyo—, sólo cómo se miran los resultados.
 */

export type BoardCode = HotelRoompack['board'];
const BOARD_CODES: readonly BoardCode[] = ['RO', 'BB', 'HB', 'FB', 'AI'];

export type ResultsSort = 'recomendados' | 'precio-asc' | 'precio-desc' | 'estrellas';
export const RESULTS_SORTS: readonly { value: ResultsSort; label: string }[] = [
  { value: 'recomendados', label: 'Recomendados' },
  { value: 'precio-asc', label: 'Menor precio' },
  { value: 'precio-desc', label: 'Mayor precio' },
  { value: 'estrellas', label: 'Más estrellas' },
];

export type ResultsView = 'lista' | 'mapa';

export interface ResultsFilters {
  /** Precio de VENTA máximo por la estadía completa, en la moneda de la búsqueda. */
  readonly maxTotal?: Money;
  /** Categorías aceptadas, 1 a 5; 0 es "sin categoría". Vacío: todas. */
  readonly stars: readonly number[];
  /** Regímenes aceptados. Vacío: todos. */
  readonly boards: readonly BoardCode[];
  readonly refundableOnly: boolean;
  /** Proveedores aceptados, por código. Sólo con la divulgación encendida. Vacío: todos. */
  readonly providers: readonly string[];
}

export interface ResultsState {
  readonly filters: ResultsFilters;
  readonly sort: ResultsSort;
  readonly view: ResultsView;
}

export const NO_FILTERS: ResultsFilters = Object.freeze({
  stars: [],
  boards: [],
  refundableOnly: false,
  providers: [],
});

export const DEFAULT_RESULTS_STATE: ResultsState = Object.freeze({
  filters: NO_FILTERS,
  sort: 'recomendados',
  view: 'lista',
});

// ───────────────────────── La URL ─────────────────────────

const PARAMS = {
  sort: 'orden',
  view: 'vista',
  maxTotal: 'precioMax',
  stars: 'estrellas',
  boards: 'regimen',
  refundable: 'reembolsable',
  providers: 'proveedor',
} as const;

const MAX_TOTAL_RE = /^([A-Z]{3})-(\d{1,15})$/;
const PROVIDER_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
export function parseResultsQuery(search: string): ResultsState {
  const params = new URLSearchParams(search);
  const sortRaw = params.get(PARAMS.sort);
  const sort = RESULTS_SORTS.some((s) => s.value === sortRaw)
    ? (sortRaw as ResultsSort)
    : 'recomendados';
  const view: ResultsView = params.get(PARAMS.view) === 'mapa' ? 'mapa' : 'lista';

  const max = MAX_TOTAL_RE.exec(params.get(PARAMS.maxTotal) ?? '');
  const maxAmount = max ? Number(max[2]) : Number.NaN;
  const stars = listParam(params, PARAMS.stars)
    .filter((v) => /^[0-5]$/.test(v))
    .map(Number)
    .sort((a, b) => b - a);
  const boards = listParam(params, PARAMS.boards).filter((v): v is BoardCode =>
    BOARD_CODES.includes(v as BoardCode),
  );
  const providers = listParam(params, PARAMS.providers)
    .filter((v) => v.length <= 40 && PROVIDER_CODE_RE.test(v))
    .slice(0, 8);

  return {
    sort,
    view,
    filters: {
      ...(max && Number.isSafeInteger(maxAmount)
        ? { maxTotal: { currency: max[1] ?? '', amountMinor: maxAmount } }
        : {}),
      stars,
      boards,
      refundableOnly: params.get(PARAMS.refundable) === '1',
      providers,
    },
  };
}

/**
 * La URL con el estado de los resultados, sin tocar los demás parámetros (`?moneda=` de la
 * búsqueda, `?cliente=` del CRM). Lo que está en su valor por defecto no se escribe.
 */
export function queryWithResults(search: string, state: ResultsState): string {
  const params = new URLSearchParams(search);
  const set = (name: string, value: string | undefined) => {
    if (value === undefined || value === '') params.delete(name);
    else params.set(name, value);
  };
  const f = state.filters;
  set(PARAMS.sort, state.sort === 'recomendados' ? undefined : state.sort);
  set(PARAMS.view, state.view === 'lista' ? undefined : state.view);
  set(
    PARAMS.maxTotal,
    f.maxTotal ? `${f.maxTotal.currency}-${Math.max(0, Math.round(f.maxTotal.amountMinor))}` : '',
  );
  set(PARAMS.stars, [...f.stars].sort((a, b) => b - a).join(','));
  set(PARAMS.boards, f.boards.join(','));
  set(PARAMS.refundable, f.refundableOnly ? '1' : undefined);
  set(PARAMS.providers, f.providers.join(','));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

// ───────────────────────── El modelo ─────────────────────────

/** Una tarifa de un hotel con lo que los filtros necesitan saber de ella. */
export interface ResultRate {
  readonly row: HotelRateRow;
  readonly refund: RateRefundability;
  readonly board: BoardCode;
  /** Código del proveedor de ESTA tarifa, si lo dice. */
  readonly provider?: string;
}

/** Un hotel de los resultados, con sus tarifas de la más barata a la más cara. */
export interface ResultHotel {
  /** Su lugar en la respuesta del API: el orden "Recomendados". */
  readonly index: number;
  /** Única en la lista: dos proveedores pueden devolver el mismo id de hotel. */
  readonly key: string;
  readonly offer: HotelOffer;
  /** 1 a 5, o 0 si no tiene categoría. */
  readonly stars: number;
  readonly rates: readonly ResultRate[];
}

export function starsOf(offer: Pick<HotelOffer, 'stars'>): number {
  const stars = offer.stars;
  if (stars === undefined || !Number.isFinite(stars) || stars <= 0) return 0;
  return Math.min(5, Math.max(1, Math.round(stars)));
}

/**
 * Los hoteles de una búsqueda listos para filtrar. `nowMs` es la hora de la respuesta: decide si
 * la penalidad del 100 % de una tarifa reembolsable ya rige (rate-refundability).
 */
export function resultHotelsOf(
  offers: readonly HotelOffer[],
  showProvider: boolean,
  nowMs: number | undefined,
): ResultHotel[] {
  return offers.map((offer, index) => ({
    index,
    key: `${index}:${offer.hotelId}`,
    offer,
    stars: starsOf(offer),
    rates: hotelRateRows(offer, showProvider).map((row) => ({
      row,
      refund: rateRefundability(row.pack, nowMs),
      board: row.pack.board,
      ...(row.pack.provider?.name ? { provider: row.pack.provider.name } : {}),
    })),
  }));
}

// ───────────────────────── Filtrar ─────────────────────────

/**
 * Los filtros que valen para ESTOS resultados: un tope de precio en otra moneda (de una búsqueda
 * anterior) no se aplica, y sin divulgación no se filtra por proveedor, que ni siquiera se muestra.
 */
export function effectiveFilters(
  filters: ResultsFilters,
  currency: string | undefined,
  disclosed: boolean,
): ResultsFilters {
  const { maxTotal, ...rest } = filters;
  return {
    ...rest,
    ...(maxTotal !== undefined && currency !== undefined && maxTotal.currency === currency
      ? { maxTotal }
      : {}),
    providers: disclosed ? filters.providers : [],
  };
}

export function rateMatches(rate: ResultRate, f: ResultsFilters): boolean {
  if (f.refundableOnly && !rate.refund.refundable) return false;
  if (f.boards.length > 0 && !f.boards.includes(rate.board)) return false;
  if (
    f.providers.length > 0 &&
    (rate.provider === undefined || !f.providers.includes(rate.provider))
  )
    return false;
  if (f.maxTotal !== undefined) {
    const sale = rate.row.sale;
    if (sale.currency !== f.maxTotal.currency || sale.amountMinor > f.maxTotal.amountMinor) {
      return false;
    }
  }
  return true;
}

/** Un hotel que pasa los filtros, con SUS tarifas que los cumplen. */
export interface FilteredHotel {
  readonly hotel: ResultHotel;
  /** Las tarifas que cumplen los filtros, de la más barata a la más cara. */
  readonly rates: readonly ResultRate[];
  /** Las que no los cumplen: la tarjeta lo dice para que nadie crea que no existen. */
  readonly hiddenRates: number;
}

function filterHotel(hotel: ResultHotel, f: ResultsFilters): FilteredHotel | undefined {
  if (f.stars.length > 0 && !f.stars.includes(hotel.stars)) return undefined;
  const rates = hotel.rates.filter((r) => rateMatches(r, f));
  if (rates.length === 0) return undefined;
  return { hotel, rates, hiddenRates: hotel.rates.length - rates.length };
}

/** Los hoteles que tienen al menos una tarifa que cumple todos los filtros, en el orden recibido. */
export function applyResultsFilters(
  hotels: readonly ResultHotel[],
  filters: ResultsFilters,
): FilteredHotel[] {
  return hotels.flatMap((h) => filterHotel(h, filters) ?? []);
}

// ───────────────────────── Ordenar ─────────────────────────

function cheapest(item: FilteredHotel): number {
  return item.rates[0]?.row.sale.amountMinor ?? Number.POSITIVE_INFINITY;
}

/**
 * El orden de la lista. Por precio manda la tarifa más barata que cumple los filtros, vencida o
 * no: que una tarjeta salte de lugar cuando vence una tarifa desordenaría lo que el vendedor está
 * mirando, y el aviso de vencimiento ya pide buscar de nuevo. Ante un empate, el orden recibido.
 */
export function sortResults(items: readonly FilteredHotel[], sort: ResultsSort): FilteredHotel[] {
  const byIndex = (a: FilteredHotel, b: FilteredHotel) => a.hotel.index - b.hotel.index;
  const sorted = [...items];
  switch (sort) {
    case 'precio-asc':
      return sorted.sort((a, b) => cheapest(a) - cheapest(b) || byIndex(a, b));
    case 'precio-desc':
      return sorted.sort((a, b) => cheapest(b) - cheapest(a) || byIndex(a, b));
    case 'estrellas':
      return sorted.sort(
        (a, b) => b.hotel.stars - a.hotel.stars || cheapest(a) - cheapest(b) || byIndex(a, b),
      );
    case 'recomendados':
      return sorted.sort(byIndex);
  }
}

// ───────────────────────── Las opciones del panel ─────────────────────────

export interface FacetOption<T> {
  readonly value: T;
  readonly label: string;
  /** Hoteles que quedarían con esta opción, sumada a los demás filtros. */
  readonly count: number;
}

export interface ResultsFacets {
  /** La moneda de los precios de estos resultados. */
  readonly currency?: string;
  /** El rango de precios de VENTA por la estadía, sobre todas las tarifas. */
  readonly price?: { readonly min: number; readonly max: number };
  readonly stars: readonly FacetOption<number>[];
  readonly boards: readonly FacetOption<BoardCode>[];
  /** Vacío con la divulgación apagada: el panel no muestra la sección. */
  readonly providers: readonly FacetOption<string>[];
  /** Hoteles que quedarían con "Solo reembolsables", sumado a los demás filtros. */
  readonly refundable: number;
}

export function starsLabel(stars: number): string {
  if (stars === 0) return 'Sin categoría';
  return `${stars} estrella${stars === 1 ? '' : 's'}`;
}

/** La moneda de los resultados: la de la primera tarifa (la búsqueda es en una sola moneda). */
export function resultsCurrency(hotels: readonly ResultHotel[]): string | undefined {
  for (const h of hotels) {
    const rate = h.rates[0];
    if (rate !== undefined) return rate.row.sale.currency;
  }
  return undefined;
}

function countWith(hotels: readonly ResultHotel[], filters: ResultsFilters): number {
  let n = 0;
  for (const h of hotels) if (filterHotel(h, filters) !== undefined) n += 1;
  return n;
}

/**
 * Qué ofrece el panel: las opciones que aparecen en estos resultados y, aunque no aparezcan, las
 * que están elegidas —si no, un filtro de la URL que no encaja quedaría sin casilla para quitarlo—.
 * Cada una con cuántos hoteles quedarían si se elige, respetando los demás filtros.
 */
export function resultsFacets(
  hotels: readonly ResultHotel[],
  filters: ResultsFilters,
  disclosed: boolean,
): ResultsFacets {
  const currency = resultsCurrency(hotels);
  const f = effectiveFilters(filters, currency, disclosed);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const starValues = new Set<number>(f.stars);
  const boardValues = new Set<BoardCode>(f.boards);
  const providerLabels = new Map<string, string>();
  for (const h of hotels) {
    starValues.add(h.stars);
    for (const r of h.rates) {
      if (r.row.sale.currency === currency) {
        min = Math.min(min, r.row.sale.amountMinor);
        max = Math.max(max, r.row.sale.amountMinor);
      }
      boardValues.add(r.board);
      if (disclosed && r.provider !== undefined && !providerLabels.has(r.provider)) {
        const label = rateProviderLabel(r.row.pack, true);
        if (label !== undefined) providerLabels.set(r.provider, label);
      }
    }
  }
  for (const code of f.providers) if (!providerLabels.has(code)) providerLabels.set(code, code);

  return {
    ...(currency === undefined ? {} : { currency }),
    ...(Number.isFinite(min) && Number.isFinite(max) ? { price: { min, max } } : {}),
    stars: [...starValues]
      .sort((a, b) => b - a)
      .map((value) => ({
        value,
        label: starsLabel(value),
        count: countWith(hotels, { ...f, stars: [value] }),
      })),
    boards: BOARD_CODES.filter((b) => boardValues.has(b)).map((value) => ({
      value,
      label: boardLabel(value),
      count: countWith(hotels, { ...f, boards: [value] }),
    })),
    providers: disclosed
      ? [...providerLabels]
          .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([value, label]) => ({
            value,
            label,
            count: countWith(hotels, { ...f, providers: [value] }),
          }))
      : [],
    refundable: countWith(hotels, { ...f, refundableOnly: true }),
  };
}

/** Cuántos filtros hay puestos (el tope de precio cuenta como uno). */
export function activeFilterCount(f: ResultsFilters): number {
  return (
    (f.maxTotal === undefined ? 0 : 1) +
    f.stars.length +
    f.boards.length +
    (f.refundableOnly ? 1 : 0) +
    f.providers.length
  );
}

/**
 * Un paso del deslizador de precio: un número redondo cercano a la centésima parte del rango, para
 * que el vendedor no tenga que apuntar a 1.234.567.
 */
export function priceStep(range: { min: number; max: number }): number {
  const span = Math.max(0, range.max - range.min);
  if (span === 0) return 1;
  const raw = span / 100;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v >= raw) ?? 10 * magnitude;
  return Math.max(1, Math.round(nice));
}

/**
 * El tope elegido en el deslizador. En su último paso no hay tope: si el rango no es múltiplo del
 * paso, el deslizador no llega exactamente al máximo, y un tope ahí escondería el hotel más caro.
 */
export function withMaxTotal(
  filters: ResultsFilters,
  amountMinor: number,
  facets: Pick<ResultsFacets, 'currency' | 'price'>,
): ResultsFilters {
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
  readonly without: ResultsFilters;
}

/** Cada filtro puesto, con cómo quitarlo: las pastillas encima de la lista. */
export function activeFilterChips(
  filters: ResultsFilters,
  facets: Pick<ResultsFacets, 'providers'>,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const { maxTotal, ...rest } = filters;
  if (maxTotal !== undefined) {
    chips.push({ id: 'precio', label: `Hasta ${formatMoney(maxTotal)}`, without: rest });
  }
  if (filters.refundableOnly) {
    chips.push({
      id: 'reembolsable',
      label: 'Solo reembolsables',
      without: { ...filters, refundableOnly: false },
    });
  }
  for (const s of filters.stars) {
    chips.push({
      id: `estrellas-${s}`,
      label: starsLabel(s),
      without: { ...filters, stars: filters.stars.filter((v) => v !== s) },
    });
  }
  for (const b of filters.boards) {
    chips.push({
      id: `regimen-${b}`,
      label: boardLabel(b),
      without: { ...filters, boards: filters.boards.filter((v) => v !== b) },
    });
  }
  for (const p of filters.providers) {
    chips.push({
      id: `proveedor-${p}`,
      label: facets.providers.find((o) => o.value === p)?.label ?? p,
      without: { ...filters, providers: filters.providers.filter((v) => v !== p) },
    });
  }
  return chips;
}

export interface Widening {
  readonly id: 'precio' | 'estrellas' | 'regimen' | 'reembolsable' | 'proveedor';
  readonly label: string;
  /** Hoteles que aparecerían. */
  readonly count: number;
  readonly next: ResultsFilters;
}

/**
 * Sin resultados por los filtros: qué quitar para ver hoteles, lo que más muestra primero. Cada
 * propuesta quita UNA dimensión entera y dice cuántos hoteles aparecerían; las que no muestran
 * ninguno no se proponen.
 */
export function wideningSuggestions(
  hotels: readonly ResultHotel[],
  filters: ResultsFilters,
): Widening[] {
  const { maxTotal, ...withoutMax } = filters;
  const candidates: Omit<Widening, 'count'>[] = [];
  if (maxTotal !== undefined) {
    candidates.push({ id: 'precio', label: 'Quitar el tope de precio', next: withoutMax });
  }
  if (filters.stars.length > 0) {
    candidates.push({
      id: 'estrellas',
      label: 'Cualquier categoría',
      next: { ...filters, stars: [] },
    });
  }
  if (filters.boards.length > 0) {
    candidates.push({
      id: 'regimen',
      label: 'Cualquier régimen',
      next: { ...filters, boards: [] },
    });
  }
  if (filters.refundableOnly) {
    candidates.push({
      id: 'reembolsable',
      label: 'Incluir no reembolsables',
      next: { ...filters, refundableOnly: false },
    });
  }
  if (filters.providers.length > 0) {
    candidates.push({
      id: 'proveedor',
      label: 'Todos los proveedores',
      next: { ...filters, providers: [] },
    });
  }
  return candidates
    .map((c) => ({ ...c, count: countWith(hotels, c.next) }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}
