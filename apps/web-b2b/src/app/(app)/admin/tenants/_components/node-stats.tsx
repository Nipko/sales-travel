import { Inbox } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '../../../../../lib/cn';
import {
  SHARED_SEATS_LABEL,
  lastOrderLabel,
  nodeDepositsHref,
  pendingDepositsLabel,
  seatsCell,
  type NodeStats,
} from '../../../../../lib/platform-node-stats';

/** Los números de una fila: cargando, sin poder leerse, o leídos (el nodo puede no venir). */
export type RowStats =
  | { readonly status: 'loading' | 'error' }
  | { readonly status: 'ready'; readonly node: NodeStats | undefined; readonly at: number };

/** Lo que dice cada número de la fila, o `null` mientras no se puede decir. */
interface StatsText {
  readonly seats: ReturnType<typeof seatsCell>;
  readonly sales: string;
  readonly lastOrder: string;
}

function textOf(stats: RowStats): StatsText | null {
  if (stats.status !== 'ready' || stats.node === undefined) return null;
  return {
    seats: seatsCell(stats.node),
    sales: String(stats.node.sales30d),
    lastOrder: lastOrderLabel(stats.node.lastOrderAt, stats.at),
  };
}

/** El cupo: "3/5", en ámbar y con "al límite" desde el 90 %; "—" si comparte el de su red. */
function SeatsValue({ seats }: { seats: StatsText['seats'] }) {
  if (seats === null) {
    return (
      <span title={SHARED_SEATS_LABEL}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{SHARED_SEATS_LABEL}</span>
      </span>
    );
  }
  if (seats.tone === 'warning') {
    return (
      <span
        data-tone="warning"
        className="inline-flex items-center gap-1 rounded-full border border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12 px-1.5 py-px font-medium text-[var(--color-fg)]"
      >
        <span aria-hidden="true">
          {seats.text} {seats.note}
        </span>
        <span className="sr-only">{seats.label}</span>
      </span>
    );
  }
  return (
    <span data-tone="neutral">
      <span aria-hidden="true">{seats.text}</span>
      <span className="sr-only">{seats.label}</span>
    </span>
  );
}

const PLACEHOLDER = (
  <span
    aria-hidden="true"
    className="inline-block h-3 w-8 animate-pulse rounded bg-[var(--color-surface-muted)]"
  />
);

/**
 * Puestos, ventas de 30 días (confirmadas o emitidas) y la última reserva en columnas de ancho fijo,
 * alineadas entre filas.
 * Sólo en pantallas anchas; en el teléfono va {@link NodeStatsLine}.
 */
export function NodeStatsColumns({ stats }: { stats: RowStats }) {
  const text = textOf(stats);
  const value = (v: ReactNode) =>
    text !== null ? v : stats.status === 'loading' ? PLACEHOLDER : <span>—</span>;
  return (
    <dl
      aria-busy={stats.status === 'loading' || undefined}
      className="hidden shrink-0 grid-cols-[5.5rem_4rem_6.5rem] gap-x-3 lg:grid"
    >
      <div className="min-w-0">
        <dt className="text-[10px] font-medium text-[var(--color-fg-subtle)]">Puestos</dt>
        <dd className="mt-0.5 text-xs tabular-nums text-[var(--color-fg)]">
          {value(text !== null ? <SeatsValue seats={text.seats} /> : null)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-[10px] font-medium text-[var(--color-fg-subtle)]">Ventas 30 d</dt>
        <dd className="mt-0.5 text-xs tabular-nums text-[var(--color-fg)]">{value(text?.sales)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-[10px] font-medium text-[var(--color-fg-subtle)]">Última reserva</dt>
        <dd className="mt-0.5 truncate text-xs text-[var(--color-fg)]">{value(text?.lastOrder)}</dd>
      </div>
    </dl>
  );
}

/** Los mismos números en una línea, para el teléfono y las pantallas medianas. */
export function NodeStatsLine({ stats }: { stats: RowStats }) {
  const text = textOf(stats);
  if (text === null) return null;
  return (
    <dl className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-muted)] lg:hidden">
      <div className="flex items-center gap-1">
        <dt>Puestos</dt>
        <dd className="tabular-nums text-[var(--color-fg)]">
          <SeatsValue seats={text.seats} />
        </dd>
      </div>
      <div className="flex items-center gap-1">
        <dt>Ventas 30 d</dt>
        <dd className="tabular-nums text-[var(--color-fg)]">{text.sales}</dd>
      </div>
      <div className="flex items-center gap-1">
        <dt>Última reserva</dt>
        <dd className="text-[var(--color-fg)]">{text.lastOrder}</dd>
      </div>
    </dl>
  );
}

/** "{n} depósitos por aprobar", hacia Plataforma → Carteras acotada al nodo. Nada si no hay. */
export function PendingDepositsBadge({ stats, nodeName }: { stats: RowStats; nodeName: string }) {
  if (stats.status !== 'ready' || stats.node === undefined) return null;
  const label = pendingDepositsLabel(stats.node.pendingDepositReports);
  if (label === null) return null;
  return (
    <Link
      href={nodeDepositsHref(stats.node.tenantId)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg)] transition-colors',
        'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12 hover:bg-[var(--color-warning)]/20',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
      )}
    >
      <Inbox aria-hidden="true" className="size-3" />
      {label}
      <span className="sr-only"> de {nodeName}</span>
    </Link>
  );
}
