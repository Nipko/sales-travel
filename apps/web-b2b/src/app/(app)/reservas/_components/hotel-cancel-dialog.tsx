'use client';

import { AlertTriangle, Ban, CircleCheck, CircleHelp, Hourglass, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { useModalBehavior } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';
import { readJson } from '../../../../lib/read-json';
import type { OrderOperationView } from '../cancel-retry-policy';
import {
  ESTIMATE_DISCLAIMER,
  hotelCancellationBlock,
  hotelCancelOutcomeOf,
  parseCancellationEstimate,
  penaltyViewOf,
  type HotelCancelOutcome,
  type PenaltyView,
} from '../hotel-cancellation-view';
import { hotelStayOf, type HotelOrderInput } from '../hotel-order-view';

/*
 * Cancelar una reserva de hotel (U-17; RF-25; D-TBO-25 A, D-TBO-26 A): primero la penalidad
 * estimada con la política aceptada al reservar, después la confirmación explícita, y al final lo
 * que respondió el proveedor, que puede ser "Cancelación en curso" y no "Cancelada".
 *
 * El pedido sale una sola vez: mientras está en vuelo no se puede cerrar ni volver a tocar, y ante
 * una respuesta que no llega nunca se ofrece repetirlo. El "Reintentar" del historial también pasa
 * por acá: un reintento es otra cancelación para el vendedor, con la penalidad de hoy.
 */

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly penalty: PenaltyView; readonly block?: string }
  | { readonly kind: 'sending'; readonly penalty: PenaltyView }
  | { readonly kind: 'done'; readonly outcome: HotelCancelOutcome };

const ESTIMATE_FAILED =
  'No pudimos calcular la penalidad estimada. Sin verla no se envía la cancelación: probá de nuevo.';

const OPS_FAILED =
  'No pudimos comprobar si hay una cancelación anterior. Por seguridad no se envía la operación.';

async function loadPhase(
  orderId: string,
  sale: { amountMinor: number; currency: string },
  retryOperationId: string | undefined,
) {
  const id = encodeURIComponent(orderId);
  const [estimateRes, opsRes] = await Promise.all([
    fetch(`/api/orders/${id}/cancellation-estimate`).catch(() => null),
    fetch(`/api/orders/${id}/operations`).catch(() => null),
  ]);
  if (estimateRes === null) return { kind: 'error', message: ESTIMATE_FAILED } as const;
  const read = await readJson<{ error?: string }>(estimateRes);
  if (!read.ok) return { kind: 'error', message: read.message } as const;
  if (!estimateRes.ok) {
    return { kind: 'error', message: read.data.error ?? ESTIMATE_FAILED } as const;
  }
  const estimate = parseCancellationEstimate(read.data);
  if (estimate === undefined) return { kind: 'error', message: ESTIMATE_FAILED } as const;
  const penalty = penaltyViewOf(estimate, sale);

  let block: string | undefined = penalty.blocked;
  if (block === undefined) {
    const ops =
      opsRes === null ? null : await readJson<{ operations?: OrderOperationView[] }>(opsRes);
    block =
      ops === null || !ops.ok || !opsRes?.ok || !Array.isArray(ops.data.operations)
        ? OPS_FAILED
        : (hotelCancellationBlock(ops.data.operations, retryOperationId) ?? undefined);
  }
  return { kind: 'ready', penalty, ...(block === undefined ? {} : { block }) } as const;
}

const OUTCOME_STYLE: Readonly<
  Record<HotelCancelOutcome['kind'], { box: string; icon: typeof CircleCheck }>
