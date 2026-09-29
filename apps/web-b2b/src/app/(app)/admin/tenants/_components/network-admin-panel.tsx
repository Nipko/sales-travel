'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Building2,
  CircleSlash,
  CirclePlay,
  MoreHorizontal,
  MoveRight,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Store,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { NodeKindBadge } from '../../../../../components/network/node-kind';
import { Button } from '../../../../../components/ui/button';
import { useConfirm } from '../../../../../components/ui/dialog';
import { TextInput } from '../../../../../components/ui/field';
import { cn } from '../../../../../lib/cn';
import {
  loadAdminNetwork,
  updateNode,
  type AdminNetworkNode,
} from '../../../../../lib/tenant-admin-client';
import { createdMessage } from '../../../../../lib/tenant-admin-form';
import {
  branchChange,
  buildForest,
  creatableKinds,
  flattenForest,
  matchesQuery,
  networkComposition,
  nodesOutsideNetwork,
  statusChange,
  statusLabel,
  type CreatableKind,
} from '../../../../../lib/tenant-network';
import { CreateNodeDialog } from './create-node-dialog';
import { MoveNodeDialog } from './move-node-dialog';

const SUPERADMIN = { superadmin: true } as const;

/** Todo lo que el superadmin puede crear desde la cabecera; el padre se elige en el formulario. */
const ALL_KINDS: readonly CreatableKind[] = ['agency', 'branch', 'consolidator', 'subagency'];

type PanelState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly nodes: readonly AdminNetworkNode[] };

type Creating = { readonly kinds: readonly CreatableKind[]; readonly parent?: AdminNetworkNode };
type Moving = { readonly node: AdminNetworkNode; readonly initialTargetId?: string };

const STATUS_STYLE: Readonly<Record<string, string>> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  suspended: 'border-red-200 bg-red-50 text-red-700',
  archived:
    'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
};

/**
 * "Gestión de Agencias": la red de Planetour como árbol, para armarla y corregirla. Quién cuelga
 * de quién, de qué tipo es cada nodo (la sucursal incluida) y si opera; alta con Planetour como
 * padre por defecto, mover un nodo con su subárbol, suspenderlo o reactivarlo y marcar sucursales.
 * Todo es del superadmin: la API lo exige en cada llamada.
 */
