'use client';

import { Building2, ChevronRight, KeyRound, Network, Plus, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { cn } from '../../../lib/cn';

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
  isInheritable: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateForm {
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  defaultLanguage: 'es' | 'pt' | 'en';
  tenantType: 'agency' | 'subagency';
  adminEmail: string;
  adminName: string;
  adminPassword: string;
}

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';
const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const AGENCY_TYPE = { label: 'Agencia', className: 'bg-sky-50 text-sky-700 border-sky-200' };
const TYPE_CONFIG: Record<string, { label: string; className: string }> = {
  platform: { label: 'Plataforma', className: 'bg-violet-50 text-violet-700 border-violet-200' },
  consolidator: {
    label: 'Consolidador',
    className: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  agency: AGENCY_TYPE,
  subagency: { label: 'Sub-agencia', className: 'bg-teal-50 text-teal-700 border-teal-200' },
};

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  suspended: 'bg-red-500',
  archived: 'bg-zinc-400',
};

// Campos de credenciales por proveedor. `secret` ⇒ input password (nunca se muestra de vuelta).
interface ProviderForm {
  label: string;
  credentials: { key: string; label: string; secret?: boolean }[];
  config: { key: string; label: string }[];
}
const LATAM_NDC: ProviderForm = {
  label: 'LATAM NDC',
  credentials: [
    { key: 'apiKey', label: 'API Key', secret: true },
    { key: 'apiSecret', label: 'API Secret', secret: true },
    { key: 'agencyId', label: 'Agency ID' },
    { key: 'agencyIata', label: 'IATA' },
    { key: 'agencyName', label: 'Nombre de agencia' },
    { key: 'travelAgentId', label: 'Travel Agent ID' },
    { key: 'country', label: 'País (POS)' },
    { key: 'accountCode', label: 'Account Code' },
  ],
  config: [{ key: 'apiUrl', label: 'API URL' }],
};
const PROVIDERS: Record<string, ProviderForm> = { 'latam-ndc': LATAM_NDC };

interface SalesRow {
  tenantId: string;
  ordersTotal: number;
  ordersConfirmed: number;
  quotationsTotal: number;
}

export default function RedPage() {
  const [tenants, setTenants] = useState<NetworkTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [createFor, setCreateFor] = useState<NetworkTenant | null>(null);
  const [credsFor, setCredsFor] = useState<NetworkTenant | null>(null);
  const [sales, setSales] = useState<Map<string, SalesRow>>(new Map());

  useEffect(() => {
    void fetchNetwork();
  }, []);

  async function fetchNetwork() {
    setLoading(true);
    try {
      const res = await fetch('/api/tenants/network');
      const data = (await res.json()) as { tenants?: NetworkTenant[] };
      const list = data.tenants ?? [];
      setTenants(list);
      void fetchSales(list);
    } catch {
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }

  // Trae el agregado de ventas por nodo, consultándolo para cada raíz de la red.
  async function fetchSales(list: NetworkTenant[]) {
    const ids = new Set(list.map((t) => t.id));
    const rootIds = list
      .filter((t) => !t.parentTenantId || !ids.has(t.parentTenantId))
      .map((t) => t.id);
    const map = new Map<string, SalesRow>();
    await Promise.all(
      rootIds.map(async (rootId) => {
        try {
          const r = await fetch(
            `/api/tenants/network/sales?tenantId=${encodeURIComponent(rootId)}`,
          );
          const d = (await r.json()) as { summary?: SalesRow[] };
          for (const row of d.summary ?? []) map.set(row.tenantId, row);
        } catch {
          /* sin datos de ventas para esta raíz */
        }
      }),
    );
    setSales(map);
  }

  // Construye el árbol a partir de parentTenantId (raíces = nodos cuyo padre no está en la red visible).
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set(tenants.map((t) => t.id));
    const childrenOf = new Map<string, NetworkTenant[]>();
    const roots: NetworkTenant[] = [];
    for (const t of tenants) {
      if (t.parentTenantId && ids.has(t.parentTenantId)) {
        const arr = childrenOf.get(t.parentTenantId) ?? [];
        arr.push(t);
        childrenOf.set(t.parentTenantId, arr);
      } else {
        roots.push(t);
      }
    }
    const byName = (a: NetworkTenant, b: NetworkTenant) => a.name.localeCompare(b.name);
    roots.sort(byName);
    for (const arr of childrenOf.values()) arr.sort(byName);
    return { roots, childrenOf };
  }, [tenants]);

  function renderRows(nodes: NetworkTenant[], level: number): React.ReactNode[] {
    return nodes.flatMap((t) => {
      const kids = childrenOf.get(t.id) ?? [];
      const type = TYPE_CONFIG[t.tenantType] ?? AGENCY_TYPE;
      return [
        <tr
          key={t.id}
          className="bg-[var(--color-surface)] transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <td className="px-4 py-3">
            <div className="flex items-center gap-2" style={{ paddingLeft: `${level * 20}px` }}>
              {level > 0 && (
                <ChevronRight
                  className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
                  aria-hidden
                />
              )}
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                <Building2 className="size-3.5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--color-fg)]">{t.name}</div>
                <code className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                  {t.slug}
                </code>
              </div>
            </div>
          </td>
          <td className="px-4 py-3">
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
                type.className,
              )}
            >
              {type.label}
            </span>
          </td>
          <td className="px-4 py-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
              <span
                className={cn('size-1.5 rounded-full', STATUS_DOT[t.status] ?? 'bg-zinc-400')}
              />
              {t.status}
            </span>
          </td>
          <td className="px-4 py-3">
            {(() => {
              const s = sales.get(t.id);
              if (!s) return <span className="text-xs text-[var(--color-fg-subtle)]">—</span>;
              return (
                <div className="flex items-center gap-3 text-xs tabular-nums text-[var(--color-fg-muted)]">
                  <span title="Reservas (confirmadas)">
                    <span className="font-medium text-[var(--color-fg)]">{s.ordersConfirmed}</span>
                    <span className="text-[var(--color-fg-subtle)]">/{s.ordersTotal}</span> res.
                  </span>
                  <span title="Cotizaciones">
                    <span className="font-medium text-[var(--color-fg)]">{s.quotationsTotal}</span>{' '}
                    cot.
                  </span>
                </div>
              );
            })()}
          </td>
          <td className="px-4 py-3">
            <div className="flex items-center justify-end gap-1.5">
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setCredsFor(t)}>
                <KeyRound className="size-3.5" />
                Credenciales
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => setCreateFor(t)}
              >
                <Plus className="size-3.5" />
                Sub-agencia
              </Button>
            </div>
          </td>
        </tr>,
        ...renderRows(kids, level + 1),
      ];
    });
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            <Network className="size-5 text-[var(--color-primary)]" />
            Mi Red
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {tenants.length} {tenants.length === 1 ? 'nodo' : 'nodos'}
            {(() => {
              const vals = [...sales.values()];
              if (!vals.length) return null;
              const o = vals.reduce((a, v) => a + v.ordersTotal, 0);
              const q = vals.reduce((a, v) => a + v.quotationsTotal, 0);
              return ` · ${o} reservas · ${q} cotizaciones en tu red`;
            })()}
          </p>
        </div>
        <Button
          className="gap-2"
          onClick={() => setCreateFor(roots[0] ?? null)}
          disabled={!roots.length}
        >
          <Plus className="size-4" />
          Nueva agencia
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          ))}
        </div>
      ) : tenants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <Network className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Aún no hay agencias en tu red
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Creá una agencia para empezar a construir tu consolidador.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Agencia
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Tipo
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Ventas
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">{renderRows(roots, 0)}</tbody>
          </table>
        </div>
      )}

      {createFor && (
        <CreateAgencyModal
          parent={createFor}
          onClose={() => setCreateFor(null)}
          onCreated={() => {
            setCreateFor(null);
            void fetchNetwork();
          }}
        />
      )}

      {credsFor && <CredentialsModal tenant={credsFor} onClose={() => setCredsFor(null)} />}
    </div>
  );
}

