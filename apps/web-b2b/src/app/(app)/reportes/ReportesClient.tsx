'use client';

import { Download, Info } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '../../../components/ui/button';
import { SegmentedControl } from '../../../components/ui/segmented-control';
import { cn } from '../../../lib/cn';
import {
  bookingsText,
  currencySummaries,
  monthName,
  monthlySeries,
  periodText,
  reportMoney,
  salesReportCsv,
  salesReportFilename,
  salesVerticalName,
  shortMonthName,
  topPerformersIn,
  verticalShares,
  type CurrencySummary,
  type SalesMetrics,
} from '../../../lib/sales-reports';
import { currencyName } from '../../../lib/wallets';

export const NO_SALES_TEXT = 'Todavía no hay ventas confirmadas en este período.';
export const COMMISSIONS_NOTICE =
  'Todavía no calculamos comisiones ni márgenes reales. Aparecerán cuando registremos el margen de cada venta.';

/**
 * Reportes de la agencia: ventas confirmadas de los últimos 12 meses por vertical, por mes y por
 * vendedor, una moneda a la vez (nunca se suman monedas distintas). Hasta G-16 mostraba verticales,
 * vendedores, comisiones y variaciones inventadas cuando no había ventas.
 */
export function ReportesClient({
  metrics,
  error,
}: {
  metrics: SalesMetrics | null;
  error: string | null;
}) {
  const summaries = metrics === null ? [] : currencySummaries(metrics);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = summaries.find((s) => s.currency === picked) ?? summaries[0] ?? null;

  function exportCsv() {
    if (metrics === null) return;
    // Blob local: el reporte no pasa por ningún servidor para bajarlo.
    const url = URL.createObjectURL(
      new Blob([salesReportCsv(metrics)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = salesReportFilename(metrics.period);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Reportes</h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Revisa tus ventas por vertical, por mes y por vendedor.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={summaries.length === 0}
          onClick={exportCsv}
        >
          <Download aria-hidden="true" />
          Exportar CSV
        </Button>
      </header>

      {metrics !== null ? (
        <p className="mb-6 text-xs text-[var(--color-fg-muted)]">
          Ventas confirmadas · {periodText(metrics.period)} · hora de Bogotá
        </p>
      ) : null}

      <div className="space-y-10">
        {error !== null ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center text-sm font-medium text-[var(--color-fg)]"
          >
            {error}
          </div>
        ) : metrics === null || selected === null ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-10 text-center text-sm text-[var(--color-fg-muted)]">
            {NO_SALES_TEXT}
          </p>
        ) : (
          <SalesReport
            metrics={metrics}
            summaries={summaries}
            selected={selected}
            onPick={setPicked}
          />
        )}

        <section aria-labelledby="reportes-comisiones">
          <SectionHeader id="reportes-comisiones" title="Comisiones y márgenes" />
          <p className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-fg)]">
            <Info
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]"
            />
            <span>{COMMISSIONS_NOTICE}</span>
          </p>
        </section>
      </div>
    </div>
  );
}

function SectionHeader({ id, title }: { id: string; title: string }) {
  return (
    <h2 id={id} className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
      {title}
    </h2>
  );
}

/** El reporte de una moneda. Sin estado propio: se prueba renderizándolo. */
export function SalesReport({
  metrics,
  summaries,
  selected,
  onPick,
}: {
  metrics: SalesMetrics;
  summaries: readonly CurrencySummary[];
  selected: CurrencySummary;
  onPick: (currency: string) => void;
}) {
  const currency = selected.currency;
  const name = currencyName(currency);
  return (
    <div className="space-y-10">
      {summaries.length > 1 ? (
        <div className="space-y-2">
          <SegmentedControl
            legend="Moneda del reporte"
            options={summaries.map((s) => ({ value: s.currency, label: s.currency }))}
            value={currency}
            onChange={onPick}
          />
          <p className="text-xs text-[var(--color-fg-muted)]">
            Cada moneda va por separado: nunca sumamos montos de monedas distintas.
          </p>
        </div>
      ) : null}

      <section aria-labelledby="reportes-resumen">
        <h2 id="reportes-resumen" className="sr-only">
          Resumen en {currency}
          {name !== currency ? ` (${name})` : ''}
        </h2>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Kpi label={`Ventas confirmadas · ${currency}`}>
            {reportMoney(selected.amountMinor, currency)}
          </Kpi>
          <Kpi label="Reservas confirmadas">{selected.count}</Kpi>
          <Kpi label="Ticket promedio">
            {selected.averageMinor === null ? '—' : reportMoney(selected.averageMinor, currency)}
          </Kpi>
        </dl>
      </section>

      <MonthlyTable metrics={metrics} currency={currency} />

      <div className="grid gap-4 lg:grid-cols-2">
        <VerticalTable metrics={metrics} currency={currency} />
        <SellersList metrics={metrics} currency={currency} />
      </div>
    </div>
  );
}

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5">
      <dt className="text-xs font-medium text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-[var(--color-fg)]">
        {children}
      </dd>
    </div>
  );
}

