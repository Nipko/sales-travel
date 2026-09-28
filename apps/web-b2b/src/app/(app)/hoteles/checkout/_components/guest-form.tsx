'use client';

import { TriangleAlert, UserRound } from 'lucide-react';
import { useId } from 'react';
import { Card } from '../../../../../components/ui/card';
import { Field, TextInput } from '../../../../../components/ui/field';
import { cn } from '../../../../../lib/cn';
import {
  CONTACT_FIELDS,
  TITLE_OPTIONS,
  guestFieldPath,
  guestSlotLabel,
  roomDetails,
  roomNameAt,
  withContact,
  withGuest,
  type GuestDraft,
  type GuestRoomDraft,
  type GuestSlotDraft,
  type GuestTitleDraft,
} from './guest-form-view';

/*
 * Los huéspedes y el contacto del paso 2 (U-12; RF-18). Un bloque por habitación en el orden de
 * la búsqueda; en cada una, cada huésped con su tipo fijo —adulto o niño, el hueco que ocupa— y
 * lo que el proveedor pide de él: título, nombre y apellido. Nada más: el Book no lleva edades,
 * documentos ni nacionalidad, que ya fijó la búsqueda.
 *
 * Los campos no se autocompletan: son los datos de otra persona, y el navegador los llenaría con
 * los del vendedor.
 */

export function GuestForm({
  draft,
  onChange,
  errors,
  roomNames,
  noNameChange,
}: {
  draft: GuestDraft;
  onChange: (next: GuestDraft) => void;
  /** Por ruta de campo (`rooms.0.guests.1.firstName`), ya en el idioma del vendedor. */
  errors: Readonly<Record<string, string>>;
  /** Los nombres de las habitaciones de la tarifa, para rotular cada bloque. */
  roomNames: readonly string[];
  /** La tarifa dice que no admite cambio de nombre (señal del PreBook). */
  noNameChange: boolean;
}) {
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="space-y-2 border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
              Huéspedes
            </h2>
            <p className="text-[11px] text-[var(--color-fg-muted)]">
              Uno por lugar de cada habitación, en el orden de la búsqueda. El proveedor pide el
              título también para los niños.
            </p>
          </div>
          <NameChangeNotice strict={noNameChange} />
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {draft.rooms.map((room, r) => (
            <RoomBlock
              key={r}
              room={room}
              roomIndex={r}
              roomName={roomNameAt(roomNames, draft.rooms.length, r)}
              errors={errors}
              onGuestChange={(g, patch) => onChange(withGuest(draft, r, g, patch))}
            />
          ))}
        </div>
      </Card>

      <ContactBlock draft={draft} onChange={onChange} errors={errors} />
    </div>
  );
}

/**
 * Antes de confirmar se avisa que el hotel puede no aceptar cambios de nombre (docs/tbo/03 §3.2
 * punto 8): destacado si la tarifa lo dice, como recordatorio si no.
 */
function NameChangeNotice({ strict }: { strict: boolean }) {
  if (strict) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
        <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>
          <strong className="font-semibold">Esta tarifa no admite cambio de nombre.</strong> Cargá
          cada nombre tal como figura en el documento: después de reservar no se puede corregir.
        </span>
      </p>
    );
  }
  return (
    <p className="text-[11px] text-[var(--color-fg-muted)]">
      Cargá los nombres como figuran en el documento de cada huésped: el hotel puede no admitir
      cambios después de reservar.
    </p>
  );
}

