'use client';

import { CheckCircle2, Loader2, Search, Ticket, X, XCircle } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
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

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
);
const labelClass = 'block text-xs font-medium text-[var(--color-fg)]';

interface Props {
  /** Prefill opcional (al venir desde una reserva recién confirmada). */
  prefill?: { lastName?: string; confirmationCode?: string };
  /** Si true, consulta automáticamente al montar (cuando el prefill está completo). */
  autoLookup?: boolean;
  onClose: () => void;
}

export function ReservationPanel({ prefill, autoLookup, onClose }: Props) {
  const [lastName, setLastName] = useState(prefill?.lastName ?? '');
  const [code, setCode] = useState(prefill?.confirmationCode ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [reservation, setReservation] = useState<CarReservation | null>(null);
  const [cancelMsg, setCancelMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [releaseMsg, setReleaseMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function lookup() {
    setError('');
    setCancelMsg(null);
    setReleaseMsg(null);
    startTransition(async () => {
      const res = await getCarReservationAction(lastName, code);
      if (!res.ok || !res.reservation) {
        setReservation(null);
        setError(res.error ?? 'No se encontró la reserva.');
        return;
      }
      setReservation(res.reservation);
    });
  }

  function cancel() {
    setError('');
    setCancelMsg(null);
    startTransition(async () => {
      const res = await cancelCarReservationAction(lastName, code);
      if (!res.ok || !res.result) {
        setCancelMsg({ ok: false, text: res.error ?? 'No se pudo cancelar.' });
        return;
      }
      setCancelMsg({
        ok: res.result.success,
        text: res.result.success
          ? 'Reserva cancelada.'
          : (res.result.message ?? 'No se pudo cancelar.'),
      });
      if (res.result.success && reservation) {
        setReservation({ ...reservation, status: 'cancelled' });
      }
    });
  }

  function release() {
    if (!reservation) return;
    setError('');
    setCancelMsg(null);
    setReleaseMsg(null);
    // referenceCode = confirmationCode de la reserva (contrato AgentCars /release).
    const referenceCode = reservation.confirmationCode;
    startTransition(async () => {
      const res = await releaseReservationAction(lastName, referenceCode);
      if (!res.ok || !res.result) {
        setReleaseMsg({ ok: false, text: res.error ?? 'No se pudo activar la reserva.' });
        return;
      }
      setReleaseMsg({ ok: true, text: 'Reserva activada.' });
      setReservation({ ...reservation, status: res.result.status });
    });
  }

  useEffect(() => {
    if (autoLookup && prefill?.lastName && prefill?.confirmationCode) lookup();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
            <Ticket className="size-4 text-[var(--color-primary)]" />
            Gestionar reserva de auto
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="rLastName" className={labelClass}>
                Apellido del conductor
              </label>
              <input
                id="rLastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="rCode" className={labelClass}>
                Código de confirmación
              </label>
              <input
                id="rCode"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={lookup}
              disabled={pending}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Consultar
            </button>
          </div>

          {error ? (
            <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-danger)]">
              {error}
            </div>
          ) : null}

          {reservation ? (
            <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-[var(--color-fg)]">
                    {reservation.firstName} {reservation.lastName}
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {reservation.confirmationCode} · {reservation.sippCode} · tarifa{' '}
                    {reservation.rateCode}
                  </p>
                </div>
                <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
                  {reservation.status}
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
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Reserva en espera (ON HOLD). Activala antes del pickup para confirmarla.
                </p>
              ) : null}

              {cancelMsg ? (
                <div
                  className={cn(
                    'rounded-lg px-3 py-2 text-xs',
                    cancelMsg.ok
                      ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 text-[var(--color-danger)]',
                  )}
                >
                  {cancelMsg.text}
                </div>
              ) : null}

              {releaseMsg ? (
                <div
                  className={cn(
                    'rounded-lg px-3 py-2 text-xs',
                    releaseMsg.ok
                      ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 text-[var(--color-danger)]',
                  )}
                >
                  {releaseMsg.text}
                </div>
              ) : null}

              {reservation.status !== 'cancelled' ? (
                <div className="flex flex-wrap gap-2">
                  {isOnHold(reservation.status) ? (
                    <button
                      type="button"
                      onClick={release}
                      disabled={pending}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="size-4" />
                      )}
                      Activar reserva
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={cancel}
                    disabled={pending}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-200 px-4 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XCircle className="size-4" />
                    Cancelar reserva
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
