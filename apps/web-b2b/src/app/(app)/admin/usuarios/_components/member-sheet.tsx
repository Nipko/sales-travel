'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ChevronUp,
  CircleAlert,
  History,
  KeyRound,
  Lock,
  LockKeyhole,
  LogOut,
  MailCheck,
  MailWarning,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../components/ui/button';
import { useConfirm } from '../../../../../components/ui/dialog';
import { Sheet } from '../../../../../components/ui/form-sheet';
import {
  auditTime,
  eventDetail,
  eventLabel,
  type AuditEntryView,
} from '../../../../../lib/audit-format';
import { cn } from '../../../../../lib/cn';
import {
  calendarDate,
  detailBadges,
  detailName,
  emailStatus,
  failedAttemptsLine,
  invitedByText,
  loadMemberAudit,
  loadMemberDetail,
  membershipLine,
  membershipStatusLabel,
  mfaLine,
  mfaRequired,
  noSessionsText,
  orderedDetailSessions,
  passwordChangedLine,
  pendingInvitationsText,
  recoveryCodesLine,
  revokeMemberSession,
  revokeSessionCopy,
  revokeSessionDone,
  revokeTenantOf,
  sentInvitationLine,
  sessionActivity,
  sessionDevice,
  sessionsHeading,
  trustedDevicesLine,
  type BadgeTone,
  type MemberDetailSession,
  type MemberDetailSource,
  type MemberDetailView,
  type SheetActionOutcome,
} from '../../../../../lib/member-detail';
import {
  exactTime,
  lastAccessLabel,
  lockedUntilLabel,
  relativeTime,
} from '../../../../../lib/tenant-admin-format';
import {
  PASSWORD_RESET_PENDING_HINT,
  PASSWORD_RESET_PENDING_LABEL,
} from '../../../../../lib/tenant-admin-team';
import { roleLabel } from './roles';
import { useNow } from './seats-ui';

/**
 * La ficha de una persona en el panel lateral, desde Equipo o desde Plataforma → Usuarios: perfil,
 * nodos y roles, seguridad, sesiones abiertas (cada una se puede cerrar), invitaciones que envió y
 * su actividad; y en el pie, las mismas acciones del menú de la fila.
 *
 * La ficha no decide quién puede qué: lo decide el API en cada llamada. Las acciones del pie son las
 * de quien la abrió (Equipo o el directorio), que las corre con su confirmación y su aviso; la ficha
 * sólo muestra su error, si lo hubo, y se vuelve a leer cuando salieron bien.
 */

export type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly detail: MemberDetailView };

export type ActivityState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly events: readonly AuditEntryView[];
      readonly nextBefore: string | null;
      readonly loadingMore: boolean;
      readonly moreError: string;
    };

/** Lo que el menú "Acciones" del pie le da a quien arma sus ítems. */
export interface SheetMenuApi {
  /** Lo elegido corre recién cuando el menú se cerró y devolvió el foco a "Acciones". */
  readonly pick: (run: () => void) => () => void;
  /** Corre una acción desde la ficha: su error se ve en la ficha y, si salió bien, se relee. */
  readonly run: (task: () => Promise<SheetActionOutcome>) => void;
  readonly now: number;
}

const BADGE_TONE: Readonly<Record<BadgeTone, string>> = {
  ok: 'bg-emerald-50 text-emerald-700',
  danger: 'bg-red-50 text-red-700',
  warn: 'bg-amber-50 text-amber-800',
};

/** Texto de estado sin fondo propio, legible en los dos temas (ver member-list.tsx). */
const TONE_TEXT = {
  success: 'text-[color-mix(in_oklab,var(--color-success)_60%,var(--color-fg))]',
  warning: 'text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-fg))]',
  danger: 'text-[color-mix(in_oklab,var(--color-danger)_60%,var(--color-fg))]',
} as const;

type FactTone = keyof typeof TONE_TEXT | 'muted';

