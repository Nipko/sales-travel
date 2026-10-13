'use client';

import { TriangleAlert, X } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '../../../../lib/cn';
import {
  filterGroupsBySlots,
  knownSlotChoice,
  roomSlotOptions,
  slotChoiceSummary,
  type RoomSlotChoice,
  type RoomSlotFacet,
  type RoomSlotOption,
  type SlotGroup,
} from './room-type-groups';

/*
 * Arriba de las habitaciones de la ficha, en una búsqueda de varias: un select por habitación para
 * elegir su tipo, y la lista muestra sólo las combinaciones que lo cumplen. El proveedor vende
 * combinaciones cerradas, así que esto filtra y nada más: nunca arma una combinación nueva, y lo
 * que se reserva es la combinación entera con su propio código. Lo elegido vive en memoria, no en
 * la URL.
 *
 * Como los filtros del listado, cada opción dice cuántas combinaciones quedarían con ella y la que
 * no dejaría ninguna no se puede elegir (la ya elegida sí se puede cambiar).
 */

const NO_CHOICE: RoomSlotChoice = Object.freeze({});

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

export interface RoomSlotFilterProps<G extends SlotGroup> {
  readonly groups: readonly G[];
  /** Habitaciones de la búsqueda: con menos de dos no hay nada que elegir. */
  readonly roomsCount: number;
  /** La lista con las combinaciones que cumplen lo elegido; sin ninguna, no se llama. */
  readonly children: (groups: readonly G[]) => ReactNode;
  /** Lo elegido de entrada; por defecto, nada. */
  readonly initialChoice?: RoomSlotChoice;
}

export function RoomSlotFilter<G extends SlotGroup>({
  groups,
  roomsCount,
  children,
  initialChoice = NO_CHOICE,
}: RoomSlotFilterProps<G>) {
  const [picked, setPicked] = useState<RoomSlotChoice>(initialChoice);
  const [lastChanged, setLastChanged] = useState<number | undefined>(undefined);
  const firstSelect = useRef<HTMLSelectElement>(null);

  const { choice, facets, shown } = useMemo(() => {
    const known = knownSlotChoice(roomSlotOptions(groups), picked);
    return {
      choice: known,
      facets: roomSlotOptions(groups, known),
      shown: filterGroupsBySlots(groups, known),
    };
  }, [groups, picked]);

  // Con una sola combinación, o con un único tipo en cada habitación, no hay nada que elegir.
  const choosable =
    roomsCount >= 2 && facets.length >= 2 && facets.some((f) => f.options.length >= 2);
  if (!choosable) return <>{children(groups)}</>;

  const summary = slotChoiceSummary(shown.length, choice, lastChanged);
  const empty = shown.length === 0;

  const choose = (index: number, identity: string | undefined) => {
    setPicked({ ...choice, [index]: identity });
    setLastChanged(index);
  };
  const clear = () => {
    setPicked(NO_CHOICE);
    setLastChanged(undefined);
    // El botón desaparece al quitar la selección: el foco vuelve a la primera habitación.
    firstSelect.current?.focus();
  };

  return (
    <>
      <fieldset className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        {/* Flotado, como en los filtros del listado: el `legend` no se dibuja sobre el borde. */}
        <legend className="float-left w-full text-xs font-semibold text-[var(--color-fg)]">
          Elige el tipo de cada habitación
        </legend>
        <p className="clear-left pt-0.5 text-[11px] text-[var(--color-fg-muted)]">
          El proveedor vende las habitaciones en combinaciones cerradas: verás sólo las que cumplen
          tu elección.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {facets.map((facet) => (
            <SlotSelect
              key={facet.index}
              facet={facet}
              value={choice[facet.index]}
              onChange={(identity) => choose(facet.index, identity)}
              selectRef={facet.index === 0 ? firstSelect : undefined}
            />
          ))}
        </div>
        <div
          className={cn('flex items-start justify-between gap-3', summary !== undefined && 'mt-3')}
        >
          {/* Siempre en la página, aunque vacío: un lector de pantalla anuncia cada cambio. */}
          <p
            role="status"
            className={cn(
              'min-w-0 flex-1 text-xs',
              empty
                ? 'flex items-start gap-1.5 rounded-md border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10 px-2.5 py-1.5 text-[var(--color-fg)]'
                : 'self-center text-[var(--color-fg-muted)]',
            )}
          >
            {empty ? (
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            ) : null}
            {summary}
          </p>
          {summary !== undefined ? (
            <button
              type="button"
              onClick={clear}
              className={cn(
                'inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)]',
                FOCUS,
              )}
            >
              <X aria-hidden="true" className="size-3.5" />
              Quitar selección
            </button>
          ) : null}
        </div>
      </fieldset>
      {empty ? null : children(shown)}
    </>
  );
}

/** «Doble estándar (3)»: el tipo y cuántas combinaciones quedarían con él. */
export function slotOptionText(option: RoomSlotOption): string {
  return `${option.label} (${option.count})`;
}

function SlotSelect({
  facet,
  value,
  onChange,
  selectRef,
}: {
  facet: RoomSlotFacet;
  value: string | undefined;
  onChange: (identity: string | undefined) => void;
  selectRef: RefObject<HTMLSelectElement | null> | undefined;
}) {
  const id = useId();
  const label = `Habitación ${facet.index + 1}`;
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-[var(--color-fg)]">
        {facet.occupancyText ? `${label} · ${facet.occupancyText}` : label}
      </label>
      {/* 16 px en el teléfono: con menos, Safari agranda la página al tocarlo. */}
      <select
        id={id}
        ref={selectRef}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={cn(
          'h-10 w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-base text-[var(--color-fg)] sm:h-9 sm:text-sm',
          FOCUS,
        )}
      >
        <option value="">Cualquier tipo</option>
        {facet.options.map((option) => (
          <option
            key={option.identity}
            value={option.identity}
            disabled={option.count === 0 && option.identity !== value}
          >
            {slotOptionText(option)}
          </option>
        ))}
      </select>
    </div>
  );
}
