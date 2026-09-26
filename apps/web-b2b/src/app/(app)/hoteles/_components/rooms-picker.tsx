'use client';

import { BedDouble, ChevronDown, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../../lib/cn';

/*
 * Habitaciones y huéspedes de la búsqueda (U-04).
 *
 * Los topes son los del BORDE de la plataforma, los mismos que valida el API
 * (`PLATFORM_OCCUPANCY_LIMITS` en `apps/api/src/hotels/hotels.schemas.ts`). No se achican al
 * proveedor más estrecho: cada proveedor declara los suyos en el API, y el que no los cumple queda
 * fuera de ESA búsqueda con el motivo en el aviso de resultados incompletos, mientras los demás
 * buscan igual. Achicarlos acá le quitaría a todos lo que sólo uno no admite.
 *
 * El panel es un popover a mano y no un menú de Radix, por lo mismo que el de pasajeros de
 * vuelos: un menú se queda con la tecla Tab y los «+» y «−» quedaban fuera del teclado.
 */

export const HOTEL_OCCUPANCY_LIMITS = {
  maxRooms: 8,
  maxAdultsPerRoom: 8,
  maxChildrenPerRoom: 6,
  maxChildAge: 17,
} as const;

/** Edad con la que entra un niño nuevo; el selector de edad queda a la vista para cambiarla. */
const DEFAULT_CHILD_AGE = 8;

export interface RoomDraft {
  readonly adults: number;
  /** Edad de cada niño. */
  readonly children: readonly number[];
}

export const DEFAULT_ROOM: RoomDraft = { adults: 2, children: [] };

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function adjustAdults(room: RoomDraft, delta: 1 | -1): RoomDraft {
  return {
    ...room,
    adults: clamp(room.adults + delta, 1, HOTEL_OCCUPANCY_LIMITS.maxAdultsPerRoom),
  };
}

export function adjustChildren(room: RoomDraft, delta: 1 | -1): RoomDraft {
  if (delta === 1) {
    if (room.children.length >= HOTEL_OCCUPANCY_LIMITS.maxChildrenPerRoom) return room;
    return { ...room, children: [...room.children, DEFAULT_CHILD_AGE] };
  }
  return { ...room, children: room.children.slice(0, -1) };
}

export function setChildAge(room: RoomDraft, index: number, age: number): RoomDraft {
  const safe = clamp(Math.round(age), 0, HOTEL_OCCUPANCY_LIMITS.maxChildAge);
  return { ...room, children: room.children.map((a, i) => (i === index ? safe : a)) };
}

export function canAddRoom(rooms: readonly RoomDraft[]): boolean {
  return rooms.length < HOTEL_OCCUPANCY_LIMITS.maxRooms;
}

/** Edades que se pueden elegir: de 0 al tope del borde. */
export function childAgeOptions(): number[] {
  return Array.from({ length: HOTEL_OCCUPANCY_LIMITS.maxChildAge + 1 }, (_, age) => age);
}

export function totalGuests(rooms: readonly RoomDraft[]): number {
  return rooms.reduce((n, r) => n + r.adults + r.children.length, 0);
}

/** Lo que se lee en el disparador: "1 hab · 2 huéspedes". */
export function roomsSummary(rooms: readonly RoomDraft[]): string {
  const guests = totalGuests(rooms);
  return `${rooms.length} hab · ${guests} huésped${guests === 1 ? '' : 'es'}`;
}

/** Lo mismo, dicho entero para el lector de pantalla. */
export function roomsSpoken(rooms: readonly RoomDraft[]): string {
  const adults = rooms.reduce((n, r) => n + r.adults, 0);
  const children = rooms.reduce((n, r) => n + r.children.length, 0);
  const parts = [
    `${rooms.length} ${rooms.length === 1 ? 'habitación' : 'habitaciones'}`,
    `${adults} ${adults === 1 ? 'adulto' : 'adultos'}`,
  ];
  if (children > 0) parts.push(`${children} ${children === 1 ? 'niño' : 'niños'}`);
  return parts.join(', ');
}

/** El valor del campo oculto `rooms`, con la forma que espera la búsqueda. */
export function serializeRooms(rooms: readonly RoomDraft[]): string {
  return JSON.stringify(rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.children] })));
}

