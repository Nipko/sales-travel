'use client';

import {
  Ban,
  BedDouble,
  Info,
  Moon,
  RefreshCw,
  Search,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../../../lib/cn';
import type { HotelRoompack } from '../../actions';
import { formatMoney } from '../../_components/hotel-format';
import { testAccountView } from '../../_components/hotel-provider-view';
import type { HotelRateRow } from '../../_components/hotel-rate-view';
import type { HotelStay } from '../../_components/hotel-search-handoff';
import { isRateExpired, OfferExpiry } from '../../_components/offer-expiry';
import { RateBookAction } from '../../_components/rate-book-action';
import type { RateRefundability } from '../../_components/rate-refundability';
import { groupRoomContent } from '../../_components/room-content-match';
import type { RoomContentState } from '../../_components/room-content-view';
import { roomTypesCountText } from '../../_components/room-type-groups';
import { RoomTypeList } from '../../_components/room-type-list';
import { TestAccountNotice } from '../../_components/test-account-notice';
import { useBookRate } from '../../_components/use-book-rate';
import type { HotelDetailRatesResult } from '../actions';
import {
  detailRatesView,
  emptyRatesView,
  ratesRefundNotice,
  type DetailRatePlan,
  type FailedProvider,
  type RatesRefundNotice,
} from './hotel-detail-view';
import {
  nightlySale,
  ratePolicyView,
  sellingHotelNote,
  uniformNightPrice,
  type HotelFacts,
  type NightPrice,
  type RatePolicyView,
} from './hotel-rate-detail-view';

/*
 * Las tarifas del hotel para la estadía de la búsqueda (D-TBO-19 A): una búsqueda nueva de este
 * solo hotel en cada proveedor que lo vende, con las políticas por tramos y el precio por noche
 * "sujetos a confirmación". El PreBook los confirma. Se pintan por tipo de habitación, como en la
 * tarjeta del listado, y cada plan abre sus tramos en «Ver condiciones».
 *
 * Una no reembolsable (declarada, o con el 100 % ya vigente) dice cuánto se pierde con su monto
 * (pedido del 2026-09-29, punto b); si quien financia a la agencia las bloqueó, se marca como no
 * disponible y no se ofrece reservarla (punto e).
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

/**
 * El aviso del hotel cuando NINGUNA de sus tarifas es reembolsable, arriba de la lista: el vendedor
 * lo lee antes de elegir, no tarifa por tarifa. Con el color de advertencia de la etiqueta "No
 * reembolsable"; si además la agencia no las puede reservar, el de peligro: no hay qué reservar.
 */
export function RatesRefundNoticeBox({ notice }: { notice: RatesRefundNotice | undefined }) {
  if (notice === undefined) return null;
  if (notice === 'blocked-all') {
    return (
      <div
        role="note"
        className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
      >
        <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
        <div className="space-y-0.5">
          <p className="font-semibold">
            Tu agencia no puede reservar este hotel para estas fechas.
          </p>
          <p className="text-xs">
            Todas sus tarifas son no reembolsables y quien financia a tu agencia bloqueó ese tipo de
            tarifa. Prueba con otras fechas u otro hotel.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-lg border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-0.5">
        <p className="font-semibold">
          Este hotel no tiene tarifas reembolsables para estas fechas.
        </p>
        <p className="text-xs">
          Si se cancela, se modifica o el pasajero no se presenta, se cobra el 100 % de la tarifa
          elegida (el monto está en cada una): no se recupera, se descuenta de la cartera o del
          crédito de la agencia y la agencia responde ante su cliente.
        </p>
      </div>
    </div>
  );
}

/**
 * Lo que una tarifa de la ficha dice a la vista, sin abrir «Ver condiciones»: cuánto se pierde si
 * es no reembolsable (pedido del 2026-09-29, punto b) y con qué nombre figura el hotel en la reserva
 * cuando lo vende otro proveedor.
 */
function RateDetailNotice({
  sale,
  refund,
  sellingNote,
}: {
  sale: HotelRateRow['sale'];
  refund: RateRefundability;
  sellingNote: string | undefined;
}) {
  if (refund.refundable && !sellingNote) return null;
  return (
    <>
      {!refund.refundable ? (
        <p className="flex items-start gap-1.5 rounded-md border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-fg)]">
          <ShieldAlert aria-hidden="true" className="mt-px size-3 shrink-0" />
          <span>
            Si se cancela, se modifica o el pasajero no se presenta, se cobra el 100 %:{' '}
            <span className="whitespace-nowrap font-semibold tabular-nums">
              {formatMoney(sale)}
            </span>
            . No se recupera y la agencia responde ante su cliente.
          </span>
        </p>
      ) : null}
      {sellingNote ? (
        <p className="flex items-start gap-1 text-[11px] text-[var(--color-fg-muted)]">
          <Info aria-hidden="true" className="mt-px size-3 shrink-0" />
          {sellingNote}
        </p>
      ) : null}
    </>
  );
}

/** Tramos de la política y precio por noche de una tarifa; `undefined` si no hay ninguno. */
interface RateDetailParts {
  readonly policy?: RatePolicyView;
  readonly perNight?: readonly NightPrice[];
}

function rateDetailParts(
  pack: HotelRoompack,
  checkinDate: string,
  nights: number,
): RateDetailParts | undefined {
  const policy = ratePolicyView(pack);
  const perNight = nightlySale(pack, checkinDate, nights);
  if (policy === undefined && perNight === undefined) return undefined;
  return {
    ...(policy === undefined ? {} : { policy }),
    ...(perNight === undefined ? {} : { perNight }),
  };
}

/** Lo que la ficha suma dentro de «Ver condiciones»: los tramos y el precio por noche. */
function RateDetailExtras({ parts: { policy, perNight } }: { parts: RateDetailParts }) {
  const uniform = perNight === undefined ? undefined : uniformNightPrice(perNight);

  return (
    <>
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
      {/* Ya dentro de «Ver condiciones»: el desglose va abierto, sin otro desplegable. */}
      {perNight !== undefined && uniform === undefined ? (
        <div className="text-[11px] text-[var(--color-fg-muted)]">
          <p className="flex items-center gap-1 font-medium text-[var(--color-fg)]">
            <Moon aria-hidden="true" className="size-3 shrink-0" />
            Precio por noche (aprox., sujeto a confirmación)
          </p>
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
        </div>
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
        Para ver tarifas, abre este hotel desde una búsqueda.
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
  /** El hotel, para volver a él desde el checkout. */
  hotelKey: string;
  /** La búsqueda desde la que se abrió el detalle. */
  searchToken: string | undefined;
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
  /**
   * Fotos, tamaño y descripción de las habitaciones según el catálogo del proveedor (TBO-07): se
   * piden junto con las tarifas y llegan por su cuenta. Sin ellas, cada tipo con su icono.
   */
  roomContent?: RoomContentState;
}

const NO_ROOM_CONTENT: RoomContentState = { status: 'idle' };

export function HotelDetailRates({
  hotelKey,
  searchToken,
  stay,
  nights,
  showProvider,
  rates,
  loading,
  onReload,
  facts,
  shownFacts,
  roomContent = NO_ROOM_CONTENT,
}: HotelDetailRatesProps) {
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [expiredCutoffMs, setExpiredCutoffMs] = useState<number | undefined>(undefined);

  // `expiresAt` lo fija el servidor: el contador corre con SU reloj, como en el listado.
  const receivedAt = rates?.receivedAt;
  useEffect(() => {
    if (receivedAt !== undefined) setClockOffsetMs(receivedAt - Date.now());
  }, [receivedAt]);

  const view = useMemo(
    () =>
      rates === undefined
        ? undefined
        : detailRatesView(
            rates,
            showProvider,
            (row) => expiredCutoffMs !== undefined && isRateExpired(row.expiresAt, expiredCutoffMs),
          ),
    [rates, showProvider, expiredCutoffMs],
  );
  const expired = (row: HotelRateRow) =>
    expiredCutoffMs !== undefined && isRateExpired(row.expiresAt, expiredCutoffMs);
  // El detalle no trae `providers[]`: cada proveedor dice el entorno de su cuenta en su parte.
  const testAccount = useMemo(
    () =>
      testAccountView(
        (rates?.outcomes ?? []).map((o) => ({
          code: o.ref.provider,
          accountEnvironment: o.accountEnvironment,
          count: o.offer?.roompacks.length ?? 0,
        })),
        showProvider,
      ),
    [rates, showProvider],
  );
  const blocked = rates?.nonRefundableBlocked === true;
  // Con la hora en que llegaron las tarifas (detailRatesView): una reembolsable cuyo 100 % ya rige
  // es no reembolsable, y si la agencia no las puede reservar, no se ofrecen.
  const unavailable = (plan: DetailRatePlan) => blocked && !plan.refund.refundable;

  const { canBook, book } = useBookRate({
    hotelKey,
    searchToken,
    stay,
    showProvider,
    shownFacts,
    factsFor: (providerCode) => facts.get(providerCode),
  });

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
  const refundNotice = ratesRefundNotice(
    view.groups.flatMap((g) => g.plans.map((p) => p.refund)),
    blocked,
  );
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
              {roomTypesCountText(view.groups.length, count)} · precios de venta por la estadía
              completa
            </p>
          </OfferExpiry>
          <TestAccountNotice view={testAccount} />
          <RatesRefundNoticeBox notice={refundNotice} />
          {provisional ? (
            <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
              <Info aria-hidden="true" className="mt-px size-3 shrink-0" />
              Políticas de cancelación y precio por noche sujetos a confirmación: se confirman al
              revisar la tarifa, antes de reservar.
            </p>
          ) : null}
          <div className="-mx-4 border-t border-[var(--color-border)]">
            <RoomTypeList
              groups={view.groups}
              nights={nights}
              roomsCount={stay.rooms.length}
              variant="detail"
              isExpired={(plan) => expired(plan.row)}
              isUnavailable={unavailable}
              testAccountCodes={testAccount.codes}
              roomContent={(group) => groupRoomContent(group, roomContent)}
              planNotice={({ row, refund }) => {
                const seller = row.pack.provider?.name;
                const note =
                  seller === undefined
                    ? undefined
                    : sellingHotelNote(facts.get(seller), shownFacts);
                return <RateDetailNotice sale={row.sale} refund={refund} sellingNote={note} />;
              }}
              planDetails={({ row }) => {
                const parts = rateDetailParts(row.pack, stay.checkinDate, nights);
                return parts === undefined ? null : <RateDetailExtras parts={parts} />;
              }}
              planAction={(plan) =>
                unavailable(plan) ? null : (
                  <RateBookAction
                    row={plan.row}
                    bookable={canBook(plan.row)}
                    expired={expired(plan.row)}
                    unavailableForAgency={false}
                    onBook={() => book(plan.row)}
                  />
                )
              }
            />
          </div>
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
