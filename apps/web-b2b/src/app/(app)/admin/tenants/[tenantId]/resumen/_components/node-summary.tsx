'use client';

import { ArrowLeft, ArrowRight, Inbox, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NodeKindBadge } from '../../../../../../../components/network/node-kind';
import { Button } from '../../../../../../../components/ui/button';
import { ToneBadge } from '../../../../../../../components/wallets/wallet-ui';
import { eventLabel } from '../../../../../../../lib/audit-format';
import { cn } from '../../../../../../../lib/cn';
import {
  activityActorLabel,
  activityNodeLabel,
  formatActivityDate,
  type ActivityEventView,
} from '../../../../../../../lib/platform-audit';
import { loadPlatformActivity } from '../../../../../../../lib/platform-audit-client';
import {
  SHARED_SEATS_LABEL,
  nodeDepositsHref,
  seatsCell,
} from '../../../../../../../lib/platform-node-stats';
import {
  NODE_ACTIVITY_DAYS,
  NODE_ACTIVITY_LIMIT,
  NODE_SUMMARY_EMPTY,
  attentionLines,
  createdLabel,
  descendantsLabel,
  heldIn,
  isQuietNode,
  nodeActivityFilters,
  nodeActivityHref,
  nodeOrdersHref,
  nodeTabHref,
  plural,
  providersCount,
  salesCountsLabel,
  salesTiles,
  withNetworkLabel,
  type NodeSummary as Summary,
  type SalesTile,
} from '../../../../../../../lib/platform-node-summary';
import { salesVerticalLabel, updatedLabel } from '../../../../../../../lib/platform-overview';
import type { TenantProviders } from '../../../../../../../lib/provider-enablement';
import { loadTenantProviders } from '../../../../../../../lib/provider-enablement-client';
import { loadNodeSummary } from '../../../../../../../lib/tenant-admin-client';
import { teamHrefFor } from '../../../../../../../lib/tenant-admin-team';
import { statusLabel } from '../../../../../../../lib/tenant-network';
import { loadFinancedWallets } from '../../../../../../../lib/wallet-client';
import {
  currencyName,
  formatMinor,
  walletStatus,
  type FinancedWallets,
  type Tone,
} from '../../../../../../../lib/wallets';
import { NodeSectionNav } from '../../_components/node-section-nav';

/** Una sección de la pestaña: cada una se lee por su lado y falla por su lado. */
export type Section<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: T };

export interface NodeSummaryState {
  /** El nodo, sus números, sus ventas y lo que espera (`GET /admin/tenants/:id/summary`). */
  readonly summary: Section<Summary>;
  readonly wallets: Section<FinancedWallets>;
  readonly providers: Section<TenantProviders>;
  /** Los últimos eventos del nodo y su red (Plataforma → Actividad). */
  readonly activity: Section<readonly ActivityEventView[]>;
}

export type SummarySection = keyof NodeSummaryState;

const LOADING: NodeSummaryState = {
  summary: { status: 'loading' },
  wallets: { status: 'loading' },
  providers: { status: 'loading' },
  activity: { status: 'loading' },
};

const SECTIONS: readonly SummarySection[] = ['summary', 'wallets', 'providers', 'activity'];

/** Cada cuánto se rehace "Actualizado hace…" sin volver a pedir nada. */
const CLOCK_TICK_MS = 30_000;

type Res<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string };

/**
 * Lo que queda de una sección después de leerla. Al actualizar (`keep`), si falla se conserva lo que
 * ya se veía: el aviso lo da quien actualiza.
 */
function settle<T>(res: Res<T>, prev: Section<T>, keep: boolean): Section<T> {
  if (res.ok) return { status: 'ready', data: res.data };
  return keep && prev.status === 'ready' ? prev : { status: 'error', message: res.message };
}

/**
 * Gestión de Agencias → nodo → Resumen: en una pantalla, cómo va el nodo. Sus ventas de 30 días por
 * moneda (él y con su red), lo que espera a una persona, sus puestos, personas y sesiones, sus
 * carteras, sus proveedores y lo último que pasó, con el camino a cada pestaña.
 *
 * Sólo superadmin: el layout de /admin/tenants lo exige y el API lo vuelve a decidir en cada lectura.
 * Cada sección se lee aparte: si una falla, las otras se ven.
 */