export function RoomsPicker() {
  const autoId = useId();
  const labelId = `${autoId}-label`;
  const panelId = `${autoId}-panel`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<RoomDraft[]>([DEFAULT_ROOM]);

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

  function patchRoom(idx: number, patch: (r: RoomDraft) => RoomDraft) {
    setRooms((rs) => rs.map((r, i) => (i === idx ? patch(r) : r)));
  }

  function addRoom() {
    setRooms((rs) => (canAddRoom(rs) ? [...rs, DEFAULT_ROOM] : rs));
  }

  function removeRoom(idx: number) {
    setRooms((rs) => (rs.length <= 1 ? rs : rs.filter((_, i) => i !== idx)));
    // El botón "Quitar" desaparece con la habitación: el foco no puede quedar en el aire.
    addRef.current?.focus({ preventScroll: true });
  }

  const roomsFull = !canAddRoom(rooms);

  return (
    <div
      ref={rootRef}
      className="relative space-y-1.5"
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
      onBlur={(event) => {
        if (!open) return;
        // Sin `relatedTarget` el foco no se fue a otro control: no es una salida.
        if (event.relatedTarget === null) return;
        if (rootRef.current?.contains(event.relatedTarget)) return;
        close(false);
      }}
    >
      <span id={labelId} className="block text-xs font-medium text-[var(--color-fg)]">
        Habitaciones
      </span>
      <input type="hidden" name="rooms" value={serializeRooms(rooms)} />

      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={`${labelId} ${autoId}-summary`}
        className={cn(
          'flex h-10 w-full items-center justify-between rounded-lg border bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors',
          open
            ? 'border-[var(--color-primary)]'
            : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <BedDouble aria-hidden="true" className="size-4 shrink-0 text-[var(--color-fg-subtle)]" />
          <span aria-hidden="true" className="truncate">
            {roomsSummary(rooms)}
          </span>
          <span id={`${autoId}-summary`} className="sr-only">
            {roomsSpoken(rooms)}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-[var(--color-fg-subtle)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Habitaciones y huéspedes"
          className={cn(
            // Desde `sm` el selector es la última columna de su fila: el panel, más ancho que
            // el disparador, se abre hacia la izquierda para no desbordar el contenedor.
            'absolute left-0 top-full z-50 mt-1 max-h-[28rem] w-full min-w-[17rem] overflow-auto rounded-lg border sm:left-auto sm:right-0 sm:w-80',
            'border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-lg)]',
          )}
        >
          {rooms.map((room, idx) => (
            <div
              key={idx}
              role="group"
              aria-labelledby={`${autoId}-room-${idx}`}
              className="mb-2 rounded-lg border border-[var(--color-border)] p-2.5 last:mb-0"
            >
              <div className="mb-1 flex items-center justify-between">
                <p
                  id={`${autoId}-room-${idx}`}
                  className="text-xs font-semibold text-[var(--color-fg)]"
                >
                  Habitación {idx + 1}
                </p>
                {rooms.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeRoom(idx)}
                    aria-label={`Quitar la habitación ${idx + 1}`}
                    className="rounded px-1 text-[11px] font-medium text-[var(--color-danger)] hover:underline"
                  >
                    Quitar
                  </button>
                ) : null}
              </div>

              <Stepper
                title="Adultos"
                singular="adulto"
                room={idx + 1}
                value={room.adults}
                canRemove={room.adults > 1}
                canAdd={room.adults < HOTEL_OCCUPANCY_LIMITS.maxAdultsPerRoom}
                onDec={() => patchRoom(idx, (r) => adjustAdults(r, -1))}
                onInc={() => patchRoom(idx, (r) => adjustAdults(r, 1))}
              />
              <Stepper
                title="Niños"
                subtitle={`Hasta ${HOTEL_OCCUPANCY_LIMITS.maxChildAge} años`}
                singular="niño"
                room={idx + 1}
                value={room.children.length}
                canRemove={room.children.length > 0}
                canAdd={room.children.length < HOTEL_OCCUPANCY_LIMITS.maxChildrenPerRoom}
                onDec={() => patchRoom(idx, (r) => adjustChildren(r, -1))}
                onInc={() => patchRoom(idx, (r) => adjustChildren(r, 1))}
              />

              {room.children.length > 0 ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {room.children.map((age, ci) => (
                    <label key={ci} className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-[var(--color-fg-muted)]">
                        Edad niño {ci + 1}
                        <span className="sr-only">, habitación {idx + 1}</span>
                      </span>
                      <select
                        value={age}
                        onChange={(e) =>
                          patchRoom(idx, (r) => setChildAge(r, ci, Number(e.target.value)))
                        }
                        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-xs text-[var(--color-fg)]"
                      >
                        {childAgeOptions().map((a) => (
                          <option key={a} value={a}>
                            {a} {a === 1 ? 'año' : 'años'}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ))}

          <button
            ref={addRef}
            type="button"
            onClick={roomsFull ? undefined : addRoom}
            aria-disabled={roomsFull || undefined}
            className={cn(
              'mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border)] py-2 text-xs font-medium text-[var(--color-fg)]',
              roomsFull ? 'cursor-not-allowed opacity-50' : 'hover:bg-[var(--color-surface-muted)]',
            )}
          >
            <Plus aria-hidden="true" className="size-3.5" /> Agregar habitación
          </button>
          <p
            aria-live="polite"
            className="mt-2 border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-fg-muted)]"
          >
            {roomsFull
              ? `Máximo ${HOTEL_OCCUPANCY_LIMITS.maxRooms} habitaciones por búsqueda.`
              : 'Si un proveedor no admite esta ocupación, lo avisamos arriba de los resultados.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Stepper({
  title,
  subtitle,
  singular,
  room,
  value,
  canAdd,
  canRemove,
  onDec,
  onInc,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly singular: string;
  readonly room: number;
  readonly value: number;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
  readonly onDec: () => void;
  readonly onInc: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div>
        <p className="text-sm text-[var(--color-fg)]">{title}</p>
        {subtitle ? <p className="text-[11px] text-[var(--color-fg-muted)]">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-2.5">
        <StepButton
          label={`Quitar un ${singular} de la habitación ${room}`}
          disabled={!canRemove}
          onClick={onDec}
        >
          <Minus aria-hidden="true" className="size-3.5" />
        </StepButton>
        <span className="w-5 text-center font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
          {value}
        </span>
        <StepButton
          label={`Agregar un ${singular} a la habitación ${room}`}
          disabled={!canAdd}
          onClick={onInc}
        >
          <Plus aria-hidden="true" className="size-3.5" />
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
    // `aria-disabled` y no `disabled`: el tope se alcanza con el foco puesto en el botón, y uno
    // deshabilitado bajo el dedo suelta el foco y el panel se cierra solo (ver pax-field).
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        'flex size-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors',
        disabled ? 'cursor-not-allowed opacity-30' : 'hover:bg-[var(--color-surface-muted)]',
      )}
    >
      {children}
    </button>
  );
}
