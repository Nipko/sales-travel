'use client';

import { ChevronDown, Plane } from 'lucide-react';
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
      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)]/8 text-[var(--color-primary)] border border-[var(--color-primary)]/10 shadow-[var(--shadow-xs)] animate-pulse">
        <span className="font-mono text-xs font-black tracking-wider uppercase">{carrier}</span>
      </div>
    );
  }

  return (
    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white border border-[var(--color-border)] p-1.5 shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] transition-shadow">
      <img
        src={`https://pics.avs.io/60/60/${carrier}.png`}
        alt={carrier}
        width={36}
        height={36}
        className="size-full object-contain rounded"
        onError={() => setFailed(true)}
      />
    </div>
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
    <div className="grid flex-1 grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-4 sm:gap-6">
      {/* Label (Ida/Vuelta) */}
      {label && (
        <span className="hidden text-[9px] font-extrabold uppercase tracking-widest text-[var(--color-primary)] bg-[var(--color-primary)]/8 px-2 py-1 rounded border border-[var(--color-primary)]/10 sm:block min-w-[65px] text-center">
          {label}
        </span>
      )}
      {!label && <span className="hidden sm:block min-w-[65px]" />}

      {/* Departure */}
      <div className="min-w-[80px]">
        <p className="font-mono text-base font-bold tabular-nums text-[var(--color-fg)] leading-none">
          {formatTime(first.departureAt)}
        </p>
        <p className="text-[11px] font-semibold text-[var(--color-fg-muted)] mt-1.5 leading-none">
          {first.origin}
        </p>
        <p className="text-[10px] text-[var(--color-fg-subtle)] mt-1 leading-none font-medium">
          {formatDate(first.departureAt)}
        </p>
      </div>

      {/* Duration + stops */}
      <div className="flex flex-col items-center gap-1 min-w-[120px] px-2">
        <p className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          {formatDuration(itinerary.totalDurationMinutes)}
        </p>

        {/* Modern timeline line */}
        <div className="relative flex w-full items-center justify-between text-[var(--color-fg-subtle)]">
          <span className="size-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)]" />
          <span className="h-[2px] flex-1 bg-gradient-to-r from-[var(--color-border)] via-[var(--color-border-strong)] to-[var(--color-border)] mx-1" />
          <Plane className="size-3 text-[var(--color-primary)] shrink-0 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transform bg-[var(--color-surface)] px-0.5 rounded-full" />
          <span className="size-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)]" />
        </div>

        {itinerary.stops === 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-success)]/10 px-2 py-0.5 text-[9px] font-bold text-[var(--color-success)]">
            <span className="size-1 rounded-full bg-[var(--color-success)] animate-pulse" />
            Directo
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warning)]/10 px-2 py-0.5 text-[9px] font-bold text-[var(--color-warning)]">
            {itinerary.stops} {itinerary.stops === 1 ? 'escala' : 'escalas'}
          </span>
        )}
      </div>

      {/* Arrival */}
      <div className="text-right min-w-[80px]">
        <p className="font-mono text-base font-bold tabular-nums text-[var(--color-fg)] leading-none">
          {formatTime(last.arrivalAt)}
        </p>
        <p className="text-[11px] font-semibold text-[var(--color-fg-muted)] mt-1.5 leading-none">
          {last.destination}
        </p>
        <p className="text-[10px] text-[var(--color-fg-subtle)] mt-1 leading-none font-medium">
          {formatDate(last.arrivalAt)}
        </p>
      </div>

      {/* Carrier info */}
      <div className="hidden text-right lg:block min-w-[90px]">
        <span className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/70 px-2 py-1 text-[10px] font-bold font-mono text-[var(--color-fg-muted)]">
          {first.carrier} {first.flightNumber}
        </span>
        {first.carrier !== (first as { operatingCarrier?: string }).operatingCarrier &&
          (first as { operatingCarrier?: string }).operatingCarrier && (
            <p className="text-[9px] text-[var(--color-fg-subtle)] mt-1.5 font-medium leading-none">
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
        'rounded-xl border bg-[var(--color-surface)] transition-all duration-300 overflow-hidden',
        expanded
          ? 'border-[var(--color-primary)]/45 shadow-[var(--shadow-md)] ring-1 ring-[var(--color-primary)]/10'
          : 'border-[var(--color-border)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)] hover:translate-y-[-1px]',
      )}
    >
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-4 p-5 text-left cursor-pointer focus:outline-none"
      >
        {/* Airline logo */}
        <AirlineLogo carrier={carrier} />

        {/* Flight legs */}
        <div className="flex flex-1 flex-col gap-4">
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
        <div className="hidden w-36 flex-col items-end md:flex pl-4 border-l border-[var(--color-border)]/50">
          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-fg-subtle)]">
            {hasMultipleFares ? 'Desde' : 'Total'}
          </p>
          <p className="font-mono text-xl font-extrabold tabular-nums text-[var(--color-fg)] tracking-tight leading-none mt-1">
            {formatMoney(cheapest.total.amountMinor, cheapest.total.currency)}
          </p>
          <div className="flex flex-col items-end gap-1 mt-2.5">
            {isRoundtrip && (
              <span className="inline-flex rounded-full bg-[var(--color-primary)]/8 border border-[var(--color-primary)]/10 px-2 py-0.5 text-[9px] font-bold text-[var(--color-primary)]">
                Ida y vuelta
              </span>
            )}
            {cheapest.fareFamily && (
              <span className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[9px] font-bold text-[var(--color-fg-muted)]">
                {cheapest.fareFamily.name}
              </span>
            )}
          </div>
        </div>

        {/* Expand toggle */}
        {hasMultipleFares && (
          <div className="flex flex-col items-center gap-1 pl-2">
            <div
              className={cn(
                'flex size-7 items-center justify-center rounded-full bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-all duration-300',
                expanded &&
                  'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20 text-[var(--color-primary)]',
              )}
            >
              <ChevronDown
                className={cn('size-4 transition-transform duration-300', expanded && 'rotate-180')}
              />
            </div>
            <span className="text-[9px] font-bold text-[var(--color-fg-subtle)] whitespace-nowrap">
              {group.offers.length} tarifas
            </span>
          </div>
        )}
      </button>

      {/* Mobile price (visible only on small screens) */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)]/50 px-5 py-3 md:hidden bg-[var(--color-surface-muted)]/20">
        <div className="flex items-center gap-2">
          {isRoundtrip && (
            <span className="rounded-full bg-[var(--color-primary)]/8 border border-[var(--color-primary)]/10 px-2.5 py-0.5 text-[9px] font-bold text-[var(--color-primary)]">
              Ida y vuelta
            </span>
          )}
          {cheapest.fareFamily && (
            <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-[9px] font-bold text-[var(--color-fg-muted)]">
              {cheapest.fareFamily.name}
            </span>
          )}
        </div>
        <div className="text-right">
          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-fg-subtle)]">
            {hasMultipleFares ? 'Desde' : 'Total'}
          </p>
          <p className="font-mono text-base font-black tabular-nums text-[var(--color-fg)]">
            {formatMoney(cheapest.total.amountMinor, cheapest.total.currency)}
          </p>
        </div>
      </div>

      {/* Expanded: fare family matrix */}
      {expanded && (
        <div className="border-t border-[var(--color-border)]/60 bg-[var(--color-surface-muted)]/30 p-5 animate-fade-in-up">
          <FareFamilyMatrix fares={group.offers} formatMoney={formatMoney} onQuote={onQuote} />
        </div>
      )}
    </div>
  );
}
