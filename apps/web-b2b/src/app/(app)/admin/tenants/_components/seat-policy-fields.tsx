'use client';

import { Field, Select, TextInput } from '../../../../../components/ui/field';
import {
  DEFAULT_IDLE_MINUTES,
  IDLE_OPTIONS,
  SEATS_MAX,
  SEATS_MIN,
  idleLabel,
} from '../../../../../lib/tenant-admin-seats';

/**
 * Puestos simultáneos e inactividad al dar de alta un nodo. Sólo los ve el superadmin (lo decidió
 * el founder: el cupo lo fija la plataforma y nadie más). Lo usan Gestión de Agencias y Mi Red.
 */
export function SeatPolicyFields({
  seats,
  idle,
  onSeats,
  onIdle,
  required,
  parentName,
  errors,
}: {
  seats: string;
  idle: string;
  onSeats: (value: string) => void;
  onIdle: (value: string) => void;
  /** Bajo la plataforma no hay de quién heredar el cupo: es obligatorio. */
  required: boolean;
  parentName: string | undefined;
  errors: { readonly concurrentSeats?: string; readonly idleTimeoutMinutes?: string };
}) {
  const parent = parentName ?? 'su padre';
  return (
    <fieldset className="space-y-4 border-t border-[var(--color-border)] pt-4">
      <legend className="sr-only">Puestos y sesión</legend>
      <div>
        <p aria-hidden="true" className="text-xs font-semibold text-[var(--color-fg)]">
          Puestos y sesión
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
          Cuántas personas pueden estar conectadas a la vez y cuándo se cierra una sesión inactiva.
          Los podés ampliar después desde el nodo.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Puestos simultáneos"
          required={required}
          error={errors.concurrentSeats}
          hint={
            required
              ? `Entre ${SEATS_MIN} y ${SEATS_MAX.toLocaleString('es-CO')}. Cuenta también los nodos de abajo sin cupo propio.`
              : `Vacío: comparte el cupo de ${parent}.`
          }
        >
          {(a11y) => (
            <TextInput
              {...a11y}
              // El asterisco de Field es aria-hidden: sin esto, un lector de pantalla se entera de
              // que es obligatorio recién al enviar. `aria-required` y no `required`: el formulario
              // valida por su cuenta y no queremos el globo del navegador.
              aria-required={required || undefined}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              value={seats}
              placeholder={required ? 'Ej.: 5' : `Heredar de ${parent}`}
              onChange={(e) => onSeats(e.target.value.replace(/\D/g, ''))}
              className="tabular-nums"
            />
          )}
        </Field>
        <Field
          label="Cierre por inactividad"
          error={errors.idleTimeoutMinutes}
          hint="Se avisa 2 minutos antes y libera el puesto."
        >
          {(a11y) => (
            <Select {...a11y} value={idle} onChange={(e) => onIdle(e.target.value)}>
              <option value="">Heredar de {parent}</option>
              {IDLE_OPTIONS.map((m) => (
                <option key={m} value={String(m)}>
                  {idleLabel(m)}
                  {m === DEFAULT_IDLE_MINUTES ? ' (por defecto)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </fieldset>
  );
}
