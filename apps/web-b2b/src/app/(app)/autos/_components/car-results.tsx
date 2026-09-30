'use client';

import { SearchX, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Select } from '../../../../components/ui/field';
import { FiltersAside } from '../../../../components/ui/filters-aside';
import { FiltersSheet } from '../../../../components/ui/filters-sheet';
import { cn } from '../../../../lib/cn';
import type { CarOffer } from '../actions';
import { formatMoney } from './car-format';
import { CarResultCard } from './car-result-card';
import {
  CAR_SORTS,
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
  resultsCurrency,
  sortCars,
  toggleIn,
  wideningSuggestions,
  type CarFilters,
  type CarResultsState,
  type CarSort,
  type ClassOption,
} from './car-results-filters';
import { ClearFiltersButton, CarFiltersPanel } from './car-results-filters-panel';
import { daysLabel } from './car-search-model';

/*
 * Los resultados de una búsqueda de autos, con el esquema de hoteles: filtros a la izquierda en
 * pantallas anchas y en una hoja en el teléfono, orden, y las tarjetas con foto. Arriba, las clases
 * con su precio "desde": la primera pregunta del cliente es "¿cuánto sale un económico y cuánto una
 * SUV?". Filtros y orden corren sobre lo ya cargado, sin volver a buscar, y quedan en la URL.
 */

/** Espera antes de escribir la URL: Safari corta más de 100 `replaceState` en 30 s. */
const URL_WRITE_DELAY_MS = 300;

const TOOLBAR_BUTTON =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40';

