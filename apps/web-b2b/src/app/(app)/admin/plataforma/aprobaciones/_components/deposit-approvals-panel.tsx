'use client';

import { ClipboardCheck, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { NodeKindBadge } from '../../../../../../components/network/node-kind';
import { Button } from '../../../../../../components/ui/button';
import { Select, TextInput } from '../../../../../../components/ui/field';
import {
  ApproveReportDialog,
  RejectReportDialog,
} from '../../../../../../components/wallets/wallet-dialogs';
import { EmptyState, ToneBadge, ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  DEFAULT_APPROVALS_FILTERS,
  SCOPE_HINT,
  SEARCH_MAX_LENGTH,
  STATUS_TABS,
  appendPage,
  emptiesLoadedPage,
  emptyCopy,
  financierLabel,
  otherFinancierOf,
  resolvedMessage,
  scopeOptions,
  sinceLabel,
  totalLabel,
  waitingTone,
  withoutReport,
  type ApprovalsFilters,
  type DepositApprovals,
  type FinancedByFilter,
  type PendingDeposits,
  type QueuedDepositReport,
} from '../../../../../../lib/deposit-approvals';
import {
  loadDepositApprovals,
  loadPendingDeposits,
  notifyPendingDepositsChanged,
} from '../../../../../../lib/deposit-approvals-client';
import { statusLabel } from '../../../../../../lib/tenant-network';
import {
  approveDepositReport,
  refreshAfterFailure,
  rejectDepositReport,
  type WalletResult,
} from '../../../../../../lib/wallet-client';
import { currencyOptionLabel } from '../../../../../../lib/wallet-forms';
import {
  formatDateTime,
  formatDay,
  formatMinor,
  reportStatus,
  type DepositReportStatus,
} from '../../../../../../lib/wallets';

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly data: DepositApprovals;
      readonly more: 'idle' | 'loading' | { readonly error: string };
    };

type Resolving = { readonly kind: 'approve' | 'reject'; readonly report: QueuedDepositReport };

/** Espera de la búsqueda: no se pide una página por cada tecla. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Plataforma → Aprobaciones: los depósitos que informaron las agencias de toda la red, en una sola
 * cola. Antes había que abrir nodo por nodo (Gestión de Agencias → nodo → Carteras) para encontrar
 * qué esperaba aprobación.
 *
 * Por omisión muestra lo que financia Planetour, que es lo que llegó a su cuenta; lo que financia un
 * consolidador o una agencia de la red se ve aparte (normalmente lo aprueba ese nodo). Aprobar y
 * rechazar usan las mismas rutas y diálogos que las carteras de cada nodo.
 */
