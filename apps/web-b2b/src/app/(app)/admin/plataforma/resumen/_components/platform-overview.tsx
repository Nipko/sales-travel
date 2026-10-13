'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NodeKindBadge } from '../../../../../../components/network/node-kind';
import { Button } from '../../../../../../components/ui/button';
import { SegmentedControl } from '../../../../../../components/ui/segmented-control';
import { ToneBadge } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  OVERVIEW_PERIODS,
  attentionItems,
  overviewHref,
  periodCaption,
  providerName,
  salesVerticalLabel,
  updatedLabel,
  wholeUnits,
  type OverviewNetwork,
  type OverviewPeriodKey,
  type OverviewSales,
  type OverviewTrend,
  type PlatformOverview as Overview,
  type SalesByCurrency,
  type TopNode,
  type WalletExposure,
} from '../../../../../../lib/platform-overview';
import {
  loadOldestPlatformDeposit,
  loadPlatformOverview,
} from '../../../../../../lib/platform-overview-client';
import { statusLabel } from '../../../../../../lib/tenant-network';
import { currencyName, formatMinor } from '../../../../../../lib/wallets';
import { AttentionList } from './attention-list';
import { TrendStrip } from './trend-strip';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: Overview; readonly refreshing: boolean };

/** Cada cuánto se rehace "Actualizado hace…" sin volver a pedir nada. */
const CLOCK_TICK_MS = 30_000;

/**
 * Plataforma → Resumen: lo primero que ve el superadmin al abrir el panel. Arriba lo que espera a una
 * persona, de lo más grave a lo menos; después cómo van las ventas del período, por moneda (nunca se
 * suman monedas distintas); la red y la exposición de las carteras.
 *
 * El período vive en `?periodo=` para poder compartir el enlace; `tenantId` (de `?nodo=`) acota todo
 * al subárbol de un nodo.
 */
export function PlatformOverview({
  initialPeriod,
  tenantId,
}: {
  initialPeriod: OverviewPeriodKey;
  tenantId: string | null;
}) {
  const [period, setPeriod] = useState<OverviewPeriodKey>(initialPeriod);
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [oldestDeposit, setOldestDeposit] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  /** El último pedido: una respuesta vieja (otro período) no pisa la nueva. */
  const request = useRef(0);
  /** Hay un Resumen en pantalla: si falla una actualización, se conserva. */
  const showing = useRef(false);

  /**
   * Lee el Resumen. Con datos en pantalla los deja (atenuados) mientras llega lo nuevo. Si falla al
   * cambiar de período, muestra el error: lo que se ve sería de otro período. Si falla al actualizar
   * el mismo, conserva lo que hay y avisa.
   */
  const load = useCallback(
    async (next: OverviewPeriodKey, kind: 'switch' | 'refresh') => {
      const id = ++request.current;
      setView((v) => (v.status === 'ready' ? { ...v, refreshing: true } : { status: 'loading' }));
      const res = await loadPlatformOverview(next, tenantId);
      if (id !== request.current) return;
      setNow(Date.now());
      if (!res.ok) {
        if (kind === 'refresh' && showing.current) {
          toast.error(`No pudimos actualizar el resumen: ${res.message}`);
          setView((v) => (v.status === 'ready' ? { ...v, refreshing: false } : v));
        } else {
          showing.current = false;
          setView({ status: 'error', message: res.message });
        }
        return;
      }
      showing.current = true;
      setView({ status: 'ready', data: res.data, refreshing: false });
      if (res.data.attention.depositReports.platform === 0) {
        setOldestDeposit(null);
        return;
      }
      const oldest = await loadOldestPlatformDeposit(tenantId);
      if (id === request.current) setOldestDeposit(oldest);
    },
    [tenantId],
  );

  useEffect(() => {
    void load(period, 'switch');
  }, [period, load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  function changePeriod(next: OverviewPeriodKey) {
    if (next === period) return;
    setPeriod(next);
    window.history.replaceState(null, '', overviewHref(next, tenantId));
  }

  const ready = view.status === 'ready' ? view : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Resumen de la plataforma
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Cómo va la red y qué necesita tu atención.
          </p>
        </div>
        <div className="flex items-center gap-3 self-start">
          {ready !== null ? (
            <p className="text-xs text-[var(--color-fg-muted)]">
              <time dateTime={ready.data.generatedAt}>
                {updatedLabel(ready.data.generatedAt, now)}
              </time>
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={view.status === 'loading' || ready?.refreshing === true}
            onClick={() => void load(period, ready !== null ? 'refresh' : 'switch')}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(ready?.refreshing === true && 'animate-spin')}
            />
            Actualizar
          </Button>
        </div>
      </header>

      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          legend="Período del resumen"
          options={OVERVIEW_PERIODS}
          value={period}
          onChange={changePeriod}
        />
        {ready !== null ? (
          <p className="text-xs text-[var(--color-fg-muted)]">
            {periodCaption(ready.data.period)} · hora de Bogotá
          </p>
        ) : null}
      </div>

      {ready?.data.scope ? (
        <p className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg)]">
          <span>
            Solo <strong className="font-semibold">{ready.data.scope.name}</strong> y su red.
          </span>
          <Link
            href={overviewHref(period, null)}
            className="font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            Ver toda la red
          </Link>
        </p>
      ) : null}

      {view.status === 'loading' ? (
        <OverviewSkeleton />
      ) : view.status === 'error' ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="mx-auto max-w-md text-sm font-medium text-[var(--color-fg)]">
            {view.message}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load(period, 'switch')}>
              <RefreshCw aria-hidden="true" />
              Reintentar
            </Button>
            {tenantId !== null ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={overviewHref(period, null)}>Ver toda la red</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          aria-busy={view.refreshing}
          className={cn('transition-opacity', view.refreshing && 'opacity-60')}
        >
          <OverviewContent overview={view.data} oldestDeposit={oldestDeposit} now={now} />
        </div>
      )}
    </div>
  );
}

