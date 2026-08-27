'use client';

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Compass,
  Cpu,
  Globe,
  Info,
  KeyRound,
  Pencil,
  Plane,
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

const PROVIDER_METADATA: Record<
  string,
  {
    name: string;
    vertical: string;
    description: string;
    icon: typeof Plane;
    badgeClass: string;
    docsUrl?: string;
  }
> = {
  sabre: {
    name: 'Sabre GDS',
    vertical: 'Vuelos (ATPCO / NDC BFM v5)',
    description:
      'Conexión directa vía Bargain Finder Max REST/SOAP API. Permite búsqueda multifuente, retarificación y gestión de PNR en tiempo real.',
    icon: Compass,
    badgeClass: 'bg-red-50 text-red-700 border-red-200',
  },
  'latam-ndc': {
    name: 'LATAM NDC',
    vertical: 'Vuelos (Direct Connect NDC v19.2)',
    description:
      'Canal oficial NDC de LATAM Airlines. Acceso a tarifas exclusivas, familias tarifarias y ancillaries sin recargos GDS.',
    icon: Plane,
    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  'agent-cars': {
    name: 'AgentCars',
    vertical: 'Renta de Autos',
    description:
      'Conector global de rentadoras de vehículos (Hertz, Avis, Budget, Europcar, etc.) con confirmación instantánea de vouchers.',
    icon: Cpu,
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  'despegar-hotels': {
    name: 'Despegar Hotels',
    vertical: 'Hotelería y Alojamiento',
    description:
      'Inventario mayorista de hoteles en Latinoamérica y el mundo con tarifas B2B netas y disponibilidad en tiempo real.',
    icon: Globe,
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
  },
};

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

  useEffect(() => {
    if (activeTenantId) {
      void loadAccounts();
      void loadOrigins();
    }
  }, [activeTenantId, loadAccounts, loadOrigins]);

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

      {/* Grid de Proveedores */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {Object.entries(PROVIDERS).map(([code, form]) => {
          const meta = PROVIDER_METADATA[code] ?? {
            name: form.label,
            vertical: 'Servicios',
            description: 'Conector de inventario para la plataforma.',
            icon: Globe,
            badgeClass: 'bg-slate-100 text-slate-800 border-slate-200',
          };
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
