'use client';

import { RefreshCw, Search } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../../../components/ui/button';
import { Dialog } from '../../../../../../components/ui/dialog';
import { Textarea, TextInput } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import { providerMetaFor } from '../../../../../../lib/provider-display';
import {
  ENABLEMENT_CHOICES,
  matchTenants,
  REASON_MAX_LENGTH,
  reasonError,
  tenantChangeDialog,
  type EnablementChoice,
  type PlatformProvider,
  type TenantOption,
} from '../../../../../../lib/provider-enablement';
import type { Loaded } from '../../../../../../lib/provider-enablement-client';
import { ChoiceControl } from '../../../_components/provider-enablement-ui';

type SetChoice = Exclude<EnablementChoice, 'inherit'>;

const SET_CHOICES = ENABLEMENT_CHOICES.filter(
  (c): c is { value: SetChoice; label: string } => c.value !== 'inherit',
);

/**
 * Agregar una excepción: buscar el tenant, elegir Habilitado o Deshabilitado y el motivo. Si es
 * Deshabilitado, el mismo diálogo es la confirmación: dice qué corta y el botón es el de peligro.
 */
export function AddExceptionDialog({
  provider,
  tenants,
  onConfirm,
  onClose,
}: {
  provider: PlatformProvider;
  tenants: Loaded<TenantOption[]> | null;
  onConfirm: (
    tenant: TenantOption,
    choice: SetChoice,
    reason: string,
  ) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const providerName = providerMetaFor(provider.code).name;
  const [query, setQuery] = useState('');
  const [tenant, setTenant] = useState<TenantOption | null>(null);
  // Arranca en lo contrario de lo que ven hoy los tenants sin excepción: es la excepción.
  const [choice, setChoice] = useState<SetChoice>(
    provider.baseline.enabled ? 'disabled' : 'enabled',
  );
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const searchId = useId();
  const resultsId = useId();
  const reasonId = useId();
  // Elegir un tenant desmonta el buscador y "Cambiar" lo vuelve a montar: el foco va al control
  // que aparece, para no quedar en el <body> y escaparse de la trampa de foco del diálogo.
  const searchRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);

  function pick(next: TenantOption | null) {
    setTenant(next);
    requestAnimationFrame(() => (next === null ? searchRef : changeRef).current?.focus());
  }

  const savingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);

  const taken = useMemo(
    () => new Set(provider.overrides.map((o) => o.tenantId.toLowerCase())),
    [provider.overrides],
  );
  const matches = useMemo(
    () => (tenants?.ok ? matchTenants(tenants.data, query, taken) : []),
    [tenants, query, taken],
  );

  const invalidReason = reasonError(reason);
  const copy =
    tenant === null
      ? null
      : tenantChangeDialog({
          providerCode: provider.code,
          tenantName: tenant.name,
          from: 'inherit',
          to: choice,
        });

  async function submit() {
    if (tenant === null || invalidReason !== undefined || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const failure = await onConfirm(tenant, choice, reason);
    savingRef.current = false;
    if (failure !== undefined) {
      setSaving(false);
      setError(failure);
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title={`Agregar excepción de ${providerName}`}
      description="Aplica al tenant elegido y a toda su red, salvo a las agencias que tengan su propia excepción."
      className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <div className="space-y-1.5">
          {/* Con el tenant elegido el buscador no está: un <label for> apuntaría a la nada. */}
          {tenant === null ? (
            <label
              htmlFor={searchId}
              className="block text-xs font-semibold text-[var(--color-fg)]"
            >
              Tenant
            </label>
          ) : (
            <span className="block text-xs font-semibold text-[var(--color-fg)]">Tenant</span>
          )}
          {tenant !== null ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2">
              <span className="min-w-0 text-sm">
                <span className="font-medium text-[var(--color-fg)]">{tenant.name}</span>{' '}
                <code className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {tenant.slug}
                </code>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                ref={changeRef}
                onClick={() => pick(null)}
                disabled={saving}
              >
                Cambiar
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
                />
                <TextInput
                  ref={searchRef}
                  id={searchId}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar por nombre o slug…"
                  autoComplete="off"
                  aria-controls={resultsId}
                  className="pl-9"
                  disabled={tenants === null || !tenants.ok}
                />
              </div>
              <TenantResults
                id={resultsId}
                tenants={tenants}
                query={query}
                matches={matches}
                onPick={pick}
              />
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-semibold text-[var(--color-fg)]">Estado</span>
          <ChoiceControl
            legend={`Estado de ${providerName} para el tenant`}
            value={choice}
            onChange={(c) => {
              if (c !== 'inherit') setChoice(c);
            }}
            choices={SET_CHOICES}
            disabled={saving}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={reasonId} className="block text-xs font-semibold text-[var(--color-fg)]">
            Motivo <span className="font-normal text-[var(--color-fg-muted)]">(opcional)</span>
          </label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={REASON_MAX_LENGTH}
            rows={2}
            placeholder="Ej.: contrato firmado, deuda vencida, piloto con esta red…"
            aria-invalid={invalidReason !== undefined}
            disabled={saving}
          />
          {invalidReason ? (
            <p className="text-[11px] text-[var(--color-danger)]">{invalidReason}</p>
          ) : null}
        </div>

        {copy !== null ? (
          <p
            className={cn(
              'rounded-lg border px-3 py-2 text-xs leading-relaxed text-[var(--color-fg)]',
              copy.destructive
                ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6'
                : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/50',
            )}
          >
            {copy.description}
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={copy?.destructive ? 'danger' : 'primary'}
            disabled={saving || tenant === null || invalidReason !== undefined}
          >
            {saving ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
            {saving ? 'Guardando…' : (copy?.confirmLabel ?? 'Agregar')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TenantResults({
  id,
  tenants,
  query,
  matches,
  onPick,
}: {
  id: string;
  tenants: Loaded<TenantOption[]> | null;
  query: string;
  matches: readonly TenantOption[];
  onPick: (tenant: TenantOption) => void;
}) {
  let hint: string | null = null;
  if (tenants === null) hint = 'Cargando tenants…';
  else if (!tenants.ok) hint = `No se pudo cargar la lista de tenants: ${tenants.message}`;
  else if (query.trim() === '') hint = 'Escribí parte del nombre o del slug.';
  else if (matches.length === 0) hint = 'Ningún tenant sin excepción coincide con esa búsqueda.';

  return (
    <div id={id} aria-live="polite">
      {hint !== null ? (
        <p className="px-1 pt-1 text-[11px] text-[var(--color-fg-muted)]">{hint}</p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto pt-1" aria-label="Tenants que coinciden">
          {matches.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                <span className="truncate font-medium text-[var(--color-fg)]">{t.name}</span>
                <code className="shrink-0 font-mono text-[11px] text-[var(--color-fg-muted)]">
                  {t.slug}
                </code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
