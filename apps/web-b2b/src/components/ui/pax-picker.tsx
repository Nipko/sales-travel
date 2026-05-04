'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Minus, Plus, Users } from 'lucide-react';
import { useState } from 'react';

interface PaxCounts {
  adults: number;
  children: number;
  infants: number;
}

interface PaxPickerProps {
  defaultValue?: PaxCounts;
}

const MIN = { adults: 1, children: 0, infants: 0 };
const MAX = { adults: 9, children: 9, infants: 9 };

export function PaxPicker({ defaultValue }: PaxPickerProps) {
  const [pax, setPax] = useState<PaxCounts>(defaultValue ?? { adults: 1, children: 0, infants: 0 });

  const total = pax.adults + pax.children + pax.infants;
  const summary = total === 1 ? '1 pasajero' : `${total} pasajeros`;

  function update(key: keyof PaxCounts, delta: 1 | -1) {
    setPax((p) => {
      const next = { ...p, [key]: Math.max(MIN[key], Math.min(MAX[key], p[key] + delta)) };
      // Constraint: infants ≤ adults
      if (next.infants > next.adults) next.infants = next.adults;
      return next;
    });
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-[var(--color-fg)]">Pasajeros</label>
      {/* Hidden inputs para el form */}
      <input type="hidden" name="adults" value={pax.adults} />
      <input type="hidden" name="children" value={pax.children} />
      <input type="hidden" name="infants" value={pax.infants} />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex h-9 w-full items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-muted)]"
          >
            <span className="flex items-center gap-2">
              <Users className="size-3.5 text-[var(--color-fg-subtle)]" />
              <span>{summary}</span>
            </span>
            <ChevronDown className="size-3.5 text-[var(--color-fg-subtle)]" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={4}
            align="start"
            className="z-50 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-md)]"
          >
            <PaxRow
              title="Adultos"
              subtitle="Desde 12 años"
              value={pax.adults}
              min={MIN.adults}
              max={MAX.adults}
              onDec={() => update('adults', -1)}
              onInc={() => update('adults', 1)}
            />
            <PaxRow
              title="Niños"
              subtitle="2 a 11 años"
              value={pax.children}
              min={MIN.children}
              max={MAX.children}
              onDec={() => update('children', -1)}
              onInc={() => update('children', 1)}
            />
            <PaxRow
              title="Infantes"
              subtitle="Menores de 2 años (en regazo)"
              value={pax.infants}
              min={MIN.infants}
              max={pax.adults}
              onDec={() => update('infants', -1)}
              onInc={() => update('infants', 1)}
              hint={pax.infants >= pax.adults ? 'Máx. 1 por adulto' : undefined}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function PaxRow({
  title,
  subtitle,
  value,
  min,
  max,
  onDec,
  onInc,
  hint,
}: {
  title: string;
  subtitle: string;
  value: number;
  min: number;
  max: number;
  onDec: () => void;
  onInc: () => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
        <p className="text-[11px] text-[var(--color-fg-muted)]">{subtitle}</p>
        {hint ? <p className="text-[11px] text-[var(--color-fg-subtle)]">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDec}
          disabled={value <= min}
          className="flex size-7 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Minus className="size-3.5" />
        </button>
        <span className="w-6 text-center font-mono text-sm tabular-nums text-[var(--color-fg)]">
          {value}
        </span>
        <button
          type="button"
          onClick={onInc}
          disabled={value >= max}
          className="flex size-7 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
