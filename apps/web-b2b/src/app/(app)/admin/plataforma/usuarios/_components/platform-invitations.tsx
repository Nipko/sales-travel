'use client';

import { CircleAlert, MailCheck, RefreshCw, Search, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { useConfirm } from '../../../../../../components/ui/dialog';
import { Field, Select, TextInput } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import { invitationNotice } from '../../../../../../lib/invitation-notice';
import {
  afterRemoval,
  afterResend,
  appendInvitations,
  emptyInvitationsMessage,
  hasInvitationFilters,
  INVITATION_STATE_FILTERS,
  invitationExpiryLabel,
  invitationsCountLabel,
  isInvitationExpired,
  loadPlatformInvitations,
  narrowsInvitations,
  stateFilterCount,
  type InvitationFilters,
  type InvitationStateFilter,
  type InvitationsView,
  type PlatformInvitation,
  type PlatformInvitationCounts,
} from '../../../../../../lib/platform-invitations';
import { exactTime } from '../../../../../../lib/tenant-admin-format';
import {
  resendInvitation,
  revokeInvitation,
} from '../../../../../../lib/tenant-admin-seats-client';
import { invitationOrigin } from '../../../../../../lib/tenant-admin-team';
import type { NetworkNode } from '../../../../../../lib/tenant-network';
import { roleLabel } from '../../../usuarios/_components/roles';
import { useNow } from '../../../usuarios/_components/seats-ui';

/** Lo que se espera después de la última tecla antes de buscar. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Los nodos de la red para el filtro "Nodo", tal como los carga el panel. */
export type NodeOptions =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly nodes: readonly NetworkNode[] };

export type InvitationsListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly view: InvitationsView };

/** Lo que se está haciendo con una invitación, para su botón. */
export type InvitationAction = 'resend' | 'revoke';

