'use client';

import { useState, type KeyboardEvent } from 'react';
import { cn } from '../../../../../../lib/cn';
import { monthLabel, type TrendSeries } from '../../../../../../lib/platform-overview';
import { formatMinor } from '../../../../../../lib/wallets';

const SHORT_MONTH = new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' });

function shortMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return SHORT_MONTH.format(new Date(Date.UTC(y, m - 1, 1)));
}

function confirmedText(n: number): string {
  return n === 1 ? '1 confirmada' : `${n} confirmadas`;
}

/**
 * Lo confirmado mes a mes en una moneda, los últimos 12 meses: una barra por mes, el mes que se lee
 * en el color de la marca y el resto en gris. Se recorre con el puntero o con las flechas (es un
 * deslizador sobre los meses) y la lectura va escrita arriba; la tabla oculta da todos los meses a un
 * lector de pantalla. Una sola serie: el título la nombra, no hace falta leyenda.
 */
export function TrendStrip({ series }: { series: TrendSeries }) {
  const last = series.points.length - 1;
  const [active, setActive] = useState(last);
  const point = series.points[active] ?? series.points[last];
  if (point === undefined) return null;

  const max = Math.max(0, ...series.points.map((p) => p.amountMinor));
  const money = (minor: number) => formatMinor(minor, series.currency, series.exponent);
  const readout = `${monthLabel(point.month)}: ${money(point.amountMinor)} · ${confirmedText(point.count)}`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? active - 1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? active + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(Math.min(last, Math.max(0, next)));
  }

  const first = series.points[0];

  return (
    <figure className="mt-4 border-t border-[var(--color-border)] pt-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[11px]">
        <span className="text-[var(--color-fg-muted)]">Últimos 12 meses</span>
        <span className="tabular-nums text-[var(--color-fg)]">{readout}</span>
      </figcaption>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`Ventas confirmadas por mes en ${series.currency}`}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={active}
        aria-valuetext={readout}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setActive(last)}
        className="mt-2 flex h-12 cursor-default items-end gap-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
      >
        {series.points.map((p, i) => (
          <div
            key={p.month}
            onPointerEnter={() => setActive(i)}
            className="flex h-full flex-1 items-end justify-center"
          >
            <span
              aria-hidden="true"
              className={cn(
                'block w-full max-w-6 rounded-t-[4px] transition-colors',
                p.amountMinor === 0
                  ? 'bg-[var(--color-border-strong)]'
                  : i === active
                    ? 'bg-[var(--color-primary)]'
                    : 'bg-[var(--color-fg-subtle)]/45',
              )}
              style={{
                height:
                  p.amountMinor === 0 || max === 0
                    ? '2px'
                    : `max(3px, ${Math.round((p.amountMinor / max) * 100)}%)`,
              }}
            />
          </div>
        ))}
      </div>
      {first !== undefined ? (
        <div
          aria-hidden="true"
          className="mt-1 flex justify-between text-[10px] text-[var(--color-fg-muted)]"
        >
          <span>{shortMonth(first.month)}</span>
          <span>{shortMonth(series.points[last]?.month ?? first.month)}</span>
        </div>
      ) : null}
      {/* `sr-only` va en un contenedor: una tabla no respeta el ancho de 1 px y desbordaría la página. */}
      <div className="sr-only">
        <table>
          <caption>Ventas confirmadas por mes en {series.currency}</caption>
          <thead>
            <tr>
              <th scope="col">Mes</th>
              <th scope="col">Reservas confirmadas</th>
              <th scope="col">Monto</th>
            </tr>
          </thead>
          <tbody>
            {series.points.map((p) => (
              <tr key={p.month}>
                <th scope="row">{monthLabel(p.month)}</th>
                <td>{p.count}</td>
                <td>{money(p.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
