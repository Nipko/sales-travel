'use client';

import { Ban, List, MapPinned, SearchX, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Select } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import type { HotelOffer, HotelSearchCriteriaView } from '../actions';
import { HotelResultCard } from './hotel-result-card';
import {
  ClearFiltersButton,
  FiltersSheet,
  ResultsFiltersPanel,
} from './hotel-results-filters-panel';
import {
  DEFAULT_RESULTS_STATE,
  NO_FILTERS,
  RESULTS_SORTS,
  activeFilterChips,
  activeFilterCount,
  applyResultsFilters,
  effectiveFilters,
  parseResultsQuery,
  queryWithResults,
  resultHotelsOf,
  resultsCurrency,
  resultsFacets,
  sortResults,
  wideningSuggestions,
  type FilteredHotel,
  type ResultHotel,
  type ResultsFilters,
  type ResultsSort,
  type ResultsState,
  type ResultsView,
} from './hotel-results-filters';
import { HotelResultsMap } from './hotel-results-map';
import { detailLinkForOffer } from './hotel-search-handoff';
import { OfferExpiry } from './offer-expiry';
import { useHotelPhotos } from './use-hotel-photos';

/*
 * Los resultados de una búsqueda de hoteles (propuesta aprobada del 2026-09-29): filtros a la
 * izquierda en pantallas anchas y en una hoja en el teléfono, orden, lista o ubicación, y las
 * tarjetas con foto. Filtros y orden corren sobre lo ya cargado, sin volver a buscar, y quedan en
 * la URL.
 */

/** Espera antes de escribir la URL: Safari corta más de 100 `replaceState` en 30 s. */
const URL_WRITE_DELAY_MS = 300;

const TOOLBAR_BUTTON =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40';

/** El estado de los resultados, leído de la URL al montar y escrito en ella al cambiar. */
function useResultsState(): [ResultsState, (update: (prev: ResultsState) => ResultsState) => void] {
  const [state, setState] = useState<ResultsState>(DEFAULT_RESULTS_STATE);
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
        // `null`, como el selector de moneda: el router de Next conserva su propio estado.
        window.history.replaceState(null, '', `${pathname}${query}${hash}`);
      } catch {
        // El navegador limitó los cambios de URL: los filtros siguen andando, sólo no se recuerdan.
      }
    }, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [state]);

  const update = useCallback((fn: (prev: ResultsState) => ResultsState) => setState(fn), []);
  return [state, update];
}

interface HotelResultsProps {
  hotels: readonly HotelOffer[];
  showProvider: boolean;
  criteria?: HotelSearchCriteriaView;
  /** Hora del servidor de la respuesta: decide si el 100 % de una tarifa ya rige. */
  receivedAt?: number;
  clockOffsetMs: number;
  /** El identificador de ESTA búsqueda para los detalles que se abran desde ella. */
  searchToken?: string;
  searching: boolean;
  onSearchAgain: () => void;
  /** El id del título de los resultados: la página le pasa el foco al llegar una búsqueda. */
  headingId?: string;
  /** Quien financia a la agencia le bloqueó las no reembolsables (0055). */
  nonRefundableBlocked?: boolean;
}

