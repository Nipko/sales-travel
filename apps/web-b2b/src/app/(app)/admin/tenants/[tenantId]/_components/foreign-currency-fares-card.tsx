'use client';

import { FlaskConical } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '../../../../../../components/ui/card';
import { cn } from '../../../../../../lib/cn';
import {
  foreignCurrencyFaresHint,
  foreignCurrencyFaresSavedMessage,
  loadForeignCurrencyFares,
  saveForeignCurrencyFares,
  type ForeignCurrencyFares,
} from '../../../../../../lib/foreign-currency-fares';

type CardState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly view: ForeignCurrencyFares };

/**
 * El interruptor de pruebas «Tarifas en otra moneda» de un nodo. Va en Proveedores porque es lo
 * que deja probar un proveedor cuyo punto de venta todavía cotiza en otra moneda.
 */
export function ForeignCurrencyFaresCard({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const labelId = useId();
  const hintId = useId();

  useEffect(() => {
    let alive = true;
    void loadForeignCurrencyFares(tenantId).then((res) => {
      if (!alive) return;
      setState(
        res.ok ? { status: 'ready', view: res.data } : { status: 'error', message: res.message },
      );
    });
    return () => {
      alive = false;
    };
  }, [tenantId]);

  async function toggle() {
    if (state.status !== 'ready' || saving) return;
    const next = !state.view.enabled;
    setSaving(true);
    const res = await saveForeignCurrencyFares(tenantId, next);
    setSaving(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setState({ status: 'ready', view: res.data });
    toast.success(foreignCurrencyFaresSavedMessage(res.data.enabled, tenantName));
  }

  const view = state.status === 'ready' ? state.view : undefined;
  const on = view?.enabled === true;

  return (
    <Card
      className={cn(
        'p-4 sm:p-5',
        on && 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/5',
      )}
    >
      <div className="flex items-start gap-3">
        <FlaskConical
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p id={labelId} className="text-sm font-medium text-[var(--color-fg)]">
            Tarifas de vuelo en otra moneda
          </p>
          {state.status === 'loading' ? (
            <span className="block h-4 w-64 max-w-full animate-pulse rounded bg-[var(--color-surface-muted)]" />
          ) : state.status === 'error' ? (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {state.message}
            </p>
          ) : (
            <p id={hintId} className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {view ? foreignCurrencyFaresHint(view) : null}
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={view ? hintId : undefined}
          disabled={view === undefined || saving}
          onClick={() => void toggle()}
          className={cn(
            'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            on
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-4 rounded-full bg-[var(--color-surface)] shadow-sm transition-transform',
              on ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>
    </Card>
  );
}
