'use client';

import { Pencil, Plus, RefreshCw, RotateCcw, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { Card } from '../../../../../../components/ui/card';
import { providerMetaFor } from '../../../../../../lib/provider-display';
import {
  choiceOf,
  enablementRequest,
  globalChangeDialog,
  globalSourceLabel,
  globalSwitchState,
  groupByVertical,
  initialReasonFor,
  legacyEnvVar,
  legacyTenantLabels,
  originLabel,
  overridesSummary,
  overrideTenantLabel,
  savedMessage,
  sortOverrides,
  tenantChangeDialog,
  updatedLabel,
  type EnablementChoice,
  type PlatformProvider,
  type TenantOption,
  type TenantOverride,
} from '../../../../../../lib/provider-enablement';
import {
  loadPlatformProviders,
  loadTenantOptions,
  saveGlobal,
  saveTenant,
  type Loaded,
} from '../../../../../../lib/provider-enablement-client';
import {
  ChangeDialog,
  ChoiceControl,
  DecisionTrail,
  EnablementStatus,
  KillSwitchNotice,
  ProviderIdentity,
  Switch,
} from '../../../_components/provider-enablement-ui';
import { AddExceptionDialog } from './add-exception-dialog';

type GlobalNext = { readonly kind: 'set'; readonly enabled: boolean } | { readonly kind: 'reset' };

type Pending =
  | { readonly scope: 'global'; readonly provider: PlatformProvider; readonly next: GlobalNext }
  | {
      readonly scope: 'tenant';
      readonly provider: PlatformProvider;
      readonly override: TenantOverride;
      readonly to: EnablementChoice;
    };

type PanelState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly providers: readonly PlatformProvider[] };

/**
 * Proveedores de la plataforma: por proveedor, el interruptor "Todos los tenants" y las
 * excepciones por tenant, cada una con su estado efectivo y de dónde sale.
 */