export function NodeSummary({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<NodeSummaryState>(LOADING);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** El último pedido de cada sección: una respuesta vieja no pisa una nueva. */
  const requests = useRef<Record<SummarySection, number>>({
    summary: 0,
    wallets: 0,
    providers: 0,
    activity: 0,
  });

  /** Lee una sección. `keep`: al actualizar, si falla, conserva lo que se veía. `true` si leyó. */
  const read = useCallback(
    async (section: SummarySection, keep: boolean): Promise<boolean> => {
      const id = ++requests.current[section];
      const live = () => id === requests.current[section];
      if (!keep) setState((s) => ({ ...s, [section]: { status: 'loading' } }));
      switch (section) {
        case 'summary': {
          const res = await loadNodeSummary(tenantId);
          if (live()) setState((s) => ({ ...s, summary: settle(res, s.summary, keep) }));
          return res.ok;
        }
        case 'wallets': {
          const res = await loadFinancedWallets(tenantId);
          if (live()) setState((s) => ({ ...s, wallets: settle(res, s.wallets, keep) }));
          return res.ok;
        }
        case 'providers': {
          const res = await loadTenantProviders(tenantId);
          if (live()) setState((s) => ({ ...s, providers: settle(res, s.providers, keep) }));
          return res.ok;
        }
        case 'activity': {
          const at = new Date();
          const res = await loadPlatformActivity(
            nodeActivityFilters(tenantId, at),
            at,
            null,
            NODE_ACTIVITY_LIMIT,
          );
          const events: Res<readonly ActivityEventView[]> = res.ok
            ? { ok: true, data: res.data.events.slice(0, NODE_ACTIVITY_LIMIT) }
            : res;
          if (live()) setState((s) => ({ ...s, activity: settle(events, s.activity, keep) }));
          return res.ok;
        }
      }
    },
    [tenantId],
  );

  const refresh = useCallback(
    async (keep: boolean) => {
      if (keep) setRefreshing(true);
      const results = await Promise.all(SECTIONS.map((section) => read(section, keep)));
      setNow(Date.now());
      if (keep) {
        setRefreshing(false);
        if (results.some((ok) => !ok)) {
          toast.error('No pudimos actualizar todo el resumen. Mostramos lo último que leímos.');
        }
      }
    },
    [read],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const retry = useCallback(
    (section: SummarySection) => {
      void read(section, false).then(() => setNow(Date.now()));
    },
    [read],
  );

  const summary = state.summary.status === 'ready' ? state.summary.data : null;
  const busy = refreshing || SECTIONS.some((section) => state[section].status === 'loading');

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <Link
        href="/admin/tenants"
        className="mb-4 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg-muted)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Agencias
      </Link>

      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <NodeSummaryHeading summary={summary} />
        <div className="flex items-center gap-3 self-start">
          {summary !== null && summary.generatedAt !== '' ? (
            <p className="text-xs text-[var(--color-fg-muted)]">
              <time dateTime={summary.generatedAt}>{updatedLabel(summary.generatedAt, now)}</time>
            </p>
          ) : null}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh(true)}>
            <RefreshCw aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
            Actualizar
          </Button>
        </div>
      </header>

      <NodeSectionNav tenantId={tenantId} current="summary" />

      <div aria-busy={refreshing || undefined} className={cn(refreshing && 'opacity-60')}>
        <NodeSummaryContent tenantId={tenantId} state={state} now={now} onRetry={retry} />
      </div>
    </div>
  );
}

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  active: 'success',
  suspended: 'danger',
};

