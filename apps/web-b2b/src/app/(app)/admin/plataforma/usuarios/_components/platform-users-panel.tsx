'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CircleAlert,
  CirclePlay,
  Download,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { useConfirm } from '../../../../../../components/ui/dialog';
import { Field, Select, TextInput } from '../../../../../../components/ui/field';
import {
  SectionTabPanel,
  SectionTabs,
  useTabsId,
} from '../../../../../../components/wallets/section-tabs';
import { cn } from '../../../../../../lib/cn';
import {
  ACTION_CANCELLED,
  ACTION_DONE,
  memberFromDetail,
  supportMembership,
  syncPlatformUser,
  type MemberDetailView,
  type SheetActionOutcome,
} from '../../../../../../lib/member-detail';
import { loadPendingInvitationCount } from '../../../../../../lib/platform-invitations';
import {
  accountStatus,
  chipPressed,
  DIRECTORY_CHIPS,
  directoryMfaState,
  hasFilters,
  lastAccess,
  loadDirectoryNodes,
  loadPlatformUsers,
  loadSuspensionImpact,
  membershipChipLabel,
  membershipChips,
  platformUserName,
  reactivateCopy,
  setPlatformUserStatus,
  statusDoneMessage,
  suspendCopy,
  teamHref,
  toggleChip,
  type AccountTone,
  type DirectoryFilters,
  type PlatformUser,
} from '../../../../../../lib/platform-users';
import { saveFile } from '../../../../../../lib/platform-audit-client';
import { DIRECTORY_ROLES } from '../../../../../../lib/platform-users-proxy';
import { isStepUpCancelled } from '../../../../../../lib/step-up';
import { exactTime } from '../../../../../../lib/tenant-admin-format';
import {
  MFA_STATE_HINT,
  MFA_STATE_LABEL,
  teamHrefFor,
  type MemberAction,
  type NetworkMember,
} from '../../../../../../lib/tenant-admin-team';
import type { NetworkNode } from '../../../../../../lib/tenant-network';
import {
  exportPlatformUsers,
  PLATFORM_EXPORT_NOTE,
  usersExportDoneMessage,
} from '../../../../../../lib/user-export';
import { SupportActionGroups } from '../../../usuarios/_components/member-list';
import { MemberNameButton, MemberSheet } from '../../../usuarios/_components/member-sheet';
import { roleLabel } from '../../../usuarios/_components/roles';
import { useNow } from '../../../usuarios/_components/seats-ui';
import { supportMember } from '../../../usuarios/_components/support-action';
import { PlatformInvitations, SEARCH_DEBOUNCE_MS, useDebounced } from './platform-invitations';

/** Las pestañas de la pantalla: las personas, o las invitaciones que nadie aceptó todavía. */
type PanelTab = 'users' | 'invitations';

export type DirectoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly users: readonly PlatformUser[];
      readonly nextCursor: string | null;
    };

type NodesState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly nodes: readonly NetworkNode[] };

/** El error de una acción sobre una persona, que se muestra en su fila. */
export interface RowError {
  readonly userId: string;
  readonly message: string;
}

/**
 * Las columnas en pantalla ancha. En el teléfono cada persona es una tarjeta: nombre y menú arriba,
 * sus nodos a lo ancho y los demás datos debajo con su etiqueta.
 */
const COLUMNS =
  'md:grid-cols-[minmax(0,2fr)_minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_2.5rem]';

/** Mismos tonos que Equipo: texto -700/-800 sobre fondo -50, más de 4.5:1 a 12px. */
const STATUS_TONE: Readonly<Record<AccountTone, string>> = {
  ok: 'bg-emerald-50 text-emerald-700',
  danger: 'bg-red-50 text-red-700',
  warn: 'bg-amber-50 text-amber-800',
};

/** Texto de estado sin fondo propio, legible en los dos temas (ver member-list.tsx). */
const TONE_TEXT = {
  success: 'text-[color-mix(in_oklab,var(--color-success)_60%,var(--color-fg))]',
  warning: 'text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-fg))]',
} as const;

const MFA_STYLE = {
  active: TONE_TEXT.success,
  pending: TONE_TEXT.warning,
  'not-required': 'text-[var(--color-fg-muted)]',
} as const;

