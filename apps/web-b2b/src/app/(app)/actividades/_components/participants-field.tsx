'use client';

import { Minus, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { TextInput } from '../../../../components/ui/field';
import { parseAges, type Participants } from './activity-model';

/**
 * Participantes por edad: adultos con un contador y las edades de los menores en un campo. La
 * edad, no una categoría, decide si es niño o bebé: cada modalidad tiene sus propios rangos.
 */
export function ParticipantsField({
  value,
  onChange,
}: {
  value: Participants;
  onChange: (next: Participants, error?: string) => void;
}) {
  const id = useId();
  const [agesText, setAgesText] = useState(value.childrenAges.join(', '));
  const [error, setError] = useState<string | undefined>();

  function setAdults(n: number) {
    onChange({ ...value, adults: Math.min(9, Math.max(1, n)) }, error);
  }

  function setAges(raw: string) {
    setAgesText(raw);
    const parsed = parseAges(raw);
    if (!parsed.ok) {
      setError(parsed.error);
      onChange(value, parsed.error);
      return;
    }
    setError(undefined);
    onChange({ ...value, childrenAges: parsed.ages });
  }

  return (
    <fieldset className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
      <legend className="sr-only">Participantes</legend>
      <div className="space-y-1.5">
        <span id={`${id}-adults`} className="block text-xs font-semibold text-[var(--color-fg)]">
          Adultos
        </span>
        <div
          role="group"
          aria-labelledby={`${id}-adults`}
          className="inline-flex h-9 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <button
            type="button"
            aria-label="Un adulto menos"
            onClick={() => setAdults(value.adults - 1)}
            disabled={value.adults <= 1}
            className="flex size-9 items-center justify-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            <Minus aria-hidden="true" className="size-4" />
          </button>
          <output aria-live="polite" className="w-8 text-center text-sm font-medium tabular-nums">
            {value.adults}
          </output>
          <button
            type="button"
            aria-label="Un adulto más"
            onClick={() => setAdults(value.adults + 1)}
            disabled={value.adults >= 9}
            className="flex size-9 items-center justify-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor={`${id}-ages`}
          className="block text-xs font-semibold text-[var(--color-fg)]"
        >
          Edades de los menores
        </label>
        <TextInput
          id={`${id}-ages`}
          inputMode="numeric"
          placeholder="Ej.: 7, 1 (vacío si no hay)"
          value={agesText}
          onChange={(e) => setAges(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={`${id}-ages-help`}
        />
        <p
          id={`${id}-ages-help`}
          role={error ? 'alert' : undefined}
          className={
            error ? 'text-xs text-[var(--color-danger)]' : 'text-xs text-[var(--color-fg-muted)]'
          }
        >
          {error ?? 'Una edad por menor, 0 a 17 años. Los bebés también cuentan.'}
        </p>
      </div>
    </fieldset>
  );
}
