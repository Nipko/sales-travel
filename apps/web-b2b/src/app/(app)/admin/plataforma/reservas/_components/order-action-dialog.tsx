'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { Dialog } from '../../../../../../components/ui/dialog';
import { Field, Textarea, TextInput } from '../../../../../../components/ui/field';
import { ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import {
  CONFIRMATION_NOT_SENT,
  ORDER_ACTION_REASON_LABEL,
  ORDER_ACTION_REASON_MAX,
  RETRIEVE_DONE_TOAST,
  RETRIEVE_NOT_FOUND_TOAST,
  actionDialogCopy,
  actionReasonError,
  cancelDoneToast,
  confirmationSentToast,
  needsPenaltyEstimate,
  penaltyLineOf,
  retryDoneToast,
  typedConfirmationHint,
  typedOrderNumberMatches,
  type ConsoleCancelOutcome,
  type PenaltyState,
  type PlatformOrderAction,
  type ProviderReadingView,
} from '../../../../../../lib/platform-order-actions';
import type { PlatformOrderDetail } from '../../../../../../lib/platform-orders';
import {
  cancelPlatformOrder,
  loadPlatformCancellationEstimate,
  retrievePlatformOrder,
  retryPlatformOrderCancellation,
  sendPlatformOrderConfirmation,
} from '../../../../../../lib/platform-orders-client';

/** Lo que vuelve a la ficha cuando la acción terminó. */
export interface OrderActionDone {
  /** La ficha releída por el API (consultar al proveedor); sin ella, la ficha se vuelve a pedir. */
  readonly detail?: PlatformOrderDetail;
  /** Lo que respondió el proveedor al consultarlo: en vuelos sólo existe en la pantalla. */
  readonly reading?: ProviderReadingView;
}

const REASON_HINT = `Entre 5 y ${ORDER_ACTION_REASON_MAX} caracteres. Lo ven la agencia y la plataforma.`;

function initialPenalty(action: PlatformOrderAction, detail: PlatformOrderDetail): PenaltyState {
  if (action.kind !== 'cancel') return { kind: 'not-estimated' };
  return needsPenaltyEstimate(detail) ? { kind: 'loading' } : { kind: 'not-estimated' };
}

/**
 * La confirmación de una acción de post-venta del superadmin sobre una reserva de otro nodo:
 * reenviar la confirmación, consultar al proveedor, reintentar una cancelación o cancelar.
 *
 * Todas piden el motivo, que queda en la auditoría del nodo. Cancelar además muestra la penalidad
 * estimada (sólo hoteles: el resto la informa el proveedor) y pide escribir el número de la orden; su
 * botón es el de peligro. Mientras el pedido está en vuelo el diálogo no se cierra: una cancelación
 * a medio enviar no se abandona.
 */
export function OrderActionDialog({
  action,
  detail,
  onClose,
  onDone,
}: {
  action: PlatformOrderAction;
  detail: PlatformOrderDetail;
  onClose: () => void;
  onDone: (done: OrderActionDone) => void;
}) {
  const copy = actionDialogCopy(action, detail);
  const isCancel = action.kind === 'cancel';
  const orderId = detail.order.id;
  const orderNumber = detail.order.orderNumber;
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [penalty, setPenalty] = useState<PenaltyState>(() => initialPenalty(action, detail));
  const formId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const sendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!sendingRef.current) onCloseRef.current();
  }, []);

  const loadPenalty = useCallback(async () => {
    setPenalty({ kind: 'loading' });
    const res = await loadPlatformCancellationEstimate(orderId);
    setPenalty(
      res.ok ? { kind: 'ready', estimate: res.data } : { kind: 'error', message: res.message },
    );
  }, [orderId]);

  // Sólo las de hotel tienen penalidad estimada; se pide al abrir.
  const estimates = isCancel && needsPenaltyEstimate(detail);
  useEffect(() => {
    if (estimates) void loadPenalty();
  }, [estimates, loadPenalty]);

  const reasonError = actionReasonError(reason);
  const typedOk = !isCancel || typedOrderNumberMatches(typed, orderNumber);
  const penaltyView = isCancel ? penaltyLineOf(penalty, detail) : null;
  const blocked = penaltyView?.blocked ?? null;
  // Cancelar un hotel sin su penalidad a la vista no se ofrece: primero se vuelve a calcular.
  const penaltyMissing = penalty.kind === 'loading' || penalty.kind === 'error';
  const disabled = sending || blocked !== null || penaltyMissing || !typedOk;

  function finishCancel(outcome: ConsoleCancelOutcome, retry: boolean) {
    if (outcome.kind === 'failed') {
      // No se tocó nada: se corrige aquí y se vuelve a enviar.
      setError(outcome.message);
      return;
    }
    if (outcome.kind === 'unknown' || outcome.kind === 'not-cancelled') {
      // Pudo haber salido, o quedó un intento que la ficha tiene que mostrar (rechazado o por
      // conciliar): no se ofrece repetirla desde aquí. La ficha se relee y su historial dice qué hacer.
      toast.error(outcome.message);
    } else {
      toast.success(
        retry
          ? retryDoneToast(outcome.inProgress)
          : cancelDoneToast(orderNumber, outcome.inProgress),
      );
    }
    onDone({});
  }

  async function run(motivo: string): Promise<void> {
    switch (action.kind) {
      case 'send-confirmation': {
        const res = await sendPlatformOrderConfirmation(orderId, motivo);
        if (!res.ok) {
          setError(res.message);
        } else if (!res.data.sent) {
          // Quedó en la auditoría como intento fallido; el diálogo sigue abierto para reintentar.
          setError(CONFIRMATION_NOT_SENT);
        } else {
          toast.success(confirmationSentToast(res.data.to));
          onDone({});
        }
        return;
      }
      case 'retrieve': {
        const res = await retrievePlatformOrder(orderId, motivo);
        if (!res.ok) {
          setError(res.message);
          return;
        }
        if (res.data.found) toast.success(RETRIEVE_DONE_TOAST);
        else toast.warning(RETRIEVE_NOT_FOUND_TOAST);
        onDone({
          reading: res.data.reading,
          ...(res.data.detail === undefined ? {} : { detail: res.data.detail }),
        });
        return;
      }
      case 'retry-cancel':
        finishCancel(
          await retryPlatformOrderCancellation(orderId, action.operationId, motivo),
          true,
        );
        return;
      case 'cancel':
        finishCancel(await cancelPlatformOrder(orderId, motivo, orderNumber), false);
        return;
    }
  }

  async function submit() {
    if (sendingRef.current || disabled) return;
    if (reasonError !== undefined) {
      setTouched(true);
      reasonRef.current?.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      await run(reason.trim());
    } finally {
      sendingRef.current = false;
      setSending(false);
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
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
            >
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={close} disabled={sending}>
              Volver
            </Button>
            <Button
              form={formId}
              type="submit"
              variant={copy.destructive ? 'danger' : 'primary'}
              disabled={disabled}
            >
              {sending ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
              {sending ? copy.pendingLabel : copy.confirmLabel}
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
        {penaltyView !== null ? (
          <div
            className="space-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2.5"
            aria-live="polite"
            aria-busy={penalty.kind === 'loading' || undefined}
          >
            <p className="text-sm font-medium text-[var(--color-fg)]">{penaltyView.line}</p>
            {penaltyView.notes.length > 0 ? (
              <ul className="space-y-1 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                {penaltyView.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            {penalty.kind === 'error' ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={() => void loadPenalty()}
              >
                Volver a calcular
              </Button>
            ) : null}
          </div>
        ) : null}

        {blocked !== null ? (
          <ToneNotice tone="danger" role="status">
            {blocked}
          </ToneNotice>
        ) : null}

        <Field
          label={ORDER_ACTION_REASON_LABEL}
          required
          error={touched ? reasonError : undefined}
          hint={REASON_HINT}
        >
          {(a11y) => (
            <Textarea
              {...a11y}
              ref={reasonRef}
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(reason.trim() !== '' || touched)}
              maxLength={ORDER_ACTION_REASON_MAX}
              rows={3}
              placeholder="Ej.: la agencia no puede entrar al panel y el cliente lo pidió por teléfono."
              disabled={sending}
            />
          )}
        </Field>

        {isCancel ? (
          <Field label="Número de la orden" required hint={typedConfirmationHint(orderNumber)}>
            {(a11y) => (
              <TextInput
                {...a11y}
                name="orderNumber"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                placeholder={String(orderNumber)}
                disabled={sending}
              />
            )}
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
