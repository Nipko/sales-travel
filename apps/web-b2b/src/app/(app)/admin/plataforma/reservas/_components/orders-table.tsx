import { Car, Hotel, Plane, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import type { MouseEvent } from 'react';
import { ToneBadge } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import { formatMoney } from '../../../../../../lib/flight-format';
import type { OrderVertical } from '../../../../../../lib/order-vertical';
import {
  ORDER_STATUS_VIEW,
  attentionParts,
  formatOrderDate,
  type OrderAttentionView,
  type PlatformOrderRow,
} from '../../../../../../lib/platform-orders';
import { providerMetaFor } from '../../../../../../lib/provider-display';
import type { Tone } from '../../../../../../lib/wallets';
import { hotelOrderStateOf, type HotelOrderTone } from '../../../../reservas/hotel-order-view';

const VERTICAL_ICON: Readonly<Record<OrderVertical, LucideIcon>> = {
  flights: Plane,
  hotels: Hotel,
  cars: Car,
};

const VERTICAL_NAME: Readonly<Record<OrderVertical, string>> = {
  flights: 'Vuelo',
  hotels: 'Hotel',
  cars: 'Auto',
};

const HOTEL_TONE: Readonly<Record<HotelOrderTone, Tone>> = {
  pending: 'warning',
  progress: 'warning',
  review: 'warning',
  confirmed: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

/**
 * El estado como lo ve la agencia en Mis Reservas: en un hotel el subestado dice en qué está una
 * pendiente ("Verificando", "Cancelación en curso"), y la consola no puede decir otra cosa.
 */
export function rowStatus(row: PlatformOrderRow): { label: string; tone: Tone } {
  if (row.vertical !== 'hotels') return ORDER_STATUS_VIEW[row.status];
  const state = hotelOrderStateOf({
    status: row.status,
    providerTracking: row.subStatus === null ? null : { subStatus: row.subStatus },
  });
  return { label: state.label, tone: HOTEL_TONE[state.tone] };
}

/** Lo que pide atención: ámbar, con el motivo escrito. Nunca sólo el color. */
export function AttentionFlag({
  attention,
  now,
  className,
}: {
  attention: OrderAttentionView;
  now: number;
  className?: string;
}) {
  const { label, since } = attentionParts(attention, now);
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-start gap-1 rounded-md border border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12 px-1.5 py-0.5 text-[11px] font-medium leading-snug text-[var(--color-fg)]',
        className,
      )}
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-px size-3 shrink-0 text-[color-mix(in_oklch,var(--color-warning),var(--color-fg)_40%)]"
      />
      <span className="min-w-0">
        <span className="sr-only">Requiere atención: </span>
        {label}
        {since !== '' ? (
          <span className="whitespace-nowrap font-normal text-[var(--color-fg-muted)]">
            {' '}
            · desde {since}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function Product({ row }: { row: PlatformOrderRow }) {
  const Icon = VERTICAL_ICON[row.vertical];
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]"
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 truncate">
        <span className="sr-only">{VERTICAL_NAME[row.vertical]} · </span>
        {providerMetaFor(row.provider).name}
      </span>
    </span>
  );
}

function Locator({ row }: { row: PlatformOrderRow }) {
  if (row.providerOrderId !== null) {
    return <span className="font-mono text-xs text-[var(--color-fg)]">{row.providerOrderId}</span>;
  }
  if (row.providerBookingRef !== null) {
    return (
      <span className="text-xs text-[var(--color-fg-muted)]">
        Ref. <span className="font-mono">{row.providerBookingRef}</span>
      </span>
    );
  }
  return (
    <span className="text-xs text-[var(--color-fg-subtle)]">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Sin localizador</span>
    </span>
  );
}

function BranchBadge({ row }: { row: PlatformOrderRow }) {
  if (!row.isBranch) return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-800">
      Sucursal
    </span>
  );
}

/** Abrir la ficha sin recargar, salvo que se pida otra pestaña (Ctrl/⌘, Shift o clic del medio). */
function openHandler(row: PlatformOrderRow, onOpen: (row: PlatformOrderRow) => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(row);
  };
}

const TH =
  'px-3 pb-2 pt-3 text-left text-[11px] font-medium text-[var(--color-fg-muted)] first:pl-4 last:pr-4';
const TD = 'px-3 py-3 align-top first:pl-4 last:pr-4';

/**
 * La lista: una tabla en pantallas anchas y tarjetas en el teléfono, la tableta y una laptop chica
 * (con el menú lateral, ocho columnas no entran). Cada fila abre la ficha; el número de orden es un
 * enlace de verdad (`?orden=`), así que también se abre en otra pestaña o se copia.
 */
