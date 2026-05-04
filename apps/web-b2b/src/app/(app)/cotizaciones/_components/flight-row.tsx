'use client';

import { ArrowRight, ChevronDown, Plane } from 'lucide-react';
import { useState } from 'react';
import type { Offer } from '../actions';
import { cn } from '../../../../lib/cn';
import { FareFamilyMatrix } from './fare-family-matrix';

export interface FlightGroup {
  key: string;
  offers: Offer[];
}

interface FlightRowProps {
  group: FlightGroup;
  formatMoney: (amountMinor: number, currency: string) => string;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatDuration: (minutes: number) => string;
}

export function FlightRow({
  group,
  formatMoney,
  formatTime,
  formatDate,
  formatDuration,
}: FlightRowProps) {
  const [expanded, setExpanded] = useState(false);
  const cheapest = group.offers[0]!;
  const itinerary = cheapest.itineraries?.[0];
  const first = itinerary?.segments[0];
  const last = itinerary?.segments[itinerary.segments.length - 1];

  if (!itinerary || !first || !last) return null;

  const hasMultipleFares = group.offers.length > 1;

  return (
    <div
      className={cn(
        'rounded-xl border bg-[var(--color-surface)] transition-all duration-200',
        expanded
          ? 'border-[var(--color-primary)]/30 shadow-[var(--shadow-md)]'
          : 'border-[var(--color-border)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)]',
      )}
    >
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-4 p-5 text-left"
      >
        {/* Airline badge */}
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
          <Plane className="size-4" />
        </div>

        {/* Flight info */}
        <div className="grid flex-1 grid-cols-[1fr_auto_1fr] items-center gap-3">
          {/* Departure */}
          <div>
            <p className="font-mono text-[15px] font-semibold tabular-nums text-[var(--color-fg)]">
              {formatTime(first.departureAt)}
            </p>
            <p className="text-xs text-[var(--color-fg-muted)]">
              {first.origin} · {formatDate(first.departureAt)}
            </p>
          </div>

          {/* Duration + stops */}
          <div className="flex flex-col items-center gap-0.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
              {formatDuration(itinerary.totalDurationMinutes)}
            </p>
            <div className="flex items-center text-[var(--color-fg-subtle)]">
              <span className="h-px w-6 bg-[var(--color-border-strong)] sm:w-10" />
              <ArrowRight className="mx-0.5 size-3" />
              <span className="h-px w-6 bg-[var(--color-border-strong)] sm:w-10" />
            </div>
            <span
              className={cn(
                'text-[10px] font-medium',
                itinerary.stops === 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-fg-subtle)]',
              )}
            >
              {itinerary.stops === 0
                ? 'Directo'
                : `${itinerary.stops} escala${itinerary.stops > 1 ? 's' : ''}`}
            </span>
          </div>

          {/* Arrival */}
          <div className="text-right">
            <p className="font-mono text-[15px] font-semibold tabular-nums text-[var(--color-fg)]">
              {formatTime(last.arrivalAt)}
            </p>
            <p className="text-xs text-[var(--color-fg-muted)]">
              {last.destination} · {formatDate(last.arrivalAt)}
            </p>
          </div>
        </div>

        {/* Carrier info (hidden on small) */}
        <div className="hidden w-20 text-right lg:block">
          <p className="font-mono text-[11px] font-medium text-[var(--color-fg-muted)]">
            {first.carrier} {first.flightNumber}
          </p>
          {first.carrier !== (first as { operatingCarrier?: string }).operatingCarrier &&
            (first as { operatingCarrier?: string }).operatingCarrier && (
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                Op. {(first as { operatingCarrier?: string }).operatingCarrier}
              </p>
            )}
        </div>

        {/* Price block */}
        <div className="hidden w-32 flex-col items-end md:flex">
          <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {hasMultipleFares ? 'Desde' : 'Total'}
          </p>
          <p className="font-mono text-lg font-bold tabular-nums text-[var(--color-fg)]">
            {formatMoney(cheapest.total.amountMinor, cheapest.total.currency)}
          </p>
          {cheapest.fareFamily && (
            <span className="mt-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              {cheapest.fareFamily.name}
            </span>
          )}
        </div>

        {/* Expand toggle */}
        {hasMultipleFares && (
          <div className="flex flex-col items-center gap-0.5">
            <ChevronDown
              className={cn(
                'size-5 text-[var(--color-fg-muted)] transition-transform duration-200',
                expanded && 'rotate-180',
              )}
            />
            <span className="text-[10px] text-[var(--color-fg-subtle)]">
              {group.offers.length} tarifas
            </span>
          </div>
        )}
      </button>

      {/* Mobile price (visible only on small screens) */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-5 py-3 md:hidden">
        <div>
          {cheapest.fareFamily && (
            <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              {cheapest.fareFamily.name}
            </span>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] text-[var(--color-fg-subtle)]">
            {hasMultipleFares ? 'Desde' : 'Total'}
          </p>
          <p className="font-mono text-base font-bold tabular-nums text-[var(--color-fg)]">
            {formatMoney(cheapest.total.amountMinor, cheapest.total.currency)}
          </p>
        </div>
      </div>

      {/* Expanded: fare family matrix */}
      {expanded && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 p-5">
          <FareFamilyMatrix fares={group.offers} formatMoney={formatMoney} />
        </div>
      )}
    </div>
  );
}