export function NetworkAdminPanel() {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<Creating | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (initial: boolean) => {
    if (initial) setState({ status: 'loading' });
    const res = await loadAdminNetwork();
    if (res.ok) {
      setState({ status: 'ready', nodes: res.data });
      return;
    }
    // Una relectura que falla no borra lo que ya se veía: se avisa y se sigue mostrando.
    if (initial) setState({ status: 'error', message: res.message });
    else toast.error(res.message);
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const nodes = state.status === 'ready' ? state.nodes : [];
  const rows = useMemo(() => flattenForest(buildForest(nodes)), [nodes]);
  const visibleRows = useMemo(
    () => (query.trim() === '' ? rows : rows.filter((r) => matchesQuery(r.node, query))),
    [rows, query],
  );
  const outside = useMemo(() => nodesOutsideNetwork(nodes), [nodes]);
  const platform = nodes.find((n) => n.tenantType === 'platform');
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);

  const closeCreating = useCallback(() => setCreating(null), []);
  const closeMoving = useCallback(() => setMoving(null), []);

  async function toggleStatus(node: AdminNetworkNode) {
    const change = statusChange(nodes, node);
    if (change === undefined) return;
    const ok = await confirm({
      title: change.title,
      description: change.description,
      confirmLabel: change.confirmLabel,
      destructive: change.destructive,
    });
    if (!ok) return;
    setBusyId(node.id);
    const res = await updateNode(node.id, { status: change.next });
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    toast.success(
      change.next === 'suspended' ? `${node.name} quedó suspendido.` : `${node.name} quedó activo.`,
    );
    void load(false);
  }

  async function toggleBranch(node: AdminNetworkNode) {
    const change = branchChange(nodes, node);
    if (change === undefined) return;
    const ok = await confirm({
      title: change.title,
      description: change.description,
      confirmLabel: change.label,
      destructive: false,
    });
    if (!ok) return;
    setBusyId(node.id);
    const res = await updateNode(node.id, { isBranch: change.isBranch });
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    toast.success(
      change.isBranch
        ? `${node.name} es sucursal de Planetour.`
        : `${node.name} ya no es sucursal.`,
    );
    void load(false);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Gestión de Agencias
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            La red de Planetour: quién cuelga de quién y si está operando. Cada nodo hereda de su
            padre credenciales, reglas de precio y marca. Planetour vende por sus sucursales.
          </p>
          {nodes.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
              {networkComposition(nodes)}
            </p>
          ) : null}
        </div>
        <Button
          className="w-full sm:w-auto"
          disabled={state.status !== 'ready'}
          onClick={() => setCreating({ kinds: ALL_KINDS })}
        >
          <Plus aria-hidden="true" />
          Nuevo nodo
        </Button>
      </header>

      {state.status === 'loading' ? (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          <span className="sr-only">Cargando la red…</span>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="text-sm font-medium text-[var(--color-fg)]">{state.message}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load(true)}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : nodes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-14 text-center">
          <Building2
            aria-hidden="true"
            className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
          />
          <p className="text-sm font-medium text-[var(--color-fg)]">La red está vacía.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {outside.length > 0 && platform !== undefined ? (
            <OutsideNetworkNotice
              nodes={outside}
              platformName={platform.name}
              onMove={(node) => setMoving({ node, initialTargetId: platform.id })}
            />
          ) : null}

          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
            />
            <TextInput
              type="search"
              aria-label="Buscar un nodo por nombre o slug"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre o slug…"
              className="pl-9"
            />
          </div>

          {visibleRows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-sm text-[var(--color-fg-muted)]">
              Ningún nodo coincide con la búsqueda.
            </p>
          ) : (
            <ul
              aria-label="Nodos de la red"
              className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
            >
              {visibleRows.map(({ node, level }) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  // Buscando, la sangría del árbol confunde: cada fila dice igual de quién cuelga.
                  level={query.trim() === '' ? level : 0}
                  parent={node.parentTenantId === null ? undefined : byId.get(node.parentTenantId)}
                  busy={busyId === node.id}
                  childKinds={creatableKinds(node, SUPERADMIN)}
                  statusAction={statusChange(nodes, node)?.label}
                  branchAction={branchChange(nodes, node)?.label}
                  onCreateChild={(kinds) => setCreating({ kinds, parent: node })}
                  onMove={() => setMoving({ node })}
                  onToggleStatus={() => void toggleStatus(node)}
                  onToggleBranch={() => void toggleBranch(node)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {creating !== null ? (
        <CreateNodeDialog
          nodes={nodes}
          kinds={creating.kinds}
          fixedParent={creating.parent}
          onClose={closeCreating}
          onCreated={(created, draft, parentName) => {
            setCreating(null);
            if (draft.kind !== undefined) {
              const msg = createdMessage(created, draft.kind, draft.name.trim(), parentName);
              if (msg.warn) toast.warning(msg.title, { description: msg.detail });
              else toast.success(msg.title, { description: msg.detail });
            }
            void load(false);
          }}
        />
      ) : null}

      {moving !== null ? (
        <MoveNodeDialog
          nodes={nodes}
          node={moving.node}
          initialTargetId={moving.initialTargetId}
          onClose={closeMoving}
          onMoved={(target, moved) => {
            const node = moving.node;
            setMoving(null);
            toast.success(
              moved === 0
                ? `${node.name} ya colgaba de ${target.name}.`
                : `${node.name} ahora cuelga de ${target.name}.`,
              {
                description:
                  moved > 1
                    ? `Se movió con ${moved - 1} ${moved - 1 === 1 ? 'nodo' : 'nodos'} de su red.`
                    : undefined,
              },
            );
            void load(false);
          }}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}

function OutsideNetworkNotice({
  nodes,
  platformName,
  onMove,
}: {
  nodes: readonly AdminNetworkNode[];
  platformName: string;
  onMove: (node: AdminNetworkNode) => void;
}) {
  const many = nodes.length > 1;
  return (
    <section
      aria-labelledby="outside-network-title"
      className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/8 px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]"
        />
        <div className="min-w-0 flex-1">
          <h2 id="outside-network-title" className="text-sm font-semibold text-[var(--color-fg)]">
            {many
              ? `${nodes.length} nodos fuera de la red de ${platformName}`
              : `Un nodo fuera de la red de ${platformName}`}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-fg-muted)]">
            {many ? 'Quedaron' : 'Quedó'} como raíz suelta: no {many ? 'heredan' : 'hereda'}{' '}
            credenciales, reglas de precio ni marca. {many ? 'Movelos' : 'Movelo'} bajo{' '}
            {platformName} para que {many ? 'vendan' : 'venda'} a su nombre.
          </p>
          <ul className="mt-3 space-y-2">
            {nodes.map((node) => (
              <li
                key={node.id}
                className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--color-fg)]">
                    {node.name}
                  </span>
                  <NodeKindBadge node={node} />
                </span>
                <Button variant="secondary" size="sm" onClick={() => onMove(node)}>
                  <MoveRight aria-hidden="true" />
                  Mover bajo {platformName}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Las guías verticales de la sangría: una por nivel, como un árbol genealógico. */
function LevelGuides({ level }: { level: number }) {
  if (level === 0) return null;
  return (
    <span aria-hidden="true" className="flex shrink-0 self-stretch">
      {Array.from({ length: level }, (_, i) => (
        <span
          key={i}
          className="ml-1.5 w-2.5 border-l border-[var(--color-border-strong)] sm:ml-2 sm:w-4"
        />
      ))}
    </span>
  );
}

function NodeRow({
  node,
  level,
  parent,
  busy,
  childKinds,
  statusAction,
  branchAction,
  onCreateChild,
  onMove,
  onToggleStatus,
  onToggleBranch,
}: {
  node: AdminNetworkNode;
  level: number;
  parent: AdminNetworkNode | undefined;
  busy: boolean;
  childKinds: readonly CreatableKind[];
  statusAction: string | undefined;
  branchAction: string | undefined;
  onCreateChild: (kinds: readonly CreatableKind[]) => void;
  onMove: () => void;
  onToggleStatus: () => void;
  onToggleBranch: () => void;
}) {
  const where =
    node.tenantType === 'platform'
      ? 'Raíz de la red'
      : parent !== undefined
        ? `Cuelga de ${parent.name}`
        : node.parentTenantId === null
          ? 'Raíz suelta, fuera de la red'
          : `Cuelga de ${node.parentName ?? 'otro nodo'}`;
  const users = `${node.userCount} ${node.userCount === 1 ? 'usuario' : 'usuarios'}`;

  return (
    <li
      aria-busy={busy || undefined}
      className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-[var(--color-surface-muted)]/50 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-2">
        <LevelGuides level={level} />
        <div className="min-w-0 py-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-[var(--color-fg)]">{node.name}</span>
            <NodeKindBadge node={node} />
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                STATUS_STYLE[node.status] ?? STATUS_STYLE.archived,
              )}
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              {statusLabel(node.status)}
            </span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-fg-muted)]">
            <code className="font-mono text-[10px] text-[var(--color-fg-subtle)]">{node.slug}</code>
            <span aria-hidden="true">·</span>
            <span>{where}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{users}</span>
            {node.countryCode ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {node.countryCode} {node.defaultCurrency}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:shrink-0">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/tenants/${node.id}`}>
            <Plug aria-hidden="true" />
            Proveedores
            <span className="sr-only"> de {node.name}</span>
          </Link>
        </Button>
        <NodeActions
          node={node}
          busy={busy}
          childKinds={childKinds}
          statusAction={statusAction}
          branchAction={branchAction}
          onCreateChild={onCreateChild}
          onMove={onMove}
          onToggleStatus={onToggleStatus}
          onToggleBranch={onToggleBranch}
        />
      </div>
    </li>
  );
}

const ITEM =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium text-[var(--color-fg)] outline-none transition-colors data-[highlighted]:bg-[var(--color-surface-muted)]';

function NodeActions({
  node,
  busy,
  childKinds,
  statusAction,
  branchAction,
  onCreateChild,
  onMove,
  onToggleStatus,
  onToggleBranch,
}: {
  node: AdminNetworkNode;
  busy: boolean;
  childKinds: readonly CreatableKind[];
  statusAction: string | undefined;
  branchAction: string | undefined;
  onCreateChild: (kinds: readonly CreatableKind[]) => void;
  onMove: () => void;
  onToggleStatus: () => void;
  onToggleBranch: () => void;
}) {
  const movable = node.tenantType !== 'platform';
  const suspends = node.status === 'active';
  const triggerRef = useRef<HTMLButtonElement>(null);
  // La acción elegida corre cuando el menú ya cerró y devolvió el foco a su botón: si abriera su
  // diálogo antes, Radix le quitaba el foco al diálogo para devolvérselo al botón, y al cerrarlo
  // el foco no volvía a ningún lado.
  const pending = useRef<(() => void) | null>(null);
  const later = (action: () => void) => () => {
    pending.current = action;
  };
  if (childKinds.length === 0 && !movable && statusAction === undefined && !branchAction) {
    return null;
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={`Acciones de ${node.name}`}
          className="px-2.5"
        >
          {busy ? (
            <RefreshCw aria-hidden="true" className="animate-spin" />
          ) : (
            <MoreHorizontal aria-hidden="true" />
          )}
          <span className="sm:hidden">Acciones</span>
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
          {childKinds.length > 0 ? (
            <DropdownMenu.Item className={ITEM} onSelect={later(() => onCreateChild(childKinds))}>
              <Plus aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
              Agregar bajo este nodo
            </DropdownMenu.Item>
          ) : null}
          {movable ? (
            <DropdownMenu.Item className={ITEM} onSelect={later(onMove)}>
              <MoveRight aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
              Mover…
            </DropdownMenu.Item>
          ) : null}
          {branchAction !== undefined ? (
            <DropdownMenu.Item className={ITEM} onSelect={later(onToggleBranch)}>
              <Store aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
              {branchAction}
            </DropdownMenu.Item>
          ) : null}
          {statusAction !== undefined ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-border)]" />
              <DropdownMenu.Item
                className={cn(ITEM, suspends && 'text-[var(--color-danger)]')}
                onSelect={later(onToggleStatus)}
              >
                {suspends ? (
                  <CircleSlash aria-hidden="true" className="size-4" />
                ) : (
                  <CirclePlay aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
                )}
                {statusAction}
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
