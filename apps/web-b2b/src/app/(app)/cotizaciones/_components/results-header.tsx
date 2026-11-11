'use client';

import { cn } from '../../../../lib/cn';
import type { SortKey } from './sort-toggle';

/** Lo que cada orden pone primero: su precio y, si aplica, un dato que lo explica. */
export interface SortHighlight {
  readonly price: string;
  readonly detail?: string;
}

export type SortHighlights = Partial<Record<'best' | 'price' | 'duration', SortHighlight>>;

const CARDS: readonly { key: 'best' | 'price' | 'duration'; label: string }[] = [
  { key: 'best', label: 'Recomendado' },
  { key: 'price', label: 'Más barato' },
  { key: 'duration', label: 'Más rápido' },
];

interface ResultsHeaderProps {
  count: number;
  sort: SortKey;
  onSortChange: (key: SortKey) => void;
  highlights: SortHighlights;
}

/**
 * El orden como lo muestran los sitios de venta: tres tarjetas con el precio del primero de cada
 * orden. Al vendedor le dice de un vistazo cuánto cuesta ir más rápido, sin cambiar de orden.
 * «Por salida» queda como texto: se usa poco y no tiene un precio que mostrar.
 */
export function ResultsHeader({ count, sort, onSortChange, highlights }: ResultsHeaderProps) {
  return (
    <div className="mb-4 space-y-3">
      <div role="radiogroup" aria-label="Ordenar vuelos" className="grid grid-cols-3 gap-2">
        {CARDS.map((card) => {
          const highlight = highlights[card.key];
          const active = sort === card.key;
          return (
            <button
              key={card.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSortChange(card.key)}
              className={cn(
                'min-w-0 rounded-xl border bg-[var(--color-surface)] px-3 py-2.5 text-left transition-colors',
                active
                  ? 'border-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
              )}
            >
              <span
                className={cn(
                  'block truncate text-xs font-medium',
                  active ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
                )}
              >
                {card.label}
                {highlight?.detail ? (
                  <span className="hidden font-normal sm:inline"> · {highlight.detail}</span>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-sm font-semibold tabular-nums text-[var(--color-fg)] sm:text-base">
                {highlight?.price ?? '—'}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-[var(--color-fg)]">
          <span className="font-semibold tabular-nums">{count}</span>{' '}
          {count === 1 ? 'vuelo encontrado' : 'vuelos encontrados'}
        </p>
        <button
          type="button"
          aria-pressed={sort === 'departure'}
          onClick={() => onSortChange(sort === 'departure' ? 'best' : 'departure')}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            sort === 'departure'
              ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
              : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
          )}
        >
          Por hora de salida
        </button>
      </div>
    </div>
  );
}
