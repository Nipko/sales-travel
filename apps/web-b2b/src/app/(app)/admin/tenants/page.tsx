'use client';

import { Building2, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../../components/ui/button';
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
  archived: { label: 'Archivado', className: 'bg-zinc-50 text-zinc-500 border-zinc-200' },
};

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/admin/tenants')
      .then((r) => r.json() as Promise<{ tenants: Tenant[] }>)
      .then((d) => setTenants(d.tenants ?? []))
      .catch(() => setTenants([]))
      .finally(() => setLoading(false));
  }, []);

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
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Tenants</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {tenants.length} {tenants.length === 1 ? 'workspace' : 'workspaces'} registrados
          </p>
        </div>
        <Button className="gap-2">
          <Plus className="size-4" />
          Nuevo tenant
        </Button>
      </div>

      {/* Search + Filters */}
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
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
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
                  Pais
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
    </div>
  );
}