export function DepositApprovalsPanel() {
  const [filters, setFilters] = useState<ApprovalsFilters>(DEFAULT_APPROVALS_FILTERS);
  const [search, setSearch] = useState('');
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [counts, setCounts] = useState<PendingDeposits | null>(null);
  const [currencies, setCurrencies] = useState<readonly string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [resolving, setResolving] = useState<Resolving | null>(null);
  /** El último pedido de la lista: una respuesta vieja (filtros de antes) no pisa la nueva. */
  const request = useRef(0);

  /**
   * Lee la página y los contadores. `initial` pinta el esqueleto; `quiet` relee detrás de lo que se
   * ve (después de resolver uno) y, si falla, conserva la lista y avisa.
   */
  const load = useCallback(async (next: ApprovalsFilters, mode: 'initial' | 'quiet') => {
    const id = ++request.current;
    if (mode === 'initial') setList({ status: 'loading' });
    const [page, pending] = await Promise.all([loadDepositApprovals(next), loadPendingDeposits()]);
    if (id !== request.current) return;
    setNow(Date.now());
    if (pending.ok) setCounts(pending.data);
    if (page.ok) {
      setList({ status: 'ready', data: page.data, more: 'idle' });
      setCurrencies((seen) =>
        [...new Set([...seen, ...page.data.totals.map((t) => t.currency)])].sort(),
      );
    } else if (mode === 'initial') {
      setList({ status: 'error', message: page.message });
    } else {
      toast.error(`No pudimos actualizar la lista: ${page.message}`);
    }
  }, []);

  useEffect(() => {
    void load(filters, 'initial');
  }, [filters, load]);

  useEffect(() => {
    const q = search.trim();
    if (q === filters.q) return;
    const timer = window.setTimeout(() => setFilters((f) => ({ ...f, q })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, filters.q]);

  const setFilter = useCallback(
    <K extends keyof ApprovalsFilters>(key: K, value: ApprovalsFilters[K]) => {
      setFilters((f) => (f[key] === value ? f : { ...f, [key]: value }));
    },
    [],
  );

  async function loadMore() {
    if (list.status !== 'ready' || list.data.nextCursor === null || list.more === 'loading') return;
    const id = request.current;
    const cursor = list.data.nextCursor;
    setList({ ...list, more: 'loading' });
    const res = await loadDepositApprovals(filters, cursor);
    if (id !== request.current) return;
    setList((s) => {
      if (s.status !== 'ready') return s;
      if (!res.ok) return { ...s, more: { error: res.message } };
      return {
        status: 'ready',
        more: 'idle',
        data: { ...res.data, reports: appendPage(s.data.reports, res.data.reports) },
      };
    });
  }

  const closeDialog = useCallback(() => setResolving(null), []);

  /** Relee sólo los contadores: después de resolver uno, la lista ya se corrigió en el lugar. */
  const reloadCounts = useCallback(async () => {
    const pending = await loadPendingDeposits();
    if (pending.ok) setCounts(pending.data);
  }, []);

  /**
   * Aprueba o rechaza por la ruta del nodo dueño. Si sale bien lo saca de la vista (sin volver a la
   * primera página), avisa al menú y relee los contadores; si el API dice que ya no aplica (otro lo
   * resolvió, 409) o no se sabe si llegó, relee todo detrás del diálogo para no seguir ofreciendo lo
   * que ya no está pendiente.
   */
  async function resolve<T>(
    kind: 'approve' | 'reject',
    report: QueuedDepositReport,
    action: () => Promise<WalletResult<T>>,
  ): Promise<string | undefined> {
    const res = await action();
    if (!res.ok) {
      if (refreshAfterFailure(res)) {
        notifyPendingDepositsChanged();
        void load(filters, 'quiet');
      }
      return res.message;
    }
    setResolving(null);
    toast.success(resolvedMessage(kind, report));
    notifyPendingDepositsChanged();
    if (list.status === 'ready' && emptiesLoadedPage(list.data, report.id)) {
      void load(filters, 'initial');
      return undefined;
    }
    setList((s) => (s.status === 'ready' ? { ...s, data: withoutReport(s.data, report) } : s));
    void reloadCounts();
    return undefined;
  }

  const scopes = useMemo(
    () => scopeOptions(counts, filters.status === 'pending'),
    [counts, filters.status],
  );
  const shown = list.status === 'ready' ? list.data.reports.length : 0;
  const matching = list.status === 'ready' ? list.data.totals.reduce((n, t) => n + t.count, 0) : 0;
  const empty = emptyCopy(filters);
  const networkWaiting =
    filters.status === 'pending' &&
    filters.financedBy === 'platform' &&
    filters.q === '' &&
    filters.currency === 'all' &&
    counts !== null &&
    counts.network > 0
      ? counts.network
      : 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Aprobaciones
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Los depósitos que informaron las agencias de toda la red. Verifica cada uno contra el
            extracto del banco: al aprobarlo se acredita en la cartera de la agencia; al rechazarlo,
            la agencia ve el motivo y puede informarlo de nuevo.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={list.status === 'loading'}
          onClick={() => void load(filters, list.status === 'ready' ? 'quiet' : 'initial')}
        >
          <RefreshCw aria-hidden="true" />
          Actualizar
        </Button>
      </header>

      <div className="mb-5 space-y-3">
        <Segmented
          legend="Estado de los depósitos"
          options={STATUS_TABS}
          value={filters.status}
          onChange={(value: DepositReportStatus) => setFilter('status', value)}
        />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <Segmented
              legend="De quién es el dinero"
              options={scopes}
              value={filters.financedBy}
              onChange={(value: FinancedByFilter) => setFilter('financedBy', value)}
            />
            <p className="max-w-prose text-xs text-[var(--color-fg-muted)]">
              {SCOPE_HINT[filters.financedBy]}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {currencies.length > 1 || filters.currency !== 'all' ? (
              <label className="flex items-center gap-2 text-xs font-medium text-[var(--color-fg-muted)]">
                <span className="shrink-0">Moneda</span>
                <Select
                  value={filters.currency}
                  onChange={(e) => setFilter('currency', e.target.value)}
                  className="sm:w-40"
                >
                  <option value="all">Todas</option>
                  {[
                    ...new Set([
                      ...currencies,
                      ...(filters.currency === 'all' ? [] : [filters.currency]),
                    ]),
                  ]
                    .sort()
                    .map((code) => (
                      <option key={code} value={code}>
                        {currencyOptionLabel(code)}
                      </option>
                    ))}
                </Select>
              </label>
            ) : null}
            <div className="relative sm:w-72">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
              />
              <TextInput
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={SEARCH_MAX_LENGTH}
                placeholder="Busca por agencia o referencia"
                aria-label="Buscar por agencia o referencia"
                className="pl-9"
              />
            </div>
          </div>
        </div>
      </div>

      {list.status === 'loading' ? (
        <div className="space-y-3" aria-busy="true" aria-live="polite">
          <span className="sr-only">Cargando los depósitos…</span>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          ))}
        </div>
      ) : list.status === 'error' ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="mx-auto max-w-md text-sm font-medium text-[var(--color-fg)]">
            {list.message}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => void load(filters, 'initial')}
          >
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : (
        <section aria-label="Depósitos informados" className="space-y-3">
          <div
            aria-live="polite"
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-xs text-[var(--color-fg-muted)]">
              {matching === 0
                ? 'Sin depósitos.'
                : shown < matching
                  ? `Mostrando ${shown} de ${matching} depósitos.`
                  : matching === 1
                    ? '1 depósito.'
                    : `${matching} depósitos.`}
            </p>
            {list.data.totals.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Totales por moneda">
                {list.data.totals.map((t) => (
                  <li
                    key={t.currency}
                    className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg)]"
                  >
                    <span className="text-[var(--color-fg-muted)]">{t.currency}</span>{' '}
                    {totalLabel(t)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {list.data.reports.length === 0 ? (
            <EmptyState icon={<ClipboardCheck className="size-6" />} title={empty.title}>
              <p>{empty.text}</p>
              {networkWaiting > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => setFilter('financedBy', 'network')}
                >
                  {networkWaiting === 1
                    ? 'Ver el que espera a otro nodo'
                    : `Ver los ${networkWaiting} que esperan a otros nodos`}
                </Button>
              ) : null}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
              {list.data.reports.map((report) => (
                <ReportRow
                  key={report.id}
                  report={report}
                  now={now}
                  onApprove={() => setResolving({ kind: 'approve', report })}
                  onReject={() => setResolving({ kind: 'reject', report })}
                />
              ))}
            </ul>
          )}

          {list.data.nextCursor !== null ? (
            <div className="flex flex-col items-center gap-2 pt-1">
              {typeof list.more === 'object' ? (
                <ToneNotice tone="danger" role="alert">
                  {list.more.error}
                </ToneNotice>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                disabled={list.more === 'loading'}
                onClick={() => void loadMore()}
              >
                {list.more === 'loading' ? (
                  <RefreshCw aria-hidden="true" className="animate-spin" />
                ) : null}
                {list.more === 'loading' ? 'Cargando…' : 'Cargar más'}
              </Button>
            </div>
          ) : null}
        </section>
      )}

      {resolving?.kind === 'approve' ? (
        <ApproveReportDialog
          key={resolving.report.id}
          report={resolving.report}
          nodeName={resolving.report.tenant.name}
          otherFinancier={otherFinancierOf(resolving.report)}
          onClose={closeDialog}
          onSubmit={(body) =>
            resolve('approve', resolving.report, () =>
              approveDepositReport(resolving.report.tenantId, resolving.report.id, body),
            )
          }
        />
      ) : resolving?.kind === 'reject' ? (
        <RejectReportDialog
          key={resolving.report.id}
          report={resolving.report}
          nodeName={resolving.report.tenant.name}
          onClose={closeDialog}
          onSubmit={(body) =>
            resolve('reject', resolving.report, () =>
              rejectDepositReport(resolving.report.tenantId, resolving.report.id, body),
            )
          }
        />
      ) : null}
    </div>
  );
}

