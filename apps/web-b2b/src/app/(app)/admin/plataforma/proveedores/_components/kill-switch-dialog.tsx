'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../../../../components/ui/button';
import { Dialog } from '../../../../../../components/ui/dialog';
import { Field, Textarea, TextInput } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import type { EnablementKillLevel } from '../../../../../../lib/provider-enablement';
import {
  KILL_EXPIRY_OPTIONS,
  KILL_LEVEL_OPTIONS,
  KILL_REASON_MAX,
  KILL_REASON_MIN,
  killSwitchDialogCopy,
  requiredReasonError,
  typedCodeMatches,
  type KillSwitchBody,
  type KillSwitchExpiry,
} from '../../../../../../lib/provider-health';

const REASON_HINT = `Entre ${KILL_REASON_MIN} y ${KILL_REASON_MAX} caracteres. Queda en la auditoría de la plataforma.`;

/** El diálogo no se cierra mientras el pedido está en vuelo, y el cierre es una sola función. */
function useGuardedClose(onClose: () => void) {
  const sendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!sendingRef.current) onCloseRef.current();
  }, []);
  return { sendingRef, close };
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
    >
      {children}
    </p>
  );
}

/** Una opción de radio en tarjeta: el texto entero es la etiqueta, y el foco se ve. */
function RadioCard({
  name,
  checked,
  onChange,
  disabled,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed text-[var(--color-fg)] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]',
        checked
          ? 'border-[var(--color-danger)]/50 bg-[var(--color-danger)]/6'
          : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-danger)] focus-visible:outline-none"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * Apagado de emergencia de un proveedor: qué corta (sólo ventas o todo), cuándo vence, el motivo y
 * el código escrito para confirmar. El botón queda `aria-disabled` hasta que el código coincide: se
 * puede llegar a él con el teclado y oír por qué no actúa, pero no dispara nada.
 *
 * `onConfirm` resuelve con un mensaje de error o `undefined` si salió bien (el padre lo cierra).
 */
export function KillSwitchDialog({
  code,
  initialLevel = 'sales',
  onConfirm,
  onClose,
}: {
  code: string;
  /** El nivel con que arranca: el del apagado vigente, para no bajarlo sin querer al reemplazarlo. */
  initialLevel?: EnablementKillLevel | undefined;
  onConfirm: (body: KillSwitchBody) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const copy = killSwitchDialogCopy(code);
  const [level, setLevel] = useState<EnablementKillLevel>(initialLevel);
  const [expiry, setExpiry] = useState<KillSwitchExpiry>(240);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();
  const levelName = useId();
  const expiryName = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const typedRef = useRef<HTMLInputElement>(null);
  const { sendingRef, close } = useGuardedClose(onClose);

  const reasonError = requiredReasonError(reason);
  const matches = typedCodeMatches(typed, code);

  async function submit() {
    if (sendingRef.current) return;
    if (reasonError !== undefined) {
      setTouched(true);
      reasonRef.current?.focus();
      return;
    }
    if (!matches) {
      typedRef.current?.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError('');
    const failure = await onConfirm({ level, reason: reason.trim(), expiresInMinutes: expiry });
    sendingRef.current = false;
    // Si salió bien, el padre ya desmontó el diálogo: no hay estado que tocar.
    if (failure !== undefined) {
      setSending(false);
      setError(failure);
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title={copy.title}
      description={copy.description}
      className="max-w-lg"
      footer={
        <div className="space-y-3">
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={close} disabled={sending}>
              Cancelar
            </Button>
            <Button
              form={formId}
              type="submit"
              variant="danger"
              aria-disabled={!matches || sending}
              className={cn(!matches && 'cursor-not-allowed opacity-50 hover:opacity-50')}
            >
              {sending ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
              {sending ? 'Apagando…' : copy.confirmLabel}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <fieldset className="space-y-2" disabled={sending}>
          <legend className="mb-1.5 text-xs font-semibold text-[var(--color-fg)]">Qué corta</legend>
          {KILL_LEVEL_OPTIONS.map((option) => (
            <RadioCard
              key={option.value}
              name={levelName}
              checked={level === option.value}
              onChange={() => setLevel(option.value)}
              disabled={sending}
            >
              <span className="font-semibold">{option.label}:</span> {option.detail}
            </RadioCard>
          ))}
        </fieldset>

        <fieldset disabled={sending}>
          <legend className="mb-1.5 text-xs font-semibold text-[var(--color-fg)]">Vence</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {KILL_EXPIRY_OPTIONS.map((option) => (
              <RadioCard
                key={option.label}
                name={expiryName}
                checked={expiry === option.value}
                onChange={() => setExpiry(option.value)}
                disabled={sending}
              >
                {option.label}
              </RadioCard>
            ))}
          </div>
        </fieldset>

        <Field label="Motivo" required error={touched ? reasonError : undefined} hint={REASON_HINT}>
          {(a11y) => (
            <Textarea
              {...a11y}
              ref={reasonRef}
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(reason.trim() !== '' || touched)}
              maxLength={KILL_REASON_MAX}
              rows={3}
              placeholder="Ej.: el proveedor devuelve tarifas en cero desde las 14:00."
              disabled={sending}
            />
          )}
        </Field>

        <Field label={copy.typedLabel} required>
          {(a11y) => (
            <TextInput
              {...a11y}
              ref={typedRef}
              name="confirmCode"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={code}
              className="font-mono"
              disabled={sending}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * Una confirmación con motivo: reanudar un proveedor (motivo opcional) o cerrar su circuito
 * (obligatorio). `onConfirm` resuelve con un mensaje de error o `undefined` si salió bien.
 */
export function ReasonConfirmDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  reasonRequired,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  reasonRequired: boolean;
  onConfirm: (reason: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const { sendingRef, close } = useGuardedClose(onClose);

  const reasonError = reasonRequired
    ? requiredReasonError(reason)
    : reason.trim().length > KILL_REASON_MAX
      ? `El motivo no puede superar los ${KILL_REASON_MAX} caracteres.`
      : undefined;

  async function submit() {
    if (sendingRef.current) return;
    if (reasonError !== undefined) {
      setTouched(true);
      reasonRef.current?.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError('');
    const failure = await onConfirm(reason.trim());
    sendingRef.current = false;
    if (failure !== undefined) {
      setSending(false);
      setError(failure);
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={description}
      className="max-w-lg"
      footer={
        <div className="space-y-3">
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={close} disabled={sending}>
              Cancelar
            </Button>
            <Button form={formId} type="submit" variant="primary" disabled={sending}>
              {sending ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
              {sending ? pendingLabel : confirmLabel}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label={reasonRequired ? 'Motivo' : 'Motivo (opcional)'}
          required={reasonRequired}
          error={touched ? reasonError : undefined}
          hint={reasonRequired ? REASON_HINT : 'Queda en la auditoría de la plataforma.'}
        >
          {(a11y) => (
            <Textarea
              {...a11y}
              ref={reasonRef}
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(reason.trim() !== '' || touched)}
              maxLength={KILL_REASON_MAX}
              rows={3}
              disabled={sending}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
