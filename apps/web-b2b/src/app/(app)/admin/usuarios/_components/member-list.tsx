'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CircleAlert,
  CirclePlay,
  Lock,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../../../../../components/ui/button';
import { cn } from '../../../../../lib/cn';
import { exactTime } from '../../../../../lib/tenant-admin-format';
import {
  MFA_STATE_HINT,
  MFA_STATE_LABEL,
  canActOn,
  grantableRoles,
  isSelf,
  memberAccess,
  memberName,
  memberStatus,
  mfaState,
  type MemberAction,
  type MemberStatusTone,
  type MfaState,
  type NetworkMember,
  type TeamActor,
} from '../../../../../lib/tenant-admin-team';
import { INVITABLE_ROLES, ROLE_CONFIG, roleLabel } from './roles';
import { useNow } from './seats-ui';

type MembersState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly items: readonly NetworkMember[] };

/**
 * Las columnas en pantalla ancha. En el teléfono cada miembro es una tarjeta: nombre y menú arriba
 * y los datos debajo con su etiqueta, sin scroll horizontal (antes la tabla pedía 640 px).
 */
const COLUMNS =
  'md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_2.5rem]';

const STATUS_TONE: Readonly<Record<MemberStatusTone, string>> = {
  ok: 'bg-emerald-50 text-emerald-700',
  danger: 'bg-red-50 text-red-700',
  warn: 'bg-amber-50 text-amber-800',
  muted: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
};

/**
 * Texto de estado sin fondo propio. Los tonos fijos de Tailwind no cambian con el tema y sobre la
 * superficie oscura no llegan a AA (emerald-700 3.4:1, amber-800 2.5:1, red-700 2.8:1); los tokens
 * solos tampoco llegan en claro (éxito 3.7:1, advertencia 2.2:1). Mezclado con --color-fg, el token
 * se oscurece en claro y se aclara en oscuro sin cambiar de tono: ≥ 5.3:1 sobre --color-surface en
 * los dos temas. En oklab y no en oklch, que haría girar el tono hacia el del texto.
 */
const TONE_TEXT = {
  success: 'text-[color-mix(in_oklab,var(--color-success)_60%,var(--color-fg))]',
  warning: 'text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-fg))]',
  danger: 'text-[color-mix(in_oklab,var(--color-danger)_60%,var(--color-fg))]',
} as const;

const MFA_STYLE: Readonly<Record<MfaState, string>> = {
  active: TONE_TEXT.success,
  pending: TONE_TEXT.warning,
  'not-required': 'text-[var(--color-fg-muted)]',
  unknown: 'text-[var(--color-fg-subtle)]',
};

/** El error de una acción sobre un miembro, que se muestra en su fila. */
export interface MemberRowError {
  readonly userId: string;
  readonly message: string;
}

const MFA_ICON: Readonly<Record<MfaState, typeof ShieldCheck | null>> = {
  active: ShieldCheck,
  pending: ShieldAlert,
  'not-required': null,
  unknown: null,
};

const selectClass =
  'h-8 w-full max-w-[180px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20 disabled:opacity-60';

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(member: NetworkMember, query: string): boolean {
  const q = fold(query.trim());
  if (q === '') return true;
  return fold(member.email).includes(q) || fold(member.name ?? '').includes(q);
}

/** La etiqueta de un dato: visible en la tarjeta del teléfono, sólo para lectores en escritorio. */
function CellLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-0.5 block text-[11px] font-medium text-[var(--color-fg-subtle)] md:sr-only">
      {children}
    </span>
  );
}

