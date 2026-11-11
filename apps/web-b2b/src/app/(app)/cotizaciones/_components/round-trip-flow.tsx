'use client';

import { ArrowLeft, Check, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchMoreFaresAction, searchReturnsAction, type Offer } from '../actions';
import { cn } from '../../../../lib/cn';
import { saleBreakdown } from '../../../../lib/sale-breakdown';
import { airlineName } from './airline-names';
import type { FareChoiceMode } from './fare-family-matrix';
import { AirlineLogo, FlightRow, type FlightGroup } from './flight-row';
import { groupByLeg, legFare, mergeReturns, returnsFromSearch } from './leg-selection';
import { mergeOffers, singleCarrier } from './more-fares';

/** Los criterios de la búsqueda que produjo los resultados (los mismos de la cotización). */
export interface RoundTripCriteria {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  paxCount: { adults: number; children: number; infants: number };
  cabin: string;
}

interface RoundTripFlowProps {
  /** Vuelos de ida, ya filtrados y ordenados por la pantalla. */
  outboundGroups: FlightGroup[];
  /** Todas las combinaciones de la búsqueda: la red si no se pueden consultar las vueltas. */
  allOffers: Offer[];
  /** Cambia con cada búsqueda nueva (y sólo entonces): ahí se vuelve a empezar por la ida. */
  searchKey: unknown;
  /** Más tarifas de una ida, al abrirla (docs/platform/18). */
  onLoadMoreFares?: (group: FlightGroup, leg: number) => Promise<'ok' | 'error'>;
  criteria: RoundTripCriteria;
  showProvider: boolean;
  /** Filtros y cabecera de la lista de idas: sólo tienen sentido en el paso 1. */
  outboundHeader: React.ReactNode;
  /** Aviso por vuelo (tarifa simulada, etc.) que la pantalla quiera pintar sobre cada fila. */
  rowNotice?: (group: FlightGroup) => React.ReactNode;
  /** «Más barato», «Más rápido» de cada ida, calculados por la pantalla sobre la lista filtrada. */
  tagsFor?: (group: FlightGroup) => readonly string[] | undefined;
  /** Avisa en qué paso está: la pantalla oculta los filtros de la ida mientras se elige la vuelta. */
  onStepChange?: (step: 1 | 2) => void;
  formatMoney: (amountMinor: number, currency: string) => string;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatDuration: (minutes: number) => string;
  onQuote: (offer: Offer) => Promise<void>;
}

const OUTBOUND_CHOICE: FareChoiceMode = {
  leg: 0,
  actionLabel: 'Elegir ida',
  priceLabel: 'Ida y vuelta desde',
  confirmsSave: false,
};

const RETURN_CHOICE: FareChoiceMode = {
  leg: 1,
  actionLabel: 'Elegir vuelta y continuar',
  priceLabel: 'Total ida y vuelta',
  confirmsSave: true,
};

type Returns = { status: 'loading' } | { status: 'ready'; offers: Offer[]; notice?: string };

/**
 * Ida y vuelta como en cualquier sitio de venta de vuelos: primero la ida y su tarifa, después
 * la vuelta y su tarifa (docs/sabre/15 §5).
 *
 * Cada precio es el total de una combinación cotizada por el proveedor. Elegida la ida, se piden
 * las vueltas que combinan con ella (Anchored Search en Sabre) y se juntan con las que ya trajo
 * la búsqueda; si el proveedor no sabe anclar o la consulta falla, quedan las de la búsqueda y la
 * pantalla lo dice.
 */