/** El error de una acción sobre una invitación, que se muestra en su fila. */
export interface InvitationRowError {
  readonly invitationId: string;
  readonly message: string;
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Plataforma → Usuarios → Invitaciones: las invitaciones que nadie aceptó todavía, de todos los nodos.
 * Filtrar por estado, correo y nodo, y reenviar o revocar cada una con las rutas de su nodo, sin ir
 * nodo por nodo a Equipo.
 *
 * Después de una acción la fila cambia en el lugar (lib/platform-invitations.ts), sin recargar: las
 * páginas traídas con "Cargar más" siguen ahí. `onChanged` avisa para que la pestaña actualice su
 * contador; `viewerEmail` es quien pasa a respaldar una invitación que reenvía.
 */
export function PlatformInvitations({
  nodes,
  viewerEmail,
  onRetryNodes,
  onChanged,
}: {
  nodes: NodeOptions;
  viewerEmail: string | null;
  onRetryNodes: () => void;
  onChanged: () => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<InvitationStateFilter>('pending');
  const [tenantId, setTenantId] = useState<string | undefined>(undefined);
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const filters = useMemo<InvitationFilters>(
    () => ({ state: stateFilter, q, tenantId }),
    [stateFilter, q, tenantId],
  );
  // Una respuesta de filtros viejos (la persona siguió escribiendo) no pinta encima de la nueva.
  const latest = useRef(filters);
  latest.current = filters;

  const [list, setList] = useState<InvitationsListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [busy, setBusy] = useState<ReadonlyMap<string, InvitationAction>>(new Map());
  const [rowError, setRowError] = useState<InvitationRowError | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setList({ status: 'loading' });
    setMoreError('');
    setRowError(null);
    const res = await loadPlatformInvitations(filters);
    if (latest.current !== filters) return;
    setList(
      res.ok ? { status: 'ready', view: res.data } : { status: 'error', message: res.message },
    );
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (list.status !== 'ready' || list.view.nextCursor === null) return;
    const asked = filters;
    setLoadingMore(true);
    setMoreError('');
    const res = await loadPlatformInvitations(asked, list.view.nextCursor);
    setLoadingMore(false);
    if (latest.current !== asked) return;
    if (!res.ok) {
      setMoreError(res.message);
      return;
    }
    setList((s) =>
      s.status === 'ready' ? { status: 'ready', view: appendInvitations(s.view, res.data) } : s,
    );
  }

  function mark(id: string, action: InvitationAction | null) {
    setBusy((prev) => {
      const next = new Map(prev);
      if (action === null) next.delete(id);
      else next.set(id, action);
      return next;
    });
  }

  function update(change: (view: InvitationsView) => InvitationsView) {
    setList((s) => (s.status === 'ready' ? { status: 'ready', view: change(s.view) } : s));
  }

  /**
   * La fila se fue de la lista: el foco, que había vuelto a su botón al cerrar la confirmación, no
   * puede quedar en un nodo suelto. Va al título de la lista.
   */
  function rowLeft() {
    headingRef.current?.focus();
  }

  /** Ya no estaba pendiente (la aceptaron o la revocaron desde otra sesión): sale de la lista. */
  function gone(invitation: PlatformInvitation) {
    const at = Date.now();
    update((view) => afterRemoval(view, invitation.id, at));
    toast.warning(
      `La invitación a ${invitation.email} ya no estaba pendiente: la aceptaron o la revocaron desde otra sesión.`,
    );
    rowLeft();
    onChanged();
  }

  async function resend(invitation: PlatformInvitation) {
    if (busy.has(invitation.id)) return;
    setRowError(null);
    mark(invitation.id, 'resend');
    const res = await resendInvitation(invitation.tenantId, invitation.id);
    mark(invitation.id, null);
    if (!res.ok) {
      if (res.gone) gone(invitation);
      else setRowError({ invitationId: invitation.id, message: res.message });
      return;
    }
    const notice = invitationNotice('resent', invitation.email, res.data, new Date());
    (notice.tone === 'warning' ? toast.warning : toast.success)(
      notice.message,
      notice.description === undefined ? undefined : { description: notice.description },
    );
    // El filtro que se ve ahora: en "Vencidas", una reenviada ya no va.
    const shown = latest.current.state;
    const at = Date.now();
    update((view) =>
      afterResend(
        view,
        invitation.id,
        { expiresAt: res.data.expiresAt, invitedByEmail: viewerEmail },
        shown,
        at,
      ),
    );
    if (shown === 'expired') rowLeft();
    onChanged();
  }

  async function revoke(invitation: PlatformInvitation) {
    if (busy.has(invitation.id)) return;
    const ok = await confirm({
      title: `Revocar la invitación a ${invitation.email}`,
      description:
        'El enlace que le enviamos deja de funcionar. Si después quieres sumarlo, tienes que invitarlo de nuevo.',
      confirmLabel: 'Revocar',
      destructive: true,
    });
    if (!ok) return;
    setRowError(null);
    mark(invitation.id, 'revoke');
    const res = await revokeInvitation(invitation.tenantId, invitation.id);
    mark(invitation.id, null);
    if (!res.ok) {
      if (res.gone) gone(invitation);
      else setRowError({ invitationId: invitation.id, message: res.message });
      return;
    }
    toast.success(`Revocamos la invitación a ${invitation.email}.`);
    const at = Date.now();
    update((view) => afterRemoval(view, invitation.id, at));
    rowLeft();
    onChanged();
  }

  function clear() {
    setSearch('');
    setStateFilter('pending');
    setTenantId(undefined);
  }

  const counts = list.status === 'ready' ? list.view.counts : null;

  return (
    <div className="space-y-5">
      {confirmDialog}
      <InvitationFiltersBar
        search={search}
        filters={filters}
        counts={counts}
        nodes={nodes}
        canClear={hasInvitationFilters({ ...filters, q: search })}
        onSearch={setSearch}
        onState={setStateFilter}
        onTenant={setTenantId}
        onRetryNodes={onRetryNodes}
        onClear={clear}
      />
      <InvitationResults
        list={list}
        filters={filters}
        busy={busy}
        rowError={rowError}
        loadingMore={loadingMore}
        moreError={moreError}
        headingRef={headingRef}
        onRetry={() => void load()}
        onLoadMore={() => void loadMore()}
        onClearFilters={clear}
        onDismissError={() => setRowError(null)}
        onResend={(i) => void resend(i)}
        onRevoke={(i) => void revoke(i)}
      />
    </div>
  );
}

const CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]';

