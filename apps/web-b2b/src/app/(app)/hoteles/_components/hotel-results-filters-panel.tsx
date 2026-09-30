'use client';

import { ShieldAlert, Star, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useModalBehavior } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';
import { formatMoney } from './hotel-format';
import {
  activeFilterCount,
  priceStep,
  toggleIn,
  withMaxTotal,
  type FacetOption,
  type ResultsFacets,
  type ResultsFilters,
} from './hotel-results-filters';

/*
 * El panel de filtros de los resultados. El mismo contenido va a la izquierda de la lista en
 * pantallas anchas y en una hoja desde abajo en el teléfono. Todo se aplica al tocarlo: no hay
 * botón de "aplicar" que olvidar.
 */

const LEGEND = 'text-xs font-semibold text-[var(--color-fg)]';

function Section({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2 border-t border-[var(--color-border)] pt-4 first:border-t-0 first:pt-0">
      <legend className={cn(LEGEND, 'mb-2')}>{legend}</legend>
      {children}
    </fieldset>
  );
}

function CheckRow({
  checked,
  count,
  onChange,
  children,
}: {
  checked: boolean;
  count: number;
  onChange: () => void;
  children: ReactNode;
}) {
  // Una opción que no dejaría ningún hotel no se puede marcar, pero sí desmarcar: la que vino
  // marcada desde la URL tiene que poder quitarse.
  const disabled = !checked && count === 0;
  return (
    <label
      className={cn(
        'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-1 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)]',
        disabled && 'cursor-not-allowed text-[var(--color-fg-subtle)] hover:bg-transparent',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="size-4 shrink-0 accent-[var(--color-primary)]"
      />
      <span className="flex min-w-0 flex-1 items-center gap-1">{children}</span>
      <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
        {count}
        <span className="sr-only"> hoteles</span>
      </span>
    </label>
  );
}

function StarsLabel({ option }: { option: FacetOption<number> }) {
  if (option.value === 0) return <>{option.label}</>;
  return (
    <>
      <span aria-hidden="true" className="flex items-center gap-0.5 text-[var(--color-accent)]">
        {Array.from({ length: option.value }, (_, i) => (
          <Star key={i} className="size-3.5 fill-current" />
        ))}
      </span>
      <span className="sr-only">{option.label}</span>
    </>
  );
}

export function ResultsFiltersPanel({
  facets,
  filters,
  onChange,
}: {
  facets: ResultsFacets;
  /** Los filtros que valen para estos resultados (`effectiveFilters`). */
  filters: ResultsFilters;
  onChange: (next: ResultsFilters) => void;
}) {
  const priceId = useId();
  const priceHintId = `${priceId}-hint`;
  const price = facets.price;
  const currency = facets.currency;
  const maxValue = filters.maxTotal?.amountMinor ?? price?.max ?? 0;
  const priceText = (amountMinor: number) =>
    currency === undefined ? String(amountMinor) : formatMoney({ amountMinor, currency });

  return (
    <div className="space-y-4">
      {price && currency && price.max > price.min ? (
        <Section legend="Precio total máximo">
          <label htmlFor={priceId} className="sr-only">
            Precio total máximo
          </label>
          <p
            className="text-sm font-semibold tabular-nums text-[var(--color-fg)]"
            aria-hidden="true"
          >
            {filters.maxTotal ? `Hasta ${priceText(maxValue)}` : 'Sin tope'}
          </p>
          <input
            id={priceId}
            type="range"
            min={price.min}
            max={price.max}
            step={priceStep(price)}
            value={Math.min(price.max, Math.max(price.min, maxValue))}
            aria-describedby={priceHintId}
            aria-valuetext={filters.maxTotal ? `Hasta ${priceText(maxValue)}` : 'Sin tope'}
            onChange={(e) => onChange(withMaxTotal(filters, Number(e.target.value), facets))}
            className="w-full accent-[var(--color-primary)]"
          />
          <div className="flex justify-between text-[11px] tabular-nums text-[var(--color-fg-muted)]">
            <span>{priceText(price.min)}</span>
            <span>{priceText(price.max)}</span>
          </div>
          <p id={priceHintId} className="text-[11px] text-[var(--color-fg-muted)]">
            Precio de venta por la estadía completa, en {currency}.
          </p>
        </Section>
      ) : null}

      <Section legend="Cancelación">
        <CheckRow
          checked={filters.refundableOnly}
          count={facets.refundable}
          onChange={() => onChange({ ...filters, refundableOnly: !filters.refundableOnly })}
        >
          Solo reembolsables
        </CheckRow>
        <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
          <ShieldAlert aria-hidden="true" className="mt-px size-3 shrink-0" />
          Deja afuera las no reembolsables y las que ya cobran el 100 % si se cancelan.
        </p>
      </Section>

      {facets.stars.length > 0 ? (
        <Section legend="Estrellas">
          {facets.stars.map((option) => (
            <CheckRow
              key={option.value}
              checked={filters.stars.includes(option.value)}
              count={option.count}
              onChange={() =>
                onChange({ ...filters, stars: toggleIn(filters.stars, option.value) })
              }
            >
              <StarsLabel option={option} />
            </CheckRow>
          ))}
        </Section>
      ) : null}

      {facets.boards.length > 0 ? (
        <Section legend="Régimen">
          {facets.boards.map((option) => (
            <CheckRow
              key={option.value}
              checked={filters.boards.includes(option.value)}
              count={option.count}
              onChange={() =>
                onChange({ ...filters, boards: toggleIn(filters.boards, option.value) })
              }
            >
              {option.label}
            </CheckRow>
          ))}
        </Section>
      ) : null}

      {facets.providers.length > 0 ? (
        <Section legend="Proveedor">
          {facets.providers.map((option) => (
            <CheckRow
              key={option.value}
              checked={filters.providers.includes(option.value)}
              count={option.count}
              onChange={() =>
                onChange({ ...filters, providers: toggleIn(filters.providers, option.value) })
              }
            >
              {option.label}
            </CheckRow>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

/** "Limpiar (3)": sólo si hay algo puesto. */
export function ClearFiltersButton({
  filters,
  onClear,
  className,
}: {
  filters: ResultsFilters;
  onClear: () => void;
  className?: string;
}) {
  const count = activeFilterCount(filters);
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className={cn(
        'rounded-md px-1.5 py-1 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
        className,
      )}
    >
      Limpiar ({count})
    </button>
  );
}

/**
 * Los filtros en el teléfono: una hoja que sube desde abajo, con el foco atrapado, Escape para
 * cerrar y el botón de abajo que dice cuántos hoteles quedan.
 */
export function FiltersSheet({
  open,
  onClose,
  resultCount,
  headerAction,
  children,
}: {
  open: boolean;
  onClose: () => void;
  resultCount: number;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useModalBehavior(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] animate-fade-in-up flex-col rounded-t-xl border-t border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
            Filtros
          </h2>
          <div className="flex items-center gap-1">
            {headerAction}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar filtros"
              className="inline-flex size-9 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {children}
        </div>
        <div className="border-t border-[var(--color-border)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2"
          >
            {resultCount === 0
              ? 'Ningún hotel con estos filtros'
              : `Ver ${resultCount} hotel${resultCount === 1 ? '' : 'es'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
