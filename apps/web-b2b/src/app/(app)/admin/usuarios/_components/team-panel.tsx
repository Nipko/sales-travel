'use client';

import { Mail, RefreshCw, Search, UserPlus, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../components/ui/button';
import { Dialog, useConfirm } from '../../../../../components/ui/dialog';
import { Label } from '../../../../../components/ui/label';
import { cn } from '../../../../../lib/cn';
import { readJson } from '../../../../../lib/read-json';
import {
  loadInvitations,
  loadMembers,
  loadMembershipImpact,
  revokeInvitation,
  runMemberAction,
  type MembershipChange,
} from '../../../../../lib/tenant-admin-seats-client';
import {
  demotes,
  grantableRoles,
  memberActionCopy,
  memberActionDoneMessage,
  memberName,
  roleChangeCopy,
  statusChangeCopy,
  type MemberAction,
  type NetworkMember,
  type PendingInvitation,
  type TeamActor,
} from '../../../../../lib/tenant-admin-team';
import { networkRoot, treeOrder, type NetworkNode } from '../../../../../lib/tenant-network';
import { MemberList, type MemberRowError } from './member-list';
import { INVITABLE_ROLES, roleLabel } from './roles';
import { InvitationList } from './invitation-list';
import { SeatsCard, useSeatsView } from './seats-ui';

/**
 * Equipo de la red.
 *
 * Antes esta pantalla consumía /api/admin/users y /api/admin/tenants, que en el backend
 * son superadmin-only: para cualquier admin de agencia devolvían 403 y la tabla quedaba
 * vacía sin explicación. Ahora usa los endpoints de red (/tenants/network*), gateados por
 * canManageTenant, así que un consolidador ve su red y una agencia ve la suya y sus
 * sub-agencias — nunca su padre ni agencias hermanas.
 *
 * Cada lista distingue cargando, error y vacío: un 403 o un 500 ya no se ve como "esta agencia no
 * tiene usuarios".
 */

type ListState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly items: readonly T[] };

type NetworkState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly tenants: readonly NetworkNode[] };

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

/** " Se revocaron N invitaciones que envió." para el aviso de éxito, según lo que devolvió el API. */
function revokedSuffix(body: unknown): string {
  const n =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['revokedInvitations']
      : undefined;
  if (typeof n !== 'number' || n <= 0) return '';
  return n === 1
    ? ' Se revocó 1 invitación que envió.'
    : ` Se revocaron ${n} invitaciones que envió.`;
}