/**
 * Un grupo de radios con aspecto de control segmentado: se recorre con las flechas, como cualquier
 * grupo de radios, y la opción marcada se lee sin depender del color.
 */
function Segmented<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly { readonly value: T; readonly label: string; readonly count?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-[var(--color-primary)]',
                checked
                  ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
              {option.count !== undefined ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                    option.count > 0
                      ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                      : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
                  )}
                >
                  {option.count}
                  <span className="sr-only"> por aprobar</span>
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Lo que se lee de un depósito antes de decidir: monto, referencia, agencia, quién lo financia. */
export function ReportRow({
  report,
  now,
  onApprove,
  onReject,
}: {
  report: QueuedDepositReport;
  now: number;
  onApprove: () => void;
  onReject: () => void;
}) {
  const pending = report.status === 'pending';
  const status = reportStatus(report.status);
  const amount = formatMinor(report.amountMinor, report.currency, report.exponent);
  const reported = [
    report.depositedOn !== null ? `Depositado el ${formatDay(report.depositedOn)}` : null,
    `Informado ${report.reportedByName !== null ? `por ${report.reportedByName} ` : ''}el ${formatDateTime(report.reportedAt)}`,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
  const resolved =
    report.status === 'pending'
      ? null
      : `${report.status === 'approved' ? 'Aprobado' : 'Rechazado'}${
          report.resolvedByName !== null ? ` por ${report.resolvedByName}` : ''
        }${report.resolvedAt !== null ? ` el ${formatDateTime(report.resolvedAt)}` : ''}`;

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-base font-semibold tabular-nums text-[var(--color-fg)]">{amount}</h3>
          <span className="break-all text-xs text-[var(--color-fg-muted)]">
            Ref. <span className="font-mono text-[var(--color-fg)]">{report.reference}</span>
          </span>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Link
            href={`/admin/tenants/${report.tenantId}/carteras`}
            className="truncate font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            {report.tenant.name}
            <span className="sr-only"> (abrir sus carteras)</span>
          </Link>
          <NodeKindBadge node={report.tenant} />
          {report.tenant.status !== 'active' ? (
            <ToneBadge tone="danger">{statusLabel(report.tenant.status)}</ToneBadge>
          ) : null}
        </p>
        <p className="text-xs text-[var(--color-fg-muted)]">{financierLabel(report)}</p>
        <p className="text-[11px] text-[var(--color-fg-muted)]">{reported}</p>
        {report.notes !== null ? (
          <p className="break-words text-xs text-[var(--color-fg)]">
            <span className="text-[var(--color-fg-muted)]">Nota de la agencia: </span>
            {report.notes}
          </p>
        ) : null}
        {resolved !== null ? (
          <p className="text-[11px] text-[var(--color-fg-muted)]">{resolved}</p>
        ) : null}
        {report.resolutionReason !== null ? (
          <p className="break-words text-xs text-[var(--color-fg)]">
            <span className="text-[var(--color-fg-muted)]">
              {report.status === 'rejected' ? 'Motivo del rechazo: ' : 'Comentario: '}
            </span>
            {report.resolutionReason}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
        {pending ? (
          <ToneBadge tone={waitingTone(report.reportedAt, now)}>
            Informado {sinceLabel(report.reportedAt, now)}
          </ToneBadge>
        ) : (
          <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
        )}
        {pending ? (
          <div className="flex gap-2">
            <Button size="sm" className="flex-1 sm:flex-none" onClick={onApprove}>
              Aprobar
              <span className="sr-only">
                {' '}
                el depósito {report.reference} de {report.tenant.name}
              </span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 sm:flex-none"
              onClick={onReject}
            >
              Rechazar
              <span className="sr-only">
                {' '}
                el depósito {report.reference} de {report.tenant.name}
              </span>
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
