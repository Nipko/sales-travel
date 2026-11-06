'use client';

import { ArrowRight, RefreshCw, Scale } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { Card } from '../../../../../../components/ui/card';
import { useConfirm } from '../../../../../../components/ui/dialog';
import { Select } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import {
  assignableProfiles,
  effectiveOriginLabel,
  itemKey,
  type EffectiveCell,
  type GovernanceProfile,
  type GovernedProvider,
  type TenantGovernance,
} from '../../../../../../lib/governance';
import {
  assignTenantProfile,
  loadCatalog,
  loadProfiles,
  loadTenantGovernance,
} from '../../../../../../lib/governance-client';
import { GovernanceRulesEditor } from '../../../_components/governance-rules';

type CardState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly view: TenantGovernance;
      readonly catalog: readonly GovernedProvider[];
      readonly profiles: readonly GovernanceProfile[];
    };

/**
 * El gobierno de UN nodo (docs/platform/17-opciones-de-pago.md §5): el perfil asignado, las reglas
 * a mano que lo pisan y, bajo cada celda, lo que queda efectivo y de dónde sale.
 */
export function TenantGovernanceCard({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [selected, setSelected] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [confirm, confirmElement] = useConfirm();
  const selectId = useId();
  const hintId = useId();

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const [view, catalog, profiles] = await Promise.all([
      loadTenantGovernance(tenantId),
      loadCatalog(),
      loadProfiles(),
    ]);
    if (!view.ok) return setState({ status: 'error', message: view.message });
    if (!catalog.ok) return setState({ status: 'error', message: catalog.message });
    if (!profiles.ok) return setState({ status: 'error', message: profiles.message });
    setSelected(view.data.profile?.id ?? '');
    setState({ status: 'ready', view: view.data, catalog: catalog.data, profiles: profiles.data });
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Relee la vista del nodo sin el esqueleto: la matriz efectiva la calcula el API. */
  const refreshView = useCallback(async () => {
    const res = await loadTenantGovernance(tenantId);
    if (!res.ok) {
      toast.error('El cambio se guardó, pero no pudimos recargar el estado. Recarga la página.');
      return;
    }
    setState((s) => (s.status === 'ready' ? { ...s, view: res.data } : s));
  }, [tenantId]);

  const effectiveByKey = useMemo(
    () =>
      state.status === 'ready'
        ? new Map(state.view.effective.map((c) => [itemKey(c), c] as const))
        : new Map<string, EffectiveCell>(),
    [state],
  );

  if (state.status === 'loading') {
    return (
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        <span className="sr-only">Cargando el gobierno del nodo…</span>
        <div className="h-24 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
        <div className="h-40 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center"
      >
        <p className="text-sm font-medium text-[var(--color-fg)]">{state.message}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" />
          Reintentar
        </Button>
      </div>
    );
  }

  const { view, catalog, profiles } = state;
  const currentId = view.profile?.id ?? '';
  const options = assignableProfiles(profiles, currentId || null);
  const changed = selected !== currentId;

  async function assign() {
    if (!changed || assigning) return;
    const target = options.find((p) => p.id === selected);
    const ok = await confirm({
      title:
        target === undefined
          ? `¿Quitar el perfil de ${view.tenant.name}?`
          : `¿Asignar «${target.name}» a ${view.tenant.name}?`,
      description:
        target === undefined
          ? `${view.tenant.name} y su red vuelven a heredar lo que decida su padre o la regla global. Sus reglas a mano siguen valiendo.`
          : `Lo que el perfil decide vale para ${view.tenant.name} y su red, salvo reglas a mano o nodos más cercanos con lo suyo. Si después editas el perfil, el cambio también llega aquí.`,
      confirmLabel: target === undefined ? 'Quitar perfil' : 'Asignar perfil',
      destructive: false,
    });
    if (!ok) return;
    setAssigning(true);
    const res = await assignTenantProfile(tenantId, selected === '' ? null : selected);
    setAssigning(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setState((s) => (s.status === 'ready' ? { ...s, view: res.data } : s));
    setSelected(res.data.profile?.id ?? '');
    toast.success(
      res.data.profile === null
        ? `${view.tenant.name} ya no tiene perfil: hereda de su red.`
        : `${view.tenant.name} usa el perfil «${res.data.profile.name}».`,
    );
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <Scale
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={selectId} className="block text-sm font-medium text-[var(--color-fg)]">
              Perfil de gobierno
            </label>
            <p id={hintId} className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {view.profile === null
                ? 'Sin perfil propio: hereda lo que decida su red o la regla global.'
                : `Usa «${view.profile.name}». Editar el perfil cambia a todos los nodos que lo usan.`}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            id={selectId}
            aria-describedby={hintId}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={assigning}
            className="sm:max-w-sm"
          >
            <option value="">Ninguno (hereda de su red)</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archivado)' : ''}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void assign()}
            disabled={!changed || assigning}
          >
            {assigning ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
            {assigning ? 'Guardando…' : 'Guardar perfil'}
          </Button>
        </div>
        <Link
          href="/admin/plataforma/gobierno"
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          Ver y editar los perfiles
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </Card>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--color-fg)]">
          Reglas a mano y estado efectivo
        </h3>
        <p className="max-w-prose text-xs leading-relaxed text-[var(--color-fg-muted)]">
          Una regla a mano le gana al perfil de este nodo y cubre su red, salvo nodos más cercanos
          con lo suyo. «Hereda» quita la regla. Debajo de cada fila, lo que queda efectivo y por
          qué.
        </p>
      </div>
      <GovernanceRulesEditor
        catalog={catalog}
        rules={view.rules}
        tenantId={tenantId}
        tenantName={view.tenant.name}
        unsetLabel="Hereda"
        onSaved={refreshView}
        extra={(key) => {
          const cell = effectiveByKey.get(itemKey(key));
          return cell === undefined ? null : <EffectiveLine cell={cell} tenantId={tenantId} />;
        }}
      />
      {confirmElement}
    </div>
  );
}

/** El estado efectivo de una celda en palabras; el punto de color sólo refuerza. */
export function EffectiveLine({ cell, tenantId }: { cell: EffectiveCell; tenantId?: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-fg-muted)]">
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]',
          cell.enabled
            ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/8'
            : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            cell.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-fg-subtle)]',
          )}
        />
        {cell.enabled ? 'Encendido' : 'Apagado'}
      </span>
      <span>{effectiveOriginLabel(cell, tenantId)}</span>
    </p>
  );
}
