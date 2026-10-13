'use client';

import {
  AlertTriangle,
  Ban,
  CircleCheck,
  CircleHelp,
  FlaskConical,
  Hourglass,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Dialog } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';
import { readJson } from '../../../../lib/read-json';
import { isTestOrder } from '../../../../lib/test-content';
import type { OrderOperationView } from '../cancel-retry-policy';
import { supportsOrderCapability } from '../order-capabilities';
import {
  TICKET_CONDITIONS_MESSAGES as M,
  canCheckTicketConditions,
  canVoidTickets,
  checkedAtLabel,
  refundableLabel,
  ticketCheckResponseOf,
  voidBlock,
  voidConfirmMessage,
  voidResultOf,
  voidSignalOf,
  voidTicketCount,
  voidableLabel,
  type SignalTone,
  type TicketCheckView,
  type TicketConditionsOrder,
  type VoidResult,
} from '../ticket-conditions-view';

/*
 * «Condiciones de los tiquetes» en el detalle de una reserva emitida (SAB-09): consultar en vivo si
 * los tiquetes todavía se pueden anular sin costo y, si el proveedor dice que sí, anularlos.
 *
 * El semáforo es lo que dijo el proveedor en el momento de la consulta, con su hora; nunca un
 * contador, porque la ventana la decide la aerolínea. Después de pedir una anulación —salga como
 * salga— la consulta se descarta: las condiciones cambiaron y, para pedir otra, hay que volver a
 * consultar. El API repite la consulta antes de anular, así que un verde viejo no anula nada.
 */

export interface TicketConditionsOrderInput extends TicketConditionsOrder {
  readonly id: string;
  readonly testContent?: boolean;
}

type CheckPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'checked'; readonly check: TicketCheckView }
  | { readonly kind: 'error'; readonly message: string };

const SIGNAL_STYLE: Readonly<
  Record<SignalTone, { readonly box: string; readonly icon: typeof CircleCheck }>
