'use client';

import { SlidersHorizontal, X } from 'lucide-react';
import { cn } from '../../../../lib/cn';
import type { FlightGroup } from './flight-row';

/**
 * Filtros de resultados de vuelo.
 *
 * Hasta ahora la pantalla sólo tenía ORDEN: con veinte tarifas en pantalla no había
 * forma de decir "sin escalas" o "sólo Avianca", que es lo primero que hace un vendedor
 * con el cliente al teléfono. Se filtra en cliente sobre los resultados ya traídos: no
 * cuesta un round-trip al proveedor y el feedback es inmediato.
 */
export interface FlightFilterState {
  maxStops: number | null;
  carriers: string[];
  /** Franja de salida del primer tramo, en horas locales [desde, hasta). */
  departureWindow: [number, number] | null;
  maxPriceMinor: number | null;
}

export const EMPTY_FILTERS: FlightFilterState = {
  maxStops: null,
  carriers: [],
  departureWindow: null,
  maxPriceMinor: null,
};

const WINDOWS: { label: string; range: [number, number] }[] = [
  { label: 'Madrugada', range: [0, 6] },
  { label: 'Mañana', range: [6, 12] },
  { label: 'Tarde', range: [12, 18] },
  { label: 'Noche', range: [18, 24] },
];

/** Precio de venta si hay markup aplicado; si no, el neto. Igual criterio que la grilla. */
function priceOf(group: FlightGroup): number {
  const cheapest = group.offers[0];
  return cheapest?.pricing?.finalMinor ?? cheapest?.total.amountMinor ?? 0;
}

function stopsOf(group: FlightGroup): number {
  const it = group.offers[0]?.itineraries?.[0];
  return it?.stops ?? 0;
}

function carriersOf(group: FlightGroup): string[] {
  const it = group.offers[0]?.itineraries?.[0];
  return [...new Set((it?.segments ?? []).map((s) => s.carrier))];
}

function departureHourOf(group: FlightGroup): number | null {
  const dep = group.offers[0]?.itineraries?.[0]?.segments[0]?.departureAt;
  return dep ? new Date(dep).getHours() : null;
}

export function applyFlightFilters(groups: FlightGroup[], f: FlightFilterState): FlightGroup[] {
  return groups.filter((g) => {
    if (f.maxStops !== null && stopsOf(g) > f.maxStops) return false;
    if (f.carriers.length > 0 && !carriersOf(g).some((c) => f.carriers.includes(c))) return false;
    if (f.maxPriceMinor !== null && priceOf(g) > f.maxPriceMinor) return false;
    if (f.departureWindow) {
      const h = departureHourOf(g);
      if (h === null || h < f.departureWindow[0] || h >= f.departureWindow[1]) return false;
    }
    return true;
  });
}

/** Opciones disponibles derivadas de los resultados, para no ofrecer filtros vacíos. */
export function deriveFilterOptions(groups: FlightGroup[]): {
  carriers: string[];
  maxPriceMinor: number;
  currency: string;
} {
  const carriers = [...new Set(groups.flatMap(carriersOf))].sort();
  const prices = groups.map(priceOf);
  return {
    carriers,
    maxPriceMinor: prices.length > 0 ? Math.max(...prices) : 0,
    currency: groups[0]?.offers[0]?.total.currency ?? 'COP',
  };
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]',
      )}
    >
      {children}
    </button>
  );
}

export function FlightFilters({
  groups,
  value,
  onChange,
  formatMoney,
}: {
  groups: FlightGroup[];
  value: FlightFilterState;
  onChange: (next: FlightFilterState) => void;
  formatMoney: (minor: number, currency: string) => string;
}) {
  const { carriers, maxPriceMinor, currency } = deriveFilterOptions(groups);
  const isDirty =
    value.maxStops !== null ||
    value.carriers.length > 0 ||
    value.departureWindow !== null ||
    value.maxPriceMinor !== null;

  function toggleCarrier(code: string) {
    onChange({
      ...value,
      carriers: value.carriers.includes(code)
        ? value.carriers.filter((c) => c !== code)
        : [...value.carriers, code],
    });
  }

  return (
    <section
      aria-label="Filtros de resultados"
      className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
          <SlidersHorizontal className="size-3.5" />
          Filtros
        </h3>
        {isDirty ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            <X className="size-3" />
            Limpiar
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div>
          <p className="mb-1.5 text-xs text-[var(--color-fg-subtle)]">Escalas</p>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              active={value.maxStops === 0}
              onClick={() => onChange({ ...value, maxStops: value.maxStops === 0 ? null : 0 })}
            >
              Sin escalas
            </Chip>
            <Chip
              active={value.maxStops === 1}
              onClick={() => onChange({ ...value, maxStops: value.maxStops === 1 ? null : 1 })}
            >
              Hasta 1
            </Chip>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs text-[var(--color-fg-subtle)]">Salida</p>
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS.map((w) => {
              const active =
                value.departureWindow?.[0] === w.range[0] &&
                value.departureWindow[1] === w.range[1];
              return (
                <Chip
                  key={w.label}
                  active={active}
                  onClick={() => onChange({ ...value, departureWindow: active ? null : w.range })}
                >
                  {w.label}
                </Chip>
              );
            })}
          </div>
        </div>

        {carriers.length > 1 ? (
          <div>
            <p className="mb-1.5 text-xs text-[var(--color-fg-subtle)]">Aerolínea</p>
            <div className="flex flex-wrap gap-1.5">
              {carriers.map((c) => (
                <Chip key={c} active={value.carriers.includes(c)} onClick={() => toggleCarrier(c)}>
                  {c}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}

        {maxPriceMinor > 0 ? (
          <div className="min-w-[190px] flex-1">
            <label
              htmlFor="price-filter"
              className="mb-1.5 block text-xs text-[var(--color-fg-subtle)]"
            >
              Precio hasta{' '}
              <span className="font-semibold text-[var(--color-fg)]">
                {formatMoney(value.maxPriceMinor ?? maxPriceMinor, currency)}
              </span>
            </label>
            <input
              id="price-filter"
              type="range"
              min={0}
              max={maxPriceMinor}
              step={Math.max(1, Math.round(maxPriceMinor / 50))}
              value={value.maxPriceMinor ?? maxPriceMinor}
              onChange={(e) => {
                const v = Number(e.target.value);
                onChange({ ...value, maxPriceMinor: v >= maxPriceMinor ? null : v });
              }}
              className="w-full accent-[var(--color-primary)]"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