function Alert({
  tone,
  children,
  onDismiss,
}: {
  tone: 'error' | 'success';
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs',
        tone === 'error'
          ? 'border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 text-[var(--color-danger)]'
          : 'border-[var(--color-success)]/25 bg-[var(--color-success)]/5 text-[var(--color-fg)]',
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar aviso"
          className="rounded text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function TeamPanel({ actor }: { actor: TeamActor }) {
  const [confirm, confirmDialog] = useConfirm();
  const [network, setNetwork] = useState<NetworkState>({ status: 'loading' });
  const [tenantId, setTenantId] = useState('');
  const [members, setMembers] = useState<ListState<NetworkMember>>({ status: 'loading' });
  const [invitations, setInvitations] = useState<ListState<PendingInvitation>>({
    status: 'loading',
  });
  const [search, setSearch] = useState('');
  // Errores que no son de un miembro (revocar una invitación). Los de una acción sobre un miembro
  // van en su fila (`memberError`): acá arriba quedaban fuera de vista con la lista larga.
  const [actionError, setActionError] = useState('');
  const [memberError, setMemberError] = useState<MemberRowError | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteSent, setInviteSent] = useState('');
  const seats = useSeatsView(tenantId === '' ? null : tenantId);
  const reloadSeats = seats.reload;

  // Carga de la red, en orden del árbol. Arranca en la raíz de la red del usuario (la plataforma, si
  // la ve): antes era el primero por orden alfabético, y una agencia suelta pasaba delante.
  const loadNetwork = useCallback(async () => {
    setNetwork({ status: 'loading' });
    let res: Response;
    try {
      res = await fetch('/api/tenants/network', { cache: 'no-store' });
    } catch {
      setNetwork({ status: 'error', message: 'No pudimos conectar con el servidor.' });
      return;
    }
    const read = await readJson<{ tenants?: unknown }>(res);
    if (!res.ok || !read.ok || !Array.isArray(read.data.tenants)) {
      setNetwork({
        status: 'error',
        message:
          res.status === 403
            ? 'No administrás ningún nodo de la red.'
            : 'No pudimos cargar tu red de agencias.',
      });
      return;
    }
    const list = read.data.tenants as NetworkNode[];
    setNetwork({ status: 'ready', tenants: treeOrder(list) });
    const root = networkRoot(list);
    setTenantId((current) => current || root?.id || '');
  }, []);

  useEffect(() => {
    void loadNetwork();
  }, [loadNetwork]);

  // Cambiar de nodo mientras vuelve la respuesta del anterior no debe pintar su equipo.
  const currentTenant = useRef(tenantId);
  currentTenant.current = tenantId;

  const load = useCallback(
    async (quiet = false) => {
      if (tenantId === '') return;
      if (!quiet) {
        setMembers({ status: 'loading' });
        setInvitations({ status: 'loading' });
      }
      const [m, i] = await Promise.all([loadMembers(tenantId), loadInvitations(tenantId)]);
      if (currentTenant.current !== tenantId) return;
      setMembers(
        m.ok ? { status: 'ready', items: m.data } : { status: 'error', message: m.message },
      );
      setInvitations(
        i.ok ? { status: 'ready', items: i.data } : { status: 'error', message: i.message },
      );
    },
    [tenantId],
  );

  useEffect(() => {
    setActionError('');
    setMemberError(null);
    void load();
  }, [load]);

  function failOn(member: NetworkMember, message: string) {
    setMemberError({ userId: member.userId, message });
  }

  /**
   * Cuántas invitaciones revocaría el cambio, para decirlo en la confirmación. `null` si no se pudo
   * saber: se confirma igual y el aviso lo dice sin número.
   */
  async function invitationsToRevoke(
    member: NetworkMember,
    change: MembershipChange,
  ): Promise<number | null> {
    setBusyUserId(member.userId);
    try {
      const res = await loadMembershipImpact(tenantId, member.userId, change);
      return res.ok ? res.data.invitationsToRevoke : null;
    } finally {
      setBusyUserId(null);
    }
  }

  async function setStatus(member: NetworkMember, status: 'active' | 'suspended') {
    const suspending = status === 'suspended';
    const revoking = suspending ? await invitationsToRevoke(member, { status }) : 0;
    const ok = await confirm({
      ...statusChangeCopy(member, status, revoking),
      destructive: suspending,
    });
    if (!ok) return;
    setActionError('');
    setMemberError(null);
    setBusyUserId(member.userId);
    try {
      const res = await fetch('/api/admin/memberships/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: member.userId, tenantId, status }),
      });
      if (!res.ok) {
        const read = await readJson<{ error?: string }>(res);
        failOn(
          member,
          (read.ok ? read.data.error : undefined) ??
            `No pudimos ${suspending ? 'suspender' : 'reactivar'} a ${memberName(member)}.`,
        );
        return;
      }
      const done = await readJson<unknown>(res);
      toast.success(
        suspending
          ? `${memberName(member)} quedó suspendido en este nodo.${revokedSuffix(done.ok ? done.data : undefined)}`
          : `${memberName(member)} volvió a tener acceso.`,
      );
      await Promise.all([load(true), reloadSeats(true)]);
    } catch {
      failOn(member, 'No pudimos conectar con el servidor. Probá de nuevo.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function changeRole(member: NetworkMember, role: string) {
    if (role === member.role) return;
    const revoking = demotes(member.role, role) ? await invitationsToRevoke(member, { role }) : 0;
    const ok = await confirm({
      ...roleChangeCopy(member, role, roleLabel, revoking),
      destructive: false,
    });
    if (!ok) return;
    setActionError('');
    setMemberError(null);
    setBusyUserId(member.userId);
    try {
      const res = await fetch('/api/admin/memberships/role', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: member.userId, tenantId, role }),
      });
      if (!res.ok) {
        const read = await readJson<{ error?: string }>(res);
        failOn(member, (read.ok ? read.data.error : undefined) ?? 'No pudimos cambiar el rol.');
        return;
      }
      const done = await readJson<unknown>(res);
      toast.success(
        `${memberName(member)} ahora es ${roleLabel(role)}.${revokedSuffix(done.ok ? done.data : undefined)}`,
      );
      await load(true);
    } catch {
      failOn(member, 'No pudimos conectar con el servidor. Probá de nuevo.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function memberAction(member: NetworkMember, action: MemberAction) {
    const copy = memberActionCopy(action, member);
    const ok = await confirm({
      title: copy.title,
      description: copy.description,
      confirmLabel: copy.confirmLabel,
      destructive: true,
    });
    if (!ok) return;
    setActionError('');
    setMemberError(null);
    setBusyUserId(member.userId);
    const res = await runMemberAction(tenantId, member.userId, action);
    setBusyUserId(null);
    if (!res.ok) {
      // Un aviso que queda (no un toast que se va): el 403 dice a quién hay que pedírselo.
      failOn(member, res.message);
      return;
    }
    toast.success(memberActionDoneMessage(action, member, res.data));
    await Promise.all([load(true), reloadSeats(true)]);
  }

  async function revoke(invitation: PendingInvitation) {
    const ok = await confirm({
      title: `Revocar la invitación a ${invitation.email}`,
      description:
        'El enlace que le enviamos deja de funcionar. Si después querés sumarlo, tenés que invitarlo de nuevo.',
      confirmLabel: 'Revocar',
      destructive: true,
    });
    if (!ok) return;
    setActionError('');
    setMemberError(null);
    const res = await revokeInvitation(tenantId, invitation.id);
    if (!res.ok) {
      setActionError(res.message);
      return;
    }
    toast.success(`Revocamos la invitación a ${invitation.email}.`);
    await load(true);
  }

  const tenants = network.status === 'ready' ? network.tenants : [];
  const selectedName = tenants.find((t) => t.id === tenantId)?.name;

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
          disabled={tenantId === ''}
        >
          <UserPlus aria-hidden="true" />
          Invitar usuario
        </Button>
      </div>

      {network.status === 'error' ? (
        <div
          role="alert"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="text-sm font-medium text-[var(--color-fg)]">{network.message}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void loadNetwork()}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : null}

      {inviteSent ? (
        <Alert tone="success" onDismiss={() => setInviteSent('')}>
          <span className="inline-flex items-center gap-2">
            <Mail aria-hidden="true" className="size-4 text-[var(--color-success)]" />
            Invitación enviada a {inviteSent}. Elige su propia contraseña al aceptarla.
          </span>
        </Alert>
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
            disabled={network.status !== 'ready' || tenants.length === 0}
            className={selectClass}
          >
            {network.status === 'loading' ? <option value="">Cargando tu red…</option> : null}
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {' '.repeat(Math.max(0, t.depth - 1) * 2)}
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
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
            />
            <input
              id="q"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nombre o correo"
              className={cn(inputClass, 'pl-8')}
            />
          </div>
        </div>
      </div>

      {network.status === 'ready' && tenants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-10 text-center">
          <Users aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            No administrás ningún nodo de la red.
          </p>
        </div>
      ) : null}

      {tenantId !== '' ? (
        <SeatsCard
          tenantId={tenantId}
          state={seats.state}
          reload={seats.reload}
          // Desconectar a alguien cambia su "En línea" y sus sesiones en la lista de miembros.
          onReleased={() => load(true)}
        />
      ) : null}

      {actionError ? (
        <Alert tone="error" onDismiss={() => setActionError('')}>
          {actionError}
        </Alert>
      ) : null}

      {/* Invitaciones pendientes */}
      {invitations.status === 'error' ? (
        <Alert tone="error">{invitations.message}</Alert>
      ) : invitations.status === 'ready' && invitations.items.length > 0 ? (
        <InvitationList items={invitations.items} onRevoke={(i) => void revoke(i)} />
      ) : null}

      {tenantId !== '' ? (
        <MemberList
          state={members}
          search={search}
          actor={actor}
          tenantName={selectedName}
          busyUserId={busyUserId}
          memberError={memberError}
          onDismissError={() => setMemberError(null)}
          onRetry={() => void load()}
          onInvite={() => {
            setShowInvite(true);
            setInviteSent('');
          }}
          onChangeRole={(m, role) => void changeRole(m, role)}
          onSetStatus={(m, status) => void setStatus(m, status)}
          onAction={(m, action) => void memberAction(m, action)}
        />
      ) : null}

      {showInvite ? (
        <InviteDialog
          tenantId={tenantId}
          tenantName={selectedName}
          roles={grantableRoles(INVITABLE_ROLES, actor)}
          onClose={() => setShowInvite(false)}
          onSent={(email) => {
            setShowInvite(false);
            setInviteSent(email);
            void load(true);
          }}
        />
      ) : null}
    </div>
  );
}