/** La etiqueta de un dato: visible en la tarjeta del teléfono, sólo para lectores en escritorio. */
function CellLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-0.5 block text-[11px] font-medium text-[var(--color-fg-subtle)] md:sr-only">
      {children}
    </span>
  );
}

/**
 * Plataforma → Usuarios: todas las personas de la red, en todos los nodos. Buscar, filtrar, ver sus
 * nodos y roles, y suspender o reactivar la cuenta en toda la plataforma. En otra pestaña, las
 * invitaciones que nadie aceptó todavía (platform-invitations.tsx).
 *
 * `viewerId`: quien mira, para no ofrecerle suspenderse a sí mismo (el API lo rechaza igual).
 * `viewerEmail`: el suyo, que pasa a respaldar una invitación que reenvía.
 *
 * Las dos pestañas quedan montadas al cambiar: cada una conserva sus filtros y lo que cargó. La de
 * invitaciones se monta recién la primera vez que se abre; hasta entonces su contador sale de un
 * pedido aparte, que se repite cada vez que una invitación cambia.
 */
export function PlatformUsersPanel({
  viewerId,
  viewerEmail = null,
}: {
  viewerId: string | null;
  viewerEmail?: string | null;
}) {
  const tabsId = useTabsId();
  const [tab, setTab] = useState<PanelTab>('users');
  const [invitationsOpened, setInvitationsOpened] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState<number | null>(null);
  // Sube cuando suspender una cuenta revocó invitaciones: la pestaña Invitaciones vuelve a pedirlas.
  const [invitationsRevision, setInvitationsRevision] = useState(0);
  const countRequest = useRef(0);
  const [confirm, confirmDialog] = useConfirm();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Omit<DirectoryFilters, 'q'>>({});
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const [state, setState] = useState<DirectoryState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [nodes, setNodes] = useState<NodesState>({ status: 'loading' });
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  // La persona cuya ficha está abierta.
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo<DirectoryFilters>(() => ({ ...filters, q }), [filters, q]);
  // Una respuesta de filtros viejos (la persona siguió escribiendo) no pinta encima de la nueva.
  const latest = useRef(query);
  latest.current = query;

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    setMoreError('');
    setRowError(null);
    const res = await loadPlatformUsers(query);
    if (latest.current !== query) return;
    setState(
      res.ok
        ? { status: 'ready', users: res.data.users, nextCursor: res.data.nextCursor }
        : { status: 'error', message: res.message },
    );
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadNodes = useCallback(async () => {
    setNodes({ status: 'loading' });
    const res = await loadDirectoryNodes();
    setNodes(
      res.ok ? { status: 'ready', nodes: res.data } : { status: 'error', message: res.message },
    );
  }, []);

  useEffect(() => {
    void loadNodes();
  }, [loadNodes]);

  // Sin el número, la pestaña dice sólo "Invitaciones": no inventa un cero. Con dos acciones
  // seguidas salen dos pedidos; sólo pinta el último, para que uno viejo no lo pise.
  const loadPendingCount = useCallback(async () => {
    const asked = ++countRequest.current;
    const res = await loadPendingInvitationCount();
    if (res.ok && asked === countRequest.current) setPendingInvitations(res.data);
  }, []);

  useEffect(() => {
    void loadPendingCount();
  }, [loadPendingCount]);

  function selectTab(next: PanelTab) {
    setTab(next);
    if (next === 'invitations') setInvitationsOpened(true);
  }

  async function loadMore() {
    if (state.status !== 'ready' || state.nextCursor === null) return;
    const asked = query;
    setLoadingMore(true);
    setMoreError('');
    const res = await loadPlatformUsers(asked, state.nextCursor);
    setLoadingMore(false);
    if (latest.current !== asked) return;
    if (!res.ok) {
      setMoreError(res.message);
      return;
    }
    setState((s) =>
      s.status === 'ready'
        ? {
            status: 'ready',
            // Sin repetir a quien ya está (alguien pudo darse de alta entre una página y otra).
            users: [
              ...s.users,
              ...res.data.users.filter((u) => !s.users.some((p) => p.id === u.id)),
            ],
            nextCursor: res.data.nextCursor,
          }
        : s,
    );
  }

  function replaceUser(updated: PlatformUser) {
    setState((s) =>
      s.status === 'ready'
        ? { ...s, users: s.users.map((u) => (u.id === updated.id ? updated : u)) }
        : s,
    );
  }

  /** La ficha se volvió a leer: su fila dice lo mismo (bloqueo, 2FA, sesiones, estado). */
  function syncFromDetail(detail: MemberDetailView) {
    setState((s) =>
      s.status === 'ready' ? { ...s, users: s.users.map((u) => syncPlatformUser(u, detail)) } : s,
    );
  }

  /** Una acción pedida desde la fila: si falla, el motivo va en su fila. */
  async function fromRow(user: PlatformUser, outcome: Promise<SheetActionOutcome>) {
    const out = await outcome;
    if (out.status === 'failed') setRowError({ userId: user.id, message: out.message });
  }

  async function setStatus(
    user: PlatformUser,
    status: 'active' | 'suspended',
  ): Promise<SheetActionOutcome> {
    const suspending = status === 'suspended';
    setRowError(null);
    let copy = reactivateCopy(user);
    if (suspending) {
      setBusyUserId(user.id);
      const impact = await loadSuspensionImpact(user.id);
      setBusyUserId(null);
      // Sin el impacto se confirma igual: el texto lo dice sin números.
      copy = suspendCopy(user, impact.ok ? impact.data : null);
    }
    const ok = await confirm({ ...copy, destructive: suspending });
    if (!ok) return ACTION_CANCELLED;

    setBusyUserId(user.id);
    // Alto impacto: puede pedir el código del 2FA en el medio y repetirse (USR-13).
    const res = await setPlatformUserStatus(user.id, status);
    setBusyUserId(null);
    if (isStepUpCancelled(res)) return ACTION_CANCELLED;
    if (!res.ok) return { status: 'failed', message: res.message };
    replaceUser({
      ...user,
      status: res.data.status,
      activeSessions: res.data.status === 'suspended' ? 0 : user.activeSessions,
    });
    // Suspender revoca las invitaciones que emitió: la otra pestaña y su número no pueden seguir
    // mostrándolas.
    if (res.data.revokedInvitations > 0) {
      setInvitationsRevision((r) => r + 1);
      void loadPendingCount();
    }
    toast.success(statusDoneMessage(user, res.data));
    return ACTION_DONE;
  }

  /**
   * Soporte desde la ficha (enviar el enlace, desbloquear, cerrar sus sesiones…), por uno de sus
   * nodos: el superadmin puede por cualquiera, y el API exige que tenga membership en ése.
   */
  function supportAction(
    tenantId: string,
    member: NetworkMember,
    action: MemberAction,
  ): Promise<SheetActionOutcome> {
    return supportMember(confirm, tenantId, member, action, (busy) =>
      setBusyUserId(busy ? member.userId : null),
    );
  }

  /**
   * Exportar a CSV (USR-16) con los filtros de la lista que se ve: la misma consulta, sin paginar. Es
   * de alto impacto: puede pedir el código del 2FA en el medio y repetirse (USR-13).
   */
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    const res = await exportPlatformUsers(query);
    setExporting(false);
    if (isStepUpCancelled(res)) return;
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    saveFile(res.data);
    toast.success(usersExportDoneMessage(res.data, 'platform'));
  }

  const filtered = hasFilters({ ...filters, q: '' }) || q.trim() !== '';
  const sheetUser =
    state.status === 'ready' ? state.users.find((u) => u.id === sheetId) : undefined;
  const sheetSelf = viewerId !== null && sheetId === viewerId;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-5 sm:py-8">
      {confirmDialog}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Usuarios de la plataforma
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Todas las personas de la red, en todos los nodos.
          </p>
        </div>
        {tab === 'users' ? (
          <ExportUsersButton exporting={exporting} onExport={() => void exportCsv()} />
        ) : null}
      </header>

      <div>
        <SectionTabs<PanelTab>
          idPrefix={tabsId}
          label="Usuarios de la plataforma"
          value={tab}
          onChange={selectTab}
          tabs={[
            { id: 'users', label: 'Usuarios' },
            {
              id: 'invitations',
              label: 'Invitaciones',
              count: pendingInvitations ?? undefined,
              countLabel: pendingInvitations === 1 ? 'pendiente' : 'pendientes',
            },
          ]}
        />

        <SectionTabPanel id="users" idPrefix={tabsId} hidden={tab !== 'users'} keepMounted>
          <div className="space-y-5">
            <DirectoryFiltersBar
              search={search}
              filters={filters}
              nodes={nodes}
              onSearch={setSearch}
              onFilters={setFilters}
              onRetryNodes={() => void loadNodes()}
              onClear={() => {
                setSearch('');
                setFilters({});
              }}
              canClear={filtered}
            />

            <DirectoryResults
              state={state}
              viewerId={viewerId}
              busyUserId={busyUserId}
              rowError={rowError}
              filtered={filtered}
              loadingMore={loadingMore}
              moreError={moreError}
              onRetry={() => void load()}
              onLoadMore={() => void loadMore()}
              onDismissError={() => setRowError(null)}
              onClearFilters={() => {
                setSearch('');
                setFilters({});
              }}
              onOpen={(u) => setSheetId(u.id)}
              onSetStatus={(u, s) => void fromRow(u, setStatus(u, s))}
            />
          </div>
        </SectionTabPanel>

        <SectionTabPanel
          id="invitations"
          idPrefix={tabsId}
          hidden={tab !== 'invitations'}
          keepMounted
        >
          {invitationsOpened ? (
            <PlatformInvitations
              nodes={nodes}
              viewerEmail={viewerEmail}
              revision={invitationsRevision}
              onRetryNodes={() => void loadNodes()}
              onChanged={() => void loadPendingCount()}
            />
          ) : null}
        </SectionTabPanel>
      </div>

      {sheetId !== null ? (
        <MemberSheet
          key={sheetId}
          source={{ kind: 'platform', userId: sheetId }}
          fallbackName={sheetUser ? platformUserName(sheetUser) : ''}
          fallbackEmail={sheetUser?.email}
          self={sheetSelf}
          busy={busyUserId === sheetId}
          canRevokeSessions={!sheetSelf}
          renderMenu={(detail, { pick, run, now }) => (
            <PlatformSheetMenuItems
              detail={detail}
              now={now}
              onPick={pick}
              onAction={(tenantId, member, action) =>
                run(() => supportAction(tenantId, member, action))
              }
              onSetStatus={
                sheetUser === undefined
                  ? undefined
                  : (status) => run(() => setStatus(sheetUser, status))
              }
            />
          )}
          unlockAction={(detail) => {
            // Sin nodos no hay por dónde: el API pide una membership en el nodo de la ruta.
            const node = supportMembership(detail);
            return node === undefined
              ? undefined
              : () => supportAction(node.tenantId, memberFromDetail(detail, node), 'unlock');
          }}
          onDetail={syncFromDetail}
          onClose={() => setSheetId(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * "Exportar CSV" del directorio, con la nota de qué sale. Aparte para pintarlo en un test. Mientras
 * exporta, el botón espera (y lo dice) en vez de desaparecer.
 */
export function ExportUsersButton({
  exporting,
  onExport,
}: {
  exporting: boolean;
  onExport: () => void;
}) {
  const noteId = useId();
  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button
        variant="secondary"
        size="sm"
        disabled={exporting}
        aria-describedby={noteId}
        onClick={onExport}
      >
        {exporting ? (
          <RefreshCw aria-hidden="true" className="animate-spin" />
        ) : (
          <Download aria-hidden="true" />
        )}
        {exporting ? 'Exportando…' : 'Exportar CSV'}
      </Button>
      <p id={noteId} className="text-xs text-[var(--color-fg-muted)] sm:text-right">
        {PLATFORM_EXPORT_NOTE}
      </p>
    </div>
  );
}

/** Búsqueda, "Rol", "Nodo" y los filtros rápidos. Aparte para pintarla en un test. */
export function DirectoryFiltersBar({
  search,
  filters,
  nodes,
  canClear,
  onSearch,
  onFilters,
  onRetryNodes,
  onClear,
}: {
  search: string;
  filters: Omit<DirectoryFilters, 'q'>;
  nodes: NodesState;
  canClear: boolean;
  onSearch: (value: string) => void;
  onFilters: (next: Omit<DirectoryFilters, 'q'>) => void;
  onRetryNodes: () => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
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
                placeholder="Busca por nombre o correo"
                maxLength={100}
                autoComplete="off"
                className="pl-8"
              />
            </div>
          )}
        </Field>
        <Field label="Rol">
          {(a11y) => (
            <Select
              {...a11y}
              value={filters.role ?? ''}
              onChange={(e) => onFilters({ ...filters, role: e.target.value || undefined })}
            >
              <option value="">Todos los roles</option>
              {DIRECTORY_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
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
                onChange={(e) => onFilters({ ...filters, tenantId: e.target.value || undefined })}
              >
                <option value="">
                  {nodes.status === 'loading' ? 'Cargando la red…' : 'Todos los nodos'}
                </option>
                {nodes.status === 'ready'
                  ? nodes.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {' '.repeat(Math.max(0, n.depth - 1) * 2)}
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

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros rápidos">
        {DIRECTORY_CHIPS.map((chip) => {
          const pressed = chipPressed(filters, chip.id);
          return (
            <button
              key={chip.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => onFilters(toggleChip(filters, chip.id))}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
                pressed
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-fg)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]',
              )}
            >
              {chip.label}
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

/** La lista con sus estados: cargando, error, vacía, o las personas y "Cargar más". */
export function DirectoryResults({
  state,
  viewerId,
  busyUserId,
  rowError,
  filtered,
  loadingMore,
  moreError,
  onRetry,
  onLoadMore,
  onDismissError,
  onClearFilters,
  onOpen,
  onSetStatus,
}: {
  state: DirectoryState;
  viewerId: string | null;
  busyUserId: string | null;
  rowError: RowError | null;
  filtered: boolean;
  loadingMore: boolean;
  moreError: string;
  onRetry: () => void;
  onLoadMore: () => void;
  onDismissError: () => void;
  onClearFilters: () => void;
  /** Abre la ficha de la persona. Sin él, el nombre es sólo texto. */
  onOpen?: (user: PlatformUser) => void;
  onSetStatus: (user: PlatformUser, status: 'active' | 'suspended') => void;
}) {
  const now = useNow();
  const count = state.status === 'ready' ? state.users.length : 0;

  return (
    <section
      aria-labelledby="platform-users-title"
      aria-busy={state.status === 'loading'}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <h2 id="platform-users-title" className="text-sm font-semibold text-[var(--color-fg)]">
          Personas
        </h2>
        <p className="text-xs text-[var(--color-fg-muted)]" aria-live="polite">
          {state.status === 'ready'
            ? `${count} ${count === 1 ? 'persona' : 'personas'}${state.nextCursor ? ' (hay más)' : ''}`
            : ''}
        </p>
      </div>

      {state.status === 'loading' ? (
        <div className="divide-y divide-[var(--color-border)]" aria-live="polite">
          <span className="sr-only">Cargando usuarios…</span>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <div className="h-4 w-48 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              <div className="ml-auto h-4 w-24 animate-pulse rounded bg-[var(--color-surface-muted)]" />
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
      ) : state.users.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <Users aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            No encontramos usuarios con esos filtros.
          </p>
          {filtered ? (
            <Button variant="secondary" size="sm" className="mt-4" onClick={onClearFilters}>
              <X aria-hidden="true" />
              Limpiar filtros
            </Button>
          ) : null}
        </div>
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
            <span>Nodos y roles</span>
            <span>Último acceso</span>
            <span>2FA</span>
            <span>Estado</span>
            <span />
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {state.users.map((u) => (
              <PlatformUserRow
                key={u.id}
                user={u}
                self={viewerId !== null && u.id === viewerId}
                now={now}
                busy={busyUserId === u.id}
                error={rowError?.userId === u.id ? rowError.message : undefined}
                onDismissError={onDismissError}
                onOpen={onOpen === undefined ? undefined : () => onOpen(u)}
                onSetStatus={(status) => onSetStatus(u, status)}
              />
            ))}
          </ul>
          {state.nextCursor !== null || moreError ? (
            <div className="flex flex-col items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
              {moreError ? (
                <p role="alert" className="text-xs text-[var(--color-danger)]">
                  {moreError}
                </p>
              ) : null}
              {state.nextCursor !== null ? (
                <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
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

function PlatformUserRow({
  user,
  self,
  now,
  busy,
  error,
  onDismissError,
  onOpen,
  onSetStatus,
}: {
  user: PlatformUser;
  self: boolean;
  now: number;
  busy: boolean;
  error: string | undefined;
  onDismissError: () => void;
  onOpen: (() => void) | undefined;
  onSetStatus: (status: 'active' | 'suspended') => void;
}) {
  const name = platformUserName(user);
  const chips = membershipChips(user);
  const hidden = user.memberships.slice(chips.shown.length);
  const access = lastAccess(user, now);
  const mfa = directoryMfaState(user);
  const status = accountStatus(user, now);
  const MfaIcon = mfa === 'active' ? ShieldCheck : mfa === 'pending' ? ShieldAlert : null;

  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 px-4 py-3 md:items-center md:gap-x-4',
        COLUMNS,
      )}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-fg)]">
          {onOpen !== undefined ? (
            <MemberNameButton name={name} onOpen={onOpen} />
          ) : (
            <span className="truncate">{name}</span>
          )}
          {self ? (
            <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              Tú
            </span>
          ) : null}
        </p>
        {user.name ? (
          <p className="truncate text-xs text-[var(--color-fg-muted)]">{user.email}</p>
        ) : null}
        {!user.emailVerified ? (
          <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
            Correo sin verificar
          </span>
        ) : null}
      </div>

      <div className="justify-self-end md:order-last">
        <UserActions name={name} user={user} self={self} busy={busy} onSetStatus={onSetStatus} />
      </div>

      <div className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-3 md:contents">
        <div className="col-span-2 min-w-0 md:col-span-1">
          <CellLabel>Nodos y roles</CellLabel>
          {user.memberships.length === 0 ? (
            <span className="text-xs text-[var(--color-fg-subtle)]">Sin nodos</span>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {chips.shown.map((m) => {
                const suspended = m.status !== 'active';
                return (
                  <li
                    key={m.tenantId}
                    className={cn(
                      'inline-flex max-w-full items-center rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-medium',
                      suspended
                        ? 'text-[var(--color-fg-subtle)] line-through'
                        : 'text-[var(--color-fg)]',
                    )}
                    title={suspended ? 'Acceso suspendido en este nodo' : undefined}
                  >
                    <span className="truncate">{membershipChipLabel(m, roleLabel)}</span>
                    {suspended ? <span className="sr-only">, acceso suspendido</span> : null}
                  </li>
                );
              })}
              {chips.more > 0 ? (
                <li
                  className="inline-flex items-center rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]"
                  title={hidden.map((m) => membershipChipLabel(m, roleLabel)).join('\n')}
                >
                  <span aria-hidden="true">+{chips.more}</span>
                  <span className="sr-only">
                    y {chips.more} {chips.more === 1 ? 'nodo más' : 'nodos más'}:{' '}
                    {hidden.map((m) => membershipChipLabel(m, roleLabel)).join(', ')}
                  </span>
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="min-w-0 text-xs text-[var(--color-fg)]">
          <CellLabel>Último acceso</CellLabel>
          {access.at ? (
            <time dateTime={access.at} title={exactTime(access.at)}>
              {access.label}
            </time>
          ) : (
            <span className="text-[var(--color-fg-muted)]">{access.label}</span>
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

        <div className="min-w-0 text-xs">
          <CellLabel>Estado</CellLabel>
          <span
            className={cn(
              'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_TONE[status.tone],
            )}
          >
            {status.label}
          </span>
        </div>
      </div>

      {error !== undefined ? (
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

const SEPARATOR = 'my-1 h-px bg-[var(--color-border)]';

const MENU_LABEL = 'px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-[var(--color-fg-subtle)]';

/**
 * El menú "Acciones" de la ficha en el directorio: el soporte de Equipo (Acceso, Seguridad) por uno
 * de sus nodos, la cuenta en toda la plataforma (suspender o reactivar) y "Ver en Equipo". Sin nodos
 * no hay soporte: esas acciones van por un nodo donde tenga membership.
 */
export function PlatformSheetMenuItems({
  detail,
  now,
  onPick,
  onAction,
  onSetStatus,
}: {
  detail: MemberDetailView;
  now: number;
  onPick: (run: () => void) => () => void;
  onAction: (tenantId: string, member: NetworkMember, action: MemberAction) => void;
  /** Suspender o reactivar la cuenta; sin él, no se ofrece. */
  onSetStatus: ((status: 'active' | 'suspended') => void) | undefined;
}) {
  const headingId = useId();
  const node = supportMembership(detail);
  const member = node === undefined ? undefined : memberFromDetail(detail, node);
  const first = detail.memberships[0];
  const href = first === undefined ? undefined : teamHrefFor(first.tenantId);
  const suspended = detail.user.status === 'suspended';
  return (
    <>
      {node !== undefined && member !== undefined ? (
        <SupportActionGroups
          member={member}
          now={now}
          onPick={onPick}
          onAction={(action) => onAction(node.tenantId, member, action)}
        />
      ) : null}
      {onSetStatus !== undefined ? (
        <>
          {node !== undefined ? <DropdownMenu.Separator className={SEPARATOR} /> : null}
          <DropdownMenu.Group aria-labelledby={headingId}>
            <DropdownMenu.Label id={headingId} className={MENU_LABEL}>
              Cuenta
            </DropdownMenu.Label>
            <DropdownMenu.Item
              className={cn(ITEM, !suspended && 'text-[var(--color-danger)]')}
              onSelect={onPick(() => onSetStatus(suspended ? 'active' : 'suspended'))}
            >
              {suspended ? (
                <CirclePlay aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
              ) : (
                <UserMinus aria-hidden="true" className="size-4" />
              )}
              {suspended ? 'Reactivar cuenta' : 'Suspender en toda la plataforma'}
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </>
      ) : null}
      {href !== undefined ? (
        <>
          <DropdownMenu.Separator className={SEPARATOR} />
          <DropdownMenu.Item asChild className={ITEM}>
            <Link href={href}>
              <Users aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
              Ver en Equipo
            </Link>
          </DropdownMenu.Item>
        </>
      ) : null}
    </>
  );
}

/**
 * Lo de adentro del menú de una persona: "Ver en Equipo" y suspender o reactivar la cuenta (nunca
 * sobre uno mismo). Aparte del menú para poder pintarlo abierto en un test.
 *
 * `onPick` recibe lo que hay que hacer: el menú lo corre recién al cerrarse (ver UserActions).
 */
export function UserActionItems({
  user,
  self,
  onPick,
  onSetStatus,
}: {
  user: PlatformUser;
  self: boolean;
  onPick: (run: () => void) => () => void;
  onSetStatus: (status: 'active' | 'suspended') => void;
}) {
  const href = teamHref(user);
  const suspended = user.status === 'suspended';
  return (
    <>
      {href !== undefined ? (
        <DropdownMenu.Item asChild className={ITEM}>
          <Link href={href}>
            <Users aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            Ver en Equipo
          </Link>
        </DropdownMenu.Item>
      ) : null}
      {self ? null : (
        <>
          {href !== undefined ? <DropdownMenu.Separator className={SEPARATOR} /> : null}
          <DropdownMenu.Item
            className={cn(ITEM, !suspended && 'text-[var(--color-danger)]')}
            onSelect={onPick(() => onSetStatus(suspended ? 'active' : 'suspended'))}
          >
            {suspended ? (
              <CirclePlay aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            ) : (
              <UserMinus aria-hidden="true" className="size-4" />
            )}
            {suspended ? 'Reactivar cuenta' : 'Suspender en toda la plataforma'}
          </DropdownMenu.Item>
        </>
      )}
    </>
  );
}

function UserActions({
  name,
  user,
  self,
  busy,
  onSetStatus,
}: {
  name: string;
  user: PlatformUser;
  self: boolean;
  busy: boolean;
  onSetStatus: (status: 'active' | 'suspended') => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // La acción elegida corre cuando el menú ya cerró y devolvió el foco a su botón: si abriera su
  // confirmación antes, Radix le quitaba el foco al diálogo para devolvérselo al botón.
  const pending = useRef<(() => void) | null>(null);
  const later = (action: () => void) => () => {
    pending.current = action;
  };

  // Sin nodos y sobre uno mismo no queda nada que ofrecer.
  if (self && teamHref(user) === undefined) return null;

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
          className="z-50 min-w-[240px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
          onCloseAutoFocus={(e) => {
            const action = pending.current;
            if (action === null) return;
            pending.current = null;
            e.preventDefault();
            triggerRef.current?.focus();
            action();
          }}
        >
          <UserActionItems user={user} self={self} onPick={later} onSetStatus={onSetStatus} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
