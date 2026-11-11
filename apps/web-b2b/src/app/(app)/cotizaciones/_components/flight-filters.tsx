'use client';

import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { airlineName } from './airline-names';
import {
  activeFilterCount,
  deriveFilterOptions,
  EMPTY_FILTERS,
  HOUR_WINDOWS,
  toggleWindow,
  type FlightFilterState,
  type OptionStat,
} from './flight-filter-model';
import type { FlightGroup } from './flight-row';

export { applyFlightFilters, EMPTY_FILTERS, type FlightFilterState } from './flight-filter-model';

interface FlightFiltersProps {
  groups: FlightGroup[];
  value: FlightFilterState;
  onChange: (next: FlightFilterState) => void;
  formatMoney: (minor: number, currency: string) => string;
  formatDuration: (minutes: number) => string;
  /** El tramo que muestra la lista (paso de ida y vuelta); sin él, todos. */
  leg?: number;
  /** Nombre de cada tramo visible para los horarios: «Tramo 1», «Ida»… */
  slotLabel?: (slot: number) => string;
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group border-b border-[var(--color-border)] py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-[var(--color-fg-subtle)] transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-2.5 space-y-1.5">{children}</div>
    </details>
  );
}

/** Una opción con casilla, su conteo y su precio desde. Sin vuelos, queda tenue pero marcable. */
function CheckRow({
  checked,
  onChange,
  label,
  stat,
  type = 'checkbox',
  name,
  formatPrice,
}: {
  checked: boolean;
  onChange: () => void;
  label: React.ReactNode;
  stat?: OptionStat;
  type?: 'checkbox' | 'radio';
  name?: string;
  formatPrice: (minor: number) => string;
}) {
  const empty = stat !== undefined && stat.count === 0;
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-sm hover:bg-[var(--color-surface-muted)]',
        empty && !checked && 'opacity-55',
      )}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        className="size-4 shrink-0 accent-[var(--color-primary)]"
      />
      <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">{label}</span>
      {stat ? (
        <span className="shrink-0 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
          {stat.minPriceMinor !== null && stat.count > 0 ? formatPrice(stat.minPriceMinor) : ''}
          <span className="ml-1.5 text-[var(--color-fg-subtle)]">{stat.count}</span>
        </span>
      ) : null}
    </label>
  );
}