function RoomBlock({
  room,
  roomIndex,
  roomName,
  errors,
  onGuestChange,
}: {
  room: GuestRoomDraft;
  roomIndex: number;
  roomName: string | undefined;
  errors: Readonly<Record<string, string>>;
  onGuestChange: (
    guestIndex: number,
    patch: Partial<Pick<GuestSlotDraft, 'title' | 'firstName' | 'lastName'>>,
  ) => void;
}) {
  const headingId = useId();
  const roomLabel = `Habitación ${roomIndex + 1}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id={headingId} className="text-xs font-semibold text-[var(--color-fg)]">
          {roomLabel}
        </h3>
        <p className="text-[11px] text-[var(--color-fg-muted)]">{roomDetails(room, roomName)}</p>
      </div>
      <div className="space-y-4">
        {room.guests.map((guest, g) => (
          <GuestFields
            key={g}
            label={guestSlotLabel(room, g)}
            roomLabel={roomLabel}
            guest={guest}
            paths={{
              title: guestFieldPath(roomIndex, g, 'title'),
              firstName: guestFieldPath(roomIndex, g, 'firstName'),
              lastName: guestFieldPath(roomIndex, g, 'lastName'),
            }}
            errors={errors}
            onChange={(patch) => onGuestChange(g, patch)}
          />
        ))}
      </div>
    </section>
  );
}

function GuestFields({
  label,
  roomLabel,
  guest,
  paths,
  errors,
  onChange,
}: {
  label: string;
  roomLabel: string;
  guest: GuestSlotDraft;
  paths: { title: string; firstName: string; lastName: string };
  errors: Readonly<Record<string, string>>;
  onChange: (patch: Partial<Pick<GuestSlotDraft, 'title' | 'firstName' | 'lastName'>>) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-2.5">
      <legend className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg)]">
        <UserRound aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
        <span className="sr-only">{roomLabel}, </span>
        {label}
      </legend>
      <TitleField
        value={guest.title}
        error={errors[paths.title]}
        onChange={(title) => onChange({ title })}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nombre" required error={errors[paths.firstName]}>
          {(props) => (
            <TextInput
              {...props}
              value={guest.firstName}
              onChange={(e) => onChange({ firstName: e.target.value })}
              autoComplete="off"
              autoCapitalize="words"
              spellCheck={false}
              maxLength={100}
              aria-required="true"
            />
          )}
        </Field>
        <Field label="Apellido" required error={errors[paths.lastName]}>
          {(props) => (
            <TextInput
              {...props}
              value={guest.lastName}
              onChange={(e) => onChange({ lastName: e.target.value })}
              autoComplete="off"
              autoCapitalize="words"
              spellCheck={false}
              maxLength={100}
              aria-required="true"
            />
          )}
        </Field>
      </div>
    </fieldset>
  );
}

/**
 * El título, elegido: nunca arranca marcado ni se deduce de nada (RF-18). Radios de verdad, como el
 * control de divulgación de Proveedores: se recorren con las flechas y se anuncian como grupo.
 */
function TitleField({
  value,
  error,
  onChange,
}: {
  value: GuestTitleDraft;
  error: string | undefined;
  onChange: (title: GuestTitleDraft) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1.5">
      <p id={labelId} className="text-xs font-semibold text-[var(--color-fg)]">
        Título
        <span className="ml-0.5 text-[var(--color-danger)]" aria-hidden="true">
          *
        </span>
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-required="true"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          'flex w-full gap-1 rounded-lg border bg-[var(--color-surface-muted)]/60 p-1 sm:w-auto sm:max-w-sm',
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]',
        )}
      >
        {TITLE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex-1 cursor-pointer rounded-md px-2 py-1.5 text-center text-xs font-semibold whitespace-nowrap text-[var(--color-fg-muted)] transition-colors',
              'has-[:checked]:bg-[var(--color-surface)] has-[:checked]:text-[var(--color-fg)] has-[:checked]:shadow-xs',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]',
            )}
          >
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              aria-invalid={error ? true : undefined}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * El contacto del HUÉSPED (D-TBO-23 A): queda en la reserva para avisarle a él. Al proveedor le
 * llega el de la agencia, así que acá no hace falta disimular nada.
 */
function ContactBlock({
  draft,
  onChange,
  errors,
}: {
  draft: GuestDraft;
  onChange: (next: GuestDraft) => void;
  errors: Readonly<Record<string, string>>;
}) {
  const { contact } = draft;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
          Contacto del huésped
        </h2>
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          Queda en la reserva para avisarle al huésped. Al proveedor le llega el contacto de la
          agencia.
        </p>
      </div>
      <fieldset className="min-w-0 space-y-3 px-4 py-4">
        <legend className="sr-only">Contacto del huésped</legend>
        <Field label="Email" required error={errors[CONTACT_FIELDS.email]}>
          {(props) => (
            <TextInput
              {...props}
              type="email"
              inputMode="email"
              value={contact.email}
              onChange={(e) => onChange(withContact(draft, { email: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
              maxLength={254}
              placeholder="nombre@dominio.com"
              aria-required="true"
            />
          )}
        </Field>
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
          <Field label="Prefijo" required error={errors[CONTACT_FIELDS.phoneCountryCode]}>
            {(props) => (
              <TextInput
                {...props}
                type="tel"
                inputMode="tel"
                value={contact.phoneCountryCode}
                onChange={(e) => onChange(withContact(draft, { phoneCountryCode: e.target.value }))}
                autoComplete="off"
                maxLength={4}
                placeholder="+57"
                className="tabular-nums"
                aria-required="true"
              />
            )}
          </Field>
          <Field label="Teléfono" required error={errors[CONTACT_FIELDS.phoneNumber]}>
            {(props) => (
              <TextInput
                {...props}
                type="tel"
                inputMode="tel"
                value={contact.phoneNumber}
                onChange={(e) => onChange(withContact(draft, { phoneNumber: e.target.value }))}
                autoComplete="off"
                maxLength={20}
                placeholder="300 123 4567"
                className="tabular-nums"
                aria-required="true"
              />
            )}
          </Field>
        </div>
      </fieldset>
    </Card>
  );
}
