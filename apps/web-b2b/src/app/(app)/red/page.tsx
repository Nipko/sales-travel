'use client';

import {
  Building2,
  Calculator,
  ChevronRight,
  KeyRound,
  Mail,
  Network,
  Percent,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
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
// AgentCars (renta de autos). El token es secreto; sourceCountry = POS del agente.
// baseUrl/suggestUrl/language son opcionales (el adapter usa defaults de desarrollo).
const AGENT_CARS: ProviderForm = {
  label: 'AgentCars',
  credentials: [{ key: 'accessToken', label: 'Access Token', secret: true }],
  config: [
    { key: 'sourceCountry', label: 'País origen / POS (ej: CO)' },
    { key: 'baseUrl', label: 'Base URL (opcional)' },
    { key: 'suggestUrl', label: 'Suggest URL (opcional)' },
    { key: 'language', label: 'Idioma (opcional)' },
  ],
};
const PROVIDERS: Record<string, ProviderForm> = {
  'latam-ndc': LATAM_NDC,
  'agent-cars': AGENT_CARS,
};

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
  const [pricingFor, setPricingFor] = useState<NetworkTenant | null>(null);
  const [usersFor, setUsersFor] = useState<NetworkTenant | null>(null);
  const [emailFor, setEmailFor] = useState<NetworkTenant | null>(null);
  const [showAudit, setShowAudit] = useState(false);
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
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setPricingFor(t)}
              >
                <Percent className="size-3.5" />
                Reglas
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setCredsFor(t)}>
                <KeyRound className="size-3.5" />
                Credenciales
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setEmailFor(t)}>
                <Mail className="size-3.5" />
                Email
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setUsersFor(t)}>
                <Users className="size-3.5" />
                Usuarios
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
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="gap-2"
            onClick={() => setShowAudit(true)}
            disabled={!roots.length}
          >
            <ScrollText className="size-4" />
            Actividad
          </Button>
          <Button
            className="gap-2"
            onClick={() => setCreateFor(roots[0] ?? null)}
            disabled={!roots.length}
          >
            <Plus className="size-4" />
            Nueva agencia
          </Button>
        </div>
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
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
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

      {pricingFor && <PricingModal tenant={pricingFor} onClose={() => setPricingFor(null)} />}

      {usersFor && <UsersModal tenant={usersFor} onClose={() => setUsersFor(null)} />}

      {emailFor && <EmailModal tenant={emailFor} onClose={() => setEmailFor(null)} />}

      {showAudit && roots[0] && (
        <AuditModal rootId={roots[0].id} onClose={() => setShowAudit(false)} />
      )}
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
      // El correo se gestiona en su propia sección "Email"; acá sólo proveedores de viaje.
      setAccounts((data.accounts ?? []).filter((a) => a.providerCode !== 'email'));
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
                      : 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
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

interface MarkupRule {
  id: string;
  vertical: string;
  ruleType: string;
  valueMinor: number;
  priority: number;
  status: string;
}

interface WaterfallStep {
  tenantName: string;
  level: number;
  ruleType: string;
  addedMinor: number;
}

const VERTICALS = ['all', 'flights', 'hotels', 'cars', 'assistance', 'activities'];