export function OrdersTable({
  orders,
  selectedId,
  now,
  hrefFor,
  onOpen,
}: {
  orders: readonly PlatformOrderRow[];
  selectedId: string | null;
  now: number;
  hrefFor: (row: PlatformOrderRow) => Route;
  onOpen: (row: PlatformOrderRow) => void;
}) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] xl:block">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Reservas de la red, de la más nueva a la más vieja</caption>
          <colgroup>
            {/* Con el menú lateral, a 1280 px quedan ~1000 para la tabla: el nodo se lleva el resto. */}
            <col className="w-[7rem]" />
            <col />
            <col className="w-[8.5rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[4.5rem]" />
            <col className="w-[11.5rem]" />
            <col className="w-[7.5rem]" />
            <col className="w-[9rem]" />
          </colgroup>
          <thead className="border-b border-[var(--color-border)]">
            <tr>
              <th scope="col" className={TH}>
                Fecha
              </th>
              <th scope="col" className={TH}>
                Nodo
              </th>
              <th scope="col" className={TH}>
                Producto
              </th>
              <th scope="col" className={TH}>
                Localizador
              </th>
              <th scope="col" className={TH}>
                N.º
              </th>
              <th scope="col" className={TH}>
                Estado
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Total
              </th>
              <th scope="col" className={TH}>
                Vendedor
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {orders.map((row) => {
              const status = rowStatus(row);
              const selected = row.id === selectedId;
              return (
                <tr
                  key={row.id}
                  data-order-row={row.id}
                  aria-current={selected ? 'true' : undefined}
                  onClick={(e) => {
                    // El clic en el enlace ya lo atiende el enlace.
                    if ((e.target as HTMLElement).closest('a')) return;
                    onOpen(row);
                  }}
                  className={cn(
                    'cursor-pointer transition-colors hover:bg-[var(--color-surface-muted)]',
                    selected && 'bg-[var(--color-primary)]/5',
                  )}
                >
                  <td className={cn(TD, 'text-xs tabular-nums text-[var(--color-fg-muted)]')}>
                    <time dateTime={row.createdAt}>{formatOrderDate(row.createdAt)}</time>
                  </td>
                  <td className={TD}>
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-words font-medium text-[var(--color-fg)]">
                        {row.tenantName}
                      </span>
                      <BranchBadge row={row} />
                    </span>
                  </td>
                  <td className={cn(TD, 'text-xs text-[var(--color-fg)]')}>
                    <Product row={row} />
                  </td>
                  <td className={cn(TD, 'truncate')}>
                    <Locator row={row} />
                  </td>
                  <td className={TD}>
                    <Link
                      href={hrefFor(row)}
                      prefetch={false}
                      scroll={false}
                      onClick={openHandler(row, onOpen)}
                      className="font-mono text-xs font-semibold tabular-nums text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    >
                      #{row.orderNumber}
                      <span className="sr-only"> · abrir la ficha de la reserva</span>
                    </Link>
                  </td>
                  <td className={TD}>
                    <span className="flex flex-col items-start gap-1">
                      <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
                      {row.attention !== null ? (
                        <AttentionFlag attention={row.attention} now={now} />
                      ) : null}
                    </span>
                  </td>
                  <td
                    className={cn(
                      TD,
                      'text-right font-mono text-xs font-semibold tabular-nums text-[var(--color-fg)]',
                    )}
                  >
                    {formatMoney(row.totalAmountMinor, row.currency)}
                  </td>
                  <td className={cn(TD, 'truncate text-xs text-[var(--color-fg-muted)]')}>
                    {row.sellerEmail ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 xl:hidden" aria-label="Reservas de la red">
        {orders.map((row) => {
          const status = rowStatus(row);
          return (
            <li key={row.id}>
              <Link
                href={hrefFor(row)}
                prefetch={false}
                scroll={false}
                onClick={openHandler(row, onOpen)}
                aria-current={row.id === selectedId ? 'true' : undefined}
                className="block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                        #{row.orderNumber}
                      </span>
                      <Locator row={row} />
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                      <span className="min-w-0 truncate font-medium text-[var(--color-fg)]">
                        {row.tenantName}
                      </span>
                      <BranchBadge row={row} />
                    </span>
                  </span>
                  <span className="shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                    {formatMoney(row.totalAmountMinor, row.currency)}
                  </span>
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-fg-muted)]">
                  <Product row={row} />
                  <time dateTime={row.createdAt}>{formatOrderDate(row.createdAt)}</time>
                  {row.sellerEmail !== null ? (
                    <span className="min-w-0 truncate">{row.sellerEmail}</span>
                  ) : null}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-1.5">
                  <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
                  {row.attention !== null ? (
                    <AttentionFlag attention={row.attention} now={now} />
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