/** El nombre del nodo, su tipo y estado, y de quién cuelga. Mientras carga, "Agencia". */
export function NodeSummaryHeading({ summary }: { summary: Summary | null }) {
  if (summary === null) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Agencia</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">Cómo va el nodo y qué necesita.</p>
      </div>
    );
  }
  const { tenant, subtree } = summary;
  const created = createdLabel(tenant.createdAt);
  const below = descendantsLabel(subtree);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)] [overflow-wrap:anywhere]">
          {tenant.name}
        </h1>
        <NodeKindBadge node={tenant} />
        <ToneBadge tone={STATUS_TONE[tenant.status] ?? 'neutral'}>
          {statusLabel(tenant.status)}
        </ToneBadge>
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-fg-muted)]">
        {tenant.slug !== '' ? (
          <>
            <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px]">
              {tenant.slug}
            </code>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        {tenant.parent !== null ? (
          <span>
            Cuelga de{' '}
            <Link
              href={nodeTabHref(tenant.parent.id, 'summary')}
              className="rounded font-medium text-[var(--color-fg)] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              {tenant.parent.name}
            </Link>
          </span>
        ) : (
          <span>{tenant.tenantType === 'platform' ? 'Raíz de la red' : 'Fuera de la red'}</span>
        )}
        {below !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{below}</span>
          </>
        ) : null}
        {tenant.countryCode !== '' ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {tenant.countryCode} {tenant.defaultCurrency}
            </span>
          </>
        ) : null}
        {created !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{created}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

// ───────────────────────────── El contenido ─────────────────────────────

/**
 * Lo que se ve debajo de las pestañas. Sin estado propio: se prueba renderizándolo con cada sección
 * cargando, leída o fallida.
 */
export function NodeSummaryContent({
  tenantId,
  state,
  now,
  onRetry,
}: {
  tenantId: string;
  state: NodeSummaryState;
  now: number;
  onRetry?: (section: SummarySection) => void;
}) {
  const summary = state.summary.status === 'ready' ? state.summary.data : null;
  const events = state.activity.status === 'ready' ? state.activity.data : null;
  const quiet = summary !== null && isQuietNode(summary, events === null ? null : events.length);

  return (
    <div className="space-y-10">
      {quiet ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-8 text-center">
          <Inbox aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">{NODE_SUMMARY_EMPTY}</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
            Cuando reserve, aquí verás sus ventas, sus reservas y lo último que pasó.
          </p>
        </div>
      ) : null}

      {state.summary.status === 'loading' ? (
        <SummarySkeleton />
      ) : state.summary.status === 'error' ? (
        <SectionError
          title="No pudimos leer el resumen del nodo."
          message={state.summary.message}
          onRetry={onRetry === undefined ? undefined : () => onRetry('summary')}
        />
      ) : (
        <>
          {quiet ? null : (
            <SalesSection
              summary={state.summary.data}
              onRetry={onRetry === undefined ? undefined : () => onRetry('summary')}
            />
          )}
          <OperationSection tenantId={tenantId} summary={state.summary.data} />
        </>
      )}

      <WalletsSection
        tenantId={tenantId}
        wallets={state.wallets}
        held={summary?.own?.held ?? []}
        onRetry={onRetry === undefined ? undefined : () => onRetry('wallets')}
      />

      <ProvidersSection
        tenantId={tenantId}
        providers={state.providers}
        onRetry={onRetry === undefined ? undefined : () => onRetry('providers')}
      />

      {quiet ? null : (
        <ActivitySection
          tenantId={tenantId}
          activity={state.activity}
          now={now}
          onRetry={onRetry === undefined ? undefined : () => onRetry('activity')}
        />
      )}
    </div>
  );
}

const CARD =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5';

const LINK =
  'inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

function SectionHeader({ id, title, aside }: { id: string; title: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="text-sm font-semibold text-[var(--color-fg)]">
        {title}
      </h2>
      {aside !== undefined ? (
        <div className="text-xs text-[var(--color-fg-muted)]">{aside}</div>
      ) : null}
    </div>
  );
}

function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={LINK}>
      {children}
      <ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/** Una sección que no se pudo leer: qué faltó, por qué y cómo reintentarlo. El resto se ve. */
function SectionError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-5 text-center"
    >
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {message !== undefined && message !== '' ? (
        <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">{message}</p>
      ) : null}
      {onRetry !== undefined ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}