const TH = 'pb-2 text-[11px] font-medium text-[var(--color-fg-muted)]';
const TD = 'border-t border-[var(--color-border)] py-2.5 align-top';

function TableCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
    >
      <h2 id={id} className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Un mes por fila, el más reciente arriba; la barra es decorativa (el monto va escrito). */
function MonthlyTable({ metrics, currency }: { metrics: SalesMetrics; currency: string }) {
  const series = monthlySeries(metrics, currency).reverse();
  const max = Math.max(0, ...series.map((m) => m.amountMinor));
  return (
    <TableCard id="reportes-meses" title={`Por mes · ${currency}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-labelledby="reportes-meses">
          <thead>
            <tr>
              <th scope="col" className={cn(TH, 'text-left')}>
                Mes
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Reservas
              </th>
              <th scope="col" className={cn(TH, 'w-1/2 text-right')}>
                Monto
              </th>
            </tr>
          </thead>
          <tbody>
            {series.map((m) => (
              <tr key={m.month}>
                <th scope="row" className={cn(TD, 'pr-3 text-left font-normal')}>
                  <span aria-hidden="true">{shortMonthName(m.month)}</span>
                  <span className="sr-only">{monthName(m.month)}</span>
                </th>
                <td className={cn(TD, 'text-right tabular-nums text-[var(--color-fg-muted)]')}>
                  {m.count}
                </td>
                <td className={cn(TD, 'pl-3 text-right tabular-nums')}>
                  <span className={m.count === 0 ? 'text-[var(--color-fg-muted)]' : undefined}>
                    {reportMoney(m.amountMinor, currency)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
                  >
                    <span
                      className="ml-auto block h-full rounded-full bg-[var(--color-primary)]"
                      style={{
                        width:
                          max === 0 || m.amountMinor === 0
                            ? '0%'
                            : `max(2px, ${Math.round((m.amountMinor / max) * 100)}%)`,
                      }}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TableCard>
  );
}

function VerticalTable({ metrics, currency }: { metrics: SalesMetrics; currency: string }) {
  const rows = verticalShares(metrics, currency);
  return (
    <TableCard id="reportes-verticales" title={`Por vertical · ${currency}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-labelledby="reportes-verticales">
          <thead>
            <tr>
              <th scope="col" className={cn(TH, 'text-left')}>
                Vertical
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Reservas
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Monto
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Parte
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.vertical}>
                <th scope="row" className={cn(TD, 'pr-3 text-left font-medium')}>
                  {salesVerticalName(v.vertical)}
                </th>
                <td className={cn(TD, 'text-right tabular-nums')}>{v.count}</td>
                <td className={cn(TD, 'pl-3 text-right tabular-nums')}>
                  {reportMoney(v.totalAmountMinor, currency)}
                </td>
                <td className={cn(TD, 'pl-3 text-right tabular-nums text-[var(--color-fg-muted)]')}>
                  {Math.round(v.share)} %
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TableCard>
  );
}

function SellersList({ metrics, currency }: { metrics: SalesMetrics; currency: string }) {
  const sellers = topPerformersIn(metrics, currency);
  return (
    <TableCard id="reportes-vendedores" title={`Por vendedor · ${currency}`}>
      {sellers.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">
          Ningún vendedor confirmó ventas en {currency} en este período.
        </p>
      ) : (
        <ol className="space-y-2">
          {sellers.map((p, i) => (
            <li
              key={p.userId}
              className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-2 first:border-t-0 first:pt-0"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="w-4 shrink-0 text-right text-xs tabular-nums text-[var(--color-fg-muted)]"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                    {p.name}
                  </span>
                  <span className="block text-[11px] text-[var(--color-fg-muted)]">
                    {bookingsText(p.count)}
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-sm tabular-nums text-[var(--color-fg)]">
                {reportMoney(p.salesMinor, currency)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[11px] text-[var(--color-fg-muted)]">
        Hasta cinco vendedores, de más a menos vendido.
      </p>
    </TableCard>
  );
}
