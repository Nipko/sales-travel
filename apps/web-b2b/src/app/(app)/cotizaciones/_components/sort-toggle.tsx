'use client';

import { cn } from '../../../../lib/cn';

export type SortKey = 'price' | 'duration' | 'departure' | 'best';

const OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'price', label: 'Precio' },
  { key: 'duration', label: 'Duración' },
  { key: 'departure', label: 'Salida' },
  { key: 'best', label: 'Mejor' },
];

interface SortToggleProps {
  value: SortKey;
  onChange: (key: SortKey) => void;
}

export function SortToggle({ value, onChange }: SortToggleProps) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150',
            value === opt.key
              ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
              : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