function Skeleton({ className, label }: { className: string; label: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div
        className={cn(
          'animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]',
          className,
        )}
      />
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-36" label="Cargando el resumen del nodo…" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
          />
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Ventas ─────────────────────────────

function SalesSection({ summary, onRetry }: { summary: Summary; onRetry?: () => void }) {
  const { sales, subtree, tenant } = summary;
  const hasNetwork = subtree !== null && subtree.descendants > 0;
  const days = sales?.days ?? 30;
  return (
    <section aria-labelledby="nodo-ventas">
      <SectionHeader
        id="nodo-ventas"
        title={`Ventas · últimos ${days} días`}
        aside="Confirmadas o emitidas. Cada moneda por su lado."
      />
      {sales === null ? (
        <SectionError title="No pudimos leer las ventas del nodo." onRetry={onRetry} />
      ) : sales.subtree.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
          {hasNetwork
            ? `Ni el nodo ni su red reservaron en los últimos ${days} días.`
            : `Sin reservas en los últimos ${days} días.`}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {salesTiles(sales, tenant.defaultCurrency).map((tile) => (
            <SalesCurrencyTile
              key={tile.currency}
              tile={tile}
              days={days}
              withNetwork={hasNetwork}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SalesCurrencyTile({
  tile,
  days,
  withNetwork,
}: {
  tile: SalesTile;
  days: number;
  withNetwork: boolean;
}) {
  const { currency, exponent, own, subtree } = tile;
  const name = currencyName(currency);
  const money = (minor: number) => formatMinor(minor, currency, exponent);
  return (
    <article
      aria-label={`Ventas de ${days} días en ${currency}`}
      className={cn(CARD, 'flex flex-col')}
    >
      <h3 className="text-xs font-medium text-[var(--color-fg-muted)]">
        Ventas {days} días · {currency}
        {name !== currency ? <span className="sr-only"> ({name})</span> : null}
      </h3>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-[var(--color-fg)]">
        {money(own?.confirmedAmountMinor ?? 0)}
      </p>
      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{salesCountsLabel(own)}</p>
      {own !== null && own.byVertical.length > 0 ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {own.byVertical.map((v) => (
            <div key={v.vertical} className="contents">
              <dt className="text-[var(--color-fg-muted)]">{salesVerticalLabel(v.vertical)}</dt>
              <dd className="text-right tabular-nums text-[var(--color-fg)]">
                {money(v.confirmedAmountMinor)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {withNetwork ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <p className="text-xs text-[var(--color-fg-muted)]">Con su red</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--color-fg)]">
            {money(subtree?.confirmedAmountMinor ?? 0)}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{salesCountsLabel(subtree)}</p>
        </div>
      ) : null}
    </article>
  );
}

// ───────────────────────────── Operación ─────────────────────────────

function Tile({
  label,
  value,
  srValue,
  hints = [],
  tone = 'neutral',
  action,
}: {
  label: string;
  value: ReactNode;
  /** El valor para un lector de pantalla, si el visible no se entiende solo ("3/5"). */
  srValue?: string;
  hints?: readonly (string | undefined | null)[];
  tone?: Extract<Tone, 'neutral' | 'warning'>;
  action?: { readonly href: string; readonly label: string };
}) {
  const lines = hints.filter((h): h is string => typeof h === 'string' && h !== '');
  return (
    <div data-tone={tone} className="flex flex-col bg-[var(--color-surface)] p-4 sm:p-5">
      <dt className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
        {/* El punto ámbar marca lo que espera; el número y las líneas de abajo lo dicen escrito. */}
        {tone === 'warning' ? (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--color-warning)]" />
        ) : null}
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-[var(--color-fg)]">
        {srValue !== undefined ? (
          <>
            <span aria-hidden="true">{value}</span>
            <span className="sr-only">{srValue}</span>
          </>
        ) : (
          value
        )}
      </dd>
      {lines.map((line) => (
        <dd key={line} className="mt-0.5 text-[11px] leading-snug text-[var(--color-fg-muted)]">
          {line}
        </dd>
      ))}
      {action !== undefined ? (
        <dd className="mt-auto pt-2">
          <SectionLink href={action.href}>{action.label}</SectionLink>
        </dd>
      ) : null}
    </div>
  );
}

const TILE_GRID =
  'grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-border)] shadow-[var(--shadow-xs)] min-[420px]:grid-cols-2 lg:grid-cols-3';

function OperationSection({ tenantId, summary }: { tenantId: string; summary: Summary }) {
  const { own, subtree, attention } = summary;
  const seats = own === null ? null : seatsCell(own);
  const lines = attention === null ? [] : attentionLines(attention);
  const deposits = own?.pendingDepositReports ?? 0;
  const networkDeposits = subtree?.pendingDepositReports ?? deposits;
  const invitations = own?.pendingInvitations ?? 0;
  return (
    <section aria-labelledby="nodo-operacion" className="space-y-3">
      <SectionHeader id="nodo-operacion" title="En este momento" />
      <dl className={TILE_GRID}>
        {attention === null ? (
          <Tile label="Requieren atención" value="—" hints={['No pudimos leerlo.']} />
        ) : (
          <Tile
            label="Requieren atención"
            value={attention.total.toLocaleString('es-CO')}
            tone={attention.total > 0 ? 'warning' : 'neutral'}
            hints={
              attention.total === 0
                ? ['Ninguna reserva de su red espera a una persona.']
                : lines.slice(0, 3).map((l) => `${l.label}: ${l.count.toLocaleString('es-CO')}`)
            }
            action={
              attention.total > 0
                ? { href: nodeOrdersHref(tenantId, 'attention'), label: 'Revisar reservas' }
                : undefined
            }
          />
        )}
        {own === null ? (
          <Tile label="Reservas vigentes" value="—" hints={['No pudimos leerlo.']} />
        ) : (
          <Tile
            label="Reservas vigentes"
            value={own.openOrders.toLocaleString('es-CO')}
            hints={[
              'Pendientes, confirmadas o emitidas',
              withNetworkLabel(subtree, subtree?.openOrders ?? 0),
            ]}
            action={
              (subtree?.openOrders ?? own.openOrders) > 0
                ? { href: nodeOrdersHref(tenantId, 'open'), label: 'Ver reservas' }
                : undefined
            }
          />
        )}
        {own === null ? (
          <Tile label="Depósitos por aprobar" value="—" hints={['No pudimos leerlo.']} />
        ) : (
          <Tile
            label="Depósitos por aprobar"
            value={deposits.toLocaleString('es-CO')}
            tone={deposits > 0 ? 'warning' : 'neutral'}
            hints={[withNetworkLabel(subtree, networkDeposits)]}
            action={
              networkDeposits > 0
                ? { href: nodeDepositsHref(tenantId), label: 'Revisar depósitos' }
                : undefined
            }
          />
        )}
        {own === null ? (
          <Tile label="Puestos" value="—" hints={['No pudimos leerlo.']} />
        ) : seats === null ? (
          <Tile
            label="Puestos"
            value="—"
            srValue={SHARED_SEATS_LABEL}
            hints={[SHARED_SEATS_LABEL]}
            action={{ href: nodeTabHref(tenantId, 'seats'), label: 'Puestos y sesión' }}
          />
        ) : (
          <Tile
            label="Puestos"
            value={seats.text}
            srValue={seats.label}
            tone={seats.tone}
            hints={[seats.note === null ? 'En uso de su cupo' : `En uso, ${seats.note}`]}
            action={{ href: nodeTabHref(tenantId, 'seats'), label: 'Puestos y sesión' }}
          />
        )}
        {own === null ? (
          <Tile label="Personas activas" value="—" hints={['No pudimos leerlo.']} />
        ) : (
          <Tile
            label="Personas activas"
            value={own.activeUsers.toLocaleString('es-CO')}
            hints={[
              withNetworkLabel(subtree, subtree?.activeUsers ?? 0),
              invitations > 0
                ? plural(invitations, 'invitación sin aceptar', 'invitaciones sin aceptar')
                : null,
            ]}
            action={{ href: teamHrefFor(tenantId), label: 'Ver usuarios' }}
          />
        )}
        {own === null ? (
          <Tile label="Conectadas ahora" value="—" hints={['No pudimos leerlo.']} />
        ) : (
          <Tile
            label="Conectadas ahora"
            value={own.liveSessions.toLocaleString('es-CO')}
            hints={[
              'Sesiones abiertas en el panel',
              withNetworkLabel(subtree, subtree?.liveSessions ?? 0),
            ]}
          />
        )}
      </dl>
    </section>
  );
}

// ───────────────────────────── Carteras ─────────────────────────────

function WalletsSection({
  tenantId,
  wallets,
  held,
  onRetry,
}: {
  tenantId: string;
  wallets: Section<FinancedWallets>;
  held: Parameters<typeof heldIn>[0];
  onRetry?: () => void;
}) {
  const href = nodeTabHref(tenantId, 'wallets');
  return (
    <section aria-labelledby="nodo-carteras">
      <SectionHeader
        id="nodo-carteras"
        title="Carteras"
        aside={<SectionLink href={href}>Gestionar carteras</SectionLink>}
      />
      {wallets.status === 'loading' ? (
        <Skeleton className="h-28" label="Cargando las carteras…" />
      ) : wallets.status === 'error' ? (
        <SectionError
          title="No pudimos leer las carteras."
          message={wallets.message}
          onRetry={onRetry}
        />
      ) : wallets.data.portfolios.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
          Este nodo no tiene carteras habilitadas.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {wallets.data.portfolios.map((w) => {
            const money = (minor: number) => formatMinor(minor, w.currency, w.exponent);
            const status = walletStatus(w.status);
            const retained = heldIn(held, w.currency);
            return (
              <article key={w.id} aria-label={`Cartera en ${w.currency}`} className={CARD}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[var(--color-fg)]">{w.currency}</h3>
                  <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="col-span-2">
                    <dt className="text-[var(--color-fg-muted)]">Disponible para reservar</dt>
                    <dd className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--color-fg)]">
                      {money(w.availableMinor)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-fg-muted)]">Saldo</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
                      {money(w.balanceMinor)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-fg-muted)]">Cupo</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
                      {money(w.creditLimitMinor)}
                    </dd>
                  </div>
                  {retained !== null ? (
                    <div className="col-span-2">
                      <dt className="text-[var(--color-fg-muted)]">
                        Retenido por reservas en curso
                      </dt>
                      <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
                        {formatMinor(retained.amountMinor, retained.currency, retained.exponent)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── Proveedores ─────────────────────────────

function ProvidersSection({
  tenantId,
  providers,
  onRetry,
}: {
  tenantId: string;
  providers: Section<TenantProviders>;
  onRetry?: () => void;
}) {
  return (
    <section aria-labelledby="nodo-proveedores">
      <SectionHeader
        id="nodo-proveedores"
        title="Proveedores"
        aside={<SectionLink href={nodeTabHref(tenantId, 'providers')}>Ver proveedores</SectionLink>}
      />
      {providers.status === 'loading' ? (
        <Skeleton className="h-16" label="Cargando los proveedores…" />
      ) : providers.status === 'error' ? (
        <SectionError
          title="No pudimos leer los proveedores."
          message={providers.message}
          onRetry={onRetry}
        />
      ) : (
        <ProvidersLine view={providers.data} />
      )}
    </section>
  );
}

function ProvidersLine({ view }: { view: TenantProviders }) {
  const counted = providersCount(view);
  if (counted.total === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        La plataforma no tiene proveedores registrados.
      </p>
    );
  }
  return (
    <div className={cn(CARD, 'space-y-2')}>
      <p className="text-sm text-[var(--color-fg)]">
        <span className="font-semibold tabular-nums">
          {counted.enabled.toLocaleString('es-CO')} de {counted.total.toLocaleString('es-CO')}
        </span>{' '}
        {counted.total === 1 ? 'proveedor habilitado' : 'proveedores habilitados'} para este nodo.
      </p>
      {counted.killSwitched.length > 0 ? (
        <ul className="space-y-1">
          {counted.killSwitched.map((p) => (
            <li key={p.name} className="flex flex-wrap items-center gap-2 text-xs">
              <ToneBadge tone="danger">Apagado de emergencia</ToneBadge>
              <span className="text-[var(--color-fg)]">
                {p.name}
                {p.salesOnly
                  ? ': sólo las ventas, en toda la plataforma'
                  : ', en toda la plataforma'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Actividad ─────────────────────────────

function ActivitySection({
  tenantId,
  activity,
  now,
  onRetry,
}: {
  tenantId: string;
  activity: Section<readonly ActivityEventView[]>;
  now: number;
  onRetry?: () => void;
}) {
  return (
    <section aria-labelledby="nodo-actividad">
      <SectionHeader
        id="nodo-actividad"
        title="Actividad reciente"
        aside={
          <SectionLink href={nodeActivityHref(tenantId, new Date(now))}>
            Ver toda la actividad
          </SectionLink>
        }
      />
      {activity.status === 'loading' ? (
        <Skeleton className="h-40" label="Cargando la actividad…" />
      ) : activity.status === 'error' ? (
        <SectionError
          title="No pudimos leer la actividad."
          message={activity.message}
          onRetry={onRetry}
        />
      ) : activity.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
          Sin actividad en los últimos {NODE_ACTIVITY_DAYS} días.
        </p>
      ) : (
        <ol
          aria-label={`Los últimos ${activity.data.length} eventos del nodo y su red`}
          className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
        >
          {activity.data.map((event) => (
            <ActivityItem key={event.id} event={event} tenantId={tenantId} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityItem({ event, tenantId }: { event: ActivityEventView; tenantId: string }) {
  const label = eventLabel(event.eventType, event.payload);
  const elsewhere = event.tenantId !== null && event.tenantId.toLowerCase() !== tenantId;
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p
          className={cn(
            'text-sm font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]',
            label.raw && 'font-mono text-xs',
          )}
        >
          {label.text}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--color-fg-muted)]">
          <span className="[overflow-wrap:anywhere]">{activityActorLabel(event)}</span>
          {elsewhere ? (
            <>
              <span aria-hidden="true">·</span>
              <span>en {activityNodeLabel(event)}</span>
            </>
          ) : null}
        </p>
      </div>
      <time
        dateTime={event.occurredAt}
        className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-[var(--color-fg-muted)]"
      >
        {formatActivityDate(event.occurredAt)}
      </time>
    </li>
  );
}
