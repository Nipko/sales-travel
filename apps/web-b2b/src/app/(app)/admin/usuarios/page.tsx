'use client';

import { Mail, Search, Shield, UserMinus, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Label } from '../../../../components/ui/label';
import { useConfirm } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';

/**
 * Equipo de la red.
 *
 * Antes esta pantalla consumía /api/admin/users y /api/admin/tenants, que en el backend
 * son superadmin-only: para cualquier admin de agencia devolvían 403 y la tabla quedaba
 * vacía sin explicación. Ahora usa los endpoints de red (/tenants/network*), gateados por
 * canManageTenant, así que un consolidador ve su red y una agencia ve la suya y sus
 * sub-agencias — nunca su padre ni agencias hermanas.
 */

interface NetworkTenant {
  id: string;
  name: string;
  tenantType: string;
  depth: number;
  status: string;
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

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  invitedByEmail: string | null;
  expiresAt: string;
  createdAt: string;
}

const ROLE_CONFIG: Record<string, { label: string; className: string }> = {
  superadmin: { label: 'Superadmin', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  platform_admin: {
    label: 'Plataforma',
    className: 'bg-purple-50 text-purple-700 border-purple-200',
  },
  consolidator_admin: {
    label: 'Consolidador',
    className: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  tenant_admin: { label: 'Admin', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  agency_admin: { label: 'Admin agencia', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  admin: { label: 'Manager', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  vendedor: { label: 'Vendedor', className: 'bg-teal-50 text-teal-700 border-teal-200' },
  cliente_final: {
    label: 'Cliente',
    className:
      'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] border-[var(--color-border)]',
  },
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: { label: 'Activo', className: 'bg-emerald-50 text-emerald-700' },
  suspended: { label: 'Suspendido', className: 'bg-red-50 text-red-700' },
  invited: { label: 'Invitado', className: 'bg-amber-50 text-amber-700' },
};

/** Roles que se pueden invitar. Espejo de ASSIGNABLE_ROLES en el backend. */
const INVITABLE_ROLES = [
  { value: 'vendedor', label: 'Vendedor' },
  { value: 'admin', label: 'Manager' },
  { value: 'agency_admin', label: 'Admin de agencia' },
  { value: 'tenant_admin', label: 'Admin' },
  { value: 'cliente_final', label: 'Cliente' },
] as const;

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export default function AdminUsuariosPage() {
  const [confirmAction, confirmDialog] = useConfirm();
  const [tenants, setTenants] = useState<NetworkTenant[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [users, setUsers] = useState<NetworkUser[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const [showInvite, setShowInvite] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSent, setInviteSent] = useState('');
  const [form, setForm] = useState<{ email: string; role: string }>({
    email: '',
    role: 'vendedor',
  });

  // Carga de la red: el primer nodo es el propio, y es el que se selecciona por defecto.
  useEffect(() => {
    fetch('/api/tenants/network')
      .then((r) => r.json() as Promise<{ tenants?: NetworkTenant[] }>)
      .then((d) => {
        const list = d.tenants ?? [];
        setTenants(list);
        if (list.length > 0) setTenantId(list[0]!.id);
        else setLoading(false);
      })
      .catch(() => {
        setError('No pudimos cargar tu red de agencias.');
        setLoading(false);
      });
  }, []);

  const load = useCallback(() => {
    if (!tenantId) return;
    setLoading(true);
    setError('');
    const q = `tenantId=${encodeURIComponent(tenantId)}`;
    Promise.all([
      fetch(`/api/tenants/network/users?${q}`).then(
        (r) => r.json() as Promise<{ users?: NetworkUser[] }>,
      ),
      fetch(`/api/invitations?${q}`).then(
        (r) => r.json() as Promise<{ invitations?: PendingInvitation[] }>,
      ),
    ])
      .then(([u, i]) => {
        setUsers(u.users ?? []);
        setInvitations(i.invitations ?? []);
      })
      .catch(() => setError('No pudimos cargar los usuarios de esta agencia.'))
      .finally(() => setLoading(false));
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError('');
    try {
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.email.trim(), tenantId, role: form.role }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setInviteError(body.error ?? 'No pudimos enviar la invitación.');
        return;
      }
      setInviteSent(form.email.trim());
      setForm({ email: '', role: 'vendedor' });
      setShowInvite(false);
      load();
    } finally {
      setInviting(false);
    }
  }

  async function setStatus(userId: string, status: 'active' | 'suspended') {
    const verb = status === 'suspended' ? 'suspender' : 'reactivar';
    const ok = await confirmAction({
      title: status === 'suspended' ? 'Suspender usuario' : 'Reactivar usuario',
      description:
        status === 'suspended'
          ? 'Se le corta el acceso de inmediato y se cierran sus sesiones abiertas.'
          : 'Vuelve a tener acceso a esta agencia.',
      confirmLabel: status === 'suspended' ? 'Suspender' : 'Reactivar',
      destructive: status === 'suspended',
    });
    if (!ok) return;

    const res = await fetch('/api/admin/memberships/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, tenantId, status }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? `No pudimos ${verb} al usuario.`);
      return;
    }
    load();
  }

  async function changeRole(userId: string, role: string) {
    const res = await fetch('/api/admin/memberships/role', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, tenantId, role }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? 'No pudimos cambiar el rol.');
      return;
    }
    load();
  }

  async function revokeInvitation(id: string) {
    await fetch(`/api/invitations/${id}/revoke?tenantId=${encodeURIComponent(tenantId)}`, {
      method: 'POST',
    });
    load();
  }

  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    return !q || u.email.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-fg)]">Equipo</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Usuarios de tu agencia y de las agencias de tu red.
          </p>
        </div>
        <Button
          onClick={() => {
            setShowInvite(true);
            setInviteSent('');
          }}
          disabled={!tenantId}
          className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)]"
        >
          <UserPlus className="mr-2 size-4" />
          Invitar usuario
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-danger)]"
        >
          {error}
        </div>
      ) : null}

      {inviteSent ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-[var(--color-success)]/20 bg-[var(--color-success)]/5 px-3 py-2.5 text-xs text-[var(--color-success)]"
        >
          <Mail className="size-4" />
          Invitación enviada a {inviteSent}. Elige su propia contraseña al aceptarla.
        </div>
      ) : null}

      {/* Selector de agencia + buscador */}
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[220px] flex-1">
          <Label htmlFor="tenant" className="mb-1.5 block text-xs font-semibold">
            Agencia
          </Label>
          <select
            id="tenant"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            className={selectClass}
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {' '.repeat(t.depth * 2)}
                {t.name}
                {t.status !== 'active' ? ' (suspendida)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <Label htmlFor="q" className="mb-1.5 block text-xs font-semibold">
            Buscar
          </Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
            <input
              id="q"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nombre o correo"
              className={cn(inputClass, 'pl-8')}
            />
          </div>
        </div>
      </div>

      {/* Invitaciones pendientes */}
      {invitations.length > 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-2.5">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              Invitaciones pendientes ({invitations.length})
            </h2>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {invitations.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <div>
                  <p className="text-sm text-[var(--color-fg)]">{i.email}</p>
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    {ROLE_CONFIG[i.role]?.label ?? i.role} · vence{' '}
                    {new Date(i.expiresAt).toLocaleDateString('es-CO')}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => revokeInvitation(i.id)}>
                  <X className="mr-1.5 size-4" />
                  Revocar
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Usuarios */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
            <tr className="text-left text-xs font-semibold text-[var(--color-fg-muted)]">
              <th className="px-4 py-2.5">Usuario</th>
              <th className="px-4 py-2.5">Rol</th>
              <th className="px-4 py-2.5">Estado</th>
              <th className="px-4 py-2.5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {loading ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-xs text-[var(--color-fg-subtle)]"
                >
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-xs text-[var(--color-fg-subtle)]"
                >
                  {search
                    ? 'Ningún usuario coincide con la búsqueda.'
                    : 'Esta agencia no tiene usuarios todavía.'}
                </td>
              </tr>
            ) : (
              filtered.map((u) => {
                const role = ROLE_CONFIG[u.role];
                const status = STATUS_CONFIG[u.membershipStatus];
                const suspended = u.membershipStatus === 'suspended';
                return (
                  <tr key={u.userId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-[var(--color-fg)]">{u.name ?? '—'}</p>
                      <p className="text-xs text-[var(--color-fg-subtle)]">{u.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        onChange={(e) => changeRole(u.userId, e.target.value)}
                        className={cn(selectClass, 'max-w-[160px]')}
                        aria-label={`Rol de ${u.email}`}
                      >
                        {INVITABLE_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                        {/* Los roles no asignables se muestran pero el backend rechaza el cambio. */}
                        {!INVITABLE_ROLES.some((r) => r.value === u.role) ? (
                          <option value={u.role}>{role?.label ?? u.role}</option>
                        ) : null}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                          status?.className ??
                            'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
                        )}
                      >
                        {status?.label ?? u.membershipStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant={suspended ? 'ghost' : 'danger'}
                        onClick={() => setStatus(u.userId, suspended ? 'active' : 'suspended')}
                      >
                        <UserMinus className="mr-1.5 size-4" />
                        {suspended ? 'Reactivar' : 'Suspender'}
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal de invitación */}
      {showInvite ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lg)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--color-fg)]">
                <Shield className="size-4 text-[var(--color-fg-muted)]" />
                Invitar usuario
              </h2>
              <button
                onClick={() => setShowInvite(false)}
                aria-label="Cerrar"
                className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={invite} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="inv-email" className="text-xs font-semibold">
                  Correo electrónico
                </Label>
                <input
                  id="inv-email"
                  type="email"
                  required
                  autoFocus
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="persona@agencia.com"
                  className={inputClass}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="inv-role" className="text-xs font-semibold">
                  Rol
                </Label>
                <select
                  id="inv-role"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  className={selectClass}
                >
                  {INVITABLE_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  No podés invitar con un rol igual o superior al tuyo.
                </p>
              </div>

              {inviteError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-danger)]"
                >
                  {inviteError}
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setShowInvite(false)}>
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  disabled={inviting}
                  className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)]"
                >
                  {inviting ? 'Enviando…' : 'Enviar invitación'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