function WindowChips({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: readonly [number, number] | null | undefined;
  onToggle: (range: readonly [number, number]) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs text-[var(--color-fg-muted)]">{label}</p>
      <div className="grid grid-cols-4 gap-1">
        {HOUR_WINDOWS.map((w) => {
          const active = value?.[0] === w.range[0] && value[1] === w.range[1];
          return (
            <button
              key={w.label}
              type="button"
              aria-pressed={active}
              title={`${w.label}: ${String(w.range[0]).padStart(2, '0')}:00 a ${String(w.range[1]).padStart(2, '0')}:00`}
              onClick={() => onToggle(w.range)}
              className={cn(
                'rounded-md border px-1 py-1 text-[11px] font-medium leading-tight transition-colors',
                active
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]',
              )}
            >
              {w.label}
              <span className="block tabular-nums opacity-80">
                {w.range[0]}–{w.range[1]}h
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * El panel de filtros: columna izquierda en escritorio, hoja inferior en el teléfono. Todo se
 * calcula en el navegador sobre lo ya traído: filtrar nunca llama al proveedor.
 */
export function FlightFilters({
  groups,
  value,
  onChange,
  formatMoney,
  formatDuration,
  leg,
  slotLabel = (slot) => `Tramo ${String(slot + 1)}`,
}: FlightFiltersProps) {
  const options = deriveFilterOptions(groups, value, leg);
  const price = (minor: number) => formatMoney(minor, options.currency);
  const radioName = useId();
  const dirty = activeFilterCount(value) > 0;

  function toggleCarrier(code: string) {
    onChange({
      ...value,
      carriers: value.carriers.includes(code)
        ? value.carriers.filter((c) => c !== code)
        : [...value.carriers, code],
    });
  }

  function toggleAirport(code: string) {
    onChange({
      ...value,
      excludedAirports: value.excludedAirports.includes(code)
        ? value.excludedAirports.filter((c) => c !== code)
        : [...value.excludedAirports, code],
    });
  }

  const durationStep = 30;
  const durationMax = options.duration
    ? Math.ceil(options.duration.max / durationStep) * durationStep
    : 0;
  const durationMin = options.duration
    ? Math.floor(options.duration.min / durationStep) * durationStep
    : 0;

  return (
    <section aria-label="Filtros de resultados" className="text-sm">
      <div className="flex items-center justify-between pb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
          <SlidersHorizontal className="size-4 text-[var(--color-fg-subtle)]" aria-hidden="true" />
          Filtros
        </h2>
        {dirty ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            <X className="size-3" aria-hidden="true" />
            Limpiar
          </button>
        ) : null}
      </div>

      <Section title="Escalas">
        <CheckRow
          type="radio"
          name={radioName}
          checked={value.maxStops === null}
          onChange={() => onChange({ ...value, maxStops: null })}
          label="Cualquiera"
          formatPrice={price}
        />
        <CheckRow
          type="radio"
          name={radioName}
          checked={value.maxStops === 0}
          onChange={() => onChange({ ...value, maxStops: 0 })}
          label="Directo"
          stat={options.stops.direct}
          formatPrice={price}
        />
        <CheckRow
          type="radio"
          name={radioName}
          checked={value.maxStops === 1}
          onChange={() => onChange({ ...value, maxStops: 1 })}
          label="Hasta 1 escala"
          stat={options.stops.upToOne}
          formatPrice={price}
        />
      </Section>

      {options.carriers.length > 1 ? (
        <Section title="Aerolíneas">
          {options.carriers.map((c) => (
            <CheckRow
              key={c.code}
              checked={value.carriers.includes(c.code)}
              onChange={() => toggleCarrier(c.code)}
              label={airlineName(c.code)}
              stat={c}
              formatPrice={price}
            />
          ))}
        </Section>
      ) : null}

      <Section title="Equipaje">
        <CheckRow
          checked={value.baggage.carryOn}
          onChange={() =>
            onChange({ ...value, baggage: { ...value.baggage, carryOn: !value.baggage.carryOn } })
          }
          label="Equipaje de mano"
          stat={options.baggage.carryOn}
          formatPrice={price}
        />
        <CheckRow
          checked={value.baggage.checked}
          onChange={() =>
            onChange({ ...value, baggage: { ...value.baggage, checked: !value.baggage.checked } })
          }
          label="Maleta facturada"
          stat={options.baggage.checked}
          formatPrice={price}
        />
      </Section>

      <Section title="Horarios">
        <div className="space-y-3">
          {Array.from({ length: options.legSlots }, (_, slot) => (
            <div key={slot} className="space-y-1.5">
              {options.legSlots > 1 ? (
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg)]">
                  {slotLabel(slot)}
                </p>
              ) : null}
              <WindowChips
                label="Salida"
                value={value.departure[slot]}
                onToggle={(range) =>
                  onChange({ ...value, departure: toggleWindow(value.departure, slot, range) })
                }
              />
              <WindowChips
                label="Llegada"
                value={value.arrival[slot]}
                onToggle={(range) =>
                  onChange({ ...value, arrival: toggleWindow(value.arrival, slot, range) })
                }
              />
            </div>
          ))}
        </div>
      </Section>

      {options.duration && durationMax > durationMin ? (
        <Section title="Duración" defaultOpen={false}>
          <label
            htmlFor={`${radioName}-dur`}
            className="block text-xs text-[var(--color-fg-muted)]"
          >
            Hasta{' '}
            <span className="font-semibold tabular-nums text-[var(--color-fg)]">
              {formatDuration(value.maxDurationMinutes ?? durationMax)}
            </span>
          </label>
          <input
            id={`${radioName}-dur`}
            type="range"
            min={durationMin}
            max={durationMax}
            step={durationStep}
            value={value.maxDurationMinutes ?? durationMax}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChange({ ...value, maxDurationMinutes: v >= durationMax ? null : v });
            }}
            className="w-full accent-[var(--color-primary)]"
          />
        </Section>
      ) : null}

      {options.airports.length > 0 ? (
        <Section title="Aeropuertos">
          {options.airports.map((a) => (
            <CheckRow
              key={a.code}
              checked={!value.excludedAirports.includes(a.code)}
              onChange={() => toggleAirport(a.code)}
              label={<span className="font-mono">{a.code}</span>}
              stat={a}
              formatPrice={price}
            />
          ))}
        </Section>
      ) : null}

      {options.maxPriceMinor > 0 ? (
        <Section title="Precio" defaultOpen={false}>
          <label
            htmlFor={`${radioName}-price`}
            className="block text-xs text-[var(--color-fg-muted)]"
          >
            Hasta{' '}
            <span className="font-semibold tabular-nums text-[var(--color-fg)]">
              {price(value.maxPriceMinor ?? options.maxPriceMinor)}
            </span>
          </label>
          <input
            id={`${radioName}-price`}
            type="range"
            min={0}
            max={options.maxPriceMinor}
            step={Math.max(1, Math.round(options.maxPriceMinor / 50))}
            value={value.maxPriceMinor ?? options.maxPriceMinor}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChange({ ...value, maxPriceMinor: v >= options.maxPriceMinor ? null : v });
            }}
            className="w-full accent-[var(--color-primary)]"
          />
        </Section>
      ) : null}
    </section>
  );
}

/**
 * En el teléfono: un botón «Filtros (n)» que abre el mismo panel como hoja inferior. El panel es
 * un diálogo de verdad (`role=dialog`, Escape cierra) y el fondo no se desplaza mientras está.
 */
export function MobileFilters({
  count,
  resultCount,
  children,
}: {
  count: number;
  resultCount: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-fg)] hover:border-[var(--color-border-strong)]"
      >
        <SlidersHorizontal className="size-4" aria-hidden="true" />
        Filtros
        {count > 0 ? (
          <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-xs font-bold text-[var(--color-primary-fg)]">
            {count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <p id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
                Filtros
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar filtros"
                className="flex size-8 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="overflow-y-auto px-4">{children}</div>
            <div className="border-t border-[var(--color-border)] p-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-11 w-full rounded-lg bg-[var(--color-primary)] text-sm font-semibold text-[var(--color-primary-fg)]"
              >
                Ver {resultCount} {resultCount === 1 ? 'vuelo' : 'vuelos'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