export function RoundTripFlow({
  outboundGroups,
  allOffers,
  searchKey,
  onLoadMoreFares,
  criteria,
  showProvider,
  outboundHeader,
  rowNotice,
  tagsFor,
  onStepChange,
  formatMoney,
  formatTime,
  formatDate,
  formatDuration,
  onQuote,
}: RoundTripFlowProps) {
  const [outbound, setOutbound] = useState<Offer | null>(null);
  const [returns, setReturns] = useState<Returns>({ status: 'loading' });
  const topRef = useRef<HTMLDivElement>(null);
  // Una respuesta que llega tarde de una ida ya cambiada no puede pisar la de la ida actual.
  const pedido = useRef(0);

  // Una búsqueda nueva empieza otra vez por la ida. NO las tarifas que se suman al abrir un vuelo:
  // por eso la clave es la búsqueda y no la lista de ofertas.
  useEffect(() => {
    pedido.current += 1;
    setOutbound(null);
    setReturns({ status: 'loading' });
  }, [searchKey]);

  /** Más tarifas de una vuelta, con la ida elegida fija. */
  const loadMoreReturnFares = useCallback(
    async (group: FlightGroup): Promise<'ok' | 'error'> => {
      const carrier = singleCarrier(group.offers[0]);
      if (outbound === null) return 'error';
      if (carrier === null) return 'ok';
      const res = await searchMoreFaresAction({
        known: group.offers,
        carrier,
        leg: 1,
        criteria,
        outbound,
      });
      if (!res.ok) return 'error';
      if (res.offers.length > 0) {
        setReturns((current) =>
          current.status === 'ready'
            ? { ...current, offers: mergeOffers(current.offers, res.offers) }
            : current,
        );
      }
      return 'ok';
    },
    [outbound, criteria],
  );

  const chooseOutbound = useCallback(
    async (offer: Offer) => {
      const turno = ++pedido.current;
      setOutbound(offer);
      setReturns({ status: 'loading' });
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

      const fromSearch = returnsFromSearch(allOffers, offer);
      const res = await searchReturnsAction(offer, criteria);
      if (turno !== pedido.current) return;

      if (res.ok && res.supported) {
        setReturns({ status: 'ready', offers: mergeReturns(res.offers, fromSearch) });
        return;
      }
      setReturns({
        status: 'ready',
        offers: fromSearch,
        notice: res.ok
          ? 'Este proveedor no permite buscar más vueltas para una ida: se muestran las de la búsqueda.'
          : 'No se pudieron consultar más vueltas: se muestran las de la búsqueda.',
      });
    },
    [allOffers, criteria],
  );

  function changeOutbound() {
    pedido.current += 1;
    setOutbound(null);
    setReturns({ status: 'loading' });
    setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  }

  useEffect(() => {
    onStepChange?.(outbound === null ? 1 : 2);
  }, [outbound, onStepChange]);

  const returnGroups = useMemo(() => {
    if (returns.status !== 'ready') return [];
    return groupByLeg(returns.offers, 1).sort(
      (a, b) => saleBreakdown(a.offers[0]!).sellMinor - saleBreakdown(b.offers[0]!).sellMinor,
    );
  }, [returns]);

  const rowProps = { showProvider, formatMoney, formatTime, formatDate, formatDuration };

  return (
    <div ref={topRef} className="scroll-mt-6">
      <Steps step={outbound === null ? 1 : 2} criteria={criteria} formatDate={formatDate} />

      {outbound === null ? (
        <>
          {outboundHeader}
          <div className="space-y-4">
            {outboundGroups.map((group) => (
              <div key={group.key}>
                {rowNotice?.(group)}
                <FlightRow
                  group={group}
                  {...rowProps}
                  {...(tagsFor?.(group) ? { tags: tagsFor(group) } : {})}
                  fareChoice={OUTBOUND_CHOICE}
                  onQuote={chooseOutbound}
                  {...(onLoadMoreFares ? { onLoadMoreFares } : {})}
                />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <ChosenOutbound
            offer={outbound}
            formatTime={formatTime}
            formatDate={formatDate}
            onChange={changeOutbound}
          />
          {returns.status === 'loading' ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-border-strong)]/60 bg-[var(--color-surface)] px-6 py-12 text-sm font-medium text-[var(--color-fg-muted)]"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Buscando vueltas para esta ida…
            </div>
          ) : (
            <>
              {returns.notice ? (
                <p className="mb-3 text-xs font-medium text-[var(--color-fg-muted)]">
                  {returns.notice}
                </p>
              ) : null}
              <p className="mb-3 text-sm font-medium text-[var(--color-fg-muted)]">
                {returnGroups.length === 1
                  ? '1 vuelta combina con esta ida'
                  : `${returnGroups.length} vueltas combinan con esta ida`}
              </p>
              {returnGroups.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border-strong)]/60 bg-[var(--color-surface)] px-6 py-12 text-center">
                  <p className="text-sm font-semibold text-[var(--color-fg)]">
                    No hay vueltas para esta ida con esa tarifa
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
                    Prueba con otra tarifa de ida u otro vuelo.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {returnGroups.map((group) => (
                    <FlightRow
                      key={group.key}
                      group={group}
                      {...rowProps}
                      fareChoice={RETURN_CHOICE}
                      onQuote={onQuote}
                      onLoadMoreFares={loadMoreReturnFares}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Steps({
  step,
  criteria,
  formatDate,
}: {
  step: 1 | 2;
  criteria: RoundTripCriteria;
  formatDate: (iso: string) => string;
}) {
  const day = (date: string | undefined) => (date ? formatDate(`${date}T12:00:00`) : '');
  const items = [
    {
      n: 1,
      label: 'Ida',
      detail: `${criteria.origin} → ${criteria.destination} · ${day(criteria.departureDate)}`,
    },
    {
      n: 2,
      label: 'Vuelta',
      detail: `${criteria.destination} → ${criteria.origin} · ${day(criteria.returnDate)}`,
    },
  ] as const;
  return (
    <ol aria-label="Pasos de ida y vuelta" className="mb-4 flex items-center gap-3 text-sm">
      {items.map((item, index) => {
        const done = item.n < step;
        const current = item.n === step;
        return (
          <li key={item.n} className={cn('flex min-w-0 items-center gap-3', index > 0 && 'flex-1')}>
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="h-px min-w-4 flex-1 bg-[var(--color-border-strong)]"
              />
            ) : null}
            <span
              aria-current={current ? 'step' : undefined}
              className="flex min-w-0 items-center gap-2"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  done || current
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                    : 'border border-[var(--color-border-strong)] text-[var(--color-fg-muted)]',
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} /> : item.n}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'block font-semibold',
                    current ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
                  )}
                >
                  {item.label}
                </span>
                <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                  {item.detail}
                </span>
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** La ida ya elegida, fija arriba mientras se elige la vuelta. */
function ChosenOutbound({
  offer,
  formatTime,
  formatDate,
  onChange,
}: {
  offer: Offer;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  onChange: () => void;
}) {
  const segments = offer.itineraries?.[0]?.segments ?? [];
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return null;
  const flights = segments.map((s) => `${s.carrier}${s.flightNumber}`).join(' + ');

  return (
    <section
      aria-label="Ida elegida"
      className="mb-4 flex flex-col gap-3 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AirlineLogo key={first.carrier} carrier={first.carrier} size="md" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
            Ida · {formatDate(first.departureAt)}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-[var(--color-fg)]">
            {formatTime(first.departureAt)} {first.origin} → {formatTime(last.arrivalAt)}{' '}
            {last.destination}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
            {airlineName(first.carrier)} · <span className="font-mono">{flights}</span> · Tarifa{' '}
            <strong className="font-semibold text-[var(--color-fg)]">
              {legFare(offer, 0).name}
            </strong>
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onChange}
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Cambiar ida
      </button>
    </section>
  );
}