> = {
  ok: { box: 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10', icon: CircleCheck },
  danger: { box: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5', icon: Ban },
  muted: {
    box: 'border-[var(--color-border)] bg-[var(--color-surface-muted)]',
    icon: CircleHelp,
  },
};

const RESULT_STYLE: Readonly<
  Record<VoidResult['kind'], { readonly box: string; readonly icon: typeof CircleCheck }>
> = {
  voided: {
    box: 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10',
    icon: CircleCheck,
  },
  unverified: {
    box: 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
    icon: Hourglass,
  },
  failed: { box: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5', icon: Ban },
};

/** El semáforo con su texto: el color nunca va solo. */
function VoidSignalBox({ check }: { check: TicketCheckView }) {
  const signal = voidSignalOf(check);
  const style = SIGNAL_STYLE[signal.tone];
  const Icon = style.icon;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs text-[var(--color-fg)]',
        style.box,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0">
        <span className="font-semibold">{signal.label}</span>
        {signal.until === undefined ? null : <span> {signal.until}</span>}
        <span className="mt-0.5 block text-[11px] text-[var(--color-fg-muted)]">
          {checkedAtLabel(check)}
        </span>
      </p>
    </div>
  );
}

/**
 * Lo que dijo la consulta: el semáforo, cada tiquete y, si se puede, el botón de anular. Si el verde
 * no se vuelve botón por el historial (`block`), se dice por qué en vez de esconderlo sin más.
 */
export function TicketCheckDetails({
  check,
  block,
  canVoid,
  onVoidRequest,
}: {
  check: TicketCheckView;
  block: string | null;
  canVoid: boolean;
  onVoidRequest: () => void;
}) {
  return (
    <>
      <div role="status">
        <VoidSignalBox check={check} />
      </div>

      {check.tickets.length > 0 ? (
        <ul className="space-y-1.5" aria-label="Tiquetes consultados">
          {check.tickets.map((ticket) => (
            <li
              key={ticket.number}
              className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"
            >
              <span className="font-mono tabular-nums text-[var(--color-fg)]">{ticket.number}</span>
              <span className="text-[var(--color-fg-muted)]">
                {voidableLabel(ticket.voidable)} · {refundableLabel(ticket.refundable)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {block !== null ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
          {block}
        </p>
      ) : null}

      {canVoid ? (
        <Button variant="danger" size="sm" onClick={onVoidRequest} className="gap-1.5 text-xs">
          <Ban aria-hidden="true" className="size-3.5" /> {M.voidButton}
        </Button>
      ) : null}
    </>
  );
}

/**
 * La confirmación de la anulación: qué pasa, cuántos tiquetes y el semáforo de la consulta. El foco
 * arranca en «No, volver»: el botón que confirma es destructivo. Con el pedido en vuelo no se cierra.
 */
export function VoidConfirmDialog({
  order,
  check,
  voiding,
  canConfirm,
  onClose,
  onConfirm,
}: {
  order: TicketConditionsOrderInput;
  check: TicketCheckView;
  voiding: boolean;
  canConfirm: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Anular tiquetes de la reserva #${order.orderNumber}`}
      description={voidConfirmMessage(voidTicketCount(order, check), order.orderNumber)}
      initialFocus="[data-void-back]"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" data-void-back disabled={voiding} onClick={onClose}>
            No, volver
          </Button>
          <Button
            variant="danger"
            className="gap-1.5"
            disabled={voiding || !canConfirm}
            onClick={onConfirm}
          >
            <Ban aria-hidden="true" />
            {voiding ? M.voiding : M.confirmButton}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-xs" aria-busy={voiding ? 'true' : undefined}>
        <VoidSignalBox check={check} />
        {isTestOrder(order) ? (
          <p className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2.5 text-[var(--color-fg)]">
            <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{M.testNote}</span>
          </p>
        ) : null}
        {voiding ? (
          <p role="status" className="text-[var(--color-fg-muted)]">
            {M.voidingNote}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function TicketConditions({
  order,
  operations,
  opsLoading,
  opsError,
  onVoidAttempted,
}: {
  order: TicketConditionsOrderInput;
  /** El historial de la reserva, ya leído por el detalle. */
  operations: readonly OrderOperationView[];
  opsLoading: boolean;
  /** No se pudo leer el historial: no se ofrece anular. */
  opsError: boolean;
  /** Salió un pedido de anulación: la reserva y su historial pueden haber cambiado. */
  onVoidAttempted: () => void;
}) {
  const [phase, setPhase] = useState<CheckPhase>({ kind: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [result, setResult] = useState<VoidResult | null>(null);
  const voidingRef = useRef(false);
  const checkingRef = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (result !== null) resultRef.current?.focus();
  }, [result]);

  const applicable = canCheckTicketConditions(order);
  const check = phase.kind === 'checked' ? phase.check : null;
  const historyBlock = opsLoading ? M.opsLoading : opsError ? M.opsFailed : voidBlock(operations);
  // El verde de la consulta sólo se vuelve botón con la capacidad, el historial leído y sin nada en
  // curso. Si algo lo impide, se dice por qué en vez de esconder el botón sin explicación.
  const voidOffered =
    applicable &&
    check !== null &&
    check.voidAvailable &&
    supportsOrderCapability(order.capabilities, 'void');
  const canVoid =
    voidOffered && historyBlock === null && canVoidTickets(order, check, operations) && !voiding;

  async function runCheck() {
    if (checkingRef.current || voidingRef.current) return;
    checkingRef.current = true;
    setResult(null);
    setPhase({ kind: 'checking' });
    let next: CheckPhase;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}/ticket-check`, {
        cache: 'no-store',
      });
      const read = await readJson<unknown>(res);
      const response = read.ok
        ? ticketCheckResponseOf(res.status, read.data)
        : ({ ok: false, message: M.checkFailed } as const);
      next = response.ok
        ? { kind: 'checked', check: response.check }
        : { kind: 'error', message: response.message };
    } catch {
      next = { kind: 'error', message: M.checkFailed };
    }
    checkingRef.current = false;
    setPhase(next);
  }

  // Con el pedido en vuelo no se cierra: el vendedor no sabría si salió.
  const closeConfirm = useCallback(() => {
    if (!voidingRef.current) setConfirming(false);
  }, []);

  async function voidTickets() {
    if (voidingRef.current || !canVoid) return;
    voidingRef.current = true;
    setVoiding(true);
    let outcome: VoidResult;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}/void`, {
        method: 'POST',
      });
      const read = await readJson<unknown>(res);
      outcome = voidResultOf(res.status, read.ok ? read.data : null);
    } catch {
      // Sin respuesta no se sabe si salió: nunca se ofrece repetirla a ciegas.
      outcome = voidResultOf(0, null);
    }
    voidingRef.current = false;
    setVoiding(false);
    setConfirming(false);
    // Las condiciones ya no son las de antes: otra anulación pide una consulta nueva.
    setPhase({ kind: 'idle' });
    setResult(outcome);
    onVoidAttempted();
  }

  if (!applicable && result === null) return null;

  const checking = phase.kind === 'checking';
  const ResultIcon = result === null ? null : RESULT_STYLE[result.kind].icon;

  return (
    <section aria-labelledby={headingId} className="border-t border-[var(--color-border)] pt-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id={headingId}
            className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]"
          >
            {M.heading}
          </h3>
          {applicable ? (
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">{M.hint}</p>
          ) : null}
        </div>
        {applicable ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={checking || voiding}
            onClick={() => void runCheck()}
            className="gap-1.5 text-xs"
          >
            <Search aria-hidden="true" className="size-3.5" />
            {checking ? 'Consultando…' : check === null ? M.check : M.recheck}
          </Button>
        ) : null}
      </div>

      <div className="mt-2 space-y-2" aria-busy={checking ? 'true' : undefined}>
        {checking ? (
          <p role="status" className="text-xs text-[var(--color-fg-subtle)]">
            {M.checking}
          </p>
        ) : null}

        {phase.kind === 'error' ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-fg)]"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{phase.message}</span>
          </p>
        ) : null}

        {check !== null ? (
          <TicketCheckDetails
            check={check}
            block={voidOffered ? historyBlock : null}
            canVoid={canVoid}
            onVoidRequest={() => setConfirming(true)}
          />
        ) : null}

        {result !== null && ResultIcon !== null ? (
          <div
            ref={resultRef}
            tabIndex={-1}
            role={result.kind === 'voided' ? 'status' : 'alert'}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs text-[var(--color-fg)] focus-visible:outline-none',
              RESULT_STYLE[result.kind].box,
            )}
          >
            <ResultIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{result.message}</span>
          </div>
        ) : null}
      </div>

      {confirming && check !== null ? (
        <VoidConfirmDialog
          order={order}
          check={check}
          voiding={voiding}
          canConfirm={canVoid}
          onClose={closeConfirm}
          onConfirm={() => void voidTickets()}
        />
      ) : null}
    </section>
  );
}