export function MemberList({
  state,
  search,
  actor,
  tenantName,
  busyUserId,
  memberError,
  onDismissError,
  onRetry,
  onInvite,
  onChangeRole,
  onSetStatus,
  onAction,
}: {
  state: MembersState;
  search: string;
  actor: TeamActor;
  tenantName: string | undefined;
  busyUserId: string | null;
  /**
   * Una acción sobre un miembro que falló (un 403 con su motivo, por ejemplo). Va en su fila y no
   * arriba de la pantalla: en el teléfono, con la lista larga, un aviso arriba quedaba fuera de
   * vista y sólo se veía que el spinner paraba.
   */
  memberError: MemberRowError | null;
  onDismissError: () => void;
  onRetry: () => void;
  onInvite: () => void;
  onChangeRole: (member: NetworkMember, role: string) => void;
  onSetStatus: (member: NetworkMember, status: 'active' | 'suspended') => void;
  onAction: (member: NetworkMember, action: MemberAction) => void;
}) {
  const now = useNow();
  const filtered = state.status === 'ready' ? state.items.filter((m) => matches(m, search)) : [];

  return (
    <section
      aria-labelledby="members-title"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="border-b border-[var(--color-border)] px-4 py-2.5">
        <h2 id="members-title" className="text-sm font-semibold text-[var(--color-fg)]">
          Miembros
          {state.status === 'ready' ? ` (${state.items.length})` : ''}
          {tenantName ? (
            <span className="font-normal text-[var(--color-fg-muted)]"> · {tenantName}</span>
          ) : null}
        </h2>
      </div>

      {state.status === 'loading' ? (
        <div className="divide-y divide-[var(--color-border)]" aria-busy="true" aria-live="polite">
          <span className="sr-only">Cargando miembros…</span>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <div className="h-4 w-40 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="ml-auto h-4 w-20 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            </div>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div role="alert" className="px-6 py-10 text-center">
          <p className="text-sm font-medium text-[var(--color-fg)]">{state.message}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : state.items.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <Users aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Esta agencia no tiene usuarios todavía.
          </p>
          <Button size="sm" className="mt-4" onClick={onInvite}>
            <UserPlus aria-hidden="true" />
            Invitá a tu primer vendedor
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-[var(--color-fg-muted)]">
          Ningún usuario coincide con la búsqueda.
        </p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={cn(
              'hidden gap-x-4 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2 text-xs font-semibold text-[var(--color-fg-muted)] md:grid',
              COLUMNS,
            )}
          >
            <span>Usuario</span>
            <span>Rol</span>
            <span>Último acceso</span>
            <span>2FA</span>
            <span>Estado</span>
            <span />
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {filtered.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                actor={actor}
                now={now}
                busy={busyUserId === m.userId}
                error={memberError?.userId === m.userId ? memberError.message : undefined}
                onDismissError={onDismissError}
                onChangeRole={(role) => onChangeRole(m, role)}
                onSetStatus={(status) => onSetStatus(m, status)}
                onAction={(action) => onAction(m, action)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function MemberRow({
  member,
  actor,
  now,
  busy,
  error,
  onDismissError,
  onChangeRole,
  onSetStatus,
  onAction,
}: {
  member: NetworkMember;
  actor: TeamActor;
  now: number;
  busy: boolean;
  error: string | undefined;
  onDismissError: () => void;
  onChangeRole: (role: string) => void;
  onSetStatus: (status: 'active' | 'suspended') => void;
  onAction: (action: MemberAction) => void;
}) {
  const self = isSelf(actor, member);
  const actionable = canActOn(actor, member);
  const roles = grantableRoles(INVITABLE_ROLES, actor);
  const roleEditable = actionable && roles.length > 0;
  const status = memberStatus(member);
  const access = memberAccess(member, now);
  const mfa = mfaState(member);
  const MfaIcon = MFA_ICON[mfa];
  const name = memberName(member);

  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 px-4 py-3 md:items-center md:gap-x-4',
        COLUMNS,
      )}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-fg)]">
          <span className="truncate">{name}</span>
          {self ? (
            <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              Vos
            </span>
          ) : null}
        </p>
        {member.name ? (
          <p className="truncate text-xs text-[var(--color-fg-muted)]">{member.email}</p>
        ) : null}
      </div>

      <div className="justify-self-end md:order-last">
        {actionable ? (
          <MemberActions
            name={name}
            member={member}
            busy={busy}
            onSetStatus={onSetStatus}
            onAction={onAction}
          />
        ) : null}
      </div>

      <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-3 md:contents">
        <div className="min-w-0">
          <CellLabel>Rol</CellLabel>
          {roleEditable ? (
            <select
              value={member.role}
              disabled={busy}
              onChange={(e) => onChangeRole(e.target.value)}
              className={selectClass}
              aria-label={`Rol de ${name}`}
            >
              {roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
              {roles.some((r) => r.value === member.role) ? null : (
                <option value={member.role} disabled>
                  {roleLabel(member.role)}
                </option>
              )}
            </select>
          ) : (
            <span
              className={cn(
                'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium',
                ROLE_CONFIG[member.role]?.className ??
                  'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
              )}
            >
              {roleLabel(member.role)}
            </span>
          )}
        </div>

        <div className="min-w-0 text-xs text-[var(--color-fg)]">
          <CellLabel>Último acceso</CellLabel>
          {access.lastAccess === undefined ? (
            <span className="text-[var(--color-fg-subtle)]">—</span>
          ) : member.lastLoginAt ? (
            <time dateTime={member.lastLoginAt} title={exactTime(member.lastLoginAt)}>
              {access.lastAccess}
            </time>
          ) : (
            <span className="text-[var(--color-fg-muted)]">{access.lastAccess}</span>
          )}
          {access.online ? (
            <span className={cn('mt-0.5 flex items-center gap-1.5 text-[11px]', TONE_TEXT.success)}>
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-[var(--color-success)]"
              />
              En línea
            </span>
          ) : null}
        </div>

        <div className="min-w-0 text-xs">
          <CellLabel>2FA</CellLabel>
          <span
            className={cn('inline-flex items-center gap-1 font-medium', MFA_STYLE[mfa])}
            title={MFA_STATE_HINT[mfa]}
          >
            {MfaIcon !== null ? <MfaIcon aria-hidden="true" className="size-3.5" /> : null}
            {MFA_STATE_LABEL[mfa]}
          </span>
          {mfa === 'pending' ? <span className="sr-only">. {MFA_STATE_HINT.pending}</span> : null}
        </div>

        <div className="min-w-0 space-y-1 text-xs">
          <CellLabel>Estado</CellLabel>
          <span
            className={cn(
              'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_TONE[status.tone],
            )}
          >
            {status.label}
          </span>
          {access.locked !== undefined ? (
            <span
              className={cn('flex items-center gap-1 text-[11px] font-medium', TONE_TEXT.danger)}
              title="Demasiados intentos fallidos. Se desbloquea solo."
            >
              <Lock aria-hidden="true" className="size-3" />
              {access.locked}
            </span>
          ) : null}
        </div>
      </div>

      {error !== undefined ? (
        // Ancho completo debajo de la fila; en escritorio va después del menú, que también es
        // `order-last`, así que queda en su propia línea.
        <div
          role="alert"
          className="col-span-full flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-fg)] md:order-last"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
          />
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Cerrar aviso"
            className="rounded text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}
    </li>
  );
}

const ITEM =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium text-[var(--color-fg)] outline-none transition-colors data-[highlighted]:bg-[var(--color-surface-muted)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

function MemberActions({
  name,
  member,
  busy,
  onSetStatus,
  onAction,
}: {
  name: string;
  member: NetworkMember;
  busy: boolean;
  onSetStatus: (status: 'active' | 'suspended') => void;
  onAction: (action: MemberAction) => void;
}) {
  const suspended = member.membershipStatus === 'suspended';
  const triggerRef = useRef<HTMLButtonElement>(null);
  // La acción elegida corre cuando el menú ya cerró y devolvió el foco a su botón: si abriera su
  // confirmación antes, Radix le quitaba el foco al diálogo para devolvérselo al botón.
  const pending = useRef<(() => void) | null>(null);
  const later = (action: () => void) => () => {
    pending.current = action;
  };
  const canReset = member.mfaEnabled !== false;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Acciones sobre ${name}`}
          className="px-2"
        >
          {busy ? (
            <RefreshCw aria-hidden="true" className="animate-spin" />
          ) : (
            <MoreHorizontal aria-hidden="true" />
          )}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[220px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
          onCloseAutoFocus={(e) => {
            const action = pending.current;
            if (action === null) return;
            pending.current = null;
            e.preventDefault();
            triggerRef.current?.focus();
            action();
          }}
        >
          {/* Siempre disponible: `activeSessions` cuenta sólo las sesiones de este subárbol y el
              miembro puede tener la suya abierta en otro de sus nodos. La acción las cierra todas,
              y si no había ninguna el aviso lo dice. */}
          <DropdownMenu.Item className={ITEM} onSelect={later(() => onAction('revoke-sessions'))}>
            <LogOut aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            Cerrar sus sesiones
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM}
            disabled={!canReset}
            onSelect={later(() => onAction('reset-mfa'))}
          >
            <ShieldOff aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            {canReset ? 'Restablecer 2FA' : 'Restablecer 2FA (no lo tiene activo)'}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-border)]" />
          <DropdownMenu.Item
            className={cn(ITEM, !suspended && 'text-[var(--color-danger)]')}
            onSelect={later(() => onSetStatus(suspended ? 'active' : 'suspended'))}
          >
            {suspended ? (
              <CirclePlay aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            ) : (
              <UserMinus aria-hidden="true" className="size-4" />
            )}
            {suspended ? 'Reactivar' : 'Suspender'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
