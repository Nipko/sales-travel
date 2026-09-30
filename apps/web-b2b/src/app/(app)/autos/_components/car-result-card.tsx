'use client';

import {
  Cog,
  DoorOpen,
  Gauge,
  Leaf,
  Loader2,
  Luggage,
  Snowflake,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../../lib/cn';
import {
  CAR_CLASS_LABELS,
  TRANSMISSION_LABELS,
  formatMinor,
  formatMoney,
  fuelOf,
  kmLabel,
  modelLabel,
} from './car-format';
import { CarPhoto, CompanyLogo } from './car-photo';
import type { ResultCar } from './car-results-filters';
import { PAYMENT_LABELS, daysLabel } from './car-search-model';

/*
 * Un auto en los resultados, con la misma estructura que la tarjeta de hotel: foto grande, lo que
 * decide la venta antes de abrir nada (clase, capacidad, transmisión, kilometraje) y el precio de
 * venta del alquiler completo grande, con cuánto sale por día.
 */

const CHIP =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg)]';

function Spec({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <li className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
      <span aria-hidden="true">{value}</span>
      <span className="sr-only">{label}</span>
    </li>
  );
}

export function CarResultCard({
  item,
  days,
  selecting = false,
  disabled = false,
  onSelect,
}: {
  item: ResultCar;
  /** Días de alquiler de la búsqueda: el precio por día. */
  days: number;
  /** Este auto se está seleccionando (abre la sesión de la tarifa). */
  selecting?: boolean;
  /** Hay otra selección en curso. */
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { offer, sale } = item;
  const title = modelLabel(offer.carModel) || offer.category || CAR_CLASS_LABELS[item.carClass];
  const km = kmLabel(offer.kmIncluded);
  const fuel = fuelOf(offer.sippCode);
  const perDay = Math.round(sale.amountMinor / Math.max(1, days));
  const margin = offer.pricing && offer.pricing.ownMarkupMinor > 0 ? offer.pricing : undefined;

  return (
    <article className="@container overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]">
      <div className="flex flex-col @lg:flex-row">
        <CarPhoto
          src={offer.imageUrl}
          className="aspect-[2/1] w-full border-b border-[var(--color-border)] @lg:aspect-auto @lg:min-h-40 @lg:w-56 @lg:shrink-0 @lg:border-b-0 @lg:border-r"
        />

        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 @2xl:flex-row @2xl:justify-between @2xl:gap-5">
          <div className="min-w-0 flex-1 space-y-2.5">
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">
                {CAR_CLASS_LABELS[item.carClass]}
                {offer.sippCode ? (
                  <span className="font-mono font-medium normal-case tracking-normal text-[var(--color-fg-subtle)]">
                    <span className="sr-only">, código SIPP </span>
                    <span aria-hidden="true">· </span>
                    {offer.sippCode}
                  </span>
                ) : null}
              </p>
              <h3 className="mt-0.5 text-[15px] font-semibold leading-snug tracking-tight text-[var(--color-fg)]">
                {title}
              </h3>
              {offer.companyName ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
                  <CompanyLogo src={offer.companyImageUrl} />
                  <span className="truncate">{offer.companyName}</span>
                </p>
              ) : null}
            </div>

            <ul
              aria-label="Características"
              className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-[var(--color-fg-muted)]"
            >
              {offer.passengers > 0 ? (
                <Spec
                  icon={Users}
                  value={String(offer.passengers)}
                  label={`${offer.passengers} pasajeros`}
                />
              ) : null}
              {offer.bags > 0 ? (
                <Spec
                  icon={Luggage}
                  value={String(offer.bags)}
                  label={`${offer.bags} ${offer.bags === 1 ? 'maleta' : 'maletas'}`}
                />
              ) : null}
              {offer.doors > 0 ? (
                <Spec
                  icon={DoorOpen}
                  value={String(offer.doors)}
                  label={`${offer.doors} puertas`}
                />
              ) : null}
              {item.transmission ? (
                <Spec
                  icon={Cog}
                  value={TRANSMISSION_LABELS[item.transmission]}
                  label={`Transmisión ${TRANSMISSION_LABELS[item.transmission].toLowerCase()}`}
                />
              ) : null}
              {offer.air ? <Spec icon={Snowflake} value="A/C" label="Aire acondicionado" /> : null}
            </ul>

            <ul aria-label="Condiciones" className="flex flex-wrap gap-1.5">
              {km ? (
                <li
                  className={cn(
                    CHIP,
                    item.unlimitedKm &&
                      'border-[var(--color-success)]/40 bg-[var(--color-success)]/10',
                  )}
                >
                  <Gauge aria-hidden="true" className="size-3.5 shrink-0" />
                  {km}
                </li>
              ) : null}
              {fuel ? (
                <li className={CHIP}>
                  {fuel === 'electrico' ? (
                    <Zap aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : (
                    <Leaf aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                  {fuel === 'electrico' ? 'Eléctrico' : 'Híbrido'}
                </li>
              ) : null}
              <li className={CHIP}>{PAYMENT_LABELS[offer.paymentOption]}</li>
            </ul>
          </div>

          <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-border)] pt-3 @2xl:w-48 @2xl:border-t-0 @2xl:pt-0 @2xl:text-right">
            <div className="flex items-end justify-between gap-3 @2xl:block">
              <div>
                <p className="text-xl font-bold leading-tight tabular-nums text-[var(--color-fg)]">
                  {formatMoney(sale)}
                </p>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Total {daysLabel(days)}
                  {days > 1 ? (
                    <>
                      {' · '}
                      <span className="whitespace-nowrap tabular-nums">
                        {formatMinor(perDay, sale.currency)} por día
                      </span>
                    </>
                  ) : null}
                </p>
                {margin ? (
                  <p className="mt-0.5 text-[11px] tabular-nums text-[var(--color-fg-muted)]">
                    <span className="whitespace-nowrap">
                      neto {formatMinor(margin.costMinor, margin.currency)}
                    </span>{' '}
                    <span className="whitespace-nowrap">
                      + markup {formatMinor(margin.ownMarkupMinor, margin.currency)}
                    </span>
                  </p>
                ) : null}
              </div>
            </div>

            <button
              type="button"
              onClick={onSelect}
              disabled={disabled || selecting}
              aria-busy={selecting}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 @2xl:mt-auto"
            >
              {selecting ? (
                <>
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  Reservando tarifa…
                </>
              ) : (
                <>
                  Seleccionar
                  <span className="sr-only"> {title}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

/** El lugar de una tarjeta mientras llegan los resultados. */
export function CarResultSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="@container overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="flex flex-col @lg:flex-row">
        <div className="aspect-[2/1] w-full animate-pulse bg-[var(--color-surface-muted)] @lg:aspect-auto @lg:min-h-40 @lg:w-56" />
        <div className="flex flex-1 flex-col gap-3 p-4 @2xl:flex-row @2xl:justify-between">
          <div className="flex-1 space-y-2.5">
            <div className="h-3 w-24 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-surface-muted)]" />
          </div>
          <div className="space-y-2 @2xl:w-48">
            <div className="h-6 w-28 animate-pulse rounded bg-[var(--color-surface-muted)] @2xl:ml-auto" />
            <div className="h-3 w-36 animate-pulse rounded bg-[var(--color-surface-muted)] @2xl:ml-auto" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-[var(--color-surface-muted)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
