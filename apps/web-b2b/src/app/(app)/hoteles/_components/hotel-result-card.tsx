'use client';

import {
  ChevronDown,
  ExternalLink,
  Gift,
  MapPin,
  Receipt,
  Star,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { mapsUrl } from '../[hotelKey]/_components/hotel-content-view';
import { hotelCardSummary, stayShortLabel } from './hotel-card-summary';
import { formatMoney } from './hotel-format';
import { HotelPhoto } from './hotel-photo';
import type { PhotoState } from './hotel-photos';
import { ExpiredTag, OwnMarginLine, ProviderPill, RateItem, RefundTag } from './hotel-rate-item';
import type { FilteredHotel, ResultRate } from './hotel-results-filters';
import type { HotelDetailLink } from './hotel-search-handoff';
import { isRateExpired } from './offer-expiry';

/*
 * La tarjeta de un hotel en los resultados (propuesta aprobada del 2026-09-29): foto grande, zona,
 * las etiquetas que importan antes de abrir nada —régimen, cancelación, promoción, cargos en el
 * hotel—, el precio por noche grande con el total de la estadía, y el proveedor discreto cuando la
 * divulgación está encendida (RF-40). Las tarifas se despliegan en la misma tarjeta; la ficha
 * completa se abre en otra pestaña para no perder la lista.
 */

const CHIP =
  'inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg)]';

interface HotelResultCardProps {
  item: FilteredHotel;
  photo: PhotoState | undefined;
  /** Noches y habitaciones de la búsqueda: el precio por noche y la línea del total. */
  nights?: number;
  rooms?: number;
  /** El último vencimiento que ya pasó: las tarifas que vencen hasta ahí se marcan vencidas. */
  expiredCutoffMs?: number;
  /** El detalle del hotel, o nada si no se puede abrir (una tarifa que no dice de dónde es). */
  detailHref?: HotelDetailLink;
  /** La agencia no puede reservar no reembolsables: esas tarifas se marcan no disponibles. */
  nonRefundableBlocked?: boolean;
}

export function HotelResultCard({
  item,
  photo,
  nights,
  rooms,
  expiredCutoffMs,
  detailHref,
  nonRefundableBlocked = false,
}: HotelResultCardProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { offer } = item.hotel;
  const name = offer.name ?? `Hotel ${offer.hotelId}`;
  const expired = (rate: ResultRate) =>
    expiredCutoffMs !== undefined && isRateExpired(rate.row.expiresAt, expiredCutoffMs);
  const summary = hotelCardSummary(item, nights, expired);
  const { headline } = summary;
  const count = item.rates.length;
  const stars = item.hotel.stars;
  const stay = stayShortLabel(nights, rooms);

  return (
    <article className="@container overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]">
      <div className="flex flex-col @lg:flex-row">
        <HotelPhoto
          state={photo}
          sizes="(min-width: 640px) 224px, calc(100vw - 2rem)"
          className="aspect-[2/1] w-full @lg:aspect-auto @lg:min-h-44 @lg:w-56 @lg:shrink-0"
        />

        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 @2xl:flex-row @2xl:justify-between @2xl:gap-5">
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-[var(--color-fg)]">
                {name}
              </h3>
              {stars > 0 ? (
                <p className="mt-0.5 flex items-center gap-0.5 text-[var(--color-accent)]">
                  {Array.from({ length: stars }, (_, i) => (
                    <Star key={i} aria-hidden="true" className="size-3 fill-current" />
                  ))}
                  <span className="sr-only">
                    {stars} estrella{stars === 1 ? '' : 's'}
                  </span>
                </p>
              ) : null}
            </div>

            {offer.address ? (
              <p className="flex items-start gap-1 text-xs text-[var(--color-fg-muted)]">
                <MapPin aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                <span className="line-clamp-2">{offer.address}</span>
              </p>
            ) : offer.location ? (
              <a
                href={mapsUrl(offer.location)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-fg-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                <MapPin aria-hidden="true" className="size-3 shrink-0" />
                Ver ubicación en el mapa
                <span className="sr-only"> (se abre en otra pestaña)</span>
              </a>
            ) : null}

            {headline ? (
              <ul
                aria-label="Condiciones de la tarifa del precio"
                className="flex flex-wrap gap-1.5"
              >
                <li className={CHIP}>{headline.row.board}</li>
                {summary.refund ? (
                  <li className="inline-flex">
                    <RefundTag badge={summary.refund} />
                  </li>
                ) : null}
                {summary.promotion ? (
                  <li className={cn(CHIP, 'min-w-0')}>
                    <Gift
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-[var(--color-primary)]"
                    />
                    <span className="truncate">{summary.promotion}</span>
                  </li>
                ) : null}
                {summary.atHotelCharges ? (
                  <li className={CHIP}>
                    <Receipt aria-hidden="true" className="size-3.5 shrink-0" />
                    Cargos a pagar en el hotel
                  </li>
                ) : null}
              </ul>
            ) : null}

            {summary.noRefundableAtAll ? (
              <p className="flex items-start gap-1.5 text-xs text-[var(--color-fg)]">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-[var(--color-warning)]"
                />
                Este hotel no tiene tarifas reembolsables para estas fechas: si se cancela, se cobra
                el 100 %.
              </p>
            ) : summary.refundableFrom ? (
              <p className="text-xs text-[var(--color-fg-muted)]">
                También hay tarifa reembolsable, desde{' '}
                <span className="font-medium tabular-nums text-[var(--color-fg)]">
                  {formatMoney(summary.refundableFrom.row.sale)}
                </span>{' '}
                por la estadía.
              </p>
            ) : null}
          </div>

          {headline && summary.total ? (
            <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-border)] pt-3 @2xl:w-48 @2xl:border-t-0 @2xl:pt-0 @2xl:text-right">
              <div>
                {count > 1 ? (
                  <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                    Desde
                  </p>
                ) : null}
                <p
                  className={cn(
                    'text-xl font-bold leading-tight tabular-nums',
                    summary.headlineExpired
                      ? 'text-[var(--color-fg-muted)] line-through'
                      : 'text-[var(--color-fg)]',
                  )}
                >
                  {summary.headlineExpired ? (
                    <span className="sr-only">Precio vencido: </span>
                  ) : null}
                  {formatMoney(summary.perNight ?? summary.total)}
                </p>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {summary.perNight
                    ? `por noche${rooms !== undefined && rooms > 1 ? `, ${rooms} habitaciones` : ''}`
                    : 'por la estadía'}
                </p>
                {summary.perNight ? (
                  <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                    Total{stay ? ` ${stay}` : ''}:{' '}
                    <span className="font-semibold tabular-nums text-[var(--color-fg)]">
                      {formatMoney(summary.total)}
                    </span>
                  </p>
                ) : null}
                <OwnMarginLine row={headline.row} />
                {headline.row.providerLabel || summary.headlineExpired ? (
                  // La pastilla es la de la tarifa del precio, no la del hotel: una tarjeta puede
                  // reunir tarifas de varios proveedores (RF-40 CA 4).
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 @2xl:justify-end">
                    <ProviderPill label={headline.row.providerLabel} />
                    {summary.headlineExpired ? <ExpiredTag /> : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5 @2xl:mt-auto">
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2"
                >
                  {open
                    ? 'Ocultar habitaciones'
                    : `Ver ${count} habitaci${count === 1 ? 'ón' : 'ones'}`}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('size-4 transition-transform', open && 'rotate-180')}
                  />
                  <span className="sr-only"> de {name}</span>
                </button>
                {/* En otra pestaña: los resultados se quedan donde estaban para comparar con el
                    siguiente hotel, sin volver a buscar. */}
                {detailHref ? (
                  <Link
                    href={detailHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center justify-center gap-1 rounded-lg text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                  >
                    Ver ficha del hotel
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                    <span className="sr-only"> {name} (se abre en otra pestaña)</span>
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div id={panelId} hidden={!open} className="border-t border-[var(--color-border)]">
        {open ? (
          <>
            <ul className="divide-y divide-[var(--color-border)]">
              {item.rates.map((rate) => (
                <RateItem
                  key={rate.row.key}
                  row={rate.row}
                  refund={rate.refund}
                  expired={expired(rate)}
                  unavailableForAgency={nonRefundableBlocked && !rate.refund.refundable}
                />
              ))}
            </ul>
            {item.hiddenRates > 0 ? (
              <p className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2 text-[11px] text-[var(--color-fg-muted)]">
                {item.hiddenRates === 1
                  ? '1 tarifa más de este hotel no cumple los filtros.'
                  : `${item.hiddenRates} tarifas más de este hotel no cumplen los filtros.`}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

const BONE = 'animate-pulse rounded bg-[var(--color-surface-muted)]';

/**
 * La silueta de la tarjeta mientras llega la búsqueda. Copia su caja —foto, nombre y zona,
 * etiquetas, precio con el botón— para que al llegar los hoteles la lista no salte. Si la tarjeta
 * cambia de forma, esto cambia con ella.
 */
export function HotelResultSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="@container overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
    >
      <div className="flex flex-col @lg:flex-row">
        <div className="aspect-[2/1] w-full animate-pulse bg-[var(--color-surface-muted)] @lg:aspect-auto @lg:min-h-44 @lg:w-56 @lg:shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 @2xl:flex-row @2xl:justify-between @2xl:gap-5">
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className={cn(BONE, 'h-4 w-3/5')} />
            <div className={cn(BONE, 'h-3 w-20')} />
            <div className={cn(BONE, 'h-3 w-2/5')} />
            <div className="flex flex-wrap gap-1.5">
              <div className={cn(BONE, 'h-5 w-20 rounded-md')} />
              <div className={cn(BONE, 'h-5 w-28 rounded-md')} />
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-border)] pt-3 @2xl:w-48 @2xl:border-t-0 @2xl:pt-0">
            <div className={cn(BONE, 'h-6 w-28 @2xl:ml-auto')} />
            <div className={cn(BONE, 'h-3 w-20 @2xl:ml-auto')} />
            <div className={cn(BONE, 'h-3 w-36 @2xl:ml-auto')} />
            <div className={cn(BONE, 'mt-1 h-10 w-full rounded-lg')} />
          </div>
        </div>
      </div>
    </div>
  );
}
