'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TripMode } from '../../../../components/ui/date-range-picker';
import { cn } from '../../../../lib/cn';
import { CABINS, cabinLabel } from './search-form-model';

/* =============================================================================================
   LA LÍNEA DE AJUSTES

   Tipo de viaje y cabina viven acá arriba, en tipografía chica, y no en la franja de abajo.
   No es esconderlos: los dos muestran su valor actual y los dos se cambian en un clic. Es
   ordenarlos por cuántas veces se tocan. En una búsqueda típica el vendedor escribe la ruta,
   pone las fechas y busca; la cabina la cambia una de cada muchas, y mientras tanto un
   desplegable del mismo tamaño que el destino le estaba disputando la atención al destino.
   ============================================================================================= */

const MODES: readonly { readonly value: TripMode; readonly label: string }[] = [
  { value: 'roundtrip', label: 'Ida y vuelta' },
  { value: 'oneway', label: 'Solo ida' },
];

export interface TripModeSwitchProps {
  readonly value: TripMode;
  readonly onChange: (mode: TripMode) => void;
}

/**
 * Tipo de viaje.
 *
 * Son radios de verdad, no botones: el grupo se recorre con las flechas, se anuncia como «uno
 * de dos» y el `name` es el que ya esperaba el server action, así que no hace falta un campo
 * oculto que duplique el estado y pueda quedar desfasado.
 *
 * Se evaluó deducirlo de si hay fecha de vuelta y borrar el control. No se puede sin cambiar
 * el calendario: en modo ida y vuelta exige las dos fechas para habilitar «Aplicar», así que
 * un buscador sin este interruptor no tendría forma de pedir un solo tramo.
 */
export function TripModeSwitch({ value, onChange }: TripModeSwitchProps) {
  return (
    <div className="flex items-center gap-1">
      {MODES.map((mode) => {
        const active = value === mode.value;
        return (
          <label
            key={mode.value}
            className={cn(
              'cursor-pointer rounded-full px-3 py-1.5 text-xs transition-colors',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2',
              'has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--color-primary)]',
              active
                ? 'bg-[var(--color-fg)] font-semibold text-[var(--color-bg)]'
                : 'font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            <input
              type="radio"
              name="tripType"
              value={mode.value}
              checked={active}
              onChange={() => onChange(mode.value)}
              className="sr-only"
            />
            {mode.label}
          </label>
        );
      })}
    </div>
  );
}

export interface CabinSelectProps {
  readonly value: string;
  readonly onChange: (cabin: string) => void;
}

/**
 * Cabina.
 *
 * Mismas reglas de apertura que el resto del buscador: abre con un clic y jamás al recibir el
 * foco, Escape cierra y devuelve el foco al disparador, el clic afuera cierra sin traérselo.
 * Elegir una opción SÍ cierra y devuelve el foco: es una elección inequívoca y no queda nada
 * más que hacer en el panel.
 */
export function CabinSelect({ value, onChange }: CabinSelectProps) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, close]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
      onBlur={(event) => {
        if (!open) return;
        if (event.relatedTarget === null) return;
        if (rootRef.current?.contains(event.relatedTarget)) return;
        close(false);
      }}
    >
      <input type="hidden" name="cabin" value={value} />

      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={cn(
          'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors',
          open
            ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
            : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]',
        )}
      >
        <span className="text-[var(--color-fg-subtle)]">Cabina</span>
        <span className="font-semibold text-[var(--color-fg)]">{cabinLabel(value)}</span>
        <ChevronDown className="size-3.5 text-[var(--color-fg-subtle)]" />
      </button>

      {open ? (
        /*
          Botones sueltos y no un `listbox`: una opción de listbox no puede contener un
          control, y un listbox promete que las flechas mueven la selección. Acá cada opción
          ES un botón, se llega con Tab y dice si está elegida con `aria-pressed`; ninguna
          promesa que el teclado no cumpla.
        */
        <div
          id={listId}
          role="dialog"
          aria-label="Cabina"
          className={cn(
            'absolute left-0 top-full z-50 mt-1.5 w-60 rounded-xl border p-1',
            'border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]',
            'origin-top animate-[scale-up_0.15s_cubic-bezier(0.16,1,0.3,1)_forwards]',
          )}
        >
          {CABINS.map((cabin) => {
            const selected = cabin.value === value;
            return (
              <button
                key={cabin.value}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onChange(cabin.value);
                  close(true);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                  'hover:bg-[var(--color-surface-muted)]',
                )}
              >
                <Check
                  className={cn(
                    'size-3.5 shrink-0',
                    selected ? 'text-[var(--color-primary)]' : 'opacity-0',
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--color-fg)]">
                    {cabin.label}
                  </span>
                  <span className="block text-[11px] text-[var(--color-fg-muted)]">
                    {cabin.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