> = {
  cancelled: {
    box: 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10',
    icon: CircleCheck,
  },
  'in-progress': {
    box: 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
    icon: Hourglass,
  },
  rejected: { box: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5', icon: Ban },
  error: { box: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5', icon: Ban },
  unknown: {
    box: 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
    icon: CircleHelp,
  },
};

export function HotelCancelDialog({
  order,
  retryOperationId,
  onClose,
}: {
  order: HotelOrderInput;
  /** El intento fallido que se reintenta (`POST …/operations/:opId/retry`); sin él, uno nuevo. */
  retryOperationId?: string;
  /** Se llama al cerrar; `attempted` = salió un pedido y la reserva puede haber cambiado. */
  onClose: (attempted: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [acknowledged, setAcknowledged] = useState(false);
  const attempted = useRef(false);
  const sendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const ackId = useId();
  const resultRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const sending = phase.kind === 'sending';
  // Estable a propósito: si cambiara con la fase, el modal soltaría y recuperaría el foco en cada
  // paso, y en pleno envío lo devolvería a la pantalla de atrás.
  const close = useCallback(() => {
    if (!sendingRef.current) onCloseRef.current(attempted.current);
  }, []);
  const panelRef = useModalBehavior(true, close);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    setPhase(
      await loadPhase(
        order.id,
        { amountMinor: order.totalAmount, currency: order.currency },
        retryOperationId,
      ),
    );
  }, [order.id, order.totalAmount, order.currency, retryOperationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (phase.kind === 'done') resultRef.current?.focus();
  }, [phase.kind]);

  async function confirm() {
    if (sendingRef.current || phase.kind !== 'ready' || phase.block) return;
    if (phase.penalty.requiresAcknowledgement && !acknowledged) return;
    attempted.current = true;
    sendingRef.current = true;
    setPhase({ kind: 'sending', penalty: phase.penalty });
    let outcome: HotelCancelOutcome;
    try {
      const id = encodeURIComponent(order.id);
      const url =
        retryOperationId === undefined
          ? `/api/orders/${id}/cancel`
          : `/api/orders/${id}/operations/${encodeURIComponent(retryOperationId)}/retry`;
      const res = await fetch(url, { method: 'POST' });
      const read = await readJson<unknown>(res);
      outcome = hotelCancelOutcomeOf(read.ok ? res.status : 0, read.ok ? read.data : null);
    } catch {
      outcome = hotelCancelOutcomeOf(0, null);
    }
    sendingRef.current = false;
    setPhase({ kind: 'done', outcome });
  }

  const stay = hotelStayOf(order);
  const rooms = stay?.rooms ?? 0;
  const penalty = phase.kind === 'ready' || phase.kind === 'sending' ? phase.penalty : undefined;
  const OutcomeIcon = phase.kind === 'done' ? OUTCOME_STYLE[phase.outcome.kind].icon : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={phase.kind === 'loading' || sending ? 'true' : undefined}
        className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]"
      >
        <div className="flex items-start gap-2.5 border-b border-[var(--color-border)] p-5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
            <AlertTriangle aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
              {retryOperationId === undefined
                ? `Cancelar reserva #${order.orderNumber}`
                : `Reintentar la cancelación de la reserva #${order.orderNumber}`}
            </h2>
            {stay ? (
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">Hotel · {stay.dates}</p>
            ) : null}
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {phase.kind === 'loading' ? (
            <div className="space-y-2" role="status">
              <span className="sr-only">Calculando la penalidad estimada…</span>
              <div className="h-4 w-32 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="h-7 w-44 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="h-3 w-full animate-pulse rounded bg-[var(--color-surface-muted)]" />
            </div>
          ) : null}

          {phase.kind === 'error' ? (
            <div
              role="alert"
              className="space-y-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2.5 text-[var(--color-fg)]"
            >
              <p>{phase.message}</p>
              <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => void load()}>
                <RefreshCw aria-hidden="true" className="size-3.5" /> Calcular de nuevo
              </Button>
            </div>
          ) : null}

          {penalty ? (
            <section aria-label="Penalidad estimada" className="space-y-2">
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-3">
                <p className="text-[11px] text-[var(--color-fg-muted)]">Penalidad estimada</p>
                <p
                  className={cn(
                    'mt-0.5 text-lg font-semibold tabular-nums tracking-tight',
                    penalty.tone === 'free'
                      ? 'text-[var(--color-success)]'
                      : 'text-[var(--color-fg)]',
                  )}
                >
                  {penalty.headline}
                </p>
                <ul className="mt-1.5 space-y-1 text-[var(--color-fg-muted)]">
                  {penalty.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                {ESTIMATE_DISCLAIMER}
              </p>
              {rooms > 1 ? (
                <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                  Se cancela la reserva completa, con sus {rooms} habitaciones: el proveedor no
                  cancela habitaciones sueltas.
                </p>
              ) : null}
            </section>
          ) : null}

          {phase.kind === 'ready' && phase.block ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2.5 text-[var(--color-fg)]"
            >
              <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{phase.block}</p>
            </div>
          ) : null}

          {phase.kind === 'ready' && !phase.block && phase.penalty.requiresAcknowledgement ? (
            <label
              htmlFor={ackId}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-[var(--color-fg)]"
            >
              <input
                id={ackId}
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 rounded border-[var(--color-border)] accent-[var(--color-danger)]"
              />
              <span>
                Entiendo que la cancelación no se puede deshacer y que el proveedor puede cobrar{' '}
                {phase.penalty.tone === 'unknown'
                  ? 'un cargo que no podemos estimar'
                  : 'esta penalidad'}
                .
              </span>
            </label>
          ) : null}

          {sending ? (
            <p role="status" className="text-[11px] text-[var(--color-fg-muted)]">
              Enviando la cancelación al proveedor. Puede tardar hasta un minuto: no cierres esta
              ventana.
            </p>
          ) : null}

          {phase.kind === 'done' ? (
            <div
              ref={resultRef}
              tabIndex={-1}
              role={
                phase.outcome.kind === 'cancelled' || phase.outcome.kind === 'in-progress'
                  ? 'status'
                  : 'alert'
              }
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-3 text-[var(--color-fg)] focus-visible:outline-none',
                OUTCOME_STYLE[phase.outcome.kind].box,
              )}
            >
              {OutcomeIcon ? (
                <OutcomeIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              ) : null}
              <p className="leading-relaxed">
                <strong className="font-semibold">{phase.outcome.title}.</strong>{' '}
                {phase.outcome.message}
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] p-4">
          {phase.kind === 'done' ? (
            <Button variant="secondary" size="sm" onClick={close}>
              Cerrar
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" disabled={sending} onClick={close}>
                No, volver
              </Button>
              {phase.kind === 'ready' || sending ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={
                    sending ||
                    (phase.kind === 'ready' &&
                      (phase.block !== undefined ||
                        (phase.penalty.requiresAcknowledgement && !acknowledged)))
                  }
                  onClick={() => void confirm()}
                >
                  {sending
                    ? 'Cancelando…'
                    : retryOperationId === undefined
                      ? 'Sí, cancelar reserva'
                      : 'Sí, reintentar la cancelación'}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