export function PlatformProvidersPanel() {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [tenants, setTenants] = useState<Loaded<TenantOption[]> | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [adding, setAdding] = useState<PlatformProvider | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const [providers, options] = await Promise.all([loadPlatformProviders(), loadTenantOptions()]);
    setTenants(options);
    setState(
      providers.ok
        ? { status: 'ready', providers: providers.data }
        : { status: 'error', message: providers.message },
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tenantNames = useMemo(
    () => new Map(tenants?.ok ? tenants.data.map((t) => [t.id, t.name] as const) : []),
    [tenants],
  );

  /** Reemplaza el proveedor con lo que devolvió el API: es la fuente, no una suposición local. */
  const replace = useCallback((updated: PlatformProvider) => {
    setState((s) =>
      s.status === 'ready'
        ? {
            status: 'ready',
            providers: s.providers.map((p) => (p.code === updated.code ? updated : p)),
          }
        : s,
    );
  }, []);

  const closePending = useCallback(() => setPending(null), []);
  const closeAdding = useCallback(() => setAdding(null), []);

  async function confirmPending(reason: string): Promise<string | undefined> {
    if (pending === null) return undefined;
    const { provider } = pending;
    if (pending.scope === 'global') {
      const choice: EnablementChoice =
        pending.next.kind === 'reset' ? 'inherit' : pending.next.enabled ? 'enabled' : 'disabled';
      const res = await saveGlobal(provider.code, enablementRequest(choice, reason));
      if (!res.ok) return res.message;
      replace(res.data);
      setPending(null);
      toast.success(savedMessage(provider.code, choice));
      return undefined;
    }
    const { override, to } = pending;
    const res = await saveTenant(provider.code, override.tenantId, enablementRequest(to, reason));
    if (!res.ok) return res.message;
    replace(res.data);
    setPending(null);
    toast.success(savedMessage(provider.code, to, overrideTenantLabel(override)));
    return undefined;
  }

  async function confirmAdd(
    provider: PlatformProvider,
    tenant: TenantOption,
    choice: Exclude<EnablementChoice, 'inherit'>,
    reason: string,
  ): Promise<string | undefined> {
    const res = await saveTenant(provider.code, tenant.id, enablementRequest(choice, reason));
    if (!res.ok) return res.message;
    replace(res.data);
    setAdding(null);
    toast.success(savedMessage(provider.code, choice, tenant.name));
    return undefined;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-6 space-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Proveedores de la plataforma
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Quién puede buscar y vender con cada proveedor. Una excepción en un consolidador cubre
            toda su red; una agencia puntual puede tener la suya, y la más cercana gana. Apagar un
            proveedor corta búsquedas y ventas nuevas: las reservas ya hechas se siguen consultando,
            cancelando y conciliando.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">
            Orden de decisión
          </span>
          <DecisionTrail />
        </div>
      </header>

      {state.status === 'loading' ? (
        <div className="space-y-3" aria-busy="true" aria-live="polite">
          <span className="sr-only">Cargando proveedores…</span>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
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
      ) : state.providers.length === 0 ? (
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
        <div className="space-y-8">
          {groupByVertical(state.providers).map((group) => (
            <section key={group.vertical} aria-labelledby={`vertical-${group.vertical}`}>
              <h2
                id={`vertical-${group.vertical}`}
                className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]"
              >
                {group.label}
              </h2>
              <ul className="space-y-4">
                {group.providers.map((provider) => (
                  <li key={provider.code}>
                    <ProviderCard
                      provider={provider}
                      tenantNames={tenantNames}
                      onGlobal={(next) => setPending({ scope: 'global', provider, next })}
                      onOverride={(override, to) =>
                        setPending({ scope: 'tenant', provider, override, to })
                      }
                      onAdd={() => setAdding(provider)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {pending !== null ? (
        <ChangeDialog
          key={`${pending.provider.code}-${pending.scope === 'tenant' ? pending.override.tenantId : 'global'}`}
          dialog={
            pending.scope === 'global'
              ? globalChangeDialog(pending.provider, pending.next)
              : tenantChangeDialog({
                  providerCode: pending.provider.code,
                  tenantName: overrideTenantLabel(pending.override),
                  from: choiceOf(pending.override),
                  to: pending.to,
                })
          }
          initialReason={
            pending.scope === 'global'
              ? initialReasonFor(
                  pending.provider.global,
                  pending.next.kind === 'reset'
                    ? 'inherit'
                    : pending.next.enabled
                      ? 'enabled'
                      : 'disabled',
                )
              : initialReasonFor(pending.override, pending.to)
          }
          onConfirm={confirmPending}
          onClose={closePending}
        />
      ) : null}

      {adding !== null ? (
        <AddExceptionDialog
          provider={adding}
          tenants={tenants}
          onConfirm={(tenant, choice, reason) => confirmAdd(adding, tenant, choice, reason)}
          onClose={closeAdding}
        />
      ) : null}
    </div>
  );
}

function ProviderCard({
  provider,
  tenantNames,
  onGlobal,
  onOverride,
  onAdd,
}: {
  provider: PlatformProvider;
  tenantNames: ReadonlyMap<string, string>;
  onGlobal: (next: GlobalNext) => void;
  onOverride: (override: TenantOverride, to: EnablementChoice) => void;
  onAdd: () => void;
}) {
  const sourceId = useId();
  const global = globalSwitchState(provider);
  const summary = overridesSummary(provider.overrides);
  const legacyTenants = legacyTenantLabels(provider.legacyEnv, tenantNames);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <ProviderIdentity code={provider.code} callPolicy={provider.callPolicy} />

        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2 sm:min-w-[228px]">
          <span className="text-xs font-semibold text-[var(--color-fg)]">Todos los tenants</span>
          <Switch
            checked={global.on}
            label={`${providerMetaFor(provider.code).name} para todos los tenants`}
            describedBy={sourceId}
            onToggle={() => onGlobal({ kind: 'set', enabled: !global.on })}
          />
        </div>
      </div>

      <div className="space-y-3 px-4 pb-4 sm:px-5">
        <div
          id={sourceId}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-muted)]"
        >
          <span>{globalSourceLabel(provider)}</span>
          {provider.global !== null ? (
            <>
              {updatedLabel(provider.global) ? (
                <span className="text-[var(--color-fg-subtle)]">
                  {updatedLabel(provider.global)}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => onGlobal({ kind: 'set', enabled: global.on })}
              >
                <Pencil aria-hidden="true" />
                Motivo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => onGlobal({ kind: 'reset' })}
              >
                <RotateCcw aria-hidden="true" />
                Quitar ajuste global
              </Button>
            </>
          ) : null}
        </div>
        {provider.global?.reason ? (
          <p className="text-xs text-[var(--color-fg)]">
            <span className="text-[var(--color-fg-muted)]">Motivo: </span>
            {provider.global.reason}
          </p>
        ) : null}

        {provider.killSwitch !== null ? <KillSwitchNotice level={provider.killSwitch} /> : null}

        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <span>Tenants sin excepción:</span>
            <EnablementStatus effective={provider.baseline} />
            <span className="sr-only">{originLabel(provider.baseline, provider)}</span>
          </div>
          <DecisionTrail origin={provider.baseline.origin} />
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/30">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <div>
            <h4 className="text-xs font-semibold text-[var(--color-fg)]">Excepciones por tenant</h4>
            <p className="text-[11px] text-[var(--color-fg-muted)]">
              {summary ?? 'Ninguna: todos los tenants siguen el ajuste de arriba.'}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onAdd}>
            <Plus aria-hidden="true" />
            Agregar excepción
          </Button>
        </div>

        {/* Con ajuste global, la variable legado ya no decide por nadie: no se la muestra. */}
        {provider.global === null && legacyTenants.length > 0 ? (
          <p className="mx-4 mb-3 rounded-lg border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/8 px-3 py-2 text-[11px] leading-relaxed text-[var(--color-fg)] sm:mx-5">
            La variable <code className="font-mono">{legacyEnvVar(provider.vertical)}</code>{' '}
            (legado) también lo enciende para {legacyTenants.join(', ')}, mientras la plataforma no
            tenga un ajuste global ni de su red que decida por ellos.
          </p>
        ) : null}

        {provider.overrides.length > 0 ? (
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {sortOverrides(provider.overrides).map((override) => (
              <OverrideRow
                key={override.tenantId}
                provider={provider}
                override={override}
                onChange={(to) => onOverride(override, to)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

function OverrideRow({
  provider,
  override,
  onChange,
}: {
  provider: PlatformProvider;
  override: TenantOverride;
  onChange: (to: EnablementChoice) => void;
}) {
  const name = overrideTenantLabel(override);
  const current = choiceOf(override);
  const updated = updatedLabel(override);
  return (
    <li className="flex flex-col gap-3 bg-[var(--color-surface)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <Link
            href={`/admin/tenants/${override.tenantId}`}
            className="truncate font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            {name}
          </Link>
          {override.tenantSlug ? (
            <code className="font-mono text-[11px] text-[var(--color-fg-muted)]">
              {override.tenantSlug}
            </code>
          ) : null}
        </p>
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          {override.reason ? (
            <span className="text-[var(--color-fg)]">{override.reason}</span>
          ) : (
            'Sin motivo'
          )}
          {updated ? <span className="text-[var(--color-fg-subtle)]"> · {updated}</span> : null}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <ChoiceControl
          legend={`${providerMetaFor(provider.code).name} para ${name}`}
          value={current}
          onChange={onChange}
        />
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
      </div>
    </li>
  );
}
