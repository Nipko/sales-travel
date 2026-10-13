'use client';

import { AlertTriangle, FlaskConical, Ticket } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Dialog } from '../../../../components/ui/dialog';
import { readJson } from '../../../../lib/read-json';
import { isTestOrder } from '../../../../lib/test-content';
import { ticketingState } from '../../../../lib/ticketing-deadline';
import { formatMoney } from '../../hoteles/_components/hotel-format';
import type { OrderOperationView } from '../cancel-retry-policy';
import { orderTicketingDeadline } from '../flight-order-view';
import {
  ISSUE_MESSAGES,
  issueBlock,
  issueRequestBody,
  issueResponseOf,
  type IssuableOrder,
} from '../issue-ticket-view';
import { FlightDeadlineBadge, type FlightTrackingOrder } from './flight-order-tracking';

/*
 * Confirmar la emisión de los tiquetes de una reserva (SAB-08). Muestra lo que se va a emitir —el
 * total, el plazo y cómo se paga— y manda el pedido UNA vez. La emisión corre en la cola del API:
 * con el 202 el diálogo se cierra y Reservas sigue la operación, así que el vendedor puede seguir
 * trabajando mientras la aerolínea emite.
 *
 * Antes de ofrecer el botón se mira el historial: con una emisión en curso o en duda no se ofrece
 * otra. El API aplica la misma compuerta.
 */

export interface IssueTicketOrder extends IssuableOrder, FlightTrackingOrder {
  readonly id: string;
  readonly orderNumber: number;
  readonly testContent?: boolean;
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly block?: string; readonly error?: string }
  | { readonly kind: 'sending' };

async function loadBlock(orderId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/operations`);
    const read = await readJson<{ operations?: OrderOperationView[] }>(res);
    if (!read.ok || !res.ok || !Array.isArray(read.data.operations)) {
      return ISSUE_MESSAGES.opsFailed;
    }
    return issueBlock(read.data.operations) ?? undefined;
  } catch {
    return ISSUE_MESSAGES.opsFailed;
  }
}

export function IssueTicketDialog({
  order,
  onClose,
  onRequested,
}: {
  order: IssueTicketOrder;
  onClose: () => void;
  /** El API aceptó el pedido: la operación que hay que seguir. */
  onRequested: (operationId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const sendingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void loadBlock(order.id).then((block) => {
      if (alive) setPhase(block === undefined ? { kind: 'ready' } : { kind: 'ready', block });
    });
    return () => {
      alive = false;
    };
  }, [order.id]);

  // Con el pedido en vuelo no se cierra: el vendedor no sabría si salió.
  const close = useCallback(() => {
    if (!sendingRef.current) onClose();
  }, [onClose]);

  async function confirm() {
    if (sendingRef.current || phase.kind !== 'ready' || phase.block !== undefined) return;
    sendingRef.current = true;
    setPhase({ kind: 'sending' });
    let outcome: ReturnType<typeof issueResponseOf>;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(issueRequestBody(order)),
      });
      const read = await readJson<unknown>(res);
      outcome = read.ok
        ? issueResponseOf(res.status, read.data)
        : { ok: false, message: read.message };
    } catch {
      outcome = { ok: false, message: ISSUE_MESSAGES.sendFailed };
    }
    sendingRef.current = false;
    if (outcome.ok) {
      onRequested(outcome.operationId);
      return;
    }
    setPhase({ kind: 'ready', error: outcome.message });
  }

  const deadline = orderTicketingDeadline(order);
  const expired = deadline !== null && ticketingState(deadline.deadline) === 'expired';
  const sending = phase.kind === 'sending';
  const blocked = phase.kind === 'ready' && phase.block !== undefined;
  const alert = phase.kind === 'ready' ? (phase.block ?? phase.error) : undefined;

  return (
    <Dialog
      open
      onClose={close}
      title={`Emitir tiquete de la reserva #${order.orderNumber}`}
      description={ISSUE_MESSAGES.paymentNote}
      initialFocus="[data-issue-cancel]"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" data-issue-cancel disabled={sending} onClick={close}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            className="gap-1.5"
            disabled={phase.kind !== 'ready' || blocked}
            onClick={() => void confirm()}
          >
            <Ticket aria-hidden="true" />
            {sending ? 'Enviando…' : 'Emitir tiquete'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-xs" aria-busy={phase.kind !== 'ready' ? 'true' : undefined}>
        <dl className="flex items-baseline justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-3">
          <dt className="text-[var(--color-fg-muted)]">Total</dt>
          <dd className="text-lg font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
            {formatMoney({ amountMinor: order.totalAmount, currency: order.currency })}
          </dd>
        </dl>

        <FlightDeadlineBadge order={order} />
        {expired ? (
          <p className="leading-relaxed text-[var(--color-fg)]">{ISSUE_MESSAGES.expiredNote}</p>
        ) : null}

        {isTestOrder(order) ? (
          <p className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2.5 text-[var(--color-fg)]">
            <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{ISSUE_MESSAGES.testNote}</span>
          </p>
        ) : null}

        {phase.kind === 'loading' ? (
          <p role="status" className="text-[var(--color-fg-subtle)]">
            Comprobando el historial de la reserva…
          </p>
        ) : null}

        {sending ? (
          <p role="status" className="text-[var(--color-fg-muted)]">
            Pidiendo la emisión. No cierres esta ventana.
          </p>
        ) : null}

        {alert !== undefined ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2.5 text-[var(--color-fg)]"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{alert}</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
