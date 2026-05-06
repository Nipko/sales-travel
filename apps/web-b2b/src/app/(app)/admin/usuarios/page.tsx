'use client';

import { Mail, Search, Shield, UserPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Label } from '../../../../components/ui/label';
import { cn } from '../../../../lib/cn';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  role: string;
  tenantName: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface TenantOption {
  id: string;
  name: string;
}

const ROLE_CONFIG: Record<string, { label: string; className: string }> = {
  superadmin: { label: 'Superadmin', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  tenant_admin: { label: 'Admin', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  admin: { label: 'Manager', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  vendedor: { label: 'Vendedor', className: 'bg-teal-50 text-teal-700 border-teal-200' },
  cliente_final: { label: 'Cliente', className: 'bg-zinc-50 text-zinc-600 border-zinc-200' },
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: { label: 'Activo', className: 'bg-emerald-50 text-emerald-700' },
  suspended: { label: 'Suspendido', className: 'bg-red-50 text-red-700' },
  invited: { label: 'Invitado', className: 'bg-amber-50 text-amber-700' },
};

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export default function AdminUsuariosPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [tenants, setTenants] = useState<TenantOption[]>([]);

  const [form, setForm] = useState({
    email: '',
    name: '',
    password: '',
    tenantId: '',
    role: 'vendedor' as 'tenant_admin' | 'admin' | 'vendedor' | 'cliente_final',
  });

  useEffect(() => {
    fetchUsers();
    fetch('/api/admin/tenants')
      .then((r) => r.json() as Promise<{ tenants: TenantOption[] }>)
      .then((d) => {
        setTenants(d.tenants ?? []);
        if (d.tenants?.length && !form.tenantId) {
          setForm((f) => ({ ...f, tenantId: d.tenants[0]!.id }));
        }
      })
      .catch(() => setTenants([]));
  }, []);

  function fetchUsers() {
    fetch('/api/admin/users')
      .then((r) => r.json() as Promise<{ users: UserRow[] }>)
      .then((d) => setUsers(d.users ?? []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }

  async function handleCreate() {
    setCreateError('');
    if (!form.email.trim() || !form.password.trim() || !form.tenantId) {
      setCreateError('Email, contraseña y agencia son requeridos.');
      return;
    }
    if (form.password.length < 12) {
      setCreateError('La contraseña debe tener al menos 12 caracteres.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as { user?: { id: string }; error?: string };
      if (!res.ok) {
        setCreateError(data.error ?? 'Error al crear usuario');
        return;
      }
      setShowCreate(false);
      setForm({
        email: '',
        name: '',
        password: '',
        tenantId: tenants[0]?.id ?? '',
        role: 'vendedor',
      });
      fetchUsers();
    } catch {
      setCreateError('Error de conexión');
    } finally {
      setCreating(false);
    }
  }

  const filtered = users.filter(
    (u) =>
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.name ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Usuarios</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {users.length} {users.length === 1 ? 'usuario' : 'usuarios'} en la plataforma
          </p>
        </div>
        <Button className="gap-2" onClick={() => setShowCreate(true)}>
          <UserPlus className="size-4" />
          Invitar usuario
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
            placeholder="Buscar por email o nombre..."
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
          <Shield className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            {search ? 'Sin resultados' : 'No hay usuarios'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Usuario
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Rol
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Agencia
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Registrado
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {filtered.map((user) => {
                const roleInfo = ROLE_CONFIG[user.role] ?? ROLE_CONFIG.vendedor!;
                const statusInfo = STATUS_CONFIG[user.status] ?? STATUS_CONFIG.active!;
                return (
                  <tr
                    key={user.id}
                    className="bg-[var(--color-surface)] transition-colors hover:bg-[var(--color-surface-muted)]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
                          <Mail className="size-3.5" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                            {user.name ?? user.email.split('@')[0]}
                          </p>
                          <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                            {user.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium',
                          roleInfo.className,
                        )}
                      >
                        {roleInfo.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                      {user.tenantName}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-medium',
                          statusInfo.className,
                        )}
                      >
                        {statusInfo.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--color-fg-subtle)]">
                      {new Date(user.createdAt).toLocaleDateString('es-CO', {
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

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-fg)]">Invitar usuario</h2>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="grid gap-4">
              <div className="space-y-1">
                <Label>Email</Label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="usuario@empresa.com"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <Label>Nombre</Label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Juan Vendedor"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <Label>Contraseña</Label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Mínimo 12 caracteres"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <Label>Agencia</Label>
                <select
                  value={form.tenantId}
                  onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                  className={selectClass}
                >
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Rol</Label>
                <select
                  value={form.role}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      role: e.target.value as
                        | 'tenant_admin'
                        | 'admin'
                        | 'vendedor'
                        | 'cliente_final',
                    })
                  }
                  className={selectClass}
                >
                  <option value="tenant_admin">Admin de la agencia</option>
                  <option value="admin">Manager</option>
                  <option value="vendedor">Vendedor</option>
                  <option value="cliente_final">Cliente final</option>
                </select>
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
                <UserPlus className="size-3.5" />
                {creating ? 'Creando…' : 'Crear usuario'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
