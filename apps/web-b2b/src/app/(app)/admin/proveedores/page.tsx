'use client';

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Eye,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';
import { cn } from '../../../../lib/cn';
import { providerMetaFor } from '../../../../lib/provider-display';
import {
  choiceFromOwn,
  disclosureStatusLabel,
  DISCLOSURE_HIDDEN,
  ownFromChoice,
  parseDisclosureView,
  type DisclosureChoice,
  type ProviderDisclosureView,
} from '../../../../lib/provider-disclosure';
import {
  DEFAULT_ACCOUNT_LABEL,
  PROVIDERS,
  PROVIDER_ACCOUNT_STATUSES,
  STATUS_LABELS,
  accountConfigSummary,
  fieldKey,
  isProviderAccountStatus,
  prefillFromAccount,
  prepareAccountSubmission,
  providerFormFor,
  type ProviderAccountStatus,
  type ProviderField,
  type ProviderSection,
  validateProviderDraft,
} from '../../../../lib/provider-forms';

interface NetworkTenant {
  id: string;
  slug: string;
  name: string;
  tenantType: string;
  parentTenantId: string | null;
  status: string;
  depth: number;
}

interface ProviderAccount {
  id: string;
  providerCode: string;
  label: string;
  config: Record<string, unknown>;
  redactedConfigKeys?: string[];
  isInheritable: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ResolvedOrigin {
  ownerTenantId: string;
  label: string;
  inherited: boolean;
  readiness?: unknown;
  missingRequiredFields?: unknown;
}

type OriginLookup = ResolvedOrigin | 'none' | 'unknown';

function isResolvedOrigin(lookup: OriginLookup | undefined): lookup is ResolvedOrigin {
  return typeof lookup === 'object' && lookup !== null;
}

type EditorState =
  | { kind: 'create'; initialProviderCode?: string }
  | { kind: 'edit'; account: ProviderAccount; droppedConfigKeys: readonly string[] };

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';
const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export default function ProveedoresPage() {
  const [tenants, setTenants] = useState<NetworkTenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<NetworkTenant | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [origins, setOrigins] = useState<Map<string, OriginLookup> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Divulgación del proveedor en los resultados de búsqueda. Arranca en OCULTO: hasta que
  // el API conteste no se puede afirmar que esta red muestre su cadena de proveedores.
  const [disclosure, setDisclosure] = useState<ProviderDisclosureView>(DISCLOSURE_HIDDEN);
  const [disclosureError, setDisclosureError] = useState('');
  const [savingDisclosure, setSavingDisclosure] = useState(false);

  // Form states
  const [providerCode, setProviderCode] = useState('sabre');
  const [label, setLabel] = useState('default');
  const [isInheritable, setIsInheritable] = useState(true);
  const [status, setStatus] = useState<ProviderAccountStatus>('active');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  // Cargar lista de agencias de la red
  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const res = await fetch('/api/tenants/network');
        const data = (await res.json()) as { tenants?: NetworkTenant[] };
        let list = data.tenants ?? [];
        if (list.length === 0) {
          const cfgRes = await fetch('/api/tenant/config');
          if (cfgRes.ok) {
            const cfg = (await cfgRes.json()) as {
              tenantId?: string;
              name?: string;
              slug?: string;
            };
            if (cfg.tenantId) {
              list = [
                {
                  id: cfg.tenantId,
                  name: cfg.name ?? 'Mi Agencia',
                  slug: cfg.slug ?? 'mi-agencia',
                  tenantType: 'agency',
                  parentTenantId: null,
                  status: 'active',
                  depth: 0,
                },
              ];
            }
          }
        }
        setTenants(list);
        if (list.length > 0 && list[0]) {
          setSelectedTenant(list[0]);
        }
      } catch {
        setTenants([]);
      } finally {
        setLoading(false);
      }
    }
    void init();
  }, []);

  const tenantNames = useMemo(
    () => new Map(tenants.map((t) => [t.id, t.name] as const)),
    [tenants],
  );

  const ownerNameOf = useCallback(
    (ownerTenantId: string) => tenantNames.get(ownerTenantId) ?? 'un ancestro de tu red',
    [tenantNames],
  );

  const activeTenantId = selectedTenant?.id;

  // Cargar cuentas y resolución de orígenes para la agencia seleccionada
  const loadAccounts = useCallback(async () => {
    if (!activeTenantId) return;
    try {
      const res = await fetch(
        `/api/provider-accounts?tenantId=${encodeURIComponent(activeTenantId)}`,
      );
      const data = (await res.json()) as { accounts?: ProviderAccount[] };
      setAccounts((data.accounts ?? []).filter((a) => a.providerCode !== 'email'));
    } catch {
      setAccounts([]);
    }
  }, [activeTenantId]);

  const loadOrigins = useCallback(async () => {
    if (!activeTenantId) return;
    const entries = await Promise.all(
      Object.keys(PROVIDERS).map(async (code): Promise<[string, OriginLookup]> => {
        try {
          const res = await fetch(
            `/api/provider-accounts/resolve?tenantId=${encodeURIComponent(activeTenantId)}&providerCode=${encodeURIComponent(code)}`,
          );
          if (!res.ok) return [code, 'unknown'];
          const data = (await res.json()) as { resolved?: ResolvedOrigin | null };
          return [code, data.resolved ?? 'none'];
        } catch {
          return [code, 'unknown'];
        }
      }),
    );
    setOrigins(new Map(entries));
  }, [activeTenantId]);

  const loadDisclosure = useCallback(async () => {
    if (!activeTenantId) return;
    setDisclosureError('');
    try {
      const res = await fetch(
        `/api/tenant/provider-disclosure?tenantId=${encodeURIComponent(activeTenantId)}`,
      );
      const data = (await res.json()) as { error?: string };
      // El proxy contesta 200 con el ajuste oculto y `error` al lado cuando el API falla:
      // la pantalla se pinta igual, pero no puede decir que está oculto por decisión de
      // nadie si en realidad no se pudo leer.
      if (typeof data.error === 'string') setDisclosureError(data.error);
      setDisclosure(parseDisclosureView(data));
    } catch {
      setDisclosure(DISCLOSURE_HIDDEN);
      setDisclosureError('No se pudo leer el ajuste.');
    }
  }, [activeTenantId]);

  useEffect(() => {
    if (activeTenantId) {
      void loadAccounts();
      void loadOrigins();
      void loadDisclosure();
    }
  }, [activeTenantId, loadAccounts, loadOrigins, loadDisclosure]);

  const provider = providerFormFor(providerCode);
  const draftLookup = origins?.get(providerCode);
  const draftOrigin = isResolvedOrigin(draftLookup) ? draftLookup : null;

  const submission = useMemo(
    () =>
      provider && selectedTenant
        ? prepareAccountSubmission(
            provider,
            { label, status, sections: { credentials, config } },
            {
              resolved: draftOrigin && {
                inherited: draftOrigin.inherited,
                label: draftOrigin.label,
              },
              tenantName: selectedTenant.name,
              ownerName: draftOrigin ? ownerNameOf(draftOrigin.ownerTenantId) : 'el consolidador',
              editing:
                editor?.kind === 'edit'
                  ? {
                      label: editor.account.label,
                      droppedConfigKeys: editor.droppedConfigKeys,
                    }
                  : null,
            },
          )
        : null,
    [
      provider,
      label,
      status,
      credentials,
      config,
      draftOrigin,
      selectedTenant,
      ownerNameOf,
      editor,
    ],
  );

  async function saveDisclosure(choice: DisclosureChoice) {
    if (!selectedTenant) return;
    setDisclosureError('');
    setSavingDisclosure(true);
    try {
      const res = await fetch('/api/tenant/provider-disclosure', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: selectedTenant.id,
          showProviderInResults: ownFromChoice(choice),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setDisclosureError(data.error ?? 'No se pudo guardar el ajuste.');
        return;
      }
      // Se pinta lo que devuelve el API, no lo que se pidió: bajo un consolidador que lo
      // oculta, "Mostrar" queda guardado pero sin efecto, y la pantalla tiene que decirlo.
      setDisclosure(parseDisclosureView(data));
    } catch {
      setDisclosureError('Error de conexión con el servidor.');
    } finally {
      setSavingDisclosure(false);
    }
  }

  function startCreate(initialCode = 'sabre') {
    setProviderCode(initialCode);
    setLabel(DEFAULT_ACCOUNT_LABEL);
    setStatus('active');
    setIsInheritable(true);
    setCredentials({});
    setConfig({ environment: 'cert', callPolicy: 'always' });
    setFieldErrors({});
    setError('');
    setEditor({ kind: 'create', initialProviderCode: initialCode });
  }

  function startEdit(account: ProviderAccount) {
    const form = providerFormFor(account.providerCode);
    if (!form) return;

    const prefill = prefillFromAccount(form, account);
    setProviderCode(account.providerCode);
    setLabel(prefill.label);
    setStatus(prefill.status);
    setIsInheritable(prefill.isInheritable);
    setConfig({ ...prefill.config });
    setCredentials({});
    setFieldErrors({});
    setError('');
    setEditor({ kind: 'edit', account, droppedConfigKeys: prefill.droppedConfigKeys });
  }

  async function save() {
    if (!selectedTenant || !provider || !submission) return;
    setError('');
    setFieldErrors({});

    const validation = validateProviderDraft(provider, { credentials, config });
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setError(validation.summary ?? 'Revisá los campos marcados.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/provider-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: selectedTenant.id,
          providerCode,
          label: submission.label,
          credentials: submission.payload.credentials,
          config: submission.payload.config,
          isInheritable,
          status,
        }),
      });
      const data = (await res.json()) as { message?: string | string[]; error?: string };
      if (!res.ok) {
        setError(
          typeof data.message === 'string'
            ? data.message
            : Array.isArray(data.message)
              ? data.message.join('. ')
              : (data.error ?? 'Error al guardar credenciales'),
        );
        return;
      }
      setEditor(null);
      setCredentials({});
      setConfig({});
      void loadAccounts();
      void loadOrigins();
    } catch {
      setError('Error de conexión con el servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary)]/10 px-2.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)] uppercase tracking-wider w-fit">
            <Zap className="size-3" />
            Conectividad & Motores GDS
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)] mt-1.5">
            Proveedores y Conectividad
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Gestión centralizada de credenciales, inventarios en tiempo real y políticas de búsqueda
            para Sabre GDS, LATAM NDC y partners mayoristas.
          </p>
        </div>

        {/* Selector de Agencia de la Red */}
        {tenants.length > 1 && (
          <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-surface)] p-1.5 shadow-xs">
            <Building2 className="size-4 text-[var(--color-fg-subtle)] ml-2" />
            <select
              value={selectedTenant?.id ?? ''}
              onChange={(e) => {
                const found = tenants.find((t) => t.id === e.target.value);
                if (found) setSelectedTenant(found);
              }}
              className="border-none bg-transparent py-1 pr-8 text-xs font-semibold text-[var(--color-fg)] focus:outline-none cursor-pointer"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.tenantType})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Info Banner */}
      <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-surface-muted)]/50 p-4 text-xs text-[var(--color-fg-muted)] shadow-xs">
        <ShieldCheck className="size-4 shrink-0 text-emerald-600 mt-0.5" />
        <div className="leading-relaxed">
          <strong className="text-[var(--color-fg)] font-semibold">
            Gobierno BYOC (Bring Your Own Credentials):
          </strong>{' '}
          Las credenciales se cifran con estándar AES-GCM (32 bytes) y nunca se transmiten en claro
          al navegador. Cuando una cuenta se encuentra en estado{' '}
          <strong className="text-emerald-700">Activo</strong>, el motor de cotización la incluye
          automáticamente en cada búsqueda en paralelo.
        </div>
      </div>

      <ProviderDisclosureCard
        view={disclosure}
        tenantName={selectedTenant?.name ?? 'esta agencia'}
        saving={savingDisclosure}
        error={disclosureError}
        onChange={(choice) => void saveDisclosure(choice)}
      />

      {/* Grid de Proveedores */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {Object.entries(PROVIDERS).map(([code, form]) => {
          const meta = providerMetaFor(code, form.label);
          const Icon = meta.icon;
          const origin = origins?.get(code);
          const ownAccounts = accounts.filter((a) => a.providerCode === code);
          const activeOwn = ownAccounts.find((a) => a.status === 'active');
          const isResolved = isResolvedOrigin(origin);

          return (
            <Card
              key={code}
              className="border border-[var(--color-border)]/60 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden flex flex-col justify-between"
            >
              <CardContent className="p-6 space-y-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20 shadow-xs">
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-[var(--color-fg)]">{meta.name}</h3>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold mt-0.5',
                          meta.badgeClass,
                        )}
                      >
                        {meta.vertical}
                      </span>
                    </div>
                  </div>

                  {/* Estado Badge */}
                  <div>
                    {isResolved ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700 shadow-2xs">
                        <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Conectado ({origin.inherited ? 'Heredado' : 'Propio'})
                      </span>
                    ) : form.fallsBackToPlatformCredentials ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-semibold text-sky-700">
                        Fallback Plataforma
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-fg-subtle)]">
                        No configurado
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs text-[var(--color-fg-muted)] leading-relaxed">
                  {meta.description}
                </p>

                {/* Detalles de Configuración / Variables activas */}
                <div className="rounded-lg border border-[var(--color-border)]/50 bg-[var(--color-surface-muted)]/40 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[var(--color-fg-subtle)] font-medium">Resolución:</span>
                    <span className="font-semibold text-[var(--color-fg)]">
                      {isResolved
                        ? origin.inherited
                          ? `Heredada de ${ownerNameOf(origin.ownerTenantId)}`
                          : `Cuenta propia (${origin.label})`
                        : form.fallsBackToPlatformCredentials
                          ? 'Credenciales globales de plataforma'
                          : 'Sin cuenta activa (no cotiza)'}
                    </span>
                  </div>

                  {activeOwn && (
                    <div className="border-t border-[var(--color-border)]/50 pt-2 space-y-1 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--color-fg-subtle)]">Variables activas:</span>
                        <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {accountConfigSummary(form, activeOwn.config).join(' · ') || 'Estándar'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--color-fg-subtle)]">
                          Herencia a sub-agencias:
                        </span>
                        <span className="font-medium text-[var(--color-fg)]">
                          {activeOwn.isInheritable ? 'Habilitada' : 'Deshabilitada'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Acciones */}
                <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)]/50 pt-4">
                  {activeOwn ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-1.5 text-xs font-semibold cursor-pointer"
                      onClick={() => startEdit(activeOwn)}
                    >
                      <Pencil className="size-3.5" />
                      Editar variables
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="gap-1.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-xs font-semibold shadow-xs cursor-pointer"
                      onClick={() => startCreate(code)}
                    >
                      <Plus className="size-3.5" />
                      Conectar {meta.name}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Modal de Conexión / Edición de Variables */}
      {editor !== null && provider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-fade-in">
          <div className="w-full max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-4">
              <div>
                <h2 className="text-base font-bold text-[var(--color-fg)]">
                  {editor.kind === 'edit'
                    ? `Editar Variables · ${provider.label}`
                    : `Conectar ${provider.label}`}
                </h2>
                <p className="text-xs text-[var(--color-fg-subtle)] mt-0.5">
                  Agencia:{' '}
                  <strong className="text-[var(--color-fg)]">{selectedTenant?.name}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditor(null)}
                className="rounded-lg p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)] cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Warning Edit Notice */}
            {submission?.edit && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900 leading-relaxed shadow-xs flex items-start gap-2.5">
                <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                <div>
                  <p className="font-bold">{submission.edit.notice.title}</p>
                  <p className="mt-1 opacity-90">{submission.edit.notice.body}</p>
                </div>
              </div>
            )}

            {/* Note */}
            {provider.note && (
              <p className="flex items-start gap-2 text-xs text-[var(--color-fg-muted)] rounded-lg bg-[var(--color-surface-muted)] p-3">
                <Info className="size-4 shrink-0 text-[var(--color-primary)] mt-0.5" />
                <span>{provider.note}</span>
              </p>
            )}

            {/* Form Fields: Credentials & Config */}
            <div className="space-y-5">
              {/* Sección Credenciales */}
              <div className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Credenciales (Se almacenan con cifrado AES-GCM)
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {provider.credentials.map((field) => (
                    <ProviderFieldControl
                      key={fieldKey('credentials', field.key)}
                      section="credentials"
                      field={field}
                      value={credentials[field.key] ?? ''}
                      error={fieldErrors[fieldKey('credentials', field.key)]}
                      onChange={(value) =>
                        setCredentials((prev) => ({ ...prev, [field.key]: value }))
                      }
                    />
                  ))}
                </div>
              </div>

              {/* Sección Configuración */}
              <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Parámetros de Operación & Variables
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {provider.config.map((field) => (
                    <ProviderFieldControl
                      key={fieldKey('config', field.key)}
                      section="config"
                      field={field}
                      value={config[field.key] ?? ''}
                      error={fieldErrors[fieldKey('config', field.key)]}
                      onChange={(value) => setConfig((prev) => ({ ...prev, [field.key]: value }))}
                    />
                  ))}
                </div>
              </div>

              {/* Estado y Herencia */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-[var(--color-border)] pt-4">
                <div className="space-y-1">
                  <Label>Estado de la Cuenta</Label>
                  <select
                    value={status}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (isProviderAccountStatus(next)) setStatus(next);
                    }}
                    className={selectClass}
                  >
                    {PROVIDER_ACCOUNT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1 flex flex-col justify-end">
                  <label className="flex items-center gap-2 text-xs font-semibold text-[var(--color-fg)] cursor-pointer pb-2">
                    <input
                      type="checkbox"
                      checked={isInheritable}
                      onChange={(e) => setIsInheritable(e.target.checked)}
                      className="size-4 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                    />
                    Heredable por toda la red de sub-agencias
                  </label>
                </div>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
                {error}
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border)] pt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditor(null)}
                className="cursor-pointer"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => void save()}
                className="gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-semibold shadow-xs cursor-pointer"
              >
                {saving ? (
                  <RefreshCw className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                {saving ? 'Guardando...' : 'Guardar y activar'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DISCLOSURE_OPTIONS: readonly { value: DisclosureChoice; label: string }[] = [
  { value: 'inherit', label: 'Heredar' },
  { value: 'show', label: 'Mostrar' },
  { value: 'hide', label: 'Ocultar' },
];

/**
 * Control de "¿se ve de qué proveedor viene cada tarifa?".
 *
 * Tres posiciones y no un interruptor porque el ajuste se HEREDA: sin la posición
 * "Heredar" no hay forma de deshacer una decisión propia y volver a seguir a la casa, y
 * "apagado" y "sin configurar" quedarían indistinguibles en pantalla.
 */
function ProviderDisclosureCard({
  view,
  tenantName,
  saving,
  error,
  onChange,
}: {
  view: ProviderDisclosureView;
  tenantName: string;
  saving: boolean;
  error: string;
  onChange: (choice: DisclosureChoice) => void;
}) {
  const current = choiceFromOwn(view.own);
  const locked = view.lockedByAncestor;

  return (
    <Card className="border border-[var(--color-border)]/60 shadow-[var(--shadow-sm)] rounded-xl">
      <CardContent className="p-6 space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20 shadow-xs">
              <Eye className="size-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[var(--color-fg)]">
                Origen de las tarifas en los resultados
              </h2>
              <p className="mt-0.5 max-w-prose text-xs text-[var(--color-fg-muted)] leading-relaxed">
                Decide si el vendedor ve de qué proveedor viene cada oferta cuando busca vuelos.
              </p>
            </div>
          </div>

          <fieldset disabled={locked || saving} className="w-full sm:w-auto">
            <legend className="sr-only">Mostrar el proveedor de cada tarifa</legend>
            <div className="flex w-full gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-1 sm:w-auto">
              {DISCLOSURE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex-1 cursor-pointer rounded-md px-3 py-1.5 text-center text-xs font-semibold text-[var(--color-fg-muted)] transition-colors sm:flex-none sm:min-w-[84px]',
                    'has-[:checked]:bg-[var(--color-surface)] has-[:checked]:text-[var(--color-fg)] has-[:checked]:shadow-xs',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
                    (locked || saving) && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="provider-disclosure"
                    value={option.value}
                    checked={current === option.value}
                    onChange={() => onChange(option.value)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <p
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold',
            view.effective
              ? 'border-[var(--color-primary)]/25 bg-[var(--color-primary)]/8 text-[var(--color-fg)]'
              : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 text-[var(--color-fg-muted)]',
          )}
        >
          {saving ? (
            <RefreshCw className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Eye className="size-3.5 shrink-0" />
          )}
          {disclosureStatusLabel(view)}
        </p>

        <div className="space-y-2 text-xs text-[var(--color-fg-muted)] leading-relaxed">
          <p>
            <strong className="font-semibold text-[var(--color-fg)]">Mostrar:</strong> cada
            resultado lleva la pastilla del proveedor (Sabre GDS, LATAM NDC…) junto a la tarifa.
          </p>
          <p>
            <strong className="font-semibold text-[var(--color-fg)]">Ocultar:</strong> el vendedor
            sigue viendo vuelo, aerolínea, escalas y precio, pero no de dónde salió la tarifa. Es
            información comercial de la casa: dice con quién tiene contrato y por dónde compra.
          </p>
          <p>
            <strong className="font-semibold text-[var(--color-fg)]">A quién afecta:</strong> a los
            vendedores de <strong className="text-[var(--color-fg)]">{tenantName}</strong> y a toda
            la red que cuelga de ella. Una agencia hija puede ocultarlo para los suyos; mostrarlo,
            no, si acá está oculto.
          </p>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/8 p-3 text-xs text-[var(--color-fg)] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]" />
          <span>
            El aviso de <strong className="font-semibold">tarifa simulada</strong> no depende de
            este ajuste: una tarifa de prueba se sigue marcando como no cotizable, se muestre o no
            el proveedor.
          </span>
        </div>

        {locked && (
          <p className="text-[11px] text-[var(--color-fg-subtle)] leading-relaxed">
            Un nivel superior de la red lo mantiene oculto, así que desde acá no se puede mostrar.
          </p>
        )}

        <p className="text-[11px] text-[var(--color-fg-subtle)] leading-relaxed">
          Es un ajuste de presentación: el código del proveedor sigue viajando en la respuesta del
          API y es visible con las herramientas de desarrollo del navegador.
        </p>

        {error && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProviderFieldControl({
  section,
  field,
  value,
  error,
  onChange,
}: {
  section: ProviderSection;
  field: ProviderField;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = `byoc-${section}-${field.key}`;
  const effectiveValue = value || field.defaultValue || '';

  const shared = {
    id,
    value: effectiveValue,
    className: cn(
      field.options ? selectClass : inputClass,
      error && 'border-[var(--color-danger)] focus-visible:border-[var(--color-danger)]',
    ),
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-semibold text-[var(--color-fg)]">
        {field.label}
        {field.required === true && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {field.options ? (
        <select {...shared} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...shared}
          type={field.secret === true ? 'password' : 'text'}
          placeholder={field.placeholder}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && (
        <p className="text-[10px] text-[var(--color-fg-subtle)] leading-relaxed">{field.help}</p>
      )}
      {error && <p className="text-[10px] font-semibold text-rose-600">{error}</p>}
    </div>
  );
}
