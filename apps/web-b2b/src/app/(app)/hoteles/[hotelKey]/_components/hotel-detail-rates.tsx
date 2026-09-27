'use client';

import { BedDouble, Info, Moon, RefreshCw, Search, ShieldAlert, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../../../lib/cn';
import type { HotelRoompack } from '../../actions';
import { formatMoney } from '../../_components/hotel-format';
import { RateItem } from '../../_components/hotel-rate-item';
import type { HotelRateRow } from '../../_components/hotel-rate-view';
import type { HotelStay } from '../../_components/hotel-search-handoff';
import { isRateExpired, OfferExpiry } from '../../_components/offer-expiry';
import type { HotelDetailRatesResult } from '../actions';
import { detailRatesView, emptyRatesView, type FailedProvider } from './hotel-detail-view';
import {
  nightlySale,
  ratePolicyView,
  sellingHotelNote,
  uniformNightPrice,
  type HotelFacts,
} from './hotel-rate-detail-view';

/*
 * Las tarifas del hotel para la estadía de la búsqueda (D-TBO-19 A): una búsqueda nueva de este
 * solo hotel en cada proveedor que lo vende, con las políticas por tramos y el precio por noche
 * "sujetos a confirmación". El PreBook los confirma.
 */

function FailedProvidersNotice({ failed }: { failed: readonly FailedProvider[] }) {
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
      />
      <div>
        <strong className="font-semibold">
          {failed.length === 1
            ? 'Un proveedor no pudo dar sus tarifas.'
            : `${failed.length} proveedores no pudieron dar sus tarifas.`}
        </strong>{' '}
        Puede haber tarifas de este hotel que no se están mostrando.
        <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-fg-muted)]">
          {failed.map((p) => (
            <li key={p.code}>
              <span className="font-medium">{p.code}</span> · {p.reason}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Tramos de la política, precio por noche y con qué nombre se reserva: lo que suma el detalle. */
function RateDetailExtras({
  pack,
  checkinDate,
  nights,
  sellingNote,
}: {
  pack: HotelRoompack;
  checkinDate: string;
  nights: number;
  sellingNote: string | undefined;
}) {
  const policy = ratePolicyView(pack);
  const perNight = nightlySale(pack, checkinDate, nights);
  const uniform = perNight === undefined ? undefined : uniformNightPrice(perNight);

  return (
    <>
      {sellingNote ? (
        <p className="flex items-start gap-1 text-[11px] text-[var(--color-fg-muted)]">
          <Info aria-hidden="true" className="mt-px size-3 shrink-0" />
          {sellingNote}
        </p>
      ) : null}

      {policy ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-[11px] text-[var(--color-fg)]">
          <p className="flex items-center gap-1 font-medium">
            <ShieldAlert aria-hidden="true" className="size-3 shrink-0" />
            Cancelación
          </p>
          {policy.caption ? (
            <p className="text-[var(--color-fg-muted)]">{policy.caption}.</p>
          ) : null}
          {policy.tiers.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {policy.tiers.map((t, i) => (
                <li key={i}>
                  <span className="text-[var(--color-fg-muted)]">{t.when}:</span>{' '}
                  <span className="font-medium tabular-nums">{t.charge}</span>
                  {t.approx ? (
                    <span className="whitespace-nowrap tabular-nums text-[var(--color-fg-muted)]">
                      {' '}
                      ({t.approx})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {policy.notes ? (
            <p className="mt-1 whitespace-pre-line text-[var(--color-fg-muted)]">{policy.notes}</p>
          ) : null}
        </div>
      ) : null}

      {perNight !== undefined && uniform !== undefined ? (
        <p className="flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
          <Moon aria-hidden="true" className="size-3 shrink-0" />
          <span>
            <span className="font-medium tabular-nums text-[var(--color-fg)]">
              ≈ {formatMoney(uniform)}
            </span>{' '}
            por noche · sujeto a confirmación
          </span>
        </p>
      ) : null}
      {perNight !== undefined && uniform === undefined ? (
        <details className="group text-[11px] text-[var(--color-fg-muted)]">
          <summary className="inline-flex cursor-pointer items-center gap-1 rounded font-medium text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]">
            <Moon aria-hidden="true" className="size-3 shrink-0" />
            Precio por noche (aprox., sujeto a confirmación)
          </summary>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {perNight.map((n, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>{n.label}</span>
                <span className="font-medium tabular-nums text-[var(--color-fg)]">
                  {formatMoney(n.amount)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** Volver a pedir las tarifas: la misma estadía, una búsqueda nueva. */
function RetryButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <RefreshCw aria-hidden="true" className={cn('size-3.5', loading && 'animate-spin')} />
      {loading ? 'Buscando…' : 'Buscar de nuevo'}
    </button>
  );
}

export function RatesSkeleton() {
  return (
    <div aria-hidden="true" className="divide-y divide-[var(--color-border)]">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2 px-4 py-3">
          <div className="flex justify-between gap-3">
            <div className="h-5 w-28 animate-pulse rounded-full bg-[var(--color-surface-muted)]" />
            <div className="h-5 w-20 animate-pulse rounded bg-[var(--color-surface-muted)]" />
          </div>
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        </div>
      ))}
    </div>
  );
}

/** Sin búsqueda de origen: la ficha se ve igual, las tarifas piden fechas y nacionalidad. */
export function RatesNeedSearch() {
  return (
    <div className="px-4 py-8 text-center">
      <BedDouble aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
      <p className="text-sm font-medium text-[var(--color-fg)]">
        Para ver tarifas, abrí este hotel desde una búsqueda.
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
        Las tarifas dependen de las fechas, las habitaciones y la nacionalidad del pasajero
        principal. Las búsquedas se recuerdan en este navegador durante la jornada.
      </p>
      <Link
        href="/hoteles"
        className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-xs font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
      >
        <Search aria-hidden="true" className="size-3.5" />
        Buscar hoteles
      </Link>
    </div>
  );
}

interface HotelDetailRatesProps {
  stay: HotelStay;
  nights: number;
  showProvider: boolean;
  rates: HotelDetailRatesResult | undefined;
  loading: boolean;
  onReload: () => void;
  /** Nombre y dirección con que cada proveedor conoce al hotel. */
  facts: ReadonlyMap<string, HotelFacts>;
  /** Los del encabezado de la página. */
  shownFacts: HotelFacts | undefined;
}

export function HotelDetailRates({
  stay,
  nights,
  showProvider,
  rates,
  loading,
  onReload,
  facts,
  shownFacts,
}: HotelDetailRatesProps) {
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [expiredCutoffMs, setExpiredCutoffMs] = useState<number | undefined>(undefined);

  // `expiresAt` lo fija el servidor: el contador corre con SU reloj, como en el listado.
  const receivedAt = rates?.receivedAt;
  useEffect(() => {
    if (receivedAt !== undefined) setClockOffsetMs(receivedAt - Date.now());
  }, [receivedAt]);

  const view = useMemo(
    () => (rates === undefined ? undefined : detailRatesView(rates, showProvider)),
    [rates, showProvider],
  );
  const expired = (row: HotelRateRow) =>
    expiredCutoffMs !== undefined && isRateExpired(row.expiresAt, expiredCutoffMs);

  if (rates === undefined || view === undefined) {
    return (
      <div aria-busy="true">
        <p className="sr-only" role="status">
          Buscando tarifas…
        </p>
        <RatesSkeleton />
      </div>
    );
  }

  if (rates.error) {
    return (
      <div className="p-4">
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{rates.error}</p>
          <RetryButton onClick={onReload} loading={loading} />
        </div>
      </div>
    );
  }

  const count = view.rows.length;
  const provisional = view.rows.some((r) => r.pack.cancellation.policySource !== 'prebook-final');
  return (
    <div
      aria-busy={loading}
      className={cn('space-y-3 p-4 transition-opacity', loading && 'opacity-60')}
    >
      <FailedProvidersNotice failed={view.failed} />
      {count === 0 ? (
        <EmptyRates view={view} onRetry={onReload} loading={loading} />
      ) : (
        <>
          <OfferExpiry
            hotels={view.offers}
            clockOffsetMs={clockOffsetMs}
            onCutoffChange={setExpiredCutoffMs}
            onSearchAgain={onReload}
            searching={loading}
          >
            <p>
              {count} tarifa{count === 1 ? '' : 's'} · precios de venta por la estadía completa
            </p>
          </OfferExpiry>
          {provisional ? (
            <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
              <Info aria-hidden="true" className="mt-px size-3 shrink-0" />
              Políticas de cancelación y precio por noche sujetos a confirmación: se confirman al
              revisar la tarifa, antes de reservar.
            </p>
          ) : null}
          <ul className="-mx-4 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {view.rows.map((row) => {
              const seller = row.pack.provider?.name;
              const note =
                seller === undefined ? undefined : sellingHotelNote(facts.get(seller), shownFacts);
              return (
                <RateItem key={row.key} row={row} expired={expired(row)}>
                  <RateDetailExtras
                    pack={row.pack}
                    checkinDate={stay.checkinDate}
                    nights={nights}
                    sellingNote={note}
                  />
                </RateItem>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function EmptyRates({
  view,
  onRetry,
  loading,
}: {
  view: Parameters<typeof emptyRatesView>[0];
  onRetry: () => void;
  loading: boolean;
}) {
  const text = emptyRatesView(view);
  return (
    <div className="px-4 py-8 text-center">
      <div role="status">
        <BedDouble
          aria-hidden="true"
          className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
        />
        <p className="text-sm font-medium text-[var(--color-fg)]">{text.title}</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">{text.hint}</p>
      </div>
      {/* Si faltó un proveedor, vale la pena volver a preguntar; si todos dijeron que no hay
          lugar, repetir la misma búsqueda no cambia nada. */}
      {view.failed.length > 0 ? (
        <div className="mt-4 flex justify-center">
          <RetryButton onClick={onRetry} loading={loading} />
        </div>
      ) : null}
    </div>
  );
}
