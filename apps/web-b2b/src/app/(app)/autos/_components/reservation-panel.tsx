'use client';

import { CircleCheck, Loader2, PauseCircle, Search, Ticket, X, XCircle } from 'lucide-react';
import { useEffect, useId, useState, useTransition, type FormEvent } from 'react';
import { useConfirm, useModalBehavior } from '../../../../components/ui/dialog';
import { Field, TextInput } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import {
  cancelCarReservationAction,
  getCarReservationAction,
  releaseReservationAction,
  type CarReservation,
} from '../actions';
import { VoucherDetails } from './voucher-details';

/** Detecta una reserva en estado ON HOLD a partir de su `status` textual del proveedor. */
function isOnHold(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'on_hold' || s.includes('hold');
}

function isCancelled(status: string): boolean {
  return /cancel/i.test(status);
}

/** El estado del proveedor ("Active", "On Hold", "cancelled"…) dicho en español. */
function statusLabel(status: string): string {
  if (isCancelled(status)) return 'Cancelada';
  if (isOnHold(status)) return 'En espera';
  if (/request/i.test(status)) return 'A confirmar';
  if (/activ|confirm/i.test(status)) return 'Confirmada';
  return status || 'Sin estado';
}

interface Props {
  /** Prefill opcional (al venir desde una reserva recién confirmada). */
  prefill?: { lastName?: string; confirmationCode?: string };
  /** Si true, consulta automáticamente al montar (cuando el prefill está completo). */
  autoLookup?: boolean;
  onClose: () => void;
}

export function ReservationPanel({ prefill, autoLookup, onClose }: Props) {
  const panelRef = useModalBehavior(true, onClose);
  const titleId = useId();
  const [confirm, confirmElement] = useConfirm();
  const [lastName, setLastName] = useState(prefill?.lastName ?? '');
  const [code, setCode] = useState(prefill?.confirmationCode ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [reservation, setReservation] = useState<CarReservation | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function lookup() {
    setError('');
    setMessage(null);
    startTransition(async () => {
      const res = await getCarReservationAction(lastName, code);
      if (!res.ok || !res.reservation) {
        setReservation(null);
        setError(res.error ?? 'No encontramos la reserva.');
        return;
      }
      setReservation(res.reservation);
    });
  }

  async function cancel() {
    if (!reservation) return;
    const ok = await confirm({
      title: '¿Cancelar la reserva?',
      description: `Se cancela la reserva ${reservation.confirmationCode} en AgentCars. Si es prepago y faltan menos de 2 días para el retiro, puede tener penalidad. No se puede deshacer.`,
      confirmLabel: 'Cancelar reserva',
    });
    if (!ok) return;
    setError('');
    setMessage(null);
    startTransition(async () => {
      const res = await cancelCarReservationAction(lastName, code);
      if (!res.ok || !res.result) {
        setMessage({ ok: false, text: res.error ?? 'No se pudo cancelar.' });
        return;
      }
      setMessage({
        ok: res.result.success,
        text: res.result.success
          ? 'Reserva cancelada.'
          : (res.result.message ?? 'No se pudo cancelar.'),
      });
      if (res.result.success) setReservation({ ...reservation, status: 'cancelled' });
    });
  }

  function release() {
    if (!reservation) return;
    setError('');
    setMessage(null);
    // referenceCode = confirmationCode de la reserva (contrato AgentCars /release).
    const referenceCode = reservation.confirmationCode;
    startTransition(async () => {
      const res = await releaseReservationAction(lastName, referenceCode);
      if (!res.ok || !res.result) {
        setMessage({ ok: false, text: res.error ?? 'No se pudo activar la reserva.' });
        return;
      }
      setMessage({ ok: true, text: 'Reserva activada.' });
      setReservation({ ...reservation, status: res.result.status });
    });
  }

  useEffect(() => {
    if (autoLookup && prefill?.lastName && prefill?.confirmationCode) lookup();
    // Sólo al montar: la consulta automática es la de la reserva recién hecha.
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    lookup();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[90dvh] w-full max-w-lg animate-fade-in flex-col rounded-t-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] sm:rounded-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <h2
            id={titleId}
            className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]"
          >
            <Ticket aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
            Gestionar reserva de auto
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Apellido del conductor">
                {(props) => (
                  <TextInput
                    {...props}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field label="Código de confirmación">
                {(props) => (
                  <TextInput
                    {...props}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono uppercase"
                  />
                )}
              </Field>
            </div>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Search aria-hidden="true" className="size-4" />
              )}
              Consultar
            </button>
          </form>

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-danger)]"
            >
              {error}
            </p>
          ) : null}

          {reservation ? (
            <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-fg)]">
                    {reservation.firstName} {reservation.lastName}
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    <span className="font-mono">{reservation.confirmationCode}</span> ·{' '}
                    {reservation.sippCode} · tarifa {reservation.rateCode}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    isCancelled(reservation.status)
                      ? 'border-[var(--color-danger)]/35 text-[var(--color-danger)]'
                      : isOnHold(reservation.status)
                        ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
                  )}
                >
                  {statusLabel(reservation.status)}
                </span>
              </div>

              {reservation.voucherNumber ? (
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Voucher:{' '}
                  <span className="font-mono font-medium text-[var(--color-fg)]">
                    {reservation.voucherNumber}
                  </span>
                </p>
              ) : null}

              <div className="border-t border-[var(--color-border)] pt-2">
                <VoucherDetails voucher={reservation.voucherInformation ?? {}} />
              </div>

              {isOnHold(reservation.status) ? (
                <p className="flex items-start gap-1.5 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
                  <PauseCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  Reserva en espera (ON HOLD). Actívala al menos 48 horas antes del retiro o se
                  cancela sola.
                </p>
              ) : null}

              <div aria-live="polite" aria-atomic="true">
                {message ? (
                  <p
                    className={cn(
                      'flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs',
                      message.ok
                        ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-fg)]'
                        : 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 text-[var(--color-danger)]',
                    )}
                  >
                    {message.ok ? (
                      <CircleCheck
                        aria-hidden="true"
                        className="mt-px size-3.5 shrink-0 text-[var(--color-success)]"
                      />
                    ) : null}
                    {message.text}
                  </p>
                ) : null}
              </div>

              {!isCancelled(reservation.status) ? (
                <div className="flex flex-wrap gap-2">
                  {isOnHold(reservation.status) ? (
                    <button
                      type="button"
                      onClick={release}
                      disabled={pending}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pending ? (
                        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                      ) : (
                        <CircleCheck aria-hidden="true" className="size-4" />
                      )}
                      Activar reserva
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void cancel()}
                    disabled={pending}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XCircle aria-hidden="true" className="size-4" />
                    Cancelar reserva
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {confirmElement}
      </div>
    </div>
  );
}
