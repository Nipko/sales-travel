'use client';

import {
  BedDouble,
  ChevronDown,
  Gift,
  MapPin,
  Receipt,
  ShieldCheck,
  ShieldX,
  Star,
  Wallet,
} from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../../../../lib/cn';
import type { HotelOffer } from '../actions';
import { formatMoney } from './hotel-format';
import { hotelCardView, type HotelRateRow } from './hotel-rate-view';
import { isRateExpired } from './offer-expiry';

/**
 * Pastilla del proveedor de UNA tarifa. Con los tokens del design system y no con el color de
 * la ficha del proveedor, igual que la fila de vuelos: son los únicos que siguen al tema oscuro.
 */
function ProviderPill({ label }: { label: string | undefined }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg-muted)]">
      <span className="sr-only">Proveedor: </span>
      {label}
    </span>
  );
}

function ExpiredTag() {
  return (
    <span className="whitespace-nowrap rounded border border-[var(--color-danger)]/40 px-1.5 py-px text-xs font-medium text-[var(--color-fg)]">
      Vencida
    </span>
  );
}

function stayLabel(nights: number | undefined): string {
  if (nights === undefined || nights < 1) return 'Total de la estadía';
  return `Total por ${nights} noche${nights === 1 ? '' : 's'}`;
}

/**
 * "neto + markup", como la fila de vuelos, con el costo de ESTE tenant. En dos piezas que no se
 * parten, para que en el teléfono baje de línea entre las dos y no le quite ancho a la tarifa.
 */
function OwnMarginLine({ row }: { row: HotelRateRow }) {
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

function RateItem({ row, expired }: { row: HotelRateRow; expired: boolean }) {
  const c = row.cancellation;
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
        <p className="flex items-start gap-1 text-[11px] text-[var(--color-fg-muted)]">
          {c.refundable ? (
            <ShieldCheck
              aria-hidden="true"
              className="mt-px size-3 shrink-0 text-[var(--color-success)]"
            />
          ) : (
            <ShieldX aria-hidden="true" className="mt-px size-3 shrink-0" />
          )}
          <span>
            <span className="font-medium text-[var(--color-fg)]">{c.label}</span>
            {c.note ? ` · ${c.note}` : null}
          </span>
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
      </div>
    </li>
  );
}

interface HotelResultCardProps {
  offer: HotelOffer;
  /**
   * Ajuste efectivo de divulgación de proveedor del tenant, el mismo que en vuelos. Apagado por
   * defecto: de quién compra el consolidador es un dato interno suyo.
   */
  showProvider?: boolean;
  /** Noches de la búsqueda: el precio es el de la estadía entera. */
  nights?: number;
  /** El último vencimiento que ya pasó: las tarifas que vencen hasta ahí se marcan vencidas. */
  expiredCutoffMs?: number;
}

export function HotelResultCard({
  offer,
  showProvider = false,
  nights,
  expiredCutoffMs,
}: HotelResultCardProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const expired = (row: HotelRateRow) =>
    expiredCutoffMs !== undefined && isRateExpired(row.expiresAt, expiredCutoffMs);
  const view = hotelCardView(offer, showProvider, expired);
  const { from, fromExpired } = view;
  const count = view.rows.length;
  const stars = offer.stars ? Math.min(5, Math.round(offer.stars)) : 0;

  return (
    <article className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">
              {offer.name ?? `Hotel ${offer.hotelId}`}
            </h3>
            {stars > 0 ? (
              <span className="flex items-center gap-0.5 text-[var(--color-accent)]">
                {Array.from({ length: stars }, (_, i) => (
                  <Star key={i} aria-hidden="true" className="size-3 fill-current" />
                ))}
                <span className="sr-only">
                  {stars} estrella{stars === 1 ? '' : 's'}
                </span>
              </span>
            ) : null}
          </div>
          {offer.address ? (
            <p className="mt-1 flex items-start gap-1 text-xs text-[var(--color-fg-muted)]">
              <MapPin aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              {offer.address}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
            <span className="font-mono">ID {offer.hotelId}</span>
            {!offer.address && offer.location ? (
              <span className="inline-flex items-center gap-1">
                <MapPin aria-hidden="true" className="size-3" />
                {offer.location.lat.toFixed(3)}, {offer.location.lng.toFixed(3)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-medium text-[var(--color-fg)]">
              {view.anyRefundable ? (
                <ShieldCheck aria-hidden="true" className="size-3 text-[var(--color-success)]" />
              ) : (
                <ShieldX aria-hidden="true" className="size-3" />
              )}
              {view.anyRefundable ? 'Con tarifa reembolsable' : 'Solo no reembolsable'}
            </span>
          </div>
        </div>

        {from ? (
          <div className="shrink-0 border-t border-[var(--color-border)] pt-3 sm:border-t-0 sm:pt-0 sm:text-right">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {count > 1 ? 'Desde' : 'Precio'}
            </p>
            {/* La pastilla va pegada al precio y es la de ESTA tarifa, no la del hotel: una
                tarjeta puede reunir tarifas de varios proveedores (RF-40 CA 4). */}
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
              <p
                className={cn(
                  'text-lg font-bold leading-tight tabular-nums',
                  fromExpired
                    ? 'text-[var(--color-fg-muted)] line-through'
                    : 'text-[var(--color-fg)]',
                )}
              >
                {fromExpired ? <span className="sr-only">Precio vencido: </span> : null}
                {formatMoney(from.sale)}
              </p>
              <ProviderPill label={from.providerLabel} />
              {fromExpired ? <ExpiredTag /> : null}
            </div>
            <OwnMarginLine row={from} />
            <p className="text-[11px] text-[var(--color-fg-muted)]">
              {stayLabel(nights)} · {from.board}
            </p>
            {from.atHotel.length > 0 ? (
              <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-fg)]">
                <Receipt aria-hidden="true" className="size-3" />
                Más cargos a pagar en el hotel
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {count > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex w-full items-center justify-center gap-1.5 border-t border-[var(--color-border)] py-2.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)]"
          >
            {open ? 'Ocultar tarifas' : `Ver ${count} tarifa${count === 1 ? '' : 's'}`}
            <ChevronDown
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            />
          </button>

          <ul
            id={panelId}
            hidden={!open}
            className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]"
          >
            {open
              ? view.rows.map((row) => <RateItem key={row.key} row={row} expired={expired(row)} />)
              : null}
          </ul>
        </>
      ) : null}
    </article>
  );
}
