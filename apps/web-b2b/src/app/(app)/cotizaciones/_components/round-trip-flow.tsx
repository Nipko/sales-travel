'use client';

import { ArrowLeft, Check, Loader2, Plane } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchReturnsAction, type Offer } from '../actions';
import { cn } from '../../../../lib/cn';
import { saleBreakdown } from '../../../../lib/sale-breakdown';
import { airlineName } from './airline-names';
import type { FareChoiceMode } from './fare-family-matrix';
import { FlightRow, type FlightGroup } from './flight-row';
import { groupByLeg, legFare, mergeReturns, returnsFromSearch } from './leg-selection';

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
  criteria: RoundTripCriteria;
  showProvider: boolean;
  /** Filtros y cabecera de la lista de idas: sólo tienen sentido en el paso 1. */
  outboundHeader: React.ReactNode;
  /** Aviso por vuelo (tarifa simulada, etc.) que la pantalla quiera pintar sobre cada fila. */
  rowNotice?: (group: FlightGroup) => React.ReactNode;
  formatMoney: (amountMinor: number, currency: string) => string;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatDuration: (minutes: number) => string;
  onQuote: (offer: Offer) => Promise<void>;
}

const OUTBOUND_CHOICE: FareChoiceMode = {
  leg: 0,
  actionLabel: 'Elegir esta ida',
  priceLabel: 'Ida y vuelta desde',
  confirmsSave: false,
};

const RETURN_CHOICE: FareChoiceMode = {
  leg: 1,
  actionLabel: 'Guardar cotización',
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
  criteria,
  showProvider,
  outboundHeader,
  rowNotice,
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

  // Una búsqueda nueva empieza otra vez por la ida.
  useEffect(() => {
    pedido.current += 1;
    setOutbound(null);
    setReturns({ status: 'loading' });
  }, [allOffers]);

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

  const returnGroups = useMemo(() => {
    if (returns.status !== 'ready') return [];
    return groupByLeg(returns.offers, 1).sort(
      (a, b) => saleBreakdown(a.offers[0]!).sellMinor - saleBreakdown(b.offers[0]!).sellMinor,
    );
  }, [returns]);

  const rowProps = { showProvider, formatMoney, formatTime, formatDate, formatDuration };

  return (
    <div ref={topRef} className="scroll-mt-6">
      <Steps step={outbound === null ? 1 : 2} />

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
                  fareChoice={OUTBOUND_CHOICE}
                  onQuote={chooseOutbound}
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

function Steps({ step }: { step: 1 | 2 }) {
  const items = [
    { n: 1, label: 'Elige la ida' },
    { n: 2, label: 'Elige la vuelta' },
  ] as const;
  return (
    <ol aria-label="Pasos de ida y vuelta" className="mb-4 flex items-center gap-2 text-sm">
      {items.map((item, index) => {
        const done = item.n < step;
        const current = item.n === step;
        return (
          <li key={item.n} className="flex items-center gap-2">
            {index > 0 ? (
              <span aria-hidden="true" className="h-px w-6 bg-[var(--color-border-strong)]" />
            ) : null}
            <span
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1 font-medium',
                current
                  ? 'bg-[var(--color-primary)]/10 text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-primary)]/25'
                  : 'text-[var(--color-fg-muted)]',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-xs font-semibold',
                  done || current
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                    : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : item.n}
              </span>
              {item.label}
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
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
        >
          <Plane className="size-4" />
        </span>
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
