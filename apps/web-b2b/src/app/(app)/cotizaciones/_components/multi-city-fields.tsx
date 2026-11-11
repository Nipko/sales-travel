'use client';

import { Plus, X } from 'lucide-react';
import { AirportCombobox } from '../../../../components/ui/airport-combobox';
import { DateRangePicker } from '../../../../components/ui/date-range-picker';
import { cn } from '../../../../lib/cn';
import {
  addLeg,
  MULTICITY_MAX_LEGS,
  MULTICITY_MIN_LEGS,
  removeLeg,
  updateLeg,
  type MultiCityLeg,
} from './search-form-model';

/** Ids estables de los campos de un tramo: la página lleva el foco ahí cuando falta algo. */
export function legFieldId(index: number, part: 'origin' | 'destination' | 'date'): string {
  return `search-leg-${String(index)}-${part}`;
}

/**
 * Los tramos de un multidestino: origen, destino y fecha por fila, «Agregar tramo» hasta el tope y
 * quitar cualquiera por encima de dos. En el teléfono cada tramo es una tarjeta apilada; en
 * escritorio, una fila. Los tramos viajan al servidor en un solo campo oculto (`legs`, JSON) para
 * que los nombres de los campos de cada fila no choquen.
 */
export function MultiCityFields({
  legs,
  onChange,
  min,
}: {
  readonly legs: readonly MultiCityLeg[];
  readonly onChange: (next: MultiCityLeg[]) => void;
  /** Primer día elegible: hoy. Cada tramo además arranca en la fecha del anterior. */
  readonly min: string;
}) {
  const payload = legs.map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    ...(leg.originKind ? { originKind: leg.originKind } : {}),
    ...(leg.destinationKind ? { destinationKind: leg.destinationKind } : {}),
    departureDate: leg.date,
  }));

  return (
    <div className="space-y-2.5">
      <input type="hidden" name="legs" value={JSON.stringify(payload)} />
      <ol className="space-y-2.5">
        {legs.map((leg, index) => {
          const previousDate = legs[index - 1]?.date;
          const legMin = previousDate && previousDate > min ? previousDate : min;
          return (
            <li
              key={leg.id}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                  Tramo {index + 1}
                </p>
                {legs.length > MULTICITY_MIN_LEGS ? (
                  <button
                    type="button"
                    onClick={() => onChange(removeLeg(legs, leg.id))}
                    aria-label={`Quitar el tramo ${String(index + 1)}`}
                    className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
                <div className="rounded-lg border border-[var(--color-border)] px-3 py-1.5">
                  <AirportCombobox
                    // El origen de un tramo nuevo sale del destino del anterior: la clave lo
                    // remonta con ese valor cuando cambia por fuera.
                    key={`${leg.id}-o-${String(leg.originRev ?? 0)}`}
                    name={`leg${String(index)}Origin`}
                    inputId={legFieldId(index, 'origin')}
                    label="Origen"
                    placeholder="Ciudad o código"
                    defaultValue={leg.origin}
                    {...(leg.originKind ? { defaultKind: leg.originKind } : {})}
                    onChange={(code, _reason, kind) =>
                      onChange(
                        updateLeg(legs, leg.id, {
                          origin: code,
                          ...(kind ? { originKind: kind } : { originKind: undefined }),
                        }),
                      )
                    }
                  />
                </div>
                <div className="rounded-lg border border-[var(--color-border)] px-3 py-1.5">
                  <AirportCombobox
                    key={`${leg.id}-d`}
                    name={`leg${String(index)}Destination`}
                    inputId={legFieldId(index, 'destination')}
                    label="Destino"
                    placeholder="Ciudad o código"
                    defaultValue={leg.destination}
                    {...(leg.destinationKind ? { defaultKind: leg.destinationKind } : {})}
                    onChange={(code, _reason, kind) => {
                      let next = updateLeg(legs, leg.id, {
                        destination: code,
                        ...(kind ? { destinationKind: kind } : { destinationKind: undefined }),
                      });
                      // El tramo siguiente, si todavía no tiene origen, sale de aquí.
                      const following = next[index + 1];
                      if (following && !following.origin && code.length === 3) {
                        next = updateLeg(next, following.id, {
                          origin: code,
                          originRev: (following.originRev ?? 0) + 1,
                          ...(kind ? { originKind: kind } : {}),
                        });
                      }
                      onChange(next);
                    }}
                  />
                </div>
                <DateRangePicker
                  mode="oneway"
                  size="md"
                  value={{ start: leg.date || null, end: null }}
                  onChange={(range) =>
                    onChange(updateLeg(legs, leg.id, { date: range.start ?? '' }))
                  }
                  min={legMin}
                  triggerId={legFieldId(index, 'date')}
                  startName={`leg${String(index)}Date`}
                  startLabel="Fecha"
                />
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        onClick={() => onChange(addLeg(legs))}
        disabled={legs.length >= MULTICITY_MAX_LEGS}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]',
          'hover:border-[var(--color-primary)]/50 hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {legs.length >= MULTICITY_MAX_LEGS
          ? `Máximo ${String(MULTICITY_MAX_LEGS)} tramos`
          : 'Agregar tramo'}
      </button>
    </div>
  );
}
