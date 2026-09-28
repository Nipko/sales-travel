'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { readJson } from '../../../../lib/read-json';
import { cn } from '../../../../lib/cn';
import { humanizeProviderError } from '../../../../lib/provider-errors';
import type { OrderOperationView } from '../cancel-retry-policy';
import { formatReadAt } from '../hotel-order-view';
import {
  operationStatusView,
  operationTypeLabel,
  type OperationTone,
} from '../order-operations-view';

/*
 * El historial durable de operaciones de una reserva (`GET /orders/:id/operations`): las que pidió
 * el vendedor y los jobs de post-venta de hotel, con su nombre legible.
 */

export interface OrderOperationsState {
  readonly operations: readonly OrderOperationView[];
  readonly loading: boolean;
  /** Sin el historial no se sabe si hay una cancelación anterior: se bloquea cancelar. */
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

const OPS_FAILED = 'No se pudo comprobar el historial de operaciones.';

/**
 * @param version cambia cuando la orden cambió en el servidor (otro estado, otro seguimiento): el
 *   historial se vuelve a leer, porque una cancelación o una lectura nueva agregan filas.
 */
export function useOrderOperations(orderId: string, version = ''): OrderOperationsState {
  const [operations, setOperations] = useState<readonly OrderOperationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/operations`);
      const read = await readJson<{ operations?: OrderOperationView[] }>(res);
      if (!read.ok || !res.ok || !Array.isArray(read.data.operations)) {
        setOperations([]);
        setError(OPS_FAILED);
        return;
      }
      setOperations(read.data.operations);
      setError(null);
    } catch {
      setOperations([]);
      setError(OPS_FAILED);
    }
  }, [orderId]);

  useEffect(() => {
    setLoading(true);
    void reload().finally(() => setLoading(false));
  }, [reload, version]);

  return { operations, loading, error, reload };
}

const TONE_CLASS: Readonly<Record<OperationTone, string>> = {
  ok: 'bg-green-50 text-green-700',
  failed: 'bg-red-50 text-red-700',
  pending: 'bg-amber-50 text-amber-700',
};

export function OrderOperationsHistory({
  state,
  canRetry,
  onRetry,
}: {
  state: OrderOperationsState;
  canRetry: (op: OrderOperationView) => boolean;
  /** Abre la confirmación del reintento; el pedido no sale desde acá. */
  onRetry: (op: OrderOperationView) => void;
}) {
  const headingId = useId();
  const { operations, loading, error } = state;
  if (!loading && !error && operations.length === 0) return null;

  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]"
      >
        Historial de operaciones
      </h3>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-2.5 py-2 text-[11px] text-[var(--color-fg)]"
        >
          {error} Por seguridad, la cancelación queda bloqueada.
        </p>
      ) : loading ? (
        <p className="text-xs text-[var(--color-fg-subtle)]">Cargando…</p>
      ) : (
        <ul className="space-y-1.5">
          {operations.map((op) => {
            const status = operationStatusView(op);
            return (
              <li
                key={op.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-[var(--color-fg)]">
                      {operationTypeLabel(op.type)}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                        TONE_CLASS[status.tone],
                      )}
                    >
                      {status.label}
                    </span>
                  </div>
                  {op.last_error ? (
                    <p className="mt-0.5 text-[11px] text-red-700">
                      {humanizeProviderError(op.last_error)}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <time
                    dateTime={op.created_at}
                    className="text-[10px] text-[var(--color-fg-subtle)]"
                  >
                    {formatReadAt(op.created_at)}
                  </time>
                  {canRetry(op) ? (
                    <button
                      type="button"
                      onClick={() => onRetry(op)}
                      className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    >
                      Reintentar
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