function InviteDialog({
  tenantId,
  tenantName,
  roles,
  onClose,
  onSent,
}: {
  tenantId: string;
  tenantName: string | undefined;
  roles: readonly { readonly value: string; readonly label: string; readonly hint: string }[];
  onClose: () => void;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(
    roles.find((r) => r.value === 'vendedor')?.value ?? roles[0]?.value ?? '',
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const hint = roles.find((r) => r.value === role)?.hint;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), tenantId, role }),
      });
      if (!res.ok) {
        const read = await readJson<{ error?: string }>(res);
        setError((read.ok ? read.data.error : undefined) ?? 'No pudimos enviar la invitación.');
        return;
      }
      onSent(email.trim());
    } catch {
      setError('No pudimos conectar con el servidor. Probá de nuevo.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!sending) onClose();
      }}
      title="Invitar usuario"
      description={
        tenantName
          ? `Se suma a ${tenantName} y elige su propia contraseña al aceptar.`
          : 'Elige su propia contraseña al aceptar.'
      }
      className="max-w-sm"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="inv-email" className="text-xs font-semibold">
            Correo electrónico
          </Label>
          <input
            id="inv-email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-describedby="inv-role-hint"
            className={selectClass}
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <p id="inv-role-hint" className="text-xs text-[var(--color-fg-muted)]">
            {hint ?? 'No podés invitar con un rol igual o superior al tuyo.'}
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-danger)]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={sending || role === ''}>
            {sending ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
            {sending ? 'Enviando…' : 'Enviar invitación'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
