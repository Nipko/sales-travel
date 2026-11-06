'use client';

import { ArrowRight, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../../../../components/ui/button';
import { SegmentedControl } from '../../../../../../components/ui/segmented-control';
import type {
  GovernanceProfile,
  GovernanceRule,
  GovernedProvider,
} from '../../../../../../lib/governance';
import {
  loadCatalog,
  loadGlobalRules,
  loadProfiles,
} from '../../../../../../lib/governance-client';
import { GovernanceRulesEditor } from '../../../_components/governance-rules';
import { ProfilesSection } from './profiles-section';

type Tab = 'profiles' | 'global';

type PanelState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly catalog: readonly GovernedProvider[];
      readonly profiles: readonly GovernanceProfile[];
      readonly rules: readonly GovernanceRule[];
    };

/**
 * Plataforma → Gobierno (docs/platform/17-opciones-de-pago.md): nada se vende ni se cobra si el
 * superadmin no lo encendió. Los perfiles se asignan a nodos; las reglas globales valen donde
 * ningún nodo decida.
 */
export function GovernancePanel() {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [tab, setTab] = useState<Tab>('profiles');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const [catalog, profiles, rules] = await Promise.all([
      loadCatalog(),
      loadProfiles(),
      loadGlobalRules(),
    ]);
    if (!catalog.ok) return setState({ status: 'error', message: catalog.message });
    if (!profiles.ok) return setState({ status: 'error', message: profiles.message });
    if (!rules.ok) return setState({ status: 'error', message: rules.message });
    setState({
      status: 'ready',
      catalog: catalog.data,
      profiles: profiles.data,
      rules: rules.data,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Relee los perfiles sin el esqueleto: el predeterminado y los conteos los decide el API. */
  const refreshProfiles = useCallback(async () => {
    const res = await loadProfiles();
    if (res.ok) {
      setState((s) => (s.status === 'ready' ? { ...s, profiles: res.data } : s));
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-6 space-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Gobierno de proveedores y formas de pago
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Nada se vende ni se cobra si no lo encendiste aquí. En cada nodo gana lo más cercano: su
            regla a mano, después su perfil, después lo que herede de su red y, al final, la regla
            global. Si nadie lo decide, queda apagado. Una forma de pago además necesita a su
            proveedor encendido.
          </p>
        </div>
        <Link
          href="/admin/tenants"
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          Asignar perfiles y reglas a un nodo desde Agencias
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </header>

      {state.status === 'loading' ? (
        <div className="space-y-3" aria-busy="true" aria-live="polite">
          <span className="sr-only">Cargando el gobierno de proveedores…</span>
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
      ) : (
        <div className="space-y-6">
          <SegmentedControl<Tab>
            legend="Sección del gobierno"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'profiles', label: 'Perfiles' },
              { value: 'global', label: 'Reglas globales' },
            ]}
          />

          {tab === 'profiles' ? (
            <ProfilesSection
              catalog={state.catalog}
              profiles={state.profiles}
              onChanged={refreshProfiles}
            />
          ) : (
            <section aria-labelledby="governance-global-title" className="space-y-4">
              <div>
                <h2
                  id="governance-global-title"
                  className="text-sm font-semibold text-[var(--color-fg)]"
                >
                  Reglas globales
                </h2>
                <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  Valen para toda la plataforma donde ningún nodo —con su regla a mano o su perfil—
                  diga otra cosa. «Sin regla» deja la decisión a los nodos; si ninguno decide, queda
                  apagado.
                </p>
              </div>
              <GovernanceRulesEditor
                catalog={state.catalog}
                rules={state.rules}
                tenantId={null}
                tenantName={null}
                unsetLabel="Sin regla"
                onSaved={(rules) => setState((s) => (s.status === 'ready' ? { ...s, rules } : s))}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