function PricingModal({ tenant, onClose }: { tenant: NetworkTenant; onClose: () => void }) {
  const [rules, setRules] = useState<MarkupRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ vertical: 'all', ruleType: 'percentage', value: '' });

  // Simulador
  const [simVertical, setSimVertical] = useState('flights');
  const [simNet, setSimNet] = useState('100000');
  const [sim, setSim] = useState<{ final: number; markup: number; steps: WaterfallStep[] } | null>(
    null,
  );
  const [simulating, setSimulating] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/pricing/rules?tenantId=${encodeURIComponent(tenant.id)}`);
      const data = (await res.json()) as { rules?: MarkupRule[] };
      setRules(data.rules ?? []);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }

  async function addRule() {
    setError('');
    const value = Number(form.value);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Ingresá un valor válido.');
      return;
    }
    // percentage: el usuario ingresa % (ej 5) → value_minor = %×100. fixed: monto en unidad mayor → minor.
    const valueMinor =
      form.ruleType === 'percentage' ? Math.round(value * 100) : Math.round(value * 100);
    setSaving(true);
    try {
      const res = await fetch('/api/pricing/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          vertical: form.vertical,
          ruleType: form.ruleType,
          valueMinor,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Error al crear la regla');
        return;
      }
      setForm({ vertical: 'all', ruleType: 'percentage', value: '' });
      void load();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(id: string) {
    await fetch(`/api/pricing/rules/${id}?tenantId=${encodeURIComponent(tenant.id)}`, {
      method: 'DELETE',
    });
    void load();
  }

  async function simulate() {
    setSimulating(true);
    try {
      const res = await fetch('/api/pricing/waterfall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          vertical: simVertical,
          netMinor: Math.round(Number(simNet) * 100),
        }),
      });
      const data = (await res.json()) as {
        finalMinor: number;
        totalMarkupMinor: number;
        breakdown: WaterfallStep[];
      };
      setSim({
        final: data.finalMinor,
        markup: data.totalMarkupMinor,
        steps: data.breakdown ?? [],
      });
    } catch {
      setSim(null);
    } finally {
      setSimulating(false);
    }
  }

  const money = (minor: number) =>
    (minor / 100).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  return (
    <Modal title={`Reglas de pricing · ${tenant.name}`} onClose={onClose} wide>
      <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
        Las reglas de este nodo se aplican <strong>en cascada</strong> junto con las de sus
        ancestros (consolidador → agencia → sub-agencia) sobre el neto del proveedor.
      </p>

      {/* Reglas propias */}
      {loading ? (
        <div className="h-12 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-xs text-[var(--color-fg-muted)]">
          Sin reglas propias. Este nodo aplica sólo las heredadas de sus ancestros.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rules.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--color-fg-muted)]">
                  {r.vertical}
                </span>
                <span className="font-medium text-[var(--color-fg)]">
                  {r.ruleType === 'percentage'
                    ? `+${(r.valueMinor / 100).toLocaleString('es-CO')}%`
                    : `+${money(r.valueMinor)}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void removeRule(r.id)}
                className="rounded p-1 text-[var(--color-fg-subtle)] hover:bg-red-50 hover:text-red-600"
                aria-label="Eliminar regla"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Agregar regla */}
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
        <div className="space-y-1">
          <Label>Vertical</Label>
          <select
            value={form.vertical}
            onChange={(e) => setForm({ ...form, vertical: e.target.value })}
            className={selectClass + ' w-32'}
          >
            {VERTICALS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Tipo</Label>
          <select
            value={form.ruleType}
            onChange={(e) => setForm({ ...form, ruleType: e.target.value })}
            className={selectClass + ' w-32'}
          >
            <option value="percentage">Porcentaje (%)</option>
            <option value="fixed">Monto fijo</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>{form.ruleType === 'percentage' ? 'Valor (%)' : 'Valor'}</Label>
          <input
            type="number"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder={form.ruleType === 'percentage' ? '5' : '10000'}
            className={inputClass + ' w-28'}
          />
        </div>
        <Button size="sm" className="gap-1.5" disabled={saving} onClick={() => void addRule()}>
          <Plus className="size-3.5" />
          {saving ? '…' : 'Agregar'}
        </Button>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Simulador */}
      <div className="mt-5 rounded-xl border border-[var(--color-border)] p-3">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--color-fg)]">
          <Calculator className="size-4 text-[var(--color-primary)]" />
          Simulador de cascada
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Vertical</Label>
            <select
              value={simVertical}
              onChange={(e) => setSimVertical(e.target.value)}
              className={selectClass + ' w-32'}
            >
              {VERTICALS.filter((v) => v !== 'all').map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Neto del proveedor</Label>
            <input
              type="number"
              value={simNet}
              onChange={(e) => setSimNet(e.target.value)}
              className={inputClass + ' w-32'}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={simulating}
            onClick={() => void simulate()}
          >
            {simulating ? 'Calculando…' : 'Simular'}
          </Button>
        </div>

        {sim && (
          <div className="mt-3 space-y-1.5 text-sm">
            {sim.steps.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]"
              >
                <span>
                  {s.tenantName}{' '}
                  <span className="text-[var(--color-fg-subtle)]">(nivel {s.level})</span>
                </span>
                <span>+ {money(s.addedMinor)}</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-[var(--color-border)] pt-2 font-medium text-[var(--color-fg)]">
              <span>Precio final</span>
              <span>
                {money(sim.final)}{' '}
                <span className="text-xs font-normal text-emerald-600">
                  (+{money(sim.markup)} markup)
                </span>
              </span>
            </div>
          </div>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </ModalFooter>
    </Modal>
  );
}

interface AuditEntry {
  id: string;
  occurredAt: string;
  eventType: string;
  tenantName: string | null;
  actorEmail: string | null;
  payload: Record<string, unknown>;
}

const EVENT_LABELS: Record<string, string> = {
  TenantCreated: 'Agencia creada',
  ProviderCredentialsUpdated: 'Credenciales actualizadas',
  MembershipRoleChanged: 'Rol cambiado',
  MarkupRuleCreated: 'Regla de markup creada',
  MarkupRuleDeleted: 'Regla de markup eliminada',
};

function AuditModal({ rootId, onClose }: { rootId: string; onClose: () => void }) {
  const [events, setEvents] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `/api/tenants/network/audit?tenantId=${encodeURIComponent(rootId)}`,
        );
        const data = (await res.json()) as { events?: AuditEntry[] };
        setEvents(data.events ?? []);
      } catch {
        setEvents([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [rootId]);

  return (
    <Modal title="Actividad de la red" onClose={onClose} wide>
      <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
        Registro inmutable de acciones sensibles en tu red (credenciales, roles, reglas de pricing,
        altas de agencias).
      </p>
      {loading ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-10 text-center text-xs text-[var(--color-fg-muted)]">
          Sin actividad registrada todavía.
        </div>
      ) : (
        <div className="space-y-1.5">
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--color-fg)]">
                  {EVENT_LABELS[e.eventType] ?? e.eventType}
                </div>
                <div className="truncate text-[11px] text-[var(--color-fg-subtle)]">
                  {e.tenantName ?? '—'}
                  {e.actorEmail ? ` · ${e.actorEmail}` : ''}
                </div>
              </div>
              <time className="shrink-0 text-[10px] text-[var(--color-fg-subtle)]">
                {new Date(e.occurredAt).toLocaleString('es-CO', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
          ))}
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

interface NetworkUser {
  userId: string;
  email: string;
  name: string | null;
  userStatus: string;
  role: string;
  membershipStatus: string;
  createdAt: string;
}

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin',
  platform_admin: 'Admin plataforma',
  consolidator_admin: 'Admin consolidador',
  tenant_admin: 'Admin agencia',
  agency_admin: 'Admin agencia',
  admin: 'Admin',
  vendedor: 'Vendedor',
  cliente_final: 'Cliente',
};
// Roles asignables desde el panel (alineado con ASSIGNABLE_ROLES / CreateUserBody del API).
const ASSIGNABLE_ROLES = ['tenant_admin', 'admin', 'vendedor', 'cliente_final'];

