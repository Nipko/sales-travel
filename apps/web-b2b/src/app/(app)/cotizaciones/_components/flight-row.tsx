'use client';

import { ArrowRight, ChevronDown } from 'lucide-react';
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
  onQuote?: (offer: Offer) => Promise<void>;
}

interface Itinerary {
  segments: {
    carrier: string;
    flightNumber: string;
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    durationMinutes: number;
    cabin: string;
    bookingClass: string;
  }[];
  totalDurationMinutes: number;
  stops: number;
}

function AirlineLogo({ carrier }: { carrier: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
        <span className="font-mono text-xs font-bold">{carrier}</span>
      </div>
    );
  }

  return (
    <img
      src={`https://pics.avs.io/60/60/${carrier}.png`}
      alt={carrier}
      width={40}
      height={40}
      className="size-10 shrink-0 rounded-lg object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function ItineraryLeg({
  itinerary,
  label,
  formatTime,
  formatDate,
  formatDuration,
}: {
  itinerary: Itinerary;
  label?: string;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatDuration: (minutes: number) => string;
}) {
  const first = itinerary.segments[0]!;
  const last = itinerary.segments[itinerary.segments.length - 1]!;

  return (
    <div className="grid flex-1 grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-3">
      {/* Label (Ida/Vuelta) */}
      {label && (
        <span className="hidden text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)] sm:block">
          {label}
        </span>
      )}
      {!label && <span className="hidden sm:block" />}

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
            itinerary.stops === 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-fg-subtle)]',
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

      {/* Carrier info */}
      <div className="hidden text-right lg:block">
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
    </div>
  );
}

export function FlightRow({
  group,
  formatMoney,
  formatTime,
  formatDate,
  formatDuration,
  onQuote,
}: FlightRowProps) {
  const [expanded, setExpanded] = useState(false);
  const cheapest = group.offers[0]!;
  const itineraries = cheapest.itineraries ?? [];
  const isRoundtrip = itineraries.length > 1;
  const firstItinerary = itineraries[0];

  if (!firstItinerary?.segments[0]) return null;

  const hasMultipleFares = group.offers.length > 1;
  const carrier = firstItinerary.segments[0].carrier;

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
        {/* Airline logo */}
        <AirlineLogo carrier={carrier} />

        {/* Flight legs */}
        <div className="flex flex-1 flex-col gap-3">
          {itineraries.map((it, i) => (
            <ItineraryLeg
              key={i}
              itinerary={it}
              label={isRoundtrip ? (i === 0 ? 'Ida' : 'Vuelta') : undefined}
              formatTime={formatTime}
              formatDate={formatDate}
              formatDuration={formatDuration}
            />
          ))}
        </div>

        {/* Price block */}
        <div className="hidden w-32 flex-col items-end md:flex">
          <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {hasMultipleFares ? 'Desde' : 'Total'}
          </p>
          <p className="font-mono text-lg font-bold tabular-nums text-[var(--color-fg)]">
            {formatMoney(cheapest.total.amountMinor, cheapest.total.currency)}
          </p>
          {isRoundtrip && (
            <span className="mt-0.5 rounded-full bg-[var(--color-primary)]/8 px-2 py-0.5 text-[10px] font-medium text-[var(--color-primary)]">
              Ida y vuelta
            </span>
          )}
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
        <div className="flex items-center gap-2">
          {isRoundtrip && (
            <span className="rounded-full bg-[var(--color-primary)]/8 px-2 py-0.5 text-[10px] font-medium text-[var(--color-primary)]">
              Ida y vuelta
            </span>
          )}
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
          <FareFamilyMatrix fares={group.offers} formatMoney={formatMoney} onQuote={onQuote} />
        </div>
      )}
    </div>
  );
}
