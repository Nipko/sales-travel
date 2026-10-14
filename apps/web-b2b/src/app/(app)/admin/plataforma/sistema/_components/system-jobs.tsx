'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { ToneBadge, ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  airportsLine,
  catalogBadge,
  catalogLine,
  catalogTitle,
  lastRunLabel,
  providerLabel,
  reconciliationStatus,
  runnerLabel,
  sweepStatus,
  systemUpdatedLabel,
  type CatalogSync,
  type JobSchedule,
  type PostSaleSweep,
  type ReconciliationProvider,
  type SystemJobs as Jobs,
} from '../../../../../../lib/platform-system';
import { loadSystemJobs } from '../../../../../../lib/platform-system-client';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly data: Jobs;
      readonly refreshing: boolean;
      /** El reloj de este navegador cuando llegó `data`. */
      readonly loadedAt: number;
    };

/** Cada cuánto se rehacen los "hace…" sin volver a pedir nada. */
const CLOCK_TICK_MS = 30_000;

/**
 * Sistema › Procesos: el barrido de post-venta, la conciliación diaria, los catálogos, los
 * aeropuertos y cuándo corre cada cosa. Se lee al abrir y con Actualizar; si falla una actualización,
 * se conserva lo que había y se avisa.
 */
export function SystemJobs() {
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  /** Hay datos en pantalla: si falla una actualización, se conservan. */
  const showing = useRef(false);

  const load = useCallback(async () => {
    setView((v) => (v.status === 'ready' ? { ...v, refreshing: true } : { status: 'loading' }));
    const res = await loadSystemJobs();
    const loadedAt = Date.now();
    setNow(loadedAt);
    if (!res.ok) {
      if (showing.current) {
        toast.error(`No pudimos actualizar los procesos: ${res.message}`);
        setView((v) => (v.status === 'ready' ? { ...v, refreshing: false } : v));
      } else {
        setView({ status: 'error', message: res.message });
      }
      return;
    }
    showing.current = true;
    setView({ status: 'ready', data: res.data, refreshing: false, loadedAt });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const ready = view.status === 'ready' ? view : null;
  // Los "hace…" y el atraso se miden con el reloj del api (`generatedAt`) más lo que pasó desde que
  // llegó la lectura: un navegador con la hora corrida no muestra un barrido detenido que corre.
  const serverNow =
    ready === null ? now : Date.parse(ready.data.generatedAt) + Math.max(0, now - ready.loadedAt);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {ready !== null ? (
          <p className="text-xs text-[var(--color-fg-muted)]">
            <time dateTime={ready.data.generatedAt}>
              {systemUpdatedLabel(ready.data.generatedAt, serverNow)}
            </time>
          </p>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          disabled={view.status === 'loading' || ready?.refreshing === true}
          onClick={() => void load()}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(ready?.refreshing === true && 'animate-spin')}
          />
          Actualizar
        </Button>
      </div>

      {view.status === 'loading' ? (
        <JobsSkeleton />
      ) : view.status === 'error' ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="mx-auto max-w-md text-sm font-medium text-[var(--color-fg)]">
            {view.message}
          </p>
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              Reintentar
            </Button>
          </div>
        </div>
      ) : (
        <div
          aria-busy={view.refreshing}
          className={cn('transition-opacity', view.refreshing && 'opacity-60')}
        >
          <SystemJobsContent jobs={view.data} now={serverNow} />
        </div>
      )}
    </div>
  );
}

function JobsSkeleton() {
  const block =
    'animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]';
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando los procesos…</span>
      <div className={cn(block, 'h-28')} />
      <div className={cn(block, 'h-40')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={cn(block, 'h-24')} />
        <div className={cn(block, 'h-24')} />
      </div>
    </div>
  );
}

const CARD =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5';

function Card({
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
    <section aria-labelledby={id} className={CARD}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-sm font-semibold text-[var(--color-fg)]">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Lo que se ve con los procesos ya leídos. Sin estado propio: se prueba renderizándolo. */
export function SystemJobsContent({ jobs, now }: { jobs: Jobs; now: number }) {
  return (
    <div className="space-y-4">
      <SweepCard sweep={jobs.postSaleSweep} now={now} />
      <ReconciliationCard
        sinceDays={jobs.reconciliation.sinceDays}
        providers={jobs.reconciliation.byProvider}
        now={now}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {jobs.catalogs.length === 0 ? (
          <Card id="sistema-catalogo" title="Catálogo de hoteles">
            <p className="text-sm text-[var(--color-fg-muted)]">
              Ningún proveedor sincroniza su catálogo por ciudad todavía.
            </p>
          </Card>
        ) : (
          jobs.catalogs.map((catalog) => (
            <CatalogCard key={catalog.providerCode} catalog={catalog} now={now} />
          ))
        )}
        <Card id="sistema-aeropuertos" title="Aeropuertos">
          {jobs.airports.count === 0 ? (
            <ToneNotice tone="warning">{airportsLine(jobs.airports)}</ToneNotice>
          ) : (
            <p className="text-sm text-[var(--color-fg)]">{airportsLine(jobs.airports)}</p>
          )}
        </Card>
      </div>
      <SchedulesCard schedules={jobs.schedules} />
    </div>
  );
}

function SweepCard({ sweep, now }: { sweep: PostSaleSweep; now: number }) {
  const status = sweepStatus(sweep, now);
  return (
    <Card
      id="sistema-barrido"
      title="Barrido de post-venta"
      aside={<ToneBadge tone={status.tone}>{status.badge}</ToneBadge>}
    >
      <p className="text-sm text-[var(--color-fg)]">{status.headline}</p>
      {status.details.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-[var(--color-fg-muted)]">
          {status.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

const TH = 'pb-2 text-[11px] font-medium text-[var(--color-fg-muted)]';
const TD = 'border-t border-[var(--color-border)] py-2.5 align-top';

function runsCaption(p: ReconciliationProvider, sinceDays: number): string {
  const runs = p.runs === 1 ? '1 corrida' : `${p.runs} corridas`;
  const failed =
    p.failedRuns === 0 ? '' : p.failedRuns === 1 ? ' · 1 fallida' : ` · ${p.failedRuns} fallidas`;
  return `${runs} en ${sinceDays} días${failed}`;
}

function ReconciliationCard({
  sinceDays,
  providers,
  now,
}: {
  sinceDays: number;
  providers: readonly ReconciliationProvider[];
  now: number;
}) {
  return (
    <Card
      id="sistema-conciliacion"
      title="Conciliación diaria"
      aside={<p className="text-xs text-[var(--color-fg-muted)]">Últimos {sinceDays} días</p>}
    >
      {providers.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">Ningún proveedor concilió todavía.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm" aria-labelledby="sistema-conciliacion">
            <thead>
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Proveedor
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Última corrida
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Estado
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Diferencias críticas
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const status = reconciliationStatus(p.lastStatus);
                return (
                  <tr key={p.providerCode}>
                    <td className={cn(TD, 'pr-3')}>
                      <span className="font-medium text-[var(--color-fg)]">
                        {providerLabel(p.providerCode)}
                      </span>
                      <span className="block text-[11px] text-[var(--color-fg-muted)]">
                        {runsCaption(p, sinceDays)}
                      </span>
                    </td>
                    <td className={cn(TD, 'pr-3 text-[var(--color-fg)]')}>
                      {p.lastFinishedAt === null ? (
                        lastRunLabel(null, now)
                      ) : (
                        <time dateTime={p.lastFinishedAt}>
                          {lastRunLabel(p.lastFinishedAt, now)}
                        </time>
                      )}
                    </td>
                    <td className={cn(TD, 'pr-3')}>
                      <span className="flex flex-wrap gap-1">
                        <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
                        {p.stale ? <ToneBadge tone="warning">Atrasada</ToneBadge> : null}
                      </span>
                    </td>
                    <td className={cn(TD, 'text-right tabular-nums text-[var(--color-fg)]')}>
                      {p.criticalItems}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CatalogCard({ catalog, now }: { catalog: CatalogSync; now: number }) {
  const badge = catalogBadge(catalog);
  return (
    <Card
      id={`sistema-catalogo-${catalog.providerCode}`}
      title={catalogTitle(catalog.providerCode)}
      aside={<ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>}
    >
      <p className="text-sm leading-relaxed text-[var(--color-fg)]">{catalogLine(catalog, now)}</p>
    </Card>
  );
}

function SchedulesCard({ schedules }: { schedules: readonly JobSchedule[] }) {
  return (
    <Card id="sistema-programacion" title="Programación">
      <ul className="divide-y divide-[var(--color-border)]">
        {schedules.map((s) => (
          <li key={s.id} className="py-2.5 first:pt-0 last:pb-0">
            <p className="text-sm font-medium text-[var(--color-fg)]">{s.label}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {s.schedule}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">
              {runnerLabel(s)}
              {s.cron !== null ? (
                <>
                  {' · '}
                  <code className="font-mono">{s.cron}</code>
                </>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