/** Extrae el mensaje de negocio del cuerpo de error del API (HttpException → { message }). */
function apiError(data: { message?: string | string[]; error?: string }, fallback: string): string {
  const m = Array.isArray(data.message) ? data.message.join(', ') : data.message;
  return m ?? data.error ?? fallback;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function UsersModal({ tenant, onClose }: { tenant: NetworkTenant; onClose: () => void }) {
  const [users, setUsers] = useState<NetworkUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ email: '', name: '', password: '', role: 'vendedor' });
  const [inviteSaving, setInviteSaving] = useState(false);
  const [inviteError, setInviteError] = useState('');

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/tenants/network/users?tenantId=${encodeURIComponent(tenant.id)}`,
      );
      const data = (await res.json()) as { users?: NetworkUser[] };
      setUsers(data.users ?? []);
    } catch {
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(u: NetworkUser, role: string) {
    if (role === u.role) return;
    setError('');
    setSavingId(u.userId);
    const prev = users;
    setUsers((list) => list.map((x) => (x.userId === u.userId ? { ...x, role } : x)));
    try {
      const res = await fetch('/api/admin/memberships/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.userId, tenantId: tenant.id, role }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string | string[]; error?: string };
        setError(apiError(data, 'No se pudo cambiar el rol'));
        setUsers(prev);
      }
    } catch {
      setError('Error de conexión');
      setUsers(prev);
    } finally {
      setSavingId(null);
    }
  }

  async function sendInvite() {
    setInviteError('');
    if (!invite.email.trim() || !invite.password) {
      setInviteError('Email y contraseña son requeridos.');
      return;
    }
    setInviteSaving(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: invite.email.trim(),
          name: invite.name.trim() || invite.email.trim(),
          password: invite.password,
          tenantId: tenant.id,
          role: invite.role,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string | string[]; error?: string };
        setInviteError(apiError(data, 'No se pudo crear el usuario'));
        return;
      }
      setInvite({ email: '', name: '', password: '', role: 'vendedor' });
      setInviting(false);
      void load();
    } catch {
      setInviteError('Error de conexión');
    } finally {
      setInviteSaving(false);
    }
  }

  const roleOptions = (current: string): string[] =>
    Array.from(new Set([...ASSIGNABLE_ROLES, current]));

  return (
    <Modal title={`Usuarios · ${tenant.name}`} onClose={onClose} wide>
      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
        Gestioná quién accede a{' '}
        <span className="font-medium text-[var(--color-fg)]">{tenant.name}</span> y con qué rol. Los
        cambios quedan registrados en la actividad de la red.
      </p>

      {loading ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : users.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-xs text-[var(--color-fg-muted)]">
          Sin usuarios en este nodo todavía.
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div
              key={u.userId}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/8 text-xs font-medium text-[var(--color-primary)]">
                  {(u.name ?? u.email).slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[var(--color-fg)]">
                    {u.name ?? u.email}
                  </div>
                  <div className="truncate text-[11px] text-[var(--color-fg-subtle)]">
                    {u.email}
                  </div>
                </div>
              </div>
              <select
                value={u.role}
                disabled={savingId === u.userId}
                onChange={(e) => void changeRole(u, e.target.value)}
                className={selectClass + ' w-40 shrink-0'}
                aria-label={`Rol de ${u.email}`}
              >
                {roleOptions(u.role).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}

      {!inviting ? (
        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => setInviting(true)}
          >
            <UserPlus className="size-3.5" />
            Invitar usuario
          </Button>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email">
              <input
                type="email"
                value={invite.email}
                onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                placeholder="persona@agencia.com"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
            <Field label="Nombre">
              <input
                value={invite.name}
                onChange={(e) => setInvite({ ...invite, name: e.target.value })}
                placeholder="Nombre"
                className={inputClass}
              />
            </Field>
            <Field label="Contraseña temporal">
              <input
                type="password"
                value={invite.password}
                onChange={(e) => setInvite({ ...invite, password: e.target.value })}
                placeholder="Mínimo 12 caracteres"
                className={inputClass}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Rol">
              <select
                value={invite.role}
                onChange={(e) => setInvite({ ...invite, role: e.target.value })}
                className={selectClass}
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {inviteError && <ErrorBox>{inviteError}</ErrorBox>}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setInviting(false)}>
              Cancelar
            </Button>
            <Button size="sm" disabled={inviteSaving} onClick={() => void sendInvite()}>
              {inviteSaving ? 'Creando…' : 'Crear usuario'}
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

interface EmailAccountView {
  providerCode: string;
  config: Record<string, unknown>;
  isInheritable: boolean;
  status: string;
  updatedAt: string;
}

function EmailModal({ tenant, onClose }: { tenant: NetworkTenant; onClose: () => void }) {
  const [existing, setExisting] = useState<EmailAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({
    fromName: '',
    fromEmail: '',
    host: 'smtp.gmail.com',
    port: '587',
    user: '',
    appPassword: '',
    isInheritable: true,
  });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/provider-accounts?tenantId=${encodeURIComponent(tenant.id)}`);
      const data = (await res.json()) as { accounts?: EmailAccountView[] };
      const acc = (data.accounts ?? []).find((a) => a.providerCode === 'email') ?? null;
      setExisting(acc);
      if (acc) {
        const c = acc.config ?? {};
        setForm((f) => ({
          ...f,
          fromName: asStr(c['fromName']),
          fromEmail: asStr(c['fromEmail']),
          host: asStr(c['host']) || f.host,
          port:
            typeof c['port'] === 'number' || typeof c['port'] === 'string'
              ? String(c['port'])
              : f.port,
          isInheritable: acc.isInheritable,
        }));
      }
    } catch {
      setExisting(null);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setError('');
    setSaved(false);
    if (!form.host.trim() || !form.user.trim() || !form.appPassword) {
      setError('Servidor, correo y clave de aplicación son requeridos.');
      return;
    }
    setSaving(true);
    try {
      const port = Number(form.port) || 587;
      const res = await fetch('/api/provider-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          providerCode: 'email',
          label: 'default',
          credentials: { user: form.user.trim(), password: form.appPassword },
          config: {
            host: form.host.trim(),
            port,
            secure: port === 465,
            fromEmail: form.fromEmail.trim() || form.user.trim(),
            fromName: form.fromName.trim(),
          },
          isInheritable: form.isInheritable,
          status: 'active',
        }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        setError(apiError(data, 'No se pudo guardar la configuración de email'));
        return;
      }
      setForm((f) => ({ ...f, appPassword: '' }));
      setSaved(true);
      void load();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch('/api/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.id }),
      });
      const data = (await res.json()) as {
        sent?: boolean;
        to?: string;
        from?: string;
        reason?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setTestMsg({ ok: false, text: apiError(data, 'No se pudo enviar la prueba.') });
        return;
      }
      if (data.sent) {
        setTestMsg({
          ok: true,
          text: `Correo de prueba enviado a ${data.to ?? ''}${data.from ? ` (desde ${data.from})` : ''}.`,
        });
      } else {
        setTestMsg({ ok: false, text: data.reason ?? 'No se pudo enviar la prueba.' });
      }
    } catch {
      setTestMsg({ ok: false, text: 'Error de conexión.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal title={`Email · ${tenant.name}`} onClose={onClose} wide>
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" />
        <span>
          Correo desde el que esta agencia envía sus notificaciones. La clave se cifra y nunca se
          muestra de vuelta. <strong className="text-[var(--color-fg)]">Si lo dejás vacío</strong>,
          se usa el correo del sistema (o el del consolidador, si lo heredás).
        </span>
      </div>

      {loading ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : (
        <>
          {existing && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <Mail className="size-3.5 shrink-0" />
              <span>
                Correo configurado
                {asStr(existing.config['fromEmail'])
                  ? ` (${asStr(existing.config['fromEmail'])})`
                  : ''}
                . Para reemplazarlo, completá de nuevo el correo y la clave.
              </span>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre del remitente">
              <input
                value={form.fromName}
                onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                placeholder="Agencia Sur"
                className={inputClass}
              />
            </Field>
            <Field label="Correo del remitente">
              <input
                type="email"
                value={form.fromEmail}
                onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
                placeholder="notificaciones@agencia.com"
                className={inputClass}
              />
            </Field>
            <Field label="Servidor SMTP">
              <input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="smtp.gmail.com"
                className={inputClass}
              />
            </Field>
            <Field label="Puerto">
              <input
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                placeholder="587"
                className={inputClass}
              />
            </Field>
            <Field label="Usuario (correo de la cuenta)">
              <input
                type="email"
                value={form.user}
                onChange={(e) => setForm({ ...form, user: e.target.value })}
                placeholder="cuenta@agencia.com"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
            <Field label="Clave de aplicación">
              <input
                type="password"
                value={form.appPassword}
                onChange={(e) => setForm({ ...form, appPassword: e.target.value })}
                placeholder="••••••••••••"
                className={inputClass}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-[var(--color-fg-subtle)]">
            En Gmail/Workspace usá una{' '}
            <span className="font-medium text-[var(--color-fg-muted)]">clave de aplicación</span>{' '}
            (no tu contraseña normal). Puerto 587 (TLS) o 465 (SSL).
          </p>
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={form.isInheritable}
              onChange={(e) => setForm({ ...form, isInheritable: e.target.checked })}
              className="size-4 rounded border-[var(--color-border)]"
            />
            Heredable: las sub-agencias sin correo propio usan éste
          </label>
          {error && <ErrorBox>{error}</ErrorBox>}
          {saved && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Configuración de email guardada.
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={testing}
              onClick={() => void sendTest()}
            >
              {testing ? 'Enviando…' : 'Enviar correo de prueba'}
            </Button>
            <span className="text-[11px] text-[var(--color-fg-subtle)]">
              Prueba el correo guardado/efectivo (guardá primero si cambiaste algo).
            </span>
            {testMsg && (
              <span
                className={cn('w-full text-xs', testMsg.ok ? 'text-emerald-700' : 'text-red-700')}
              >
                {testMsg.text}
              </span>
            )}
          </div>
        </>
      )}

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cerrar
        </Button>
        <Button size="sm" disabled={saving || loading} onClick={() => void save()}>
          {saving ? 'Guardando…' : 'Guardar email'}
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
