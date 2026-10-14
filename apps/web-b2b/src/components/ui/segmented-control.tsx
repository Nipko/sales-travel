'use client';

import { useId } from 'react';
import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Un contador al lado de la etiqueta (lo que espera en esa opción). */
  readonly count?: number;
}

/**
 * Un grupo de radios con aspecto de control segmentado: se recorre con las flechas, como cualquier
 * grupo de radios, y la opción marcada se lee sin depender del color.
 *
 * `countLabel` es lo que un lector de pantalla oye después del contador ("3 por aprobar").
 */
export function SegmentedControl<T extends string>({
  legend,
  options,
  value,
  onChange,
  countLabel,
}: {
  legend: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  countLabel?: string;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-[var(--color-primary)]',
                checked
                  ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
              {option.count !== undefined ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                    option.count > 0
                      ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                      : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
                  )}
                >
                  {option.count}
                  {countLabel !== undefined ? <span className="sr-only"> {countLabel}</span> : null}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
