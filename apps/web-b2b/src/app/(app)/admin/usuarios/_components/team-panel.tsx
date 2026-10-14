'use client';

import { Mail, RefreshCw, Search, UserPlus, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../components/ui/button';
import { useConfirm } from '../../../../../components/ui/dialog';
import { Label } from '../../../../../components/ui/label';
import { cn } from '../../../../../lib/cn';
import {
  invitationNotice,
  type InvitationKind,
  type InvitationNotice,
  type IssuedInvitation,
} from '../../../../../lib/invitation-notice';
import {
  ACTION_CANCELLED,
  ACTION_DONE,
  type SheetActionOutcome,
} from '../../../../../lib/member-detail';
import { readJson } from '../../../../../lib/read-json';
import { isStepUpCancelled } from '../../../../../lib/step-up';
import { queryWithTeamTenant } from '../../../../../lib/team-filters';
import {
  loadInvitations,
  loadMembers,
  loadMembershipImpact,
  removeMembership,
  resendInvitation,
  revokeInvitation,
  type MembershipChange,
} from '../../../../../lib/tenant-admin-seats-client';
import {
  canActOn,
  demotes,
  grantableRoles,
  isSelf,
  memberName,
  memberRemovedMessage,
  removeMemberCopy,
  roleChangeCopy,
  statusChangeCopy,
  type MemberAction,
  type NetworkMember,
  type PendingInvitation,
  type TeamActor,
} from '../../../../../lib/tenant-admin-team';
import { networkRoot, treeOrder, type NetworkNode } from '../../../../../lib/tenant-network';
import { inputClass, selectClass } from './field-classes';
import { InvitationList } from './invitation-list';
import { InviteDialog } from './invite-dialog';
import { useTeamFilters } from './member-filters';
import { MemberActionItems, MemberList, type MemberRowError } from './member-list';
import { MemberSheet } from './member-sheet';
import { invitableRolesIn, offeredRoleLabel } from './roles';
import { SeatsCard, useSeatsView } from './seats-ui';
import { supportMember } from './support-action';

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

/** Un aviso pasajero: el éxito, o la advertencia de un correo que no salió. */
function notify(notice: InvitationNotice) {
  const show = notice.tone === 'warning' ? toast.warning : toast.success;
  show(
    notice.message,
    notice.description === undefined ? undefined : { description: notice.description },
  );
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

/**
 * `initialTenantId`: el nodo con que abre (el "Usuarios" de /red). Sólo si está en la red del actor;
 * si no, abre en la raíz como siempre.
 */
export function TeamPanel({
  actor,
  initialTenantId,
}: {
  actor: TeamActor;
  initialTenantId?: string;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [network, setNetwork] = useState<NetworkState>({ status: 'loading' });
  const [tenantId, setTenantId] = useState('');
  const [members, setMembers] = useState<ListState<NetworkMember>>({ status: 'loading' });
  const [invitations, setInvitations] = useState<ListState<PendingInvitation>>({
    status: 'loading',
  });
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useTeamFilters();
  // Errores que no son de un miembro (revocar una invitación). Los de una acción sobre un miembro
  // van en su fila (`memberError`): acá arriba quedaban fuera de vista con la lista larga.
  const [actionError, setActionError] = useState('');
  const [memberError, setMemberError] = useState<MemberRowError | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState('');
  // La persona cuya ficha está abierta (por id: la fila se refresca después de cada acción).
  const [sheetUserId, setSheetUserId] = useState<string | null>(null);
  const seats = useSeatsView(tenantId === '' ? null : tenantId);
  // Adonde va el foco cuando la fila de quien se quitó del nodo desaparece.
  const membersHeading = useRef<HTMLHeadingElement>(null);
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
            ? 'No administras ningún nodo de la red.'
            : 'No pudimos cargar tu red de agencias.',
      });
      return;
    }
    const list = read.data.tenants as NetworkNode[];
    setNetwork({ status: 'ready', tenants: treeOrder(list) });
    const root = networkRoot(list);
    // Manda el `?tenant=` del navegador: al volver con "atrás", el router de Next pinta la página que
    // tiene en caché, con el nodo de antes de que `chooseTenant` escribiera el elegido, y la pantalla
    // abría en ése con los filtros (leídos de la URL) del otro.
    const wanted = new URLSearchParams(window.location.search).get('tenant') ?? initialTenantId;
    const initial = list.some((t) => t.id === wanted) ? wanted : undefined;
    setTenantId((current) => current || initial || root?.id || '');
  }, [initialTenantId]);

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

  /**
   * El nodo elegido queda en la URL junto a los filtros: una recarga o un enlace abren el mismo nodo
   * con los mismos filtros, no la raíz con filtros de otro.
   */
  function chooseTenant(id: string) {
    setTenantId(id);
    setSheetUserId(null);
    const { pathname, search: query, hash } = window.location;
    try {
      // `null`: el router de Next conserva su propio estado.
      window.history.replaceState(null, '', `${pathname}${queryWithTeamTenant(query, id)}${hash}`);
    } catch {
      // El navegador limitó los cambios de URL: el nodo cambia igual, sólo no se recuerda.
    }
  }

  function failOn(member: NetworkMember, message: string) {
    setMemberError({ userId: member.userId, message });
  }

  /**
   * Una acción pedida desde la fila: si falla, el motivo va en su fila. Pedida desde la ficha, lo
   * muestra la ficha (que tapa la fila).
   */
  async function fromRow(member: NetworkMember, outcome: Promise<SheetActionOutcome>) {
    const out = await outcome;
    if (out.status === 'failed') failOn(member, out.message);
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

  async function setStatus(
    member: NetworkMember,
    status: 'active' | 'suspended',
  ): Promise<SheetActionOutcome> {
    const suspending = status === 'suspended';
    const revoking = suspending ? await invitationsToRevoke(member, { status }) : 0;
    const ok = await confirm({
      ...statusChangeCopy(member, status, revoking),
      destructive: suspending,
    });
    if (!ok) return ACTION_CANCELLED;
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
        return {
          status: 'failed',
          message:
            (read.ok ? read.data.error : undefined) ??
            `No pudimos ${suspending ? 'suspender' : 'reactivar'} a ${memberName(member)}.`,
        };
      }
      const done = await readJson<unknown>(res);
      toast.success(
        suspending
          ? `${memberName(member)} quedó suspendido en este nodo.${revokedSuffix(done.ok ? done.data : undefined)}`
          : `${memberName(member)} volvió a tener acceso.`,
      );
      await Promise.all([load(true), reloadSeats(true)]);
      return ACTION_DONE;
    } catch {
      return {
        status: 'failed',
        message: 'No pudimos conectar con el servidor. Inténtalo de nuevo.',
      };
    } finally {
      setBusyUserId(null);
    }
  }

  /**
   * Quitarlo del nodo (USR-11): primero cuántas invitaciones se revocarían, después la confirmación
   * destructiva. Si es admin, el API puede pedir el código del 2FA (lo abre `removeMembership`); si
   * se cierra ese diálogo, no se hizo nada y no hay error que mostrar. Al salir bien deja de estar en
   * la lista, y su ficha se cierra.
   */
  async function removeMember(member: NetworkMember): Promise<SheetActionOutcome> {
    const nodeName = selectedName;
    const revoking = await invitationsToRevoke(member, { status: 'removed' });
    const ok = await confirm({
      ...removeMemberCopy(member, nodeName, revoking),
      destructive: true,
    });
    if (!ok) return ACTION_CANCELLED;
    setActionError('');
    setMemberError(null);
    setBusyUserId(member.userId);
    try {
      const res = await removeMembership(tenantId, member.userId);
      if (isStepUpCancelled(res)) return ACTION_CANCELLED;
      if (!res.ok) return { status: 'failed', message: res.message };
      toast.success(memberRemovedMessage(member, nodeName, res.data));
      setSheetUserId((open) => (open === member.userId ? null : open));
      await Promise.all([load(true), reloadSeats(true)]);
      // Su fila (y el botón desde el que se quitó) ya no está: el foco no queda en el documento.
      membersHeading.current?.focus();
      return ACTION_DONE;
    } finally {
      setBusyUserId(null);
    }
  }

  async function changeRole(member: NetworkMember, role: string) {
    if (role === member.role) return;
    const revoking = demotes(member.role, role) ? await invitationsToRevoke(member, { role }) : 0;
    const ok = await confirm({
      ...roleChangeCopy(member, role, offeredRoleLabel, revoking),
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
        `${memberName(member)} ahora es ${offeredRoleLabel(role)}.${revokedSuffix(done.ok ? done.data : undefined)}`,
      );
      await load(true);
    } catch {
      failOn(member, 'No pudimos conectar con el servidor. Inténtalo de nuevo.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function memberAction(
    member: NetworkMember,
    action: MemberAction,
  ): Promise<SheetActionOutcome> {
    const out = await supportMember(confirm, tenantId, member, action, (busy) => {
      if (busy) {
        setActionError('');
        setMemberError(null);
      }
      setBusyUserId(busy ? member.userId : null);
    });
    if (out.status === 'done') await Promise.all([load(true), reloadSeats(true)]);
    return out;
  }

  async function revoke(invitation: PendingInvitation) {
    const ok = await confirm({
      title: `Revocar la invitación a ${invitation.email}`,
      description:
        'El enlace que le enviamos deja de funcionar. Si después quieres sumarlo, tienes que invitarlo de nuevo.',
      confirmLabel: 'Revocar',
      destructive: true,
    });
    if (!ok) return;
    setActionError('');
    setMemberError(null);
    const res = await revokeInvitation(tenantId, invitation.id);
    if (!res.ok) {
      setActionError(res.message);
      // Ya no estaba pendiente (la aceptaron o la revocaron desde otra sesión): la fila quedó vieja.
      if (res.gone) await load(true);
      return;
    }
    toast.success(`Revocamos la invitación a ${invitation.email}.`);
    await load(true);
  }

  async function resend(invitation: PendingInvitation) {
    setActionError('');
    setMemberError(null);
    setResendingId(invitation.id);
    try {
      const res = await resendInvitation(tenantId, invitation.id);
      if (!res.ok) {
        setActionError(res.message);
        if (res.gone) await load(true);
        return;
      }
      notify(invitationNotice('resent', invitation.email, res.data, new Date()));
      await load(true);
    } finally {
      setResendingId(null);
    }
  }

  /**
   * Lo que emitió "Invitar usuario": una invitación nueva o el reenvío de la pendiente. Una nueva cuyo
   * correo salió queda en el aviso de arriba; lo demás (un reenvío, un correo que no salió) es un
   * aviso pasajero.
   */
  function invitationIssued(kind: InvitationKind, email: string, issued: IssuedInvitation) {
    setShowInvite(false);
    const notice = invitationNotice(kind, email, issued, new Date());
    if (kind === 'invited' && notice.tone === 'success') setInviteSent(notice.message);
    else notify(notice);
    void load(true);
  }

  const tenants = network.status === 'ready' ? network.tenants : [];
  const selected = tenants.find((t) => t.id === tenantId);
  const selectedName = selected?.name;
  const roles = grantableRoles(invitableRolesIn(selected?.tenantType), actor);
  const sheetMember =
    members.status === 'ready' ? members.items.find((m) => m.userId === sheetUserId) : undefined;
  const sheetActionable = sheetMember !== undefined && canActOn(actor, sheetMember);

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
            {inviteSent}
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
            onChange={(e) => chooseTenant(e.target.value)}
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
            No administras ningún nodo de la red.
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
        <InvitationList
          items={invitations.items}
          onRevoke={(i) => void revoke(i)}
          onResend={(i) => void resend(i)}
          resendingId={resendingId}
        />
      ) : null}

      {tenantId !== '' ? (
        <MemberList
          state={members}
          search={search}
          filters={filters}
          onFiltersChange={setFilters}
          actor={actor}
          roles={roles}
          tenantName={selectedName}
          busyUserId={busyUserId}
          memberError={memberError}
          onDismissError={() => setMemberError(null)}
          onRetry={() => void load()}
          onInvite={() => {
            setShowInvite(true);
            setInviteSent('');
          }}
          onOpen={(m) => setSheetUserId(m.userId)}
          onChangeRole={(m, role) => void changeRole(m, role)}
          onSetStatus={(m, status) => void fromRow(m, setStatus(m, status))}
          onRemove={(m) => void fromRow(m, removeMember(m))}
          onAction={(m, action) => void fromRow(m, memberAction(m, action))}
          headingRef={membersHeading}
        />
      ) : null}

      {sheetUserId !== null && tenantId !== '' ? (
        <MemberSheet
          key={`${tenantId}:${sheetUserId}`}
          source={{ kind: 'team', tenantId, userId: sheetUserId }}
          fallbackName={sheetMember ? memberName(sheetMember) : ''}
          fallbackEmail={sheetMember?.email}
          self={sheetMember ? isSelf(actor, sheetMember) : actor.userId === sheetUserId}
          busy={busyUserId === sheetUserId}
          canRevokeSessions={sheetActionable}
          renderMenu={
            sheetMember !== undefined && sheetActionable
              ? (_detail, { pick, run, now }) => (
                  <MemberActionItems
                    member={sheetMember}
                    now={now}
                    onPick={pick}
                    onSetStatus={(status) => run(() => setStatus(sheetMember, status))}
                    // Al salir bien la ficha se cierra: no hay nada que recargar en ella.
                    onRemove={() =>
                      run(async () => {
                        const out = await removeMember(sheetMember);
                        return out.status === 'done' ? ACTION_CANCELLED : out;
                      })
                    }
                    onAction={(action) => run(() => memberAction(sheetMember, action))}
                  />
                )
              : undefined
          }
          unlockAction={
            sheetMember !== undefined && sheetActionable
              ? () => () => memberAction(sheetMember, 'unlock')
              : undefined
          }
          onChanged={() => void Promise.all([load(true), reloadSeats(true)])}
          onClose={() => setSheetUserId(null)}
        />
      ) : null}

      {showInvite ? (
        <InviteDialog
          tenantId={tenantId}
          tenantName={selectedName}
          roles={roles}
          pendingRoleOf={(id) =>
            invitations.status === 'ready'
              ? invitations.items.find((i) => i.id === id)?.role
              : undefined
          }
          onClose={() => setShowInvite(false)}
          onDone={invitationIssued}
        />
      ) : null}
    </div>
  );
}
