'use client';

import { Building2, Plus, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Label } from '../../../../components/ui/label';
import { cn } from '../../../../lib/cn';

interface Tenant {
  id: string;
  slug: string;
  name: string;
  countryCode: string;
  defaultCurrency: string;
  status: string;
  userCount: number;
  createdAt: string;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: { label: 'Activo', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  suspended: { label: 'Suspendido', className: 'bg-red-50 text-red-700 border-red-200' },
  archived: {
    label: 'Archivado',
    className:
      'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)] border-[var(--color-border)]',
  },
};

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [form, setForm] = useState({
    name: '',
    slug: '',
    countryCode: 'CO',
    defaultCurrency: 'COP',
    defaultLanguage: 'es' as 'es' | 'pt' | 'en',
    adminEmail: '',
    adminName: '',
    adminPassword: '',
  });

  useEffect(() => {
    fetchTenants();
  }, []);

  function fetchTenants() {
    fetch('/api/admin/tenants')
      .then((r) => r.json() as Promise<{ tenants: Tenant[] }>)
      .then((d) => setTenants(d.tenants ?? []))
      .catch(() => setTenants([]))
      .finally(() => setLoading(false));
  }

  function handleSlugify(name: string) {
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

  async function handleCreate() {
    setCreateError('');
    if (!form.name.trim() || !form.slug.trim()) {
      setCreateError('Nombre y slug son requeridos.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as { tenant?: { id: string }; error?: string };
      if (!res.ok) {
        setCreateError(data.error ?? 'Error al crear tenant');
        return;
      }
      setShowCreate(false);
      setForm({
        name: '',
        slug: '',
        countryCode: 'CO',
        defaultCurrency: 'COP',
        defaultLanguage: 'es',
        adminEmail: '',
        adminName: '',
        adminPassword: '',
      });
      fetchTenants();
    } catch {
      setCreateError('Error de conexión');
    } finally {
      setCreating(false);
    }
  }

  const filtered = tenants.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.slug.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Agencias</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {tenants.length} {tenants.length === 1 ? 'agencia' : 'agencias'} registradas
          </p>
        </div>
        <Button className="gap-2" onClick={() => setShowCreate(true)}>
          <Plus className="size-4" />
          Nueva agencia
        </Button>
      </div>

      {/* Search */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o slug..."
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-2.5 pl-10 pr-4 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] transition-colors focus:border-[var(--color-primary)] focus:outline-none"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <Building2 className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            {search ? 'Sin resultados' : 'No hay tenants'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Nombre
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Slug
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  País
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Usuarios
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Creado
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {filtered.map((tenant) => {
                const statusInfo = STATUS_CONFIG[tenant.status] ?? STATUS_CONFIG.active!;
                return (
                  <tr
                    key={tenant.id}
                    className="bg-[var(--color-surface)] transition-colors hover:bg-[var(--color-surface-muted)]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                          <Building2 className="size-4" />
                        </div>
                        <span className="text-sm font-medium text-[var(--color-fg)]">
                          {tenant.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
                        {tenant.slug}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                      {tenant.countryCode}
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[var(--color-fg-muted)]">
                      {tenant.userCount}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium',
                          statusInfo.className,
                        )}
                      >
                        <span className="size-1.5 rounded-full bg-current" />
                        {statusInfo.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--color-fg-subtle)]">
                      {new Date(tenant.createdAt).toLocaleDateString('es-CO', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-fg)]">Nueva agencia</h2>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label>Nombre de la agencia</Label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => handleSlugify(e.target.value)}
                  placeholder="Mi Agencia de Viajes"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Slug (URL)</Label>
                <input
                  type="text"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  placeholder="mi-agencia"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <Label>País</Label>
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
                  <option value="EC">Ecuador</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label>Moneda</Label>
                <select
                  value={form.defaultCurrency}
                  onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value })}
                  className={selectClass}
                >
                  <option value="COP">COP</option>
                  <option value="BRL">BRL</option>
                  <option value="PEN">PEN</option>
                  <option value="CLP">CLP</option>
                  <option value="MXN">MXN</option>
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label>Idioma</Label>
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
              </div>

              {/* Admin user section */}
              <div className="space-y-1 sm:col-span-2">
                <div className="my-2 border-t border-[var(--color-border)]" />
                <p className="text-xs font-medium text-[var(--color-fg-muted)]">
                  Admin de la agencia (opcional)
                </p>
              </div>
              <div className="space-y-1">
                <Label>Email admin</Label>
                <input
                  type="email"
                  value={form.adminEmail}
                  onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
                  placeholder="admin@agencia.com"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <Label>Nombre admin</Label>
                <input
                  type="text"
                  value={form.adminName}
                  onChange={(e) => setForm({ ...form, adminName: e.target.value })}
                  placeholder="Juan Admin"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Contraseña admin</Label>
                <input
                  type="password"
                  value={form.adminPassword}
                  onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
                  placeholder="Mínimo 12 caracteres"
                  className={inputClass}
                />
              </div>
            </div>

            {createError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {createError}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={creating}
                onClick={() => void handleCreate()}
                className="gap-1.5"
              >
                <Plus className="size-3.5" />
                {creating ? 'Creando…' : 'Crear agencia'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