function useResultsState(): [
  CarResultsState,
  (update: (prev: CarResultsState) => CarResultsState) => void,
] {
  const [state, setState] = useState<CarResultsState>(DEFAULT_RESULTS_STATE);
  const loaded = useRef(false);

  useEffect(() => {
    setState(parseResultsQuery(window.location.search));
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const id = window.setTimeout(() => {
      const { pathname, search, hash } = window.location;
      const query = queryWithResults(search, state);
      if (query === search || (query === '' && search === '')) return;
      try {
        // `null`: el router de Next conserva su propio estado.
        window.history.replaceState(null, '', `${pathname}${query}${hash}`);
      } catch {
        // El navegador limitó los cambios de URL: los filtros siguen andando, sólo no se recuerdan.
      }
    }, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [state]);

  const update = useCallback((fn: (prev: CarResultsState) => CarResultsState) => setState(fn), []);
  return [state, update];
}

export function CarResults({
  offers,
  days,
  searching,
  selectingKey,
  onSelect,
  headingId: headingIdProp,
}: {
  offers: readonly CarOffer[];
  /** Días de alquiler de la búsqueda. */
  days: number;
  searching: boolean;
  /** La tarjeta cuya tarifa se está abriendo. */
  selectingKey?: string | undefined;
  onSelect: (offer: CarOffer, key: string) => void;
  /** El id del título de los resultados: la página le pasa el foco al llegar una búsqueda. */
  headingId?: string;
}) {
  const [state, update] = useResultsState();
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const sortId = useId();
  const ownHeadingId = useId();
  const headingId = headingIdProp ?? ownHeadingId;

  const cars = useMemo(() => resultCarsOf(offers), [offers]);
  const currency = resultsCurrency(cars);
  const filters = useMemo(
    () => effectiveFilters(state.filters, currency),
    [state.filters, currency],
  );
  const sorted = useMemo(
    () => sortCars(applyCarFilters(cars, filters), state.sort),
    [cars, filters, state.sort],
  );
  const facets = useMemo(() => carFacets(cars, filters), [cars, filters]);
  const chips = activeFilterChips(filters, facets);

  const setFilters = useCallback(
    (next: CarFilters) => update((prev) => ({ ...prev, filters: next })),
    [update],
  );
  const clearFilters = useCallback(() => setFilters(NO_FILTERS), [setFilters]);
  const filterCount = activeFilterCount(filters);
  const total = cars.length;
  const shown = sorted.length;

  const panel = <CarFiltersPanel facets={facets} filters={filters} onChange={setFilters} />;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={searching}
      className={cn('transition-opacity', searching && 'opacity-60')}
    >
      <div className="xl:grid xl:grid-cols-[15rem_minmax(0,1fr)] xl:items-start xl:gap-6">
        <FiltersAside
          headerAction={<ClearFiltersButton filters={filters} onClear={clearFilters} />}
        >
          {panel}
        </FiltersAside>

        <div className="min-w-0 space-y-3">
          {/* Una sola fila en pantallas anchas (título a la izquierda, orden a la derecha); en el
              teléfono, Filtros y orden arriba y el título debajo. Es un único título: la página le
              pasa el foco al llegar una búsqueda. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <h2
              id={headingId}
              tabIndex={-1}
              className="order-last w-full text-sm font-normal text-[var(--color-fg-muted)] focus:outline-none sm:order-none sm:w-auto sm:min-w-0 sm:flex-1"
            >
              <span className="font-semibold text-[var(--color-fg)]">
                {shown === total ? total : `${shown} de ${total}`} auto{total === 1 ? '' : 's'}
              </span>{' '}
              · precios de venta por {daysLabel(days)}
              {currency ? ` en ${currency}` : ''}
            </h2>

            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              className={cn(TOOLBAR_BUTTON, 'shrink-0 px-2.5 xl:hidden')}
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              Filtros
              {filterCount > 0 ? (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--color-primary)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--color-primary-fg)]">
                  <span className="sr-only">, </span>
                  {filterCount}
                  <span className="sr-only"> puestos</span>
                </span>
              ) : null}
            </button>

            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
              <label
                htmlFor={sortId}
                className="sr-only text-xs text-[var(--color-fg-muted)] sm:not-sr-only sm:whitespace-nowrap"
              >
                Ordenar por
              </label>
              <Select
                id={sortId}
                value={state.sort}
                onChange={(e) => update((prev) => ({ ...prev, sort: e.target.value as CarSort }))}
                className="h-9 w-full min-w-0 pl-2.5 pr-7 text-sm shadow-[var(--shadow-xs)] sm:w-auto"
              >
                {CAR_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {facets.classes.length > 1 ? (
            <ClassStrip
              options={facets.classes}
              selected={filters.classes}
              onToggle={(c) => setFilters({ ...filters, classes: toggleIn(filters.classes, c) })}
            />
          ) : null}

          {/* Al tocar un filtro el título cambia, pero un título no se anuncia: esta región sí. */}
          <p aria-live="polite" aria-atomic="true" className="sr-only">
            {shown === total
              ? `${total} auto${total === 1 ? '' : 's'}`
              : `${shown} de ${total} autos con estos filtros`}
          </p>

          {chips.length > 0 ? (
            <ul aria-label="Filtros puestos" className="flex flex-wrap items-center gap-1.5">
              {chips.map((chip) => (
                <li key={chip.id}>
                  <button
                    type="button"
                    onClick={() => setFilters(chip.without)}
                    className="inline-flex h-8 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-2.5 pr-1.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                  >
                    <span className="sr-only">Quitar filtro: </span>
                    {chip.label}
                    <X aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
                  </button>
                </li>
              ))}
              <li>
                <ClearFiltersButton filters={filters} onClear={clearFilters} />
              </li>
            </ul>
          ) : null}

          {shown === 0 ? (
            <FilteredEmpty
              total={total}
              suggestions={wideningSuggestions(cars, filters)}
              onApply={setFilters}
              onClear={clearFilters}
            />
          ) : (
            <div className="space-y-3">
              {sorted.map((item) => (
                <CarResultCard
                  key={item.key}
                  item={item}
                  days={days}
                  selecting={selectingKey === item.key}
                  disabled={selectingKey !== undefined || searching}
                  onSelect={() => onSelect(item.offer, item.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <FiltersSheet
        open={sheetOpen}
        onClose={closeSheet}
        submitLabel={
          shown === 0
            ? 'Ningún auto con estos filtros'
            : `Ver ${shown} auto${shown === 1 ? '' : 's'}`
        }
        headerAction={<ClearFiltersButton filters={filters} onClear={clearFilters} />}
      >
        {panel}
      </FiltersSheet>
    </section>
  );
}

/** Las clases con su precio "desde": se tocan para filtrar, como en el panel. */
function ClassStrip({
  options,
  selected,
  onToggle,
}: {
  options: readonly ClassOption[];
  selected: readonly ClassOption['value'][];
  onToggle: (value: ClassOption['value']) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Clases de auto"
      // `relative`: los `sr-only` de las clases que no entran en el teléfono quedaban a la derecha,
      // fuera de la fila, y hacían que toda la página se corriera de lado sobre un hueco en blanco.
      className="relative -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
    >
      {options.map((option) => {
        const active = selected.includes(option.value);
        const empty = option.count === 0 && !active;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={empty}
            onClick={() => onToggle(option.value)}
            className={cn(
              'flex min-w-[7.5rem] shrink-0 snap-start flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
              active
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8 shadow-[var(--shadow-xs)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
              empty && 'cursor-not-allowed opacity-50',
            )}
          >
            <span className="text-xs font-semibold text-[var(--color-fg)]">{option.label}</span>
            <span className="text-[11px] tabular-nums text-[var(--color-fg-muted)]">
              {option.from ? `desde ${formatMoney(option.from)}` : 'sin autos'}
              <span className="sr-only">
                , {option.count} {option.count === 1 ? 'auto' : 'autos'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Ningún auto cumple todos los filtros: cuántos hay y qué quitar para verlos. */
function FilteredEmpty({
  total,
  suggestions,
  onApply,
  onClear,
}: {
  total: number;
  suggestions: ReturnType<typeof wideningSuggestions>;
  onApply: (next: CarFilters) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-8 text-center"
    >
      <SearchX aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
      <p className="text-sm font-medium text-[var(--color-fg)]">
        Ningún auto cumple todos los filtros.
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
        La búsqueda trajo {total} auto{total === 1 ? '' : 's'}. Amplía los filtros para verlos:
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onApply(s.next)}
            className={TOOLBAR_BUTTON}
          >
            {s.label}
            <span className="text-xs font-normal tabular-nums text-[var(--color-fg-muted)]">
              ({s.count})
            </span>
          </button>
        ))}
        <button type="button" onClick={onClear} className={TOOLBAR_BUTTON}>
          Quitar todos los filtros
        </button>
      </div>
    </div>
  );
}