export function HotelResults({
  hotels,
  showProvider,
  criteria,
  receivedAt,
  clockOffsetMs,
  searchToken,
  searching,
  onSearchAgain,
  headingId: headingIdProp,
  nonRefundableBlocked = false,
}: HotelResultsProps) {
  const [state, update] = useResultsState();
  const [expiredCutoffMs, setExpiredCutoffMs] = useState<number | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const sortId = useId();
  const ownHeadingId = useId();
  const headingId = headingIdProp ?? ownHeadingId;

  const results: ResultHotel[] = useMemo(
    () => resultHotelsOf(hotels, showProvider, receivedAt),
    [hotels, showProvider, receivedAt],
  );
  const currency = resultsCurrency(results);
  const filters = useMemo(
    () => effectiveFilters(state.filters, currency, showProvider),
    [state.filters, currency, showProvider],
  );
  const sorted: FilteredHotel[] = useMemo(
    () => sortResults(applyResultsFilters(results, filters), state.sort),
    [results, filters, state.sort],
  );
  const facets = useMemo(
    () => resultsFacets(results, filters, showProvider),
    [results, filters, showProvider],
  );
  const chips = activeFilterChips(filters, facets);
  const order = useMemo(() => sorted.map((i) => i.hotel.key), [sorted]);
  const photos = useHotelPhotos(results, order);

  const setFilters = useCallback(
    (next: ResultsFilters) => update((prev) => ({ ...prev, filters: next })),
    [update],
  );
  const clearFilters = useCallback(() => setFilters(NO_FILTERS), [setFilters]);
  const filterCount = activeFilterCount(filters);
  const total = results.length;
  const shown = sorted.length;

  const panel = <ResultsFiltersPanel facets={facets} filters={filters} onChange={setFilters} />;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={searching}
      className={cn('transition-opacity', searching && 'opacity-60')}
    >
      <div className="xl:grid xl:grid-cols-[15rem_minmax(0,1fr)] xl:items-start xl:gap-6">
        <aside
          aria-label="Filtros"
          className="hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] xl:sticky xl:top-4 xl:block xl:max-h-[calc(100dvh-7rem)] xl:overflow-y-auto"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Filtros</h2>
            <ClearFiltersButton filters={filters} onClear={clearFilters} />
          </div>
          {panel}
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-1.5 sm:gap-2">
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
                // El espacio antes del número: sin él, el nombre accesible queda "Filtros1 puestos".
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--color-primary)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--color-primary-fg)]">
                  <span className="sr-only">, </span>
                  {filterCount}
                  <span className="sr-only"> puestos</span>
                </span>
              ) : null}
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
              <label
                htmlFor={sortId}
                className="sr-only text-xs text-[var(--color-fg-muted)] sm:not-sr-only sm:whitespace-nowrap"
              >
                Ordenar por
              </label>
              <Select
                id={sortId}
                value={state.sort}
                onChange={(e) =>
                  update((prev) => ({ ...prev, sort: e.target.value as ResultsSort }))
                }
                className="h-9 w-full min-w-0 pl-2.5 pr-7 text-sm shadow-[var(--shadow-xs)] sm:w-auto"
              >
                {RESULTS_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>

            <ViewToggle
              value={state.view}
              onChange={(view) => update((prev) => ({ ...prev, view }))}
            />
          </div>

          <OfferExpiry
            hotels={hotels}
            clockOffsetMs={clockOffsetMs}
            onCutoffChange={setExpiredCutoffMs}
            onSearchAgain={onSearchAgain}
            searching={searching}
          >
            <h2 id={headingId} tabIndex={-1} className="font-normal focus:outline-none">
              <span className="font-semibold text-[var(--color-fg)]">
                {shown === total ? total : `${shown} de ${total}`} hotel{total === 1 ? '' : 'es'}
              </span>{' '}
              con disponibilidad · precios de venta
              {criteria?.currency ? ` en ${criteria.currency}` : ''}
            </h2>
          </OfferExpiry>

          {nonRefundableBlocked ? (
            <p className="flex items-start gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg)]">
              <Ban
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
              />
              <span>
                Tu agencia no puede reservar tarifas no reembolsables: quien la financia las
                bloqueó. Se muestran marcadas como no disponibles; filtra por{' '}
                <span className="font-medium">Solo reembolsables</span> para ver sólo las que puedes
                vender.
              </span>
            </p>
          ) : null}

          {/* Al tocar un filtro el título cambia, pero un título no se anuncia: esta región sí.
              Montada desde el principio y con el mismo texto, no dice nada hasta que cambia. */}
          <p aria-live="polite" aria-atomic="true" className="sr-only">
            {shown === total
              ? `${total} hotel${total === 1 ? '' : 'es'}`
              : `${shown} de ${total} hoteles con estos filtros`}
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
              suggestions={wideningSuggestions(results, filters)}
              onApply={setFilters}
              onClear={clearFilters}
            />
          ) : state.view === 'mapa' ? (
            <HotelResultsMap items={sorted} photos={photos} nights={criteria?.nights} />
          ) : (
            <div className="space-y-3">
              {sorted.map((item) => (
                <HotelResultCard
                  key={item.hotel.key}
                  item={item}
                  photo={photos.get(item.hotel.key)}
                  nights={criteria?.nights}
                  rooms={criteria?.rooms}
                  expiredCutoffMs={expiredCutoffMs}
                  detailHref={
                    searchToken === undefined
                      ? undefined
                      : detailLinkForOffer(item.hotel.offer, searchToken)
                  }
                  nonRefundableBlocked={nonRefundableBlocked}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <FiltersSheet
        open={sheetOpen}
        onClose={closeSheet}
        resultCount={shown}
        headerAction={<ClearFiltersButton filters={filters} onClear={clearFilters} />}
      >
        {panel}
      </FiltersSheet>
    </section>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ResultsView;
  onChange: (view: ResultsView) => void;
}) {
  const options: { value: ResultsView; label: string; Icon: typeof List }[] = [
    { value: 'lista', label: 'Lista', Icon: List },
    { value: 'mapa', label: 'Mapa', Icon: MapPinned },
  ];
  return (
    <div
      role="group"
      aria-label="Cómo ver los resultados"
      className="inline-flex h-9 shrink-0 items-center rounded-lg sm:ml-auto border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 shadow-[var(--shadow-xs)]"
    >
      {options.map(({ value: v, label, Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'inline-flex h-full items-center gap-1.5 rounded-md px-2 text-sm font-medium sm:px-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
            value === v
              ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
              : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          <span className="sr-only sm:not-sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Ningún hotel cumple todos los filtros: cuántos hay y qué quitar para verlos. */
function FilteredEmpty({
  total,
  suggestions,
  onApply,
  onClear,
}: {
  total: number;
  suggestions: ReturnType<typeof wideningSuggestions>;
  onApply: (next: ResultsFilters) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-8 text-center"
    >
      <SearchX aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
      <p className="text-sm font-medium text-[var(--color-fg)]">
        Ningún hotel cumple todos los filtros.
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
        La búsqueda trajo {total} hotel{total === 1 ? '' : 'es'}. Amplía los filtros para verlos:
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
