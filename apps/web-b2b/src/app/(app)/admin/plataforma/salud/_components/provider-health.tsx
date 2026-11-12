'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../../../../components/ui/button';
import { ToneBadge } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  agoLabel,
  durationLabel,
  HEALTH_LABEL,
  HEALTH_TONE,
  parseProviderHealth,
  verticalLabel,
  type ProviderHealthView,
} from '../../../../../../lib/platform-health';
import { providerLabel } from '../../../../../../lib/platform-system';

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: ProviderHealthView; readonly loadedAt: number };

async function load(): Promise<State> {
  try {
    const res = await fetch('/api/admin/system/providers', { cache: 'no-store' });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const error =
        typeof body === 'object' && body !== null && 'error' in body
          ? String(body.error)
          : `No se pudo leer la salud de los proveedores (${String(res.status)}).`;
      return { status: 'error', message: error };
    }
    const data = parseProviderHealth(body);
    return data
      ? { status: 'ready', data, loadedAt: Date.now() }
      : { status: 'error', message: 'El servidor respondió algo que no pudimos leer.' };
  } catch {
    return { status: 'error', message: 'No pudimos conectar con el servidor.' };
  }
}

/**
 * Plataforma → Salud: cada proveedor, cómo respondió a las búsquedas y si necesita atención. Lo
 * caído va primero y arriba de todo, con el motivo escrito.
 */
export function ProviderHealthPanel() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setState(await load());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const header = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Salud</h1>
        <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
          Cómo están respondiendo los proveedores a las búsquedas de toda la red.
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void refresh()}
        aria-disabled={refreshing || undefined}
        className="gap-1.5"
      >
        <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
        Actualizar
      </Button>
    </div>
  );

  if (state.status === 'loading') {
    return (
      <div>
        {header}
        <p className="text-sm text-[var(--color-fg-muted)]">Cargando…</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div>
        {header}
        <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">
          {state.message}
        </p>
      </div>
    );
  }

  const { data, loadedAt } = state;
  const alerts = data.providers.filter((p) => p.status === 'down' || p.status === 'degraded');

  return (
    <div>
      {header}

      {alerts.length > 0 ? (
        <div className="mb-5 space-y-2">
          {alerts.map((p) => (
            <div
              key={`${p.providerCode}-${p.vertical}`}
              role="alert"
              className={cn(
                'flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm text-[var(--color-fg)]',
                p.status === 'down'
                  ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/8'
                  : 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12',
              )}
            >
              <TriangleAlert
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  p.status === 'down'
                    ? 'text-[var(--color-danger)]'
                    : 'text-[var(--color-warning)]',
                )}
                aria-hidden="true"
              />
              <span>
                <strong className="font-semibold">
                  {providerLabel(p.providerCode)} · {verticalLabel(p.vertical)}:{' '}
                  {HEALTH_LABEL[p.status].toLowerCase()}.
                </strong>{' '}
                {p.reason}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-5 rounded-xl border border-[var(--color-success)]/35 bg-[var(--color-success)]/10 px-4 py-3 text-sm text-[var(--color-fg)]">
          Todos los proveedores con búsquedas están respondiendo.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-fg-muted)]">
              <th className="px-4 py-2.5 font-medium">Proveedor</th>
              <th className="px-3 py-2.5 font-medium">Estado</th>
              <th className="px-3 py-2.5 text-right font-medium">Búsquedas {data.recentHours} h</th>
              <th className="px-3 py-2.5 text-right font-medium">
                Con resultados ({data.periodDays} d)
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Errores</th>
              <th className="px-3 py-2.5 text-right font-medium">Latencia (p95)</th>
              <th className="px-4 py-2.5 font-medium">Último resultado</th>
            </tr>
          </thead>
          <tbody>
            {data.providers.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No hubo búsquedas en los últimos {data.periodDays} días.
                </td>
              </tr>
            ) : (
              data.providers.map((p) => (
                <tr
                  key={`${p.providerCode}-${p.vertical}`}
                  className="border-b border-[var(--color-border)] last:border-b-0"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-[var(--color-fg)]">
                      {providerLabel(p.providerCode)}
                    </p>
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      {verticalLabel(p.vertical)}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <ToneBadge tone={HEALTH_TONE[p.status]}>{HEALTH_LABEL[p.status]}</ToneBadge>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {p.recentSearches.toLocaleString('es-CO')}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {p.hitRate === null ? '—' : `${String(p.hitRate)}%`}
                    <span className="block text-xs text-[var(--color-fg-muted)]">
                      {p.withResults.toLocaleString('es-CO')} de{' '}
                      {p.searches.toLocaleString('es-CO')}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {p.errors.toLocaleString('es-CO')}
                    {p.lastErrorCode ? (
                      <span className="block max-w-[10rem] truncate text-xs text-[var(--color-fg-muted)]">
                        {p.lastErrorCode}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {durationLabel(p.p95DurationMs)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3',
                      p.status === 'down' && 'font-semibold text-[var(--color-danger)]',
                    )}
                  >
                    {agoLabel(p.lastResultAt, loadedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Sale del registro de búsquedas: no consulta a ningún proveedor. «Sin resultados» = varias
        búsquedas en las últimas {data.recentHours} h y ninguna trajo nada.
      </p>
    </div>
  );
}
