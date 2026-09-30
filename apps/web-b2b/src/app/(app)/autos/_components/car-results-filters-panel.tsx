'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '../../../../lib/cn';
import { formatMinor } from './car-format';
import {
  activeFilterCount,
  priceStep,
  toggleIn,
  withMaxTotal,
  type CarFacets,
  type CarFilters,
} from './car-results-filters';

/*
 * El panel de filtros de los resultados de autos. Como en hoteles, el mismo contenido va a la
 * izquierda de la lista en pantallas anchas y en una hoja en el teléfono, y todo se aplica al
 * tocarlo: no hay botón de "aplicar" que olvidar.
 */

function Section({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1 border-t border-[var(--color-border)] pt-4 first:border-t-0 first:pt-0">
      <legend className="mb-2 text-xs font-semibold text-[var(--color-fg)]">{legend}</legend>
      {children}
    </fieldset>
  );
}

function ChoiceRow({
  type = 'checkbox',
  name,
  checked,
  count,
  onChange,
  children,
}: {
  type?: 'checkbox' | 'radio';
  name?: string;
  checked: boolean;
  count?: number;
  onChange: () => void;
  children: ReactNode;
}) {
  // Una opción que no dejaría ningún auto no se puede marcar, pero sí desmarcar: la que vino
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
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="size-4 shrink-0 accent-[var(--color-primary)]"
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count === undefined ? null : (
        <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
          <span className="sr-only">, </span>
          {count}
          <span className="sr-only">{count === 1 ? ' auto' : ' autos'}</span>
        </span>
      )}
    </label>
  );
}

export function CarFiltersPanel({
  facets,
  filters,
  onChange,
}: {
  facets: CarFacets;
  /** Los filtros que valen para estos resultados (`effectiveFilters`). */
  filters: CarFilters;
  onChange: (next: CarFilters) => void;
}) {
  const priceId = useId();
  const priceHintId = `${priceId}-hint`;
  const seatsName = useId();
  const { price, currency } = facets;
  const maxValue = filters.maxTotal?.amountMinor ?? price?.max ?? 0;
  const priceText = (amountMinor: number) =>
    currency === undefined ? String(amountMinor) : formatMinor(amountMinor, currency);
  const { minSeats: _seats, ...withoutSeats } = filters;

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
            Precio de venta por el alquiler completo, en {currency}.
          </p>
        </Section>
      ) : null}

      {facets.classes.length > 1 ? (
        <Section legend="Clase">
          {facets.classes.map((option) => (
            <ChoiceRow
              key={option.value}
              checked={filters.classes.includes(option.value)}
              count={option.count}
              onChange={() =>
                onChange({ ...filters, classes: toggleIn(filters.classes, option.value) })
              }
            >
              {option.label}
            </ChoiceRow>
          ))}
        </Section>
      ) : null}

      {facets.transmissions.length > 0 ? (
        <Section legend="Transmisión">
          {facets.transmissions.map((option) => (
            <ChoiceRow
              key={option.value}
              checked={filters.transmissions.includes(option.value)}
              count={option.count}
              onChange={() =>
                onChange({
                  ...filters,
                  transmissions: toggleIn(filters.transmissions, option.value),
                })
              }
            >
              {option.label}
            </ChoiceRow>
          ))}
        </Section>
      ) : null}

      {facets.seats.length > 0 ? (
        <Section legend="Pasajeros">
          <ChoiceRow
            type="radio"
            name={seatsName}
            checked={filters.minSeats === undefined}
            onChange={() => onChange(withoutSeats)}
          >
            Cualquier capacidad
          </ChoiceRow>
          {facets.seats.map((option) => (
            <ChoiceRow
              key={option.value}
              type="radio"
              name={seatsName}
              checked={filters.minSeats === option.value}
              count={option.count}
              onChange={() => onChange({ ...withoutSeats, minSeats: option.value })}
            >
              {option.label}
            </ChoiceRow>
          ))}
        </Section>
      ) : null}

      <Section legend="Incluye">
        <ChoiceRow
          checked={filters.unlimitedKmOnly}
          count={facets.unlimitedKm}
          onChange={() => onChange({ ...filters, unlimitedKmOnly: !filters.unlimitedKmOnly })}
        >
          Kilometraje ilimitado
        </ChoiceRow>
        <ChoiceRow
          checked={filters.airOnly}
          count={facets.air}
          onChange={() => onChange({ ...filters, airOnly: !filters.airOnly })}
        >
          Aire acondicionado
        </ChoiceRow>
      </Section>

      {facets.companies.length > 1 ? (
        <Section legend="Arrendadora">
          {facets.companies.map((option) => (
            <ChoiceRow
              key={option.value}
              checked={filters.companies.includes(option.value)}
              count={option.count}
              onChange={() =>
                onChange({ ...filters, companies: toggleIn(filters.companies, option.value) })
              }
            >
              {option.label}
            </ChoiceRow>
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
}: {
  filters: CarFilters;
  onClear: () => void;
}) {
  const count = activeFilterCount(filters);
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className="rounded-md px-1.5 py-1 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
    >
      Limpiar ({count})
    </button>
  );
}
