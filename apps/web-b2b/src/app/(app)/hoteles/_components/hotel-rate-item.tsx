import { BedDouble, Gift, Receipt, ShieldAlert, ShieldCheck, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../../../lib/cn';
import { formatMoney } from './hotel-format';
import type { HotelRateRow } from './hotel-rate-view';
import {
  rateRefundability,
  refundLine,
  type RateRefundability,
  type RefundBadge,
} from './rate-refundability';

/*
 * La fila de UNA tarifa de hotel, la misma en la tarjeta del listado y en el detalle del hotel:
 * misma pastilla de proveedor y misma regla (RF-40 CA 4), mismo precio de venta y mismos cargos en
 * el hotel. El detalle le suma lo suyo por `children`.
 */

/**
 * Pastilla del proveedor de UNA tarifa. Con los tokens del design system y no con el color de
 * la ficha del proveedor, igual que la fila de vuelos: son los únicos que siguen al tema oscuro.
 */
export function ProviderPill({ label }: { label: string | undefined }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg-muted)]">
      <span className="sr-only">Proveedor: </span>
      {label}
    </span>
  );
}

/**
 * La etiqueta de cancelación. "No reembolsable" va con el color de advertencia en todas partes
 * (tarjeta, fila de tarifa, detalle, checkout): es lo que el vendedor no puede pasar por alto antes
 * de venderla (pedido del founder del 2026-09-29). El texto dice lo mismo sin el color.
 */
export function RefundTag({ badge, className }: { badge: RefundBadge; className?: string }) {
  if (badge.tone === 'warning') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/20 px-1.5 py-px text-xs font-semibold text-[var(--color-fg)]',
          className,
        )}
      >
        <ShieldAlert aria-hidden="true" className="size-3.5 shrink-0" />
        {badge.label}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-xs font-medium text-[var(--color-fg)]',
        badge.tone === 'success'
          ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
          : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]',
        className,
      )}
    >
      <ShieldCheck
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0',
          badge.tone === 'success'
            ? 'text-[var(--color-success)]'
            : 'text-[var(--color-fg-subtle)]',
        )}
      />
      {badge.label}
    </span>
  );
}

export function ExpiredTag() {
  return (
    <span className="whitespace-nowrap rounded border border-[var(--color-danger)]/40 px-1.5 py-px text-xs font-medium text-[var(--color-fg)]">
      Vencida
    </span>
  );
}

export function stayLabel(nights: number | undefined): string {
  if (nights === undefined || nights < 1) return 'Total de la estadía';
  return `Total por ${nights} noche${nights === 1 ? '' : 's'}`;
}

/**
 * "neto + markup", como la fila de vuelos, con el costo de ESTE tenant. En dos piezas que no se
 * parten, para que en el teléfono baje de línea entre las dos y no le quite ancho a la tarifa.
 */
export function OwnMarginLine({ row }: { row: HotelRateRow }) {
  if (!row.ownMargin) return null;
  return (
    <p className="text-[11px] tabular-nums text-[var(--color-fg-muted)]">
      <span className="whitespace-nowrap">neto {formatMoney(row.ownMargin.cost)}</span>{' '}
      <span className="whitespace-nowrap">+ markup {formatMoney(row.ownMargin.margin)}</span>
    </p>
  );
}

/**
 * Lo que se paga en el hotel, aparte del total (U-07): cada cargo con su importe y su moneda,
 * sin sumarlos. Va en su propio recuadro para que nadie lo lea como parte del precio.
 */
function AtHotelCharges({ row }: { row: HotelRateRow }) {
  if (row.atHotel.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-fg)]">
      <p className="flex items-center gap-1 font-medium">
        <Receipt aria-hidden="true" className="size-3 shrink-0" />A pagar en el hotel, aparte del
        total
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {row.atHotel.map((c, i) => (
          <li key={i}>
            {c.description}
            {c.room === undefined ? '' : ` (habitación ${c.room})`}:{' '}
            <span className="font-medium tabular-nums">{c.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RateExtras({ row }: { row: HotelRateRow }) {
  const lines: string[] = [];
  if (row.inclusion) lines.push(`Incluye: ${row.inclusion}`);
  if (row.transfers) lines.push('Traslados incluidos');
  for (const inc of row.included) lines.push(`Incluido en el precio: ${inc}`);
  if (lines.length === 0 && row.promotions.length === 0) return null;
  return (
    <div className="space-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
      {row.promotions.map((p) => (
        <p key={p} className="flex items-start gap-1 text-[var(--color-fg)]">
          <Gift aria-hidden="true" className="mt-px size-3 shrink-0" />
          {p}
        </p>
      ))}
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

export function RateItem({
  row,
  expired,
  refund,
  children,
}: {
  row: HotelRateRow;
  expired: boolean;
  /**
   * La cancelación leída con la hora de la búsqueda (rate-refundability): una reembolsable cuyo
   * 100 % ya rige sale como no reembolsable. Sin ella, sólo lo que declaró el proveedor.
   */
  refund?: RateRefundability;
  /** Lo que agrega el detalle del hotel debajo de la fila (políticas, precio por noche). */
  children?: ReactNode;
}) {
  const line = refundLine(refund ?? rateRefundability(row.pack));
  return (
    <li className="space-y-1.5 px-4 py-3">
      {/* El precio arriba, a la altura del régimen y la pastilla: en el teléfono, debajo de los
          detalles quedaba a una pantalla de distancia de la tarifa que nombra. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
            {row.board}
          </span>
          <ProviderPill label={row.providerLabel} />
          {expired ? <ExpiredTag /> : null}
        </div>
        <div className="max-w-[55%] shrink-0 text-right">
          <p
            className={cn(
              'whitespace-nowrap text-sm font-bold tabular-nums',
              expired ? 'text-[var(--color-fg-muted)] line-through' : 'text-[var(--color-fg)]',
            )}
          >
            {expired ? <span className="sr-only">Precio vencido: </span> : null}
            {formatMoney(row.sale)}
          </p>
          <OwnMarginLine row={row} />
        </div>
      </div>
      <div className="min-w-0 space-y-1.5">
        <p className="flex items-start gap-1.5 text-xs text-[var(--color-fg)]">
          <BedDouble
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
          />
          {row.rooms}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
          <RefundTag badge={line} />
          {line.note ? <span>{line.note}</span> : null}
        </p>
        <RateExtras row={row} />
        <AtHotelCharges row={row} />
        {row.extraGuest ? (
          <p className="text-[11px] text-[var(--color-fg-muted)]">
            Cargo por huésped adicional: {formatMoney(row.extraGuest)}. Informativo, no está en el
            total.
          </p>
        ) : null}
        {row.commission ? (
          <p className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
            <Wallet aria-hidden="true" className="size-3 text-[var(--color-success)]" />
            Comisión {formatMoney(row.commission.amount)}
            {row.commission.percentage ? ` (${row.commission.percentage}%)` : ''}
          </p>
        ) : null}
        {children}
      </div>
    </li>
  );
}