function OverviewSkeleton() {
  const block =
    'animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]';
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando el resumen…</span>
      <div className="space-y-3">
        <div className="h-4 w-40 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        <div className={cn(block, 'h-28')} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className={cn(block, 'h-44')} />
        ))}
      </div>
      <div className={cn(block, 'h-24')} />
    </div>
  );
}

function SectionHeader({ id, title, aside }: { id: string; title: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="text-sm font-semibold text-[var(--color-fg)]">
        {title}
      </h2>
      {aside !== undefined ? <p className="text-xs text-[var(--color-fg-muted)]">{aside}</p> : null}
    </div>
  );
}

/** Lo que se ve con el Resumen ya leído. Sin estado propio: se prueba renderizándolo. */
export function OverviewContent({
  overview,
  oldestDeposit,
  now,
}: {
  overview: Overview;
  oldestDeposit: string | null | undefined;
  now: number;
}) {
  const items = attentionItems(overview, oldestDeposit, now);
  return (
    <div className="space-y-10">
      <section aria-labelledby="resumen-atencion">
        <SectionHeader
          id="resumen-atencion"
          title="Requiere tu atención"
          aside={
            items.length === 0 ? undefined : items.length === 1 ? '1 tema' : `${items.length} temas`
          }
        />
        <AttentionList items={items} />
      </section>

      <SalesSection sales={overview.sales} trend={overview.trend} topNodes={overview.topNodes} />

      <NetworkSection network={overview.network} />

      <WalletsSection wallets={overview.wallets} />
    </div>
  );
}

function money(minor: number, currency: string, exponent: number | null): string {
  return formatMinor(minor, currency, exponent);
}

function salesCounts(row: SalesByCurrency): string {
  const parts = [
    row.confirmedCount === 1 ? '1 confirmada' : `${row.confirmedCount} confirmadas`,
    row.cancelledCount === 1 ? '1 cancelada' : `${row.cancelledCount} canceladas`,
  ];
  if (row.failedCount > 0) {
    parts.push(row.failedCount === 1 ? '1 fallida' : `${row.failedCount} fallidas`);
  }
  if (row.pendingCount > 0) parts.push(`${row.pendingCount} en curso`);
  return parts.join(' · ');
}

