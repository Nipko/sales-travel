'use client';

import { Info } from 'lucide-react';
import { cn } from '../../../../lib/cn';
import type { PriceCalendarDay } from '../actions';

const WEEKDAY = new Intl.DateTimeFormat('es-CO', { weekday: 'short', timeZone: 'UTC' });
const DAY_MONTH = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

function parts(date: string): { weekday: string; dayMonth: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return { weekday: WEEKDAY.format(d).replace('.', ''), dayMonth: DAY_MONTH.format(d) };
}

/**
 * Los días a mostrar: los del calendario, con el día buscado pisado por el precio REAL de esta
 * búsqueda (no un estimado), y sin precio en los días ya pasados.
 */
export function calendarCells(
  days: readonly PriceCalendarDay[],
  selected: string,
  currentMinPriceMinor: number | null,
  today: string,
): { date: string; price: number | null; past: boolean; selected: boolean; cheapest: boolean }[] {
  const cells = days.map((day) => {
    const isSelected = day.date === selected;
    return {
      date: day.date,
      price: isSelected ? (currentMinPriceMinor ?? day.minPriceMinor) : day.minPriceMinor,
      past: day.date < today,
      selected: isSelected,
    };
  });
  const priced = cells.filter((c) => c.price !== null && !c.past).map((c) => c.price!);
  const min = priced.length > 1 ? Math.min(...priced) : null;
  return cells.map((c) => ({ ...c, cheapest: min !== null && c.price === min }));
}

/**
 * Calendario de precios ±3 días (docs/platform/18): los precios de los días vecinos salen de lo
 * que la agencia ya buscó en los últimos 3 días, sin llamar al proveedor. Elegir un día lanza la
 * búsqueda real de esa fecha.
 */
export function PriceCalendar({
  days,
  selected,
  currentMinPriceMinor,
  currency,
  today,
  formatMoney,
  onPick,
}: {
  days: readonly PriceCalendarDay[];
  selected: string;
  currentMinPriceMinor: number | null;
  currency: string;
  today: string;
  formatMoney: (minor: number, currency: string) => string;
  onPick: (date: string) => void;
}) {
  if (days.length === 0) return null;
  const cells = calendarCells(days, selected, currentMinPriceMinor, today);

  return (
    <section aria-label="Precios por fecha de salida" className="mb-4">
      <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        {cells.map((cell, index) => {
          const { weekday, dayMonth } = parts(cell.date);
          return (
            <button
              key={cell.date}
              type="button"
              disabled={cell.past}
              aria-current={cell.selected ? 'date' : undefined}
              onClick={() => (cell.selected ? undefined : onPick(cell.date))}
              className={cn(
                'flex min-w-0 flex-col items-center gap-0.5 px-1 py-2 text-center transition-colors',
                index > 0 && 'border-l border-[var(--color-border)]',
                cell.selected
                  ? 'bg-[var(--color-primary)]/10 ring-2 ring-inset ring-[var(--color-primary)]'
                  : 'hover:bg-[var(--color-surface-muted)]',
                cell.past && 'cursor-not-allowed opacity-40',
              )}
            >
              <span className="text-[11px] font-medium capitalize text-[var(--color-fg-muted)]">
                {weekday} <span className="hidden sm:inline">{dayMonth}</span>
              </span>
              <span
                className={cn(
                  'w-full truncate text-xs tabular-nums sm:text-sm',
                  cell.selected ? 'font-bold text-[var(--color-fg)]' : 'font-semibold',
                  cell.price === null && 'font-normal text-[var(--color-fg-subtle)]',
                  cell.cheapest &&
                    !cell.selected &&
                    'text-[var(--color-success-fg,var(--color-fg))]',
                )}
              >
                {cell.past ? '—' : cell.price === null ? 'Ver' : formatMoney(cell.price, currency)}
              </span>
              {cell.cheapest ? (
                <span className="rounded-full bg-[var(--color-success)]/15 px-1.5 text-[10px] font-semibold text-[var(--color-fg)]">
                  Más barato
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
        <Info className="size-3.5 shrink-0" aria-hidden="true" />
        Precios estimados de búsquedas de tu agencia en los últimos 3 días. Elige un día para ver el
        precio actual.
      </p>
    </section>
  );
}