/** Búsqueda por correo, "Nodo" y el estado (pendientes, vencidas o todas). Aparte para un test. */
export function InvitationFiltersBar({
  search,
  filters,
  counts,
  nodes,
  canClear,
  onSearch,
  onState,
  onTenant,
  onRetryNodes,
  onClear,
}: {
  search: string;
  filters: InvitationFilters;
  counts: PlatformInvitationCounts | null;
  nodes: NodeOptions;
  canClear: boolean;
  onSearch: (value: string) => void;
  onState: (state: InvitationStateFilter) => void;
  onTenant: (tenantId: string | undefined) => void;
  onRetryNodes: () => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)]">
        <Field label="Buscar">
          {(a11y) => (
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
              />
              <TextInput
                {...a11y}
                type="search"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Busca por correo"
                maxLength={100}
                autoComplete="off"
                className="pl-8"
              />
            </div>
          )}
        </Field>
        <Field
          label="Nodo"
          hint={nodes.status === 'error' ? undefined : 'Incluye todo lo que cuelga de él.'}
          error={nodes.status === 'error' ? nodes.message : undefined}
        >
          {(a11y) => (
            <div className="flex gap-2">
              <Select
                {...a11y}
                value={filters.tenantId ?? ''}
                disabled={nodes.status !== 'ready'}
                onChange={(e) => onTenant(e.target.value || undefined)}
              >
                <option value="">
                  {nodes.status === 'loading' ? 'Cargando la red…' : 'Todos los nodos'}
                </option>
                {nodes.status === 'ready'
                  ? nodes.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {' '.repeat(Math.max(0, n.depth - 1) * 2)}
                        {n.name}
                        {n.status !== 'active' ? ' (suspendido)' : ''}
                      </option>
                    ))
                  : null}
              </Select>
              {nodes.status === 'error' ? (
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={onRetryNodes}
                  aria-label="Volver a cargar los nodos"
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Estado">
        {INVITATION_STATE_FILTERS.map((option) => {
          const pressed = filters.state === option.id;
          const n = stateFilterCount(counts, option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => onState(option.id)}
              className={cn(
                CHIP,
                pressed
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-fg)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]',
              )}
            >
              {option.label}
              {n === undefined ? null : <span className="tabular-nums">({n})</span>}
            </button>
          );
        })}
        {canClear ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X aria-hidden="true" />
            Limpiar filtros
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** La lista con sus estados: cargando, error, vacía, o las invitaciones y "Cargar más". */
export function InvitationResults({
  list,
  filters,
  busy,
  rowError,
  loadingMore,
  moreError,
  headingRef,
  onRetry,
  onLoadMore,
  onClearFilters,
  onDismissError,
  onResend,
  onRevoke,
}: {
  list: InvitationsListState;
  filters: InvitationFilters;
  busy: ReadonlyMap<string, InvitationAction>;
  rowError: InvitationRowError | null;
  loadingMore: boolean;
  moreError: string;
  headingRef?: Ref<HTMLHeadingElement>;
  onRetry: () => void;
  onLoadMore: () => void;
  onClearFilters: () => void;
  onDismissError: () => void;
  onResend: (invitation: PlatformInvitation) => void;
  onRevoke: (invitation: PlatformInvitation) => void;
}) {
  const now = useNow();
  const view = list.status === 'ready' ? list.view : null;

  return (
    <section
      aria-labelledby="platform-invitations-title"
      aria-busy={list.status === 'loading'}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <h2
          ref={headingRef}
          id="platform-invitations-title"
          tabIndex={-1}
          className="rounded text-sm font-semibold text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          Invitaciones
        </h2>
        <p className="text-xs text-[var(--color-fg-muted)]" aria-live="polite">
          {view === null
            ? ''
            : invitationsCountLabel(view.invitations.length, view.nextCursor !== null)}
        </p>
      </div>

      {list.status === 'loading' ? (
        <div className="divide-y divide-[var(--color-border)]" aria-live="polite">
          <span className="sr-only">Cargando invitaciones…</span>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <div className="h-4 w-56 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="ml-auto h-4 w-28 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            </div>
          ))}
        </div>
      ) : list.status === 'error' ? (
        <div role="alert" className="px-6 py-10 text-center">
          <p className="text-sm font-medium text-[var(--color-fg)]">{list.message}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : list.view.invitations.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <MailCheck
            aria-hidden="true"
            className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
          />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            {emptyInvitationsMessage(filters)}
          </p>
          {narrowsInvitations(filters) ? (
            <Button variant="secondary" size="sm" className="mt-4" onClick={onClearFilters}>
              <X aria-hidden="true" />
              Limpiar filtros
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="divide-y divide-[var(--color-border)]">
            {list.view.invitations.map((i) => (
              <InvitationRow
                key={i.id}
                invitation={i}
                now={now}
                action={busy.get(i.id)}
                error={rowError?.invitationId === i.id ? rowError.message : undefined}
                onDismissError={onDismissError}
                onResend={() => onResend(i)}
                onRevoke={() => onRevoke(i)}
              />
            ))}
          </ul>
          {list.view.nextCursor !== null || moreError ? (
            <div className="flex flex-col items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
              {moreError ? (
                <p role="alert" className="text-xs text-[var(--color-danger)]">
                  {moreError}
                </p>
              ) : null}
              {list.view.nextCursor !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-disabled={loadingMore || undefined}
                  onClick={loadingMore ? undefined : onLoadMore}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                >
                  {loadingMore ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
                  {loadingMore ? 'Cargando…' : 'Cargar más'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function InvitationRow({
  invitation,
  now,
  action,
  error,
  onDismissError,
  onResend,
  onRevoke,
}: {
  invitation: PlatformInvitation;
  now: number;
  action: InvitationAction | undefined;
  error: string | undefined;
  onDismissError: () => void;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const expired = isInvitationExpired(invitation, now);
  const working = action !== undefined;
  // `aria-disabled` y no `disabled`: tras confirmar, el foco vuelve al botón, y uno deshabilitado
  // lo soltaba al <body> justo cuando el resultado se anuncia.
  const guard = (run: () => void) => (working ? undefined : run);

  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-0.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-[var(--color-fg)]">
            {invitation.email}
          </span>
          {expired ? (
            <span className="shrink-0 rounded-full border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-2 py-0.5 text-[11px] font-medium text-[var(--color-danger)]">
              Vencida
            </span>
          ) : null}
        </p>
        <p className="break-words text-xs text-[var(--color-fg-muted)]">
          {roleLabel(invitation.role)}
          {' · '}
          {invitation.tenantName || 'Nodo sin nombre'}
          {' · '}
          <time
            dateTime={invitation.expiresAt}
            title={exactTime(invitation.expiresAt)}
            className={cn(expired && 'font-medium text-[var(--color-danger)]')}
          >
            {invitationExpiryLabel(invitation, now)}
          </time>
        </p>
        <p className="truncate text-xs text-[var(--color-fg-subtle)]">
          {invitation.createdAt ? (
            <time dateTime={invitation.createdAt} title={exactTime(invitation.createdAt)}>
              {invitationOrigin(invitation, now)}
            </time>
          ) : (
            invitationOrigin(invitation, now)
          )}
        </p>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant={expired ? 'secondary' : 'ghost'}
          size="sm"
          aria-disabled={working || undefined}
          onClick={guard(onResend)}
          aria-label={`Reenviar la invitación a ${invitation.email}`}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          <Send aria-hidden="true" />
          {action === 'resend' ? 'Reenviando…' : 'Reenviar'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={working || undefined}
          onClick={guard(onRevoke)}
          aria-label={`Revocar la invitación a ${invitation.email}`}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          <X aria-hidden="true" />
          {action === 'revoke' ? 'Revocando…' : 'Revocar'}
        </Button>
      </div>

      {error !== undefined ? (
        <div
          role="alert"
          className="col-span-full flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-fg)]"
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
