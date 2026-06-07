'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BedDouble, ChevronDown, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../../../lib/cn';

interface Room {
  adults: number;
  children: number[]; // edades
}

const MAX_ROOMS = 8;
const MAX_ADULTS = 8;
const MAX_CHILDREN = 6;
const DEFAULT_CHILD_AGE = 8;

export function RoomsPicker() {
  const [rooms, setRooms] = useState<Room[]>([{ adults: 2, children: [] }]);

  const totalGuests = rooms.reduce((n, r) => n + r.adults + r.children.length, 0);
  const summary = `${rooms.length} hab · ${totalGuests} huésped${totalGuests === 1 ? '' : 'es'}`;
  const serialized = JSON.stringify(
    rooms.map((r) => ({ adults: r.adults, childrenAges: r.children })),
  );

  function patchRoom(idx: number, patch: (r: Room) => Room) {
    setRooms((rs) => rs.map((r, i) => (i === idx ? patch(r) : r)));
  }

  function setAdults(idx: number, delta: 1 | -1) {
    patchRoom(idx, (r) => ({ ...r, adults: clamp(r.adults + delta, 1, MAX_ADULTS) }));
  }

  function setChildren(idx: number, delta: 1 | -1) {
    patchRoom(idx, (r) => {
      if (delta === 1) {
        if (r.children.length >= MAX_CHILDREN) return r;
        return { ...r, children: [...r.children, DEFAULT_CHILD_AGE] };
      }
      return { ...r, children: r.children.slice(0, -1) };
    });
  }

  function setChildAge(idx: number, childIdx: number, age: number) {
    patchRoom(idx, (r) => ({
      ...r,
      children: r.children.map((a, i) => (i === childIdx ? age : a)),
    }));
  }

  function addRoom() {
    setRooms((rs) => (rs.length >= MAX_ROOMS ? rs : [...rs, { adults: 2, children: [] }]));
  }

  function removeRoom(idx: number) {
    setRooms((rs) => (rs.length <= 1 ? rs : rs.filter((_, i) => i !== idx)));
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-[var(--color-fg)]">Habitaciones</label>
      <input type="hidden" name="rooms" value={serialized} />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex h-10 w-full items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)]"
          >
            <span className="flex items-center gap-2">
              <BedDouble className="size-4 text-[var(--color-fg-subtle)]" />
              <span>{summary}</span>
            </span>
            <ChevronDown className="size-3.5 text-[var(--color-fg-subtle)]" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={4}
            align="start"
            className="z-50 max-h-[28rem] w-80 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg"
          >
            {rooms.map((room, idx) => (
              <div
                key={idx}
                className="mb-2 rounded-lg border border-[var(--color-border)] p-2.5 last:mb-0"
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="text-xs font-semibold text-[var(--color-fg)]">
                    Habitación {idx + 1}
                  </p>
                  {rooms.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeRoom(idx)}
                      className="text-[11px] text-[var(--color-danger)] hover:underline"
                    >
                      Quitar
                    </button>
                  ) : null}
                </div>

                <Stepper
                  label="Adultos"
                  value={room.adults}
                  onDec={() => setAdults(idx, -1)}
                  onInc={() => setAdults(idx, 1)}
                  canDec={room.adults > 1}
                  canInc={room.adults < MAX_ADULTS}
                />
                <Stepper
                  label="Niños"
                  value={room.children.length}
                  onDec={() => setChildren(idx, -1)}
                  onInc={() => setChildren(idx, 1)}
                  canDec={room.children.length > 0}
                  canInc={room.children.length < MAX_CHILDREN}
                />

                {room.children.length > 0 ? (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {room.children.map((age, ci) => (
                      <label key={ci} className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-[var(--color-fg-muted)]">
                          Niño {ci + 1}
                        </span>
                        <select
                          value={age}
                          onChange={(e) => setChildAge(idx, ci, Number(e.target.value))}
                          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-xs text-[var(--color-fg)]"
                        >
                          {Array.from({ length: 18 }, (_, a) => (
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

            {rooms.length < MAX_ROOMS ? (
              <button
                type="button"
                onClick={addRoom}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border)] py-2 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-surface-muted)]"
              >
                <Plus className="size-3.5" /> Agregar habitación
              </button>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function Stepper({
  label,
  value,
  onDec,
  onInc,
  canDec,
  canInc,
}: {
  label: string;
  value: number;
  onDec: () => void;
  onInc: () => void;
  canDec: boolean;
  canInc: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-[var(--color-fg)]">{label}</span>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onDec}
          disabled={!canDec}
          className="flex size-7 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Minus className="size-3.5" />
        </button>
        <span className="w-5 text-center font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
          {value}
        </span>
        <button
          type="button"
          onClick={onInc}
          disabled={!canInc}
          className="flex size-7 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
