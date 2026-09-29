'use client';

import { ArrowLeft, ArrowRight, Pencil, RefreshCw, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { Card } from '../../../../../../components/ui/card';
import { providerMetaFor } from '../../../../../../lib/provider-display';
import {
  choiceOf,
  enablementRequest,
  groupByVertical,
  initialReasonFor,
  originLabel,
  savedMessage,
  tenantChangeDialog,
  updatedLabel,
  type EnablementChoice,
  type TenantProvider,
  type TenantProviders,
} from '../../../../../../lib/provider-enablement';
import { loadTenantProviders, saveTenant } from '../../../../../../lib/provider-enablement-client';
import {
  ChangeDialog,
  ChoiceControl,
  DecisionTrail,
  EnablementStatus,
  KillSwitchNotice,
  ProviderIdentity,
} from '../../../_components/provider-enablement-ui';
import { NodeSectionNav } from './node-section-nav';

type PanelState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly view: TenantProviders };

interface Pending {
  readonly provider: TenantProvider;
  readonly to: EnablementChoice;
}

/**
 * Los proveedores de UN tenant, con el mismo control de tres posiciones que la vista de la
 * plataforma. Acá sí se ve el estado efectivo completo —incluido lo que hereda de su red—, que la
 * vista por proveedor no puede mostrar sin el árbol.
 */
export function TenantProvidersPanel({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ status: 'loading' });
      const res = await loadTenantProviders(tenantId);
      if (res.ok) setState({ status: 'ready', view: res.data });
      else if (!quiet) setState({ status: 'error', message: res.message });
      return res.ok;
    },
    [tenantId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const closePending = useCallback(() => setPending(null), []);

  async function confirmPending(reason: string): Promise<string | undefined> {
    if (pending === null || state.status !== 'ready') return undefined;
    const { provider, to } = pending;
    const res = await saveTenant(provider.code, tenantId, enablementRequest(to, reason));
    if (!res.ok) return res.message;
    setPending(null);
    toast.success(savedMessage(provider.code, to, state.view.tenantName));
    // El PUT devuelve la vista del proveedor en la plataforma, no lo que ve ESTE tenant (que
    // depende de su red): se vuelve a pedir, sin tapar la pantalla con el esqueleto.
    if (!(await load(true))) {
      toast.error('El cambio se guardó, pero no pudimos recargar el estado. Recargá la página.');
    }
    return undefined;
  }

  const tenantName = state.status === 'ready' ? state.view.tenantName : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <Link
        href="/admin/tenants"
        className="mb-4 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg-muted)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Agencias
      </Link>

      <header className="mb-6 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            {tenantName ?? 'Agencia'}
          </h1>
          {state.status === 'ready' ? (
            <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
              {state.view.tenantSlug}
            </code>
          ) : null}
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
          Qué proveedores puede usar para buscar y vender. Un ajuste acá cubre también su red, salvo
          a las agencias que tengan el suyo; <strong className="font-semibold">Heredar</strong>{' '}
          sigue lo que decidan su red o el ajuste global.
        </p>
        <Link
          href="/admin/plataforma/proveedores"
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          Ver todos los proveedores de la plataforma
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </header>

      <NodeSectionNav tenantId={tenantId} current="providers" />

      <section aria-labelledby="tenant-providers-title">
        <h2
          id="tenant-providers-title"
          className="mb-3 text-sm font-semibold text-[var(--color-fg)]"
        >
          Proveedores
        </h2>

        {state.status === 'loading' ? (
          <div className="space-y-3" aria-busy="true" aria-live="polite">
            <span className="sr-only">Cargando proveedores…</span>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
              />
            ))}
          </div>
        ) : state.status === 'error' ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
          >
            <p className="text-sm font-medium text-[var(--color-fg)]">{state.message}</p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              Reintentar
            </Button>
          </div>
        ) : state.view.providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-12 text-center">
            <Unplug
              aria-hidden="true"
              className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
            />
            <p className="text-sm font-medium text-[var(--color-fg)]">
              La plataforma no tiene proveedores registrados.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {groupByVertical(state.view.providers).map((group) => (
              <div key={group.vertical}>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
                  {group.label}
                </h3>
                <ul className="space-y-3">
                  {group.providers.map((provider) => (
                    <li key={provider.code}>
                      <TenantProviderCard
                        provider={provider}
                        tenantId={tenantId}
                        tenantName={state.view.tenantName}
                        onChange={(to) => setPending({ provider, to })}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {pending !== null && tenantName !== null ? (
        <ChangeDialog
          key={pending.provider.code}
          dialog={tenantChangeDialog({
            providerCode: pending.provider.code,
            tenantName,
            from: choiceOf(pending.provider.own),
            to: pending.to,
          })}
          initialReason={initialReasonFor(pending.provider.own, pending.to)}
          onConfirm={confirmPending}
          onClose={closePending}
        />
      ) : null}
    </div>
  );
}

function TenantProviderCard({
  provider,
  tenantId,
  tenantName,
  onChange,
}: {
  provider: TenantProvider;
  tenantId: string;
  tenantName: string;
  onChange: (to: EnablementChoice) => void;
}) {
  const current = choiceOf(provider.own);
  const updated = provider.own === null ? '' : updatedLabel(provider.own);
  const name = providerMetaFor(provider.code).name;
  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <ProviderIdentity code={provider.code} callPolicy={provider.callPolicy} headingLevel={4} />
        <div className="flex items-center gap-1.5">
          <ChoiceControl
            legend={`${name} para ${tenantName}`}
            value={current}
            onChange={onChange}
          />
          {provider.own !== null ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={`Editar el motivo de ${name}`}
              title="Editar motivo"
              onClick={() => onChange(current)}
            >
              <Pencil aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
        <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          <EnablementStatus effective={provider.effective} />
          {/* En el apagado de emergencia lo explica el aviso de abajo; acá sería repetirlo. */}
          {provider.effective.origin === 'kill-switch' ? null : (
            <span>{originLabel(provider.effective, provider, tenantId)}</span>
          )}
        </p>
        <DecisionTrail origin={provider.effective.origin} />
      </div>

      {provider.own !== null ? (
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          {provider.own.reason ? (
            <>
              Motivo: <span className="text-[var(--color-fg)]">{provider.own.reason}</span>
            </>
          ) : (
            'Sin motivo'
          )}
          {updated ? <span className="text-[var(--color-fg-subtle)]"> · {updated}</span> : null}
        </p>
      ) : null}

      {provider.killSwitch !== null ? <KillSwitchNotice level={provider.killSwitch} /> : null}
    </Card>
  );
}
