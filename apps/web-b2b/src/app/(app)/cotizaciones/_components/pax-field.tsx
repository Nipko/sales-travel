'use client';

import { Minus, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../../lib/cn';
import {
  adjustPax,
  canAddPax,
  canRemovePax,
  paxComposition,
  paxLabel,
  paxTotal,
  PAX_MAX_TOTAL,
  type PaxCounts,
  type PaxKey,
} from './search-form-model';

/* =============================================================================================
   PASAJEROS

   Mismo talón que la ruta y las fechas: etiqueta chica arriba, valor grande abajo. Las reglas
   —mínimo un adulto, un infante por adulto, nueve por reserva— viven en `search-form-model`;
   acá sólo se pintan y se enrutan los clics.

   El panel es un popover a mano y no un menú de Radix a propósito. Un menú se queda con la
   tecla Tab (la cancela para no perder el foco entre sus ítems), así que los botones «+» y «−»,
   que no son ítems de menú sino controles, quedaban fuera del alcance del teclado. Con un
   popover común son botones de verdad, en el orden de tabulación de la página.

   Las reglas de apertura son las mismas que las del calendario, para que todo el buscador se
   comporte igual: se abre con un clic y nunca al recibir el foco; Escape cierra y devuelve el
   foco al disparador; el clic afuera cierra y NO se lo devuelve, porque el usuario ya se fue.
   ============================================================================================= */

export interface PaxFieldProps {
  readonly value: PaxCounts;
  readonly onChange: (next: PaxCounts) => void;
  readonly triggerId: string;
}

export function PaxField({ value, onChange, triggerId }: PaxFieldProps) {
  const autoId = useId();
  const panelId = `${autoId}-panel`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const remaining = PAX_MAX_TOTAL - paxTotal(value);

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

  function bump(key: PaxKey, delta: 1 | -1) {
    onChange(adjustPax(value, key, delta));
  }

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
        // Sin `relatedTarget` el foco no se fue a ningún lado: cambió de ventana, o el navegador
        // lo soltó. Cerrar ahí sería cerrar sin que nadie lo pida. Del clic afuera —que sí es
        // una salida— se encarga el `mousedown` de arriba.
        if (event.relatedTarget === null) return;
        if (rootRef.current?.contains(event.relatedTarget)) return;
        close(false);
      }}
    >
      <input type="hidden" name="adults" value={value.adults} />
      <input type="hidden" name="children" value={value.children} />
      <input type="hidden" name="infants" value={value.infants} />

      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          'flex h-14 w-full items-stretch overflow-hidden rounded-xl border text-left',
          'bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-colors',
          open
            ? 'border-[var(--color-primary)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
        )}
      >
        <span
          aria-hidden="true"
          className="hidden w-11 shrink-0 items-center justify-center border-r border-[var(--color-border)] text-[var(--color-fg-subtle)] sm:flex"
        >
          <Users className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-fg-subtle)]">
            Pasajeros
          </span>
          <span className="truncate text-[15px] font-semibold leading-tight text-[var(--color-fg)]">
            {paxComposition(value)}
          </span>
        </span>
        {/* El total en palabras: la composición abreviada se lee, el total se dice. */}
        <span className="sr-only">{paxLabel(value)}</span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Pasajeros del viaje"
          className={cn(
            'absolute left-0 top-full z-50 mt-2 w-full min-w-[17rem] rounded-xl border sm:w-[19rem]',
            'border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-lg)]',
            'origin-top animate-[scale-up_0.15s_cubic-bezier(0.16,1,0.3,1)_forwards]',
          )}
        >
          <PaxRow
            title="Adultos"
            subtitle="Desde 12 años"
            singular="adulto"
            value={value.adults}
            canAdd={canAddPax(value, 'adults')}
            canRemove={canRemovePax(value, 'adults')}
            onDec={() => bump('adults', -1)}
            onInc={() => bump('adults', 1)}
          />
          <PaxRow
            title="Niños"
            subtitle="2 a 11 años"
            singular="niño"
            value={value.children}
            canAdd={canAddPax(value, 'children')}
            canRemove={canRemovePax(value, 'children')}
            onDec={() => bump('children', -1)}
            onInc={() => bump('children', 1)}
          />
          <PaxRow
            title="Infantes"
            subtitle="Menores de 2 años, en regazo"
            singular="infante"
            value={value.infants}
            canAdd={canAddPax(value, 'infants')}
            canRemove={canRemovePax(value, 'infants')}
            onDec={() => bump('infants', -1)}
            onInc={() => bump('infants', 1)}
            hint={value.infants >= value.adults ? 'Uno por adulto' : undefined}
          />

          {/*
            Por qué el «+» está apagado, dicho antes de que lo intenten. `aria-live` porque el
            tope se alcanza mientras el panel ya está abierto: nadie vuelve a leer el pie.
          */}
          <p
            aria-live="polite"
            className="mt-1 border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-fg-muted)]"
          >
            {remaining === 0
              ? `Máximo ${PAX_MAX_TOTAL} pasajeros por reserva. Para un grupo más grande hay que partirlo en dos.`
              : paxLabel(value)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PaxRow({
  title,
  subtitle,
  singular,
  value,
  canAdd,
  canRemove,
  onDec,
  onInc,
  hint,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly singular: string;
  readonly value: number;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
  readonly onDec: () => void;
  readonly onInc: () => void;
  readonly hint?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0">
      <div>
        <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
        <p className="text-[11px] text-[var(--color-fg-muted)]">{subtitle}</p>
        {hint ? <p className="text-[11px] text-[var(--color-fg-subtle)]">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2.5">
        <StepButton label={`Quitar un ${singular}`} disabled={!canRemove} onClick={onDec}>
          <Minus className="size-3.5" />
        </StepButton>
        {/*
          El número no se anuncia solo: lo dice el `aria-label` del botón que acaba de moverlo,
          que es donde está el foco. Una región viva acá repetiría el mismo dato dos veces.
        */}
        <span className="w-6 text-center font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
          {value}
        </span>
        <StepButton label={`Agregar un ${singular}`} disabled={!canAdd} onClick={onInc}>
          <Plus className="size-3.5" />
        </StepButton>
      </div>
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    /*
      `aria-disabled` y no `disabled`: el tope se alcanza CON EL FOCO PUESTO en este botón
      —bajar adultos hasta uno, subir niños hasta nueve— y un botón que se deshabilita bajo el
      dedo del usuario suelta el foco al `body`. El panel, que cierra cuando el foco se le va,
      se cerraba solo justo después de un clic. Apagado pero enfocable: el lector lo sigue
      anunciando y el foco se queda donde el usuario lo dejó.
    */
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        'flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)]',
        'text-[var(--color-fg-muted)] transition-colors',
        disabled ? 'cursor-not-allowed opacity-30' : 'hover:bg-[var(--color-surface-muted)]',
      )}
    >
      {children}
    </button>
  );
}