/** El nombre de una persona en una lista, como el botón que abre su ficha. */
export function MemberNameButton({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Ver la ficha de ${name}`}
      className="inline-block min-w-0 max-w-full truncate rounded py-0.5 text-left font-medium text-[var(--color-fg)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
    >
      {name}
    </button>
  );
}

/**
 * La ficha con sus datos: la lee al abrir (perfil e historial en paralelo), cierra sesiones puntuales
 * con su propia confirmación y corre las acciones del pie que le pasa quien la abrió.
 *
 * Quien la abre la monta con una `key` por persona: `source` se toma al montar y no cambia.
 */
export function MemberSheet({
  source,
  fallbackName,
  fallbackEmail,
  self,
  busy = false,
  canRevokeSessions,
  renderMenu,
  unlockAction,
  onChanged,
  onDetail,
  onClose,
}: {
  source: MemberDetailSource;
  /** Cómo nombrarla mientras carga: lo que ya dice la fila. */
  fallbackName: string;
  fallbackEmail?: string;
  /** Es la ficha de quien mira: no se le ofrece actuar sobre sí mismo. */
  self: boolean;
  /** Una acción sobre esta persona está en curso (la marca quien la corre). */
  busy?: boolean;
  /** Ofrecer "Cerrar esta sesión". Nunca en la propia ficha; el rango lo decide el API. */
  canRevokeSessions: boolean;
  /** Los ítems del menú "Acciones" del pie. Sin él, no hay menú. */
  renderMenu?: (detail: MemberDetailView, api: SheetMenuApi) => ReactNode;
  /**
   * "Desbloquear" junto al bloqueo: la acción para esta ficha, o `undefined` si no se ofrece. Sin
   * él, nunca se ofrece.
   */
  unlockAction?: (detail: MemberDetailView) => (() => Promise<SheetActionOutcome>) | undefined;
  /** Se cerró una de sus sesiones: lo que dependa de ellas (la lista, los puestos) se refresca. */
  onChanged?: () => void;
  /** Cada vez que se lee la ficha: la lista de atrás puede ponerse al día con lo que dice. */
  onDetail?: (detail: MemberDetailView) => void;
  onClose: () => void;
}) {
  const [src] = useState(source);
  const now = useNow();
  const [confirm, confirmDialog] = useConfirm();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [activity, setActivity] = useState<ActivityState>({ status: 'loading' });
  const [actionError, setActionError] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const running = useRef(false);
  const latest = useRef({ onDetail, onChanged });
  latest.current = { onDetail, onChanged };
  // Cada lectura del historial; una página que vuelve tarde de una lectura anterior se descarta.
  const activityRead = useRef(0);

  const loadDetail = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ status: 'loading' });
      const res = await loadMemberDetail(src);
      if (res.ok) {
        setState({ status: 'ready', detail: res.data });
        latest.current.onDetail?.(res.data);
      } else if (!quiet) {
        setState({ status: 'error', message: res.message });
      } else {
        // Releer después de una acción: si falla, queda lo que se veía y se avisa.
        toast.error(res.message);
      }
    },
    [src],
  );

  const loadActivity = useCallback(
    async (quiet = false) => {
      const read = ++activityRead.current;
      if (!quiet) setActivity({ status: 'loading' });
      const res = await loadMemberAudit(src);
      if (read !== activityRead.current) return;
      if (res.ok) {
        setActivity({
          status: 'ready',
          events: res.data.events,
          nextBefore: res.data.nextBefore,
          loadingMore: false,
          moreError: '',
        });
      } else if (!quiet) {
        setActivity({ status: 'error', message: res.message });
      }
    },
    [src],
  );

  useEffect(() => {
    void loadDetail();
    void loadActivity();
  }, [loadDetail, loadActivity]);

  const refresh = useCallback(
    () => Promise.all([loadDetail(true), loadActivity(true)]),
    [loadDetail, loadActivity],
  );

  async function loadMoreActivity() {
    if (activity.status !== 'ready' || activity.nextBefore === null || activity.loadingMore) return;
    const read = activityRead.current;
    const before = activity.nextBefore;
    setActivity((prev) =>
      prev.status === 'ready' ? { ...prev, loadingMore: true, moreError: '' } : prev,
    );
    const res = await loadMemberAudit(src, before);
    if (read !== activityRead.current) return;
    setActivity((prev) => {
      if (prev.status !== 'ready') return prev;
      if (!res.ok) return { ...prev, loadingMore: false, moreError: res.message };
      const seen = new Set(prev.events.map((e) => e.id));
      return {
        ...prev,
        events: [...prev.events, ...res.data.events.filter((e) => !seen.has(e.id))],
        nextBefore: res.data.nextBefore,
        loadingMore: false,
        moreError: '',
      };
    });
  }

  const run = useCallback(
    (task: () => Promise<SheetActionOutcome>) => {
      if (running.current) return;
      running.current = true;
      setActionError('');
      void (async () => {
        let outcome: SheetActionOutcome;
        try {
          outcome = await task();
        } catch {
          outcome = {
            status: 'failed',
            message: 'No pudimos completar la acción. Inténtalo de nuevo.',
          };
        } finally {
          running.current = false;
        }
        if (outcome.status === 'failed') setActionError(outcome.message);
        if (outcome.status === 'done') await refresh();
      })();
    },
    [refresh],
  );

  async function revokeSession(session: MemberDetailSession) {
    if (state.status !== 'ready' || revokingId !== null) return;
    const tenantId = revokeTenantOf(src, session);
    if (tenantId === null) return;
    const name = detailName(state.detail.user);
    if (!(await confirm({ ...revokeSessionCopy(name), destructive: true }))) return;
    setActionError('');
    setRevokingId(session.id);
    const res = await revokeMemberSession(tenantId, src.userId, session.id);
    setRevokingId(null);
    if (res.ok) toast.success(revokeSessionDone(name));
    else setActionError(res.message);
    // Un 404 es que ya no estaba abierta: la lista de sesiones quedó vieja.
    if (res.ok || res.gone === true) {
      await refresh();
      latest.current.onChanged?.();
    }
  }

  const detail = state.status === 'ready' ? state.detail : undefined;
  const unlock = detail !== undefined && !self ? unlockAction?.(detail) : undefined;

  return (
    <>
      <MemberSheetView
        source={src}
        fallbackName={fallbackName}
        fallbackEmail={fallbackEmail}
        state={state}
        activity={activity}
        now={now}
        self={self}
        busy={busy}
        actionError={actionError}
        revokingId={revokingId}
        canRevokeSessions={canRevokeSessions && !self}
        menu={
          detail !== undefined && renderMenu !== undefined && !self
            ? (pick) => renderMenu(detail, { pick, run, now })
            : undefined
        }
        onUnlock={unlock === undefined ? undefined : () => run(unlock)}
        onRevokeSession={(s) => void revokeSession(s)}
        onRetry={() => void loadDetail()}
        onRetryActivity={() => void loadActivity()}
        onLoadMoreActivity={() => void loadMoreActivity()}
        onDismissError={() => setActionError('')}
        onClose={onClose}
      />
      {confirmDialog}
    </>
  );
}

/** Lo que pinta la ficha, sin pedir nada: para probarla con cada estado sin levantar el navegador. */
export function MemberSheetView({
  source,
  fallbackName,
  fallbackEmail,
  state,
  activity,
  now,
  self,
  busy,
  actionError,
  revokingId,
  canRevokeSessions,
  menu,
  onUnlock,
  onRevokeSession,
  onRetry,
  onRetryActivity,
  onLoadMoreActivity,
  onDismissError,
  onClose,
}: {
  source: MemberDetailSource;
  fallbackName: string;
  fallbackEmail?: string | undefined;
  state: DetailState;
  activity: ActivityState;
  now: number;
  self: boolean;
  busy: boolean;
  actionError: string;
  revokingId: string | null;
  canRevokeSessions: boolean;
  /** Los ítems del menú "Acciones"; sin él, el pie sólo tiene "Cerrar". */
  menu?: ((pick: SheetMenuApi['pick']) => ReactNode) | undefined;
  onUnlock?: (() => void) | undefined;
  onRevokeSession: (session: MemberDetailSession) => void;
  onRetry: () => void;
  onRetryActivity: () => void;
  onLoadMoreActivity: () => void;
  onDismissError: () => void;
  onClose: () => void;
}) {
  const detail = state.status === 'ready' ? state.detail : undefined;
  const name = detail ? detailName(detail.user) : fallbackName.trim() || 'Ficha del usuario';
  const email = detail ? detail.user.email : fallbackEmail;
  const badges = detail
    ? detailBadges(detail, now, source.kind === 'team' ? source.tenantId : undefined)
    : [];

  return (
    <Sheet
      title={name}
      subtitle={email !== undefined && email !== name ? email : undefined}
      meta={
        self || badges.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Estado">
            {self ? (
              <li className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
                Tú
              </li>
            ) : null}
            {badges.map((b) => (
              <li
                key={b.label}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  BADGE_TONE[b.tone],
                )}
              >
                {b.label}
              </li>
            ))}
          </ul>
        ) : undefined
      }
      onClose={onClose}
      footer={
        <>
          {actionError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-fg)]"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
              />
              <p className="min-w-0 flex-1">{actionError}</p>
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
          <div className="flex flex-wrap-reverse items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              className="h-10 flex-1 sm:h-9 sm:flex-none"
            >
              Cerrar
            </Button>
            {menu !== undefined && detail !== undefined ? (
              <SheetActionsMenu name={name} busy={busy} items={menu} />
            ) : null}
          </div>
        </>
      }
    >
      {state.status === 'loading' ? (
        <div aria-busy="true" className="space-y-6 pt-3">
          <p role="status" className="sr-only">
            Cargando la ficha…
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2.5">
              <div className="h-3 w-24 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="h-4 w-full animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            </div>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div role="alert" className="flex flex-col items-center gap-3 px-2 py-12 text-center">
          <p className="text-sm font-medium text-[var(--color-fg)]">{state.message}</p>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : (
        <DetailSections
          source={source}
          detail={state.detail}
          activity={activity}
          now={now}
          self={self}
          busy={busy}
          revokingId={revokingId}
          canRevokeSessions={canRevokeSessions}
          onUnlock={onUnlock}
          onRevokeSession={onRevokeSession}
          onRetryActivity={onRetryActivity}
          onLoadMoreActivity={onLoadMoreActivity}
        />
      )}
    </Sheet>
  );
}

/**
 * "Acciones" en el pie: el mismo menú agrupado de la fila, hacia arriba. Mientras corre una acción
 * queda `aria-disabled` y no abre: deshabilitado soltaría el foco fuera de la ficha.
 */
function SheetActionsMenu({
  name,
  busy,
  items,
}: {
  name: string;
  busy: boolean;
  items: (pick: SheetMenuApi['pick']) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Como en la fila (MemberActions): si la confirmación abriera antes de que el menú devuelva el
  // foco, Radix se lo quitaba al diálogo.
  const pending = useRef<(() => void) | null>(null);
  const later = (action: () => void) => () => {
    pending.current = action;
  };

  return (
    <DropdownMenu.Root modal={false} open={open && !busy} onOpenChange={(o) => setOpen(o && !busy)}>
      <DropdownMenu.Trigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          aria-disabled={busy || undefined}
          aria-label={`Acciones sobre ${name}`}
          className="h-10 flex-1 aria-disabled:cursor-wait aria-disabled:opacity-60 sm:h-9 sm:flex-none"
        >
          {busy ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
          {busy ? 'Aplicando…' : 'Acciones'}
          {busy ? null : <ChevronUp aria-hidden="true" />}
        </Button>
      </DropdownMenu.Trigger>
      {/* Sin portal, a diferencia del de la fila: dentro del diálogo (`aria-modal`), un lector de
          pantalla no deja de lado el menú como contenido de atrás, y el Tab del panel lo ve como
          propio. Su Escape y su Tab los atiende Radix (useModalBehavior lo respeta). */}
      <DropdownMenu.Content
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={16}
        className="z-50 min-w-[260px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
        onCloseAutoFocus={(e) => {
          const action = pending.current;
          if (action === null) return;
          pending.current = null;
          e.preventDefault();
          triggerRef.current?.focus();
          action();
        }}
      >
        {items(later)}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="border-t border-[var(--color-border)] py-4 first:border-t-0 first:pt-3"
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 id={id} className="text-xs font-semibold text-[var(--color-fg-muted)]">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-[var(--color-fg-muted)]">{children}</p>;
}

const FACT_TEXT: Readonly<Record<FactTone, string>> = {
  ...TONE_TEXT,
  muted: 'text-[var(--color-fg)]',
};

const FACT_ICON: Readonly<Record<FactTone, string>> = {
  success: TONE_TEXT.success,
  warning: TONE_TEXT.warning,
  danger: TONE_TEXT.danger,
  muted: 'text-[var(--color-fg-subtle)]',
};

/** Un dato de seguridad, con su ícono y, si corresponde, una acción a la derecha. */
function Fact({
  icon: Icon,
  tone = 'muted',
  action,
  hint,
  children,
}: {
  icon: LucideIcon;
  tone?: FactTone;
  action?: ReactNode;
  /** Lo que el lector de pantalla tiene que oír después del dato. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', FACT_ICON[tone])} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className={cn('min-w-0 text-sm', FACT_TEXT[tone], tone !== 'muted' && 'font-medium')}>
          {children}
          {hint ? <span className="sr-only">. {hint}</span> : null}
        </span>
        {action}
      </div>
    </li>
  );
}

/** Partes de una línea separadas por " · ", sin que el separador se lea. */
function Dotted({ parts }: { parts: readonly ReactNode[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

const DT = 'pt-px text-xs text-[var(--color-fg-muted)]';
const DD = 'min-w-0 break-words text-sm text-[var(--color-fg)]';

function DetailSections({
  source,
  detail,
  activity,
  now,
  self,
  busy,
  revokingId,
  canRevokeSessions,
  onUnlock,
  onRevokeSession,
  onRetryActivity,
  onLoadMoreActivity,
}: {
  source: MemberDetailSource;
  detail: MemberDetailView;
  activity: ActivityState;
  now: number;
  self: boolean;
  busy: boolean;
  revokingId: string | null;
  canRevokeSessions: boolean;
  onUnlock: (() => void) | undefined;
  onRevokeSession: (session: MemberDetailSession) => void;
  onRetryActivity: () => void;
  onLoadMoreActivity: () => void;
}) {
  const base = useId();
  const { user, security } = detail;
  const verified = emailStatus(user.emailVerified);
  const joined = relativeTime(user.createdAt, now);
  const mfa = mfaLine(detail);
  const locked = lockedUntilLabel(security.lockedUntil, now);
  const failed =
    locked === undefined ? failedAttemptsLine(security.failedLoginAttempts) : undefined;
  const passwordChanged = passwordChangedLine(user.passwordChangedAt, now);
  const sessions = orderedDetailSessions(detail.sessions);
  const { pending, items: invitations } = detail.invitationsSent;
  const mfaSince = calendarDate(security.mfaEnabledAt);

  return (
    <div>
      <Section id={`${base}-perfil`} title="Perfil">
        <dl className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5">
          {verified !== undefined ? (
            <>
              <dt className={DT}>Correo</dt>
              <dd
                className={cn(
                  DD,
                  'flex items-center gap-1.5 font-medium',
                  user.emailVerified ? TONE_TEXT.success : TONE_TEXT.warning,
                )}
              >
                {user.emailVerified ? (
                  <MailCheck aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <MailWarning aria-hidden="true" className="size-4 shrink-0" />
                )}
                {verified}
              </dd>
            </>
          ) : null}
          <dt className={DT}>Alta</dt>
          <dd className={DD}>
            {joined !== undefined && user.createdAt !== null ? (
              <time dateTime={user.createdAt} title={exactTime(user.createdAt)}>
                {joined}
              </time>
            ) : (
              <span className="text-[var(--color-fg-subtle)]">—</span>
            )}
          </dd>
          <dt className={DT}>Último acceso</dt>
          <dd className={DD}>
            {user.lastLoginAt !== null ? (
              <time dateTime={user.lastLoginAt} title={exactTime(user.lastLoginAt)}>
                {lastAccessLabel(user.lastLoginAt, now)}
              </time>
            ) : (
              <span className="text-[var(--color-fg-muted)]">
                {lastAccessLabel(user.lastLoginAt, now)}
              </span>
            )}
          </dd>
          {detail.invitedBy !== null ? (
            <>
              <dt className={DT}>Invitado por</dt>
              <dd className={DD}>
                <time dateTime={detail.invitedBy.at} title={exactTime(detail.invitedBy.at)}>
                  {invitedByText(detail.invitedBy, now)}
                </time>
              </dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section id={`${base}-nodos`} title="Nodos y roles">
        {detail.memberships.length === 0 ? (
          <Empty>
            {source.kind === 'team'
              ? 'No tiene nodos que administres.'
              : 'No pertenece a ningún nodo.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {detail.memberships.map((m) => (
              <li
                key={m.tenantId}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <span className="sr-only">{membershipLine(m)}</span>
                <div aria-hidden="true" className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                    {m.tenantName}
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">{roleLabel(m.role)}</p>
                </div>
                <span
                  aria-hidden="true"
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    m.status === 'active' ? BADGE_TONE.ok : BADGE_TONE.danger,
                  )}
                >
                  {membershipStatusLabel(m.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id={`${base}-seguridad`} title="Seguridad">
        <ul className="space-y-2.5">
          {mfa !== undefined ? (
            <Fact
              icon={security.mfaEnabled ? ShieldCheck : ShieldOff}
              tone={security.mfaEnabled ? 'success' : mfaRequired(detail) ? 'warning' : 'muted'}
            >
              {security.mfaEnabled && mfaSince !== undefined && security.mfaEnabledAt !== null ? (
                <time dateTime={security.mfaEnabledAt} title={exactTime(security.mfaEnabledAt)}>
                  {mfa}
                </time>
              ) : (
                mfa
              )}
            </Fact>
          ) : null}
          {security.mfaEnabled && security.recoveryCodesLeft !== null ? (
            <Fact icon={KeyRound} tone={security.recoveryCodesLeft === 0 ? 'warning' : 'muted'}>
              {recoveryCodesLine(security.recoveryCodesLeft)}
            </Fact>
          ) : null}
          {security.mfaEnabled && security.trustedDevices !== null ? (
            <Fact icon={MonitorSmartphone}>{trustedDevicesLine(security.trustedDevices)}</Fact>
          ) : null}
          {locked !== undefined ? (
            <Fact
              icon={Lock}
              tone="danger"
              hint="Demasiados intentos fallidos. Se desbloquea solo a esa hora."
              action={
                onUnlock !== undefined ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-disabled={busy || undefined}
                    onClick={busy ? undefined : onUnlock}
                    className="aria-disabled:cursor-wait aria-disabled:opacity-60"
                  >
                    Desbloquear
                  </Button>
                ) : null
              }
            >
              {locked}
            </Fact>
          ) : null}
          {failed !== undefined ? (
            <Fact icon={TriangleAlert} tone="warning">
              {failed}
            </Fact>
          ) : null}
          {passwordChanged !== undefined ? <Fact icon={History}>{passwordChanged}</Fact> : null}
          {user.passwordResetRequired ? (
            <Fact icon={LockKeyhole} tone="warning" hint={PASSWORD_RESET_PENDING_HINT}>
              {PASSWORD_RESET_PENDING_LABEL}
            </Fact>
          ) : null}
        </ul>
      </Section>

      <Section id={`${base}-sesiones`} title={sessionsHeading(sessions.length)}>
        {sessions.length === 0 ? (
          <Empty>{noSessionsText(source.kind)}</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                closable={canRevokeSessions && !s.current && revokeTenantOf(source, s) !== null}
                platformOnly={canRevokeSessions && revokeTenantOf(source, s) === null}
                now={now}
                revoking={revokingId === s.id}
                disabled={revokingId !== null}
                onRevoke={() => onRevokeSession(s)}
              />
            ))}
          </ul>
        )}
        {self ? (
          <p className="mt-2.5 text-xs text-[var(--color-fg-muted)]">
            Tus sesiones se cierran desde{' '}
            <Link
              href="/configuracion/seguridad"
              className="font-medium text-[var(--color-fg)] underline underline-offset-2 hover:text-[var(--color-primary)]"
            >
              Mi cuenta → Seguridad
            </Link>
            .
          </p>
        ) : null}
      </Section>

      <Section
        id={`${base}-invitaciones`}
        title="Invitaciones que envió"
        aside={
          pending > 0 ? (
            <span className="text-xs text-[var(--color-fg-muted)]">
              {pendingInvitationsText(pending)}
            </span>
          ) : null
        }
      >
        {pending === 0 ? (
          <Empty>{pendingInvitationsText(0)}</Empty>
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-border)]">
              {invitations.map((i) => (
                <li key={i.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="truncate text-sm text-[var(--color-fg)]">{i.email}</p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {sentInvitationLine(i, now)}
                  </p>
                </li>
              ))}
            </ul>
            {pending > invitations.length ? (
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                Se muestran las {invitations.length} más recientes.
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section id={`${base}-actividad`} title="Actividad">
        <ActivityList state={activity} onRetry={onRetryActivity} onLoadMore={onLoadMoreActivity} />
      </Section>
    </div>
  );
}

function SessionItem({
  session,
  closable,
  platformOnly,
  now,
  revoking,
  disabled,
  onRevoke,
}: {
  session: MemberDetailSession;
  closable: boolean;
  /** Una sesión de plataforma, sin nodo: no se cierra de a una. */
  platformOnly: boolean;
  now: number;
  revoking: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const device = sessionDevice(session);
  const parts: ReactNode[] = [];
  if (session.ip) {
    parts.push(
      <span key="ip" className="font-mono text-[11px]">
        {session.ip}
      </span>,
    );
  }
  if (session.tenantName) parts.push(<span key="nodo">{session.tenantName}</span>);
  parts.push(
    <time key="visto" dateTime={session.lastSeenAt} title={exactTime(session.lastSeenAt)}>
      {sessionActivity(session, now)}
    </time>,
  );

  return (
    <li className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-[var(--color-fg)]">
          <Monitor aria-hidden="true" className="size-4 shrink-0 text-[var(--color-fg-subtle)]" />
          <span>{device}</span>
          {session.current ? (
            <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              Esta sesión
            </span>
          ) : null}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 pl-6 text-xs text-[var(--color-fg-muted)]">
          <Dotted parts={parts} />
        </p>
        {platformOnly ? (
          <p className="pl-6 text-[11px] text-[var(--color-fg-subtle)]">
            Sesión sin nodo: se cierra con &quot;Cerrar sus sesiones&quot;.
          </p>
        ) : null}
      </div>
      {closable ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onRevoke}
          aria-label={`Cerrar esta sesión: ${device}${session.ip ? `, ${session.ip}` : ''}`}
          className="ml-6 self-start sm:ml-0 sm:self-center"
        >
          {revoking ? (
            <RefreshCw aria-hidden="true" className="animate-spin" />
          ) : (
            <LogOut aria-hidden="true" />
          )}
          {revoking ? 'Cerrando…' : 'Cerrar esta sesión'}
        </Button>
      ) : null}
    </li>
  );
}

/** El historial: cada evento con su frase, el detalle, dónde y quién, y la hora; "Cargar más". */
export function ActivityList({
  state,
  onRetry,
  onLoadMore,
}: {
  state: ActivityState;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <div aria-busy="true" className="space-y-2">
        <p role="status" className="sr-only">
          Cargando la actividad…
        </p>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-[var(--color-surface-muted)]" />
        ))}
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {state.message}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Reintentar
        </Button>
      </div>
    );
  }
  if (state.events.length === 0) return <Empty>Sin actividad registrada.</Empty>;
  return (
    <>
      <ul className="divide-y divide-[var(--color-border)]">
        {state.events.map((e) => {
          const label = eventLabel(e.eventType, e.payload);
          const detail = eventDetail(e);
          const where = [e.tenantName, e.actorEmail === null ? null : `por ${e.actorEmail}`]
            .filter((part): part is string => part !== null)
            .join(' · ');
          return (
            <li key={e.id} className="flex items-start justify-between gap-3 py-2 first:pt-0">
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-[var(--color-fg)]',
                    label.raw ? 'break-all font-mono text-xs' : 'text-sm font-medium',
                  )}
                >
                  {label.text}
                </p>
                {detail ? (
                  <p className="break-words text-xs text-[var(--color-fg-muted)]">{detail}</p>
                ) : null}
                {where ? (
                  <p className="truncate text-[11px] text-[var(--color-fg-subtle)]">{where}</p>
                ) : null}
              </div>
              <time
                dateTime={e.occurredAt}
                title={exactTime(e.occurredAt)}
                className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[var(--color-fg-subtle)]"
              >
                {auditTime(e.occurredAt)}
              </time>
            </li>
          );
        })}
      </ul>
      {state.nextBefore !== null || state.moreError ? (
        <div className="mt-3 flex flex-col items-center gap-2">
          {state.moreError ? (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {state.moreError}
            </p>
          ) : null}
          {state.nextBefore !== null ? (
            <Button
              variant="secondary"
              size="sm"
              // `aria-disabled` y no `disabled`: un botón deshabilitado suelta el foco fuera de la ficha.
              aria-disabled={state.loadingMore || undefined}
              onClick={state.loadingMore ? undefined : onLoadMore}
              className="aria-disabled:cursor-wait aria-disabled:opacity-60"
            >
              {state.loadingMore ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
              {state.loadingMore ? 'Cargando…' : 'Cargar más'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
