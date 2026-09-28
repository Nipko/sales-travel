'use client';

import { AlertOctagon, RefreshCw } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Dialog } from '../../../../components/ui/dialog';
import { Textarea } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import { providerMetaFor } from '../../../../lib/provider-display';
import {
  callPolicyLabel,
  ENABLEMENT_CHOICES,
  killSwitchLabel,
  PRECEDENCE,
  REASON_MAX_LENGTH,
  reasonError,
  statusLabel,
  type EffectiveEnablement,
  type EnablementCallPolicy,
  type EnablementChangeDialog,
  type EnablementChoice,
  type EnablementKillLevel,
  type EnablementOrigin,
} from '../../../../lib/provider-enablement';

/*
 * Piezas comunes de la habilitación de proveedores: la vista de la plataforma
 * (`/admin/plataforma/proveedores`) y el detalle de un tenant (`/admin/tenants/[tenantId]`) usan
 * el MISMO control, la misma pastilla y el mismo rastro de decisión, para que un proveedor se lea
 * igual desde los dos lados.
 */

/** Nombre, ícono, código y política de un proveedor. */
export function ProviderIdentity({
  code,
  callPolicy,
  headingLevel = 3,
}: {
  code: string;
  callPolicy: EnablementCallPolicy;
  headingLevel?: 2 | 3 | 4;
}) {
  const meta = providerMetaFor(code);
  const Icon = meta.icon;
  const Heading = (['h2', 'h3', 'h4'] as const)[headingLevel - 2] ?? 'h3';
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <Heading className="truncate text-sm font-semibold text-[var(--color-fg)]">
          {meta.name}
        </Heading>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-fg-muted)]">
          <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-px font-mono text-[11px] text-[var(--color-fg-muted)]">
            {code}
          </code>
          <span>{callPolicyLabel(callPolicy)}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * El estado efectivo en palabras, con un punto de color que sólo REFUERZA: verde encendido, gris
 * apagado por ajuste, rojo sólo para el apagado de emergencia. El texto va siempre en el color de
 * primer plano, así el contraste no depende del tono.
 */
export function EnablementStatus({
  effective,
  className,
}: {
  effective: Pick<EffectiveEnablement, 'enabled' | 'origin'>;
  className?: string;
}) {
  const emergency = effective.origin === 'kill-switch';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]',
        emergency
          ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8'
          : effective.enabled
            ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/8'
            : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          emergency
            ? 'bg-[var(--color-danger)]'
            : effective.enabled
              ? 'bg-[var(--color-success)]'
              : 'bg-[var(--color-fg-subtle)]',
        )}
      />
      {emergency ? 'Apagado de emergencia' : statusLabel(effective)}
    </span>
  );
}

/**
 * El rastro de la decisión: las cinco capas de la regla, de la que más manda a la que menos, con
 * la que decidió marcada. Es la respuesta a "¿por qué está así?" sin leer documentación.
 */
