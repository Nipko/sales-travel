'use client';

import {
  ChevronDown,
  ExternalLink,
  MapPin,
  Receipt,
  ShieldCheck,
  ShieldX,
  Star,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { cn } from '../../../../lib/cn';
import type { HotelOffer } from '../actions';
import { formatMoney } from './hotel-format';
import { ExpiredTag, OwnMarginLine, ProviderPill, RateItem, stayLabel } from './hotel-rate-item';
import { hotelCardView, type HotelRateRow } from './hotel-rate-view';
import type { HotelDetailLink } from './hotel-search-handoff';
import { isRateExpired } from './offer-expiry';

const FOOTER_ACTION =
  'flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]';

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
  /** El detalle del hotel, o nada si no se puede abrir (una tarifa que no dice de dónde es). */
  detailHref?: HotelDetailLink;
}

export function HotelResultCard({
  offer,
  showProvider = false,
  nights,
  expiredCutoffMs,
  detailHref,
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
          <div className="flex border-t border-[var(--color-border)]">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={panelId}
              className={cn(FOOTER_ACTION, 'flex-1')}
            >
              {open ? 'Ocultar tarifas' : `Ver ${count} tarifa${count === 1 ? '' : 's'}`}
              <ChevronDown
                aria-hidden="true"
                className={cn('size-3.5 transition-transform', open && 'rotate-180')}
              />
            </button>
            {/* En otra pestaña: los resultados se quedan donde estaban para comparar con el
                siguiente hotel, sin volver a buscar. */}
            {detailHref ? (
              <Link
                href={detailHref}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(FOOTER_ACTION, 'border-l border-[var(--color-border)] px-4')}
              >
                Ver hotel
                <ExternalLink aria-hidden="true" className="size-3.5" />
                {/* En la lista de enlaces del lector, veinte "Ver hotel" iguales no dicen cuál es. */}
                <span className="sr-only">
                  {' '}
                  {offer.name ?? `Hotel ${offer.hotelId}`} (se abre en otra pestaña)
                </span>
              </Link>
            ) : null}
          </div>

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