function SalesSection({
  sales,
  trend,
  topNodes,
}: {
  sales: OverviewSales;
  trend: OverviewTrend;
  topNodes: readonly TopNode[];
}) {
  const { created, accepted } = sales.quotations;
  return (
    <section aria-labelledby="resumen-ventas" className="space-y-4">
      <SectionHeader id="resumen-ventas" title="Ventas del período" />
      {sales.byCurrency.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
          No hubo reservas en este período.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sales.byCurrency.map((row) => (
            <CurrencyTile
              key={row.currency}
              row={row}
              verticals={sales.byVertical.filter((v) => v.currency === row.currency)}
              series={trend.series.find((s) => s.currency === row.currency)}
            />
          ))}
        </div>
      )}
      <div className="space-y-1 text-xs text-[var(--color-fg-muted)]">
        <p>Cada moneda va por separado: nunca sumamos montos de monedas distintas.</p>
        <p>
          Cotizaciones del período: {created === 1 ? '1 creada' : `${created} creadas`} ·{' '}
          {accepted === 1 ? '1 aceptada' : `${accepted} aceptadas`}.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ProvidersTable sales={sales} />
        <TopNodesTable nodes={topNodes} />
      </div>
    </section>
  );
}

function CurrencyTile({
  row,
  verticals,
  series,
}: {
  row: SalesByCurrency;
  verticals: OverviewSales['byVertical'];
  series: OverviewTrend['series'][number] | undefined;
}) {
  const name = currencyName(row.currency);
  return (
    <article
      aria-label={`Ventas confirmadas en ${row.currency}`}
      className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
    >
      <h3 className="text-xs font-medium text-[var(--color-fg-muted)]">
        Ventas confirmadas · {row.currency}
        {name !== row.currency ? <span className="sr-only"> ({name})</span> : null}
      </h3>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
        {money(row.confirmedAmountMinor, row.currency, row.exponent)}
      </p>
      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{salesCounts(row)}</p>
      {row.averageTicketMinor !== null ? (
        <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
          Ticket promedio{' '}
          {money(wholeUnits(row.averageTicketMinor, row.exponent), row.currency, row.exponent)}
        </p>
      ) : null}
      {verticals.length > 0 ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {verticals.map((v) => (
            <div key={v.vertical} className="contents">
              <dt className="text-[var(--color-fg-muted)]">{salesVerticalLabel(v.vertical)}</dt>
              <dd className="text-right tabular-nums text-[var(--color-fg)]">
                {money(v.amountMinor, v.currency, v.exponent)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {series !== undefined ? <TrendStrip series={series} /> : null}
    </article>
  );
}

const TH = 'pb-2 text-[11px] font-medium text-[var(--color-fg-muted)]';
const TD = 'border-t border-[var(--color-border)] py-2.5 align-top';

function TableCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5">
      <h3 id={id} className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function ProvidersTable({ sales }: { sales: OverviewSales }) {
  return (
    <TableCard id="resumen-proveedores" title="Por proveedor">
      {sales.byProvider.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">Sin reservas en este período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-labelledby="resumen-proveedores">
            <thead>
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Proveedor
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Confirmadas
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Monto
                </th>
              </tr>
            </thead>
            <tbody>
              {sales.byProvider.map((row) => {
                const extra = [
                  row.currency,
                  row.cancelledCount > 0
                    ? row.cancelledCount === 1
                      ? '1 cancelada'
                      : `${row.cancelledCount} canceladas`
                    : null,
                  row.failedCount > 0
                    ? row.failedCount === 1
                      ? '1 fallida'
                      : `${row.failedCount} fallidas`
                    : null,
                  row.pendingCount > 0 ? `${row.pendingCount} en curso` : null,
                ].filter((p): p is string => p !== null);
                return (
                  <tr key={`${row.provider}-${row.currency}`}>
                    <td className={cn(TD, 'pr-3')}>
                      <span className="font-medium text-[var(--color-fg)]">
                        {providerName(row.provider)}
                      </span>
                      <span className="block text-[11px] text-[var(--color-fg-muted)]">
                        {extra.join(' · ')}
                      </span>
                    </td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{row.confirmedCount}</td>
                    <td className={cn(TD, 'pl-3 text-right tabular-nums')}>
                      {money(row.confirmedAmountMinor, row.currency, row.exponent)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </TableCard>
  );
}

function TopNodesTable({ nodes }: { nodes: readonly TopNode[] }) {
  return (
    <TableCard id="resumen-nodos" title="Nodos con más ventas">
      {nodes.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">
          Ningún nodo confirmó reservas en este período.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-labelledby="resumen-nodos">
            <thead>
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Nodo
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Confirmadas
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Vendido
                </th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.tenantId}>
                  <td className={cn(TD, 'pr-3')}>
                    <Link
                      href={`/admin/tenants/${node.tenantId}`}
                      className="font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    >
                      {node.name}
                    </Link>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {node.tenantType !== '' ? <NodeKindBadge node={node} /> : null}
                      {node.status !== 'active' ? (
                        <ToneBadge tone="danger">{statusLabel(node.status)}</ToneBadge>
                      ) : null}
                    </span>
                  </td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{node.confirmedCount}</td>
                  <td className={cn(TD, 'pl-3 text-right tabular-nums')}>
                    {node.amounts.map((a) => (
                      <span key={a.currency} className="block">
                        {money(a.amountMinor, a.currency, a.exponent)}
                        <span className="ml-1 text-[10px] text-[var(--color-fg-muted)]">
                          {a.currency}
                        </span>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TableCard>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-4 sm:p-5">
      <dt className="text-xs text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight text-[var(--color-fg)]">
        {value.toLocaleString('es-CO')}
      </dd>
      {hint !== undefined ? (
        <dd className="mt-0.5 text-[11px] leading-snug text-[var(--color-fg-muted)]">{hint}</dd>
      ) : null}
    </div>
  );
}

function NetworkSection({ network }: { network: OverviewNetwork }) {
  const { nodes, users } = network;
  const kinds = [
    nodes.consolidators === 1 ? '1 consolidador' : `${nodes.consolidators} consolidadores`,
    nodes.agencies === 1 ? '1 agencia' : `${nodes.agencies} agencias`,
    nodes.branches === 1 ? '1 sucursal' : `${nodes.branches} sucursales`,
    nodes.subagencies === 1 ? '1 sub-agencia' : `${nodes.subagencies} sub-agencias`,
  ];
  return (
    <section aria-labelledby="resumen-red" className="space-y-3">
      <SectionHeader id="resumen-red" title="Red" />
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-border)] shadow-[var(--shadow-xs)] lg:grid-cols-4">
        <Stat
          label="Nodos activos"
          value={nodes.active}
          hint={`de ${nodes.total}${nodes.suspended > 0 ? ` · ${nodes.suspended} suspendidos` : ''}`}
        />
        <Stat label="Altas en el período" value={nodes.created} />
        <Stat
          label="Usuarios activos"
          value={users.active}
          hint={`${users.loggedInPeriod} ingresaron en el período`}
        />
        <Stat
          label="Conectados ahora"
          value={network.liveSessions}
          hint="Sesiones abiertas en el panel"
        />
      </dl>
      <p className="text-xs text-[var(--color-fg-muted)]">En la red: {kinds.join(' · ')}.</p>
    </section>
  );
}

function WalletsSection({ wallets }: { wallets: readonly WalletExposure[] }) {
  return (
    <section aria-labelledby="resumen-carteras" className="space-y-3">
      <SectionHeader id="resumen-carteras" title="Carteras de la red" aside="Saldos de hoy" />
      {wallets.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">Ningún nodo tiene cartera todavía.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {wallets.map((w) => {
            const m = (minor: number) => money(minor, w.currency, w.exponent);
            const flags = [
              w.overlimit > 0 ? `${w.overlimit} sobre el cupo` : null,
              w.suspended > 0
                ? w.suspended === 1
                  ? '1 suspendida'
                  : `${w.suspended} suspendidas`
                : null,
            ].filter((f): f is string => f !== null);
            return (
              <article
                key={w.currency}
                aria-label={`Carteras en ${w.currency}`}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[var(--color-fg)]">{w.currency}</h3>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {w.wallets === 1 ? '1 cartera' : `${w.wallets} carteras`}
                    {flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}
                  </p>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-[var(--color-fg-muted)]">Deuda de la red</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
                      {m(w.debtMinor)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-fg-muted)]">Cupo otorgado</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
                      {m(w.creditLimitMinor)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-fg-muted)]">Saldo a favor</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
                      {m(w.fundsMinor)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-fg-muted)]">
                  Lo que financia Planetour: cupo {m(w.platformCreditLimitMinor)} · deuda{' '}
                  {m(w.platformDebtMinor)}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
