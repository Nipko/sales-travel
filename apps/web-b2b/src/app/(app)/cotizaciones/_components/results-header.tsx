'use client';

import { SortToggle, type SortKey } from './sort-toggle';

interface ResultsHeaderProps {
  count: number;
  sort: SortKey;
  onSortChange: (key: SortKey) => void;
}

export function ResultsHeader({ count, sort, onSortChange }: ResultsHeaderProps) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-[var(--color-fg)]">
        <span className="font-semibold tabular-nums">{count}</span>{' '}
        {count === 1 ? 'vuelo encontrado' : 'vuelos encontrados'}
      </p>
      <SortToggle value={sort} onChange={onSortChange} />
    </div>
  );
}