export function DecisionTrail({
  origin,
  className,
}: {
  origin?: EnablementOrigin;
  className?: string;
}) {
  return (
    <ol
      aria-label={origin === undefined ? 'Orden de decisión' : 'Qué capa decide'}
      className={cn('flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]', className)}
    >
      {PRECEDENCE.map((step, i) => {
        const deciding = step.origin === origin;
        return (
          <li key={step.origin} className="flex items-center gap-1">
            {i > 0 ? (
              <span aria-hidden="true" className="text-[var(--color-fg-subtle)]">
                ›
              </span>
            ) : null}
            <span
              aria-current={deciding ? 'step' : undefined}
              className={cn(
                'rounded px-1.5 py-px',
                deciding
                  ? 'border border-[var(--color-border-strong)] bg-[var(--color-surface)] font-semibold text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                  : 'text-[var(--color-fg-subtle)]',
              )}
            >
              {deciding ? <span className="sr-only">Decide: </span> : null}
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Heredar / Habilitado / Deshabilitado. Radios nativos dentro de un fieldset: flechas del teclado,
 * lector de pantalla y foco visible sin reimplementar nada. Muestra lo GUARDADO: elegir otra
 * posición abre el diálogo y, si se cancela, el control no se movió.
 */
export function ChoiceControl({
  legend,
  value,
  onChange,
  disabled,
  choices = ENABLEMENT_CHOICES,
  className,
}: {
  legend: string;
  value: EnablementChoice | null;
  onChange: (choice: EnablementChoice) => void;
  disabled?: boolean;
  choices?: readonly { value: EnablementChoice; label: string }[];
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className={cn('w-full sm:w-auto', className)}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex w-full gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-1 sm:w-auto">
        {choices.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex-1 cursor-pointer rounded-md px-2.5 py-1.5 text-center text-xs font-semibold text-[var(--color-fg-muted)] transition-colors sm:flex-none sm:min-w-[92px]',
              'hover:text-[var(--color-fg)]',
              'has-[:checked]:bg-[var(--color-surface)] has-[:checked]:text-[var(--color-fg)] has-[:checked]:shadow-[var(--shadow-xs)]',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Interruptor accesible (`role="switch"`). */
export function Switch({
  checked,
  onToggle,
  label,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
          : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block size-4.5 rounded-full bg-[var(--color-surface)] shadow-[var(--shadow-sm)] transition-transform duration-150',
          checked ? 'translate-x-[22px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}

export function KillSwitchNotice({ level }: { level: EnablementKillLevel }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs leading-relaxed text-[var(--color-fg)]">
      <AlertOctagon
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-danger)]"
      />
      <span>
        {killSwitchLabel(level)} Le gana a cualquier ajuste de este panel; los cambios que hagas acá
        valen cuando operaciones lo levante.
      </span>
    </p>
  );
}

/**
 * El diálogo de todo cambio: confirma lo que puede apagar y recoge el motivo que queda en la
 * auditoría. `onConfirm` resuelve con un mensaje de error o `undefined` si salió bien.
 */
export function ChangeDialog({
  dialog,
  initialReason,
  onConfirm,
  onClose,
}: {
  dialog: EnablementChangeDialog;
  initialReason: string;
  onConfirm: (reason: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const reasonId = useId();
  const hintId = `${reasonId}-hint`;
  const invalid = dialog.withReason ? reasonError(reason) : undefined;

  // `useModalBehavior` rehace su efecto —y mueve el foco— cada vez que cambia la identidad de
  // `onClose`. Con refs, el cierre es una sola función durante toda la vida del diálogo, y
  // Escape no cierra a mitad de un guardado.
  const savingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);

  async function confirm() {
    if (invalid !== undefined || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const failure = await onConfirm(reason);
    savingRef.current = false;
    // Si salió bien, el padre ya desmontó el diálogo: no hay estado que tocar.
    if (failure !== undefined) {
      setSaving(false);
      setError(failure);
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title={dialog.title}
      description={dialog.description}
      className="max-w-lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
        className="space-y-4"
      >
        {dialog.withReason ? (
          <div className="space-y-1.5">
            <label
              htmlFor={reasonId}
              className="block text-xs font-semibold text-[var(--color-fg)]"
            >
              Motivo <span className="font-normal text-[var(--color-fg-muted)]">(opcional)</span>
            </label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX_LENGTH}
              rows={3}
              placeholder="Ej.: contrato firmado, deuda vencida, piloto con esta red…"
              aria-invalid={invalid !== undefined}
              aria-describedby={hintId}
            />
            <p
              id={hintId}
              className={cn(
                'text-[11px]',
                invalid ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]',
              )}
            >
              {invalid ?? 'Queda en la auditoría junto con quién hizo el cambio y cuándo.'}
            </p>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={dialog.destructive ? 'danger' : 'primary'}
            disabled={saving || invalid !== undefined}
          >
            {saving ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
            {saving ? 'Guardando…' : dialog.confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
