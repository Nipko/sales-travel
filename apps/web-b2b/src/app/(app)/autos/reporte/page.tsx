'use client';

import { FileText, Loader2, Search } from 'lucide-react';
import { useState, useTransition } from 'react';
import { cn } from '../../../../lib/cn';
import { dailyReportAction, type DailyReportEntry } from './actions';

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
  'transition-all duration-150',
);
const labelClass = 'block text-xs font-medium text-[var(--color-fg)]';

/** Mapea estados conocidos a estilo de badge; el resto cae al neutro. */
function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('cancel')) {
    return 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]';
  }
  if (s.includes('confirm') || s.includes('ok')) {
    return 'bg-emerald-100 text-emerald-700';
  }
  if (s.includes('hold') || s.includes('request') || s.includes('pend')) {
    return 'bg-amber-100 text-amber-700';
  }
  return 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]';
}

export default function ReportePage() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const [date, setDate] = useState('');
  const [entries, setEntries] = useState<DailyReportEntry[]>([]);

  function runReport() {
    setError('');
    startTransition(async () => {
      const res = await dailyReportAction(date || undefined);
      setSearched(true);
      if (!res.ok) {
        setError(res.error ?? 'No se pudo obtener el reporte.');
        setEntries([]);
        return;
      }
      setEntries(res.entries);
    });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
          <FileText className="size-5 text-[var(--color-primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
            Reporte diario de autos
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Movimientos del día (recogidas y devoluciones) vía AgentCars
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}

      {/* ─────────── Filtro ─────────── */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <label htmlFor="reportDate" className={labelClass}>
              Fecha <span className="text-[var(--color-fg-subtle)]">(opcional)</span>
            </label>
            <input
              id="reportDate"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={cn(inputClass, 'w-44')}
            />
          </div>
          <button
            type="button"
            onClick={runReport}
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Generando…
              </>
            ) : (
              <>
                <Search className="size-4" /> Ver reporte
              </>
            )}
          </button>
          <p className="text-[11px] text-[var(--color-fg-subtle)]">
            Sin fecha, el proveedor devuelve los movimientos del día actual.
          </p>
        </div>
      </div>

      {/* ─────────── Tabla ─────────── */}
      {searched ? (
        entries.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
            <FileText className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
            <p className="text-sm text-[var(--color-fg-muted)]">Sin movimientos para esa fecha.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[var(--color-fg-muted)]">
              {entries.length} {entries.length === 1 ? 'movimiento' : 'movimientos'}
            </p>
            <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-fg-muted)]">
                    <th className="px-4 py-2.5 font-medium">Código</th>
                    <th className="px-4 py-2.5 font-medium">Recogida</th>
                    <th className="px-4 py-2.5 font-medium">Devolución</th>
                    <th className="px-4 py-2.5 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => (
                    <tr
                      key={`${entry.confirmationCode}-${i}`}
                      className="border-b border-[var(--color-border)] last:border-0"
                    >
                      <td className="px-4 py-2.5 font-mono text-xs font-medium text-[var(--color-fg)]">
                        {entry.confirmationCode}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--color-fg-muted)]">
                        {entry.pickUpDate}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--color-fg-muted)]">
                        {entry.dropOffDate}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            'inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium',
                            statusClass(entry.status),
                          )}
                        >
                          {entry.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
