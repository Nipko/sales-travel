'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Dialog } from '../../../../../components/ui/dialog';
import { Field, Textarea } from '../../../../../components/ui/field';
import { ToneNotice } from '../../../../../components/wallets/wallet-ui';
import {
  IMPACT_UNAVAILABLE,
  NODE_STATUS_REASON_LABEL,
  NODE_STATUS_REASON_MAX,
  NODE_STATUS_REASON_MIN,
  nodeReasonError,
  reactivateCopy,
  suspendCopy,
  type NodeImpact,
} from '../../../../../lib/platform-node-stats';
import { loadNodeImpact, updateNode } from '../../../../../lib/tenant-admin-client';

/** Suspender o reactivar. */
export type NodeStatusMode = 'suspend' | 'reactivate';

/** El impacto de suspender, mientras se calcula y después. Reactivar no lo pide. */
export type ImpactState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly impact: NodeImpact }
  | { readonly kind: 'error' }
  | { readonly kind: 'skipped' };

interface DialogProps {
  readonly node: { readonly id: string; readonly name: string };
  readonly mode: NodeStatusMode;
  /** Al reactivar: el ancestro que sigue suspendido, si hay uno (el nodo no opera hasta que vuelva). */
  readonly suspendedAncestorName: string | null;
  readonly onClose: () => void;
  readonly onDone: (next: 'active' | 'suspended') => void;
}

/**
 * Suspender o reactivar un nodo con toda su red, desde Agencias. Suspender pide primero el impacto
 * (personas, sesiones, reservas vigentes, saldo retenido y depósitos por aprobar) y lo dice antes de
 * confirmar; si no se puede calcular, el diálogo sigue sin números. Pide el motivo, que queda en la
 * auditoría: obligatorio al suspender, opcional al reactivar.
 */
export function SuspendNodeDialog(props: DialogProps) {
  const { mode, node } = props;
  const [impact, setImpact] = useState<ImpactState>(
    mode === 'suspend' ? { kind: 'loading' } : { kind: 'skipped' },
  );

  const load = useCallback(async () => {
    setImpact({ kind: 'loading' });
    const res = await loadNodeImpact(node.id);
    setImpact(res.ok ? { kind: 'ready', impact: res.data } : { kind: 'error' });
  }, [node.id]);

  useEffect(() => {
    if (mode === 'suspend') void load();
  }, [mode, load]);

  return <NodeStatusDialog {...props} impact={impact} onRetryImpact={() => void load()} />;
}

/**
 * El diálogo con el impacto ya resuelto (o cargando). Aparte del que lo carga para poder pintarlo
 * en cada estado.
 */
export function NodeStatusDialog({
  node,
  mode,
  suspendedAncestorName,
  impact,
  onRetryImpact,
  onClose,
  onDone,
}: DialogProps & { readonly impact: ImpactState; readonly onRetryImpact: () => void }) {
  const suspending = mode === 'suspend';
  const copy = suspending
    ? suspendCopy(node.name, impact.kind === 'ready' ? impact.impact : null)
    : reactivateCopy(node.name, suspendedAncestorName);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Mientras el cambio está en vuelo el diálogo no se cierra: no se abandona a medio enviar.
  const sendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!sendingRef.current) onCloseRef.current();
  }, []);

  const reasonError = nodeReasonError(reason, copy.reasonRequired);
  // Suspender no se ofrece mientras se cuenta el impacto: un instante, y se ve qué se corta.
  const disabled = sending || impact.kind === 'loading';

  async function submit() {
    if (sendingRef.current || disabled) return;
    if (reasonError !== undefined) {
      setTouched(true);
      reasonRef.current?.focus();
      return;
    }
    const motivo = reason.trim();
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      const res = await updateNode(
        node.id,
        suspending
          ? { status: 'suspended', reason: motivo }
          : { status: 'active', ...(motivo === '' ? {} : { reason: motivo }) },
      );
      if (!res.ok) {
        setError(res.message);
        return;
      }
      onDone(suspending ? 'suspended' : 'active');
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
      description={copy.body}
      initialFocus="[data-dialog-body] textarea"
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
              className="h-auto min-h-9 whitespace-normal py-2 text-center"
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
        {impact.kind === 'loading' ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2.5 text-xs text-[var(--color-fg-muted)]"
          >
            <RefreshCw aria-hidden="true" className="size-3.5 animate-spin" />
            Calculando a quién afecta…
          </p>
        ) : impact.kind === 'error' ? (
          <div className="space-y-1">
            <ToneNotice tone="warning" role="status">
              {IMPACT_UNAVAILABLE} Puedes suspender igual: el corte es el mismo.
            </ToneNotice>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={onRetryImpact}
              disabled={sending}
            >
              Volver a calcular
            </Button>
          </div>
        ) : copy.details.length > 0 ? (
          <ul className="space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2.5 text-xs leading-relaxed text-[var(--color-fg)]">
            {copy.details.map((line) => (
              <li key={line} className="tabular-nums">
                {line}
              </li>
            ))}
          </ul>
        ) : null}

        <Field
          label={copy.reasonRequired ? NODE_STATUS_REASON_LABEL : 'Motivo (opcional)'}
          required={copy.reasonRequired}
          error={touched ? reasonError : undefined}
          hint={
            copy.reasonRequired
              ? `Entre ${NODE_STATUS_REASON_MIN} y ${NODE_STATUS_REASON_MAX} caracteres. Queda en la auditoría del nodo.`
              : 'Si lo escribes, queda en la auditoría del nodo.'
          }
        >
          {(a11y) => (
            <Textarea
              {...a11y}
              ref={reasonRef}
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(reason.trim() !== '' || touched)}
              maxLength={NODE_STATUS_REASON_MAX}
              rows={3}
              placeholder={
                suspending
                  ? 'Ej.: deuda vencida con Planetour; se reactiva al registrar el pago.'
                  : 'Ej.: registró el pago pendiente.'
              }
              disabled={sending}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