function CreateAgencyModal({
  parent,
  onClose,
  onCreated,
}: {
  parent: NetworkTenant;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const defaultType: 'agency' | 'subagency' =
    parent.tenantType === 'consolidator' ? 'agency' : 'subagency';
  const [form, setForm] = useState<CreateForm>({
    name: '',
    slug: '',
    countryCode: 'CO',
    defaultCurrency: 'COP',
    defaultLanguage: 'es',
    tenantType: defaultType,
    adminEmail: '',
    adminName: '',
    adminPassword: '',
  });

  function onName(name: string) {
    setForm((f) => ({
      ...f,
      name,
      slug: name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 50),
    }));
  }

  async function submit() {
    setError('');
    if (!form.name.trim() || !form.slug.trim()) {
      setError('Nombre y slug son requeridos.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, parentTenantId: parent.id }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Error al crear la agencia');
        return;
      }
      onCreated();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Nueva agencia" onClose={onClose}>
      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
        Colgará de <span className="font-medium text-[var(--color-fg)]">{parent.name}</span>.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2" label="Nombre">
          <input
            value={form.name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Agencia Sur"
            className={inputClass}
          />
        </Field>
        <Field className="sm:col-span-2" label="Slug (URL)">
          <input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            placeholder="agencia-sur"
            className={inputClass}
          />
        </Field>
        <Field label="Tipo">
          <select
            value={form.tenantType}
            onChange={(e) =>
              setForm({ ...form, tenantType: e.target.value as 'agency' | 'subagency' })
            }
            className={selectClass}
          >
            <option value="agency">Agencia</option>
            <option value="subagency">Sub-agencia</option>
          </select>
        </Field>
        <Field label="País">
          <select
            value={form.countryCode}
            onChange={(e) => setForm({ ...form, countryCode: e.target.value })}
            className={selectClass}
          >
            <option value="CO">Colombia</option>
            <option value="BR">Brasil</option>
            <option value="PE">Perú</option>
            <option value="CL">Chile</option>
            <option value="MX">México</option>
            <option value="AR">Argentina</option>
          </select>
        </Field>
        <Field label="Moneda">
          <select
            value={form.defaultCurrency}
            onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value })}
            className={selectClass}
          >
            <option value="COP">COP</option>
            <option value="BRL">BRL</option>
            <option value="PEN">PEN</option>
            <option value="USD">USD</option>
          </select>
        </Field>
        <Field label="Idioma">
          <select
            value={form.defaultLanguage}
            onChange={(e) =>
              setForm({ ...form, defaultLanguage: e.target.value as 'es' | 'pt' | 'en' })
            }
            className={selectClass}
          >
            <option value="es">Español</option>
            <option value="pt">Portugués</option>
            <option value="en">Inglés</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <div className="my-1 border-t border-[var(--color-border)]" />
          <p className="text-xs font-medium text-[var(--color-fg-muted)]">
            Admin de la agencia (opcional)
          </p>
        </div>
        <Field label="Email admin">
          <input
            type="email"
            value={form.adminEmail}
            onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
            placeholder="admin@agencia.com"
            className={inputClass}
          />
        </Field>
        <Field label="Nombre admin">
          <input
            value={form.adminName}
            onChange={(e) => setForm({ ...form, adminName: e.target.value })}
            placeholder="Nombre"
            className={inputClass}
          />
        </Field>
        <Field className="sm:col-span-2" label="Contraseña admin">
          <input
            type="password"
            value={form.adminPassword}
            onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
            placeholder="Mínimo 12 caracteres"
            className={inputClass}
          />
        </Field>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button size="sm" className="gap-1.5" disabled={saving} onClick={() => void submit()}>
          <Plus className="size-3.5" />
          {saving ? 'Creando…' : 'Crear agencia'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function CredentialsModal({ tenant, onClose }: { tenant: NetworkTenant; onClose: () => void }) {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [providerCode, setProviderCode] = useState('latam-ndc');
  const [label, setLabel] = useState('default');
  const [isInheritable, setIsInheritable] = useState(true);
  const [status, setStatus] = useState<'sandbox' | 'active' | 'disabled'>('sandbox');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});

  const provider = PROVIDERS[providerCode] ?? LATAM_NDC;

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/provider-accounts?tenantId=${encodeURIComponent(tenant.id)}`);
      const data = (await res.json()) as { accounts?: ProviderAccount[] };
      setAccounts(data.accounts ?? []);
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setError('');
    setSaving(true);
    try {
      const res = await fetch('/api/provider-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          providerCode,
          label: label.trim() || 'default',
          credentials,
          config,
          isInheritable,
          status,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Error al guardar credenciales');
        return;
      }
      setAdding(false);
      setCredentials({});
      setConfig({});
      void load();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Credenciales · ${tenant.name}`} onClose={onClose} wide>
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" />
        <span>
          Las credenciales se cifran y nunca se muestran de vuelta. Si esta agencia no carga las
          suyas, hereda las del consolidador (cuentas marcadas como heredables).
        </span>
      </div>

      {loading ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-xs text-[var(--color-fg-muted)]">
          Sin credenciales propias. {tenant.name} opera con las del consolidador (si son
          heredables).
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <KeyRound className="size-4 text-[var(--color-fg-subtle)]" />
                <div>
                  <div className="text-sm font-medium text-[var(--color-fg)]">
                    {PROVIDERS[a.providerCode]?.label ?? a.providerCode}{' '}
                    <span className="font-normal text-[var(--color-fg-subtle)]">· {a.label}</span>
                  </div>
                  <div className="text-[10px] text-[var(--color-fg-subtle)]">
                    {a.isInheritable ? 'Heredable por sub-agencias' : 'No heredable'}
                  </div>
                </div>
              </div>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  a.status === 'active'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : a.status === 'sandbox'
                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-500',
                )}
              >
                {a.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <div className="mt-4">
          <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Conectar credenciales
          </Button>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Proveedor">
              <select
                value={providerCode}
                onChange={(e) => setProviderCode(e.target.value)}
                className={selectClass}
              >
                {Object.entries(PROVIDERS).map(([code, p]) => (
                  <option key={code} value={code}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Etiqueta">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="default"
                className={inputClass}
              />
            </Field>
            {provider.credentials.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={credentials[f.key] ?? ''}
                  onChange={(e) => setCredentials((c) => ({ ...c, [f.key]: e.target.value }))}
                  className={inputClass}
                  autoComplete="off"
                />
              </Field>
            ))}
            {provider.config.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  value={config[f.key] ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                  className={inputClass}
                />
              </Field>
            ))}
            <Field label="Estado">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
                className={selectClass}
              >
                <option value="sandbox">Sandbox</option>
                <option value="active">Activo</option>
                <option value="disabled">Deshabilitado</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 self-end pb-1.5 text-xs text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={isInheritable}
                onChange={(e) => setIsInheritable(e.target.checked)}
                className="size-4 rounded border-[var(--color-border)]"
              />
              Heredable por sub-agencias
            </label>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Guardando…' : 'Guardar credenciales'}
            </Button>
          </div>
        </div>
      )}

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/* ---------- primitivos de UI locales ---------- */

function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className={cn(
          'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl',
          wide ? 'max-w-2xl' : 'max-w-lg',
          'max-h-[90vh] overflow-y-auto',
        )}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      {children}
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex items-center justify-end gap-2">{children}</div>;
}
