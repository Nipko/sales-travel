'use client';

import { airlineLogoUrl } from './airline-names';

import {
  Armchair,
  Briefcase,
  Check,
  CircleDollarSign,
  CircleHelp,
  Clock,
  Luggage,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { loadFullDataset } from '../../../../lib/airports';
import {
  connectionAlerts,
  connectionLabel,
  formatDurationShort,
  stopsLabel,
  type InclusionChip,
  type InclusionKey,
  type TimelineConnectionView,
  type TimelineLegView,
  type TimelineSegmentView,
} from './itinerary-timeline-view';

/*
 * El itinerario completo, tramo por tramo, en una línea de tiempo vertical: lo que el checkout
 * muestra antes de reservar y el detalle de la reserva después. Todo lo que decide qué se pinta
 * vive en `itinerary-timeline-view.ts`; aquí sólo hay forma.
 */

/** Ciudad de cada aeropuerto, del dataset que ya usa el buscador. Sin él, sólo el código. */
function useAirportCities(codes: readonly string[]): Readonly<Record<string, string>> {
  const [cities, setCities] = useState<Readonly<Record<string, string>>>({});
  const key = [...new Set(codes)].sort().join(',');
  useEffect(() => {
    let alive = true;
    const wanted = new Set(key.split(',').filter(Boolean));
    if (wanted.size === 0) return;
    void loadFullDataset()
      .then((airports) => {
        if (!alive) return;
        const found: Record<string, string> = {};
        for (const airport of airports) {
          if (wanted.has(airport.code) && airport.city) found[airport.code] = airport.city;
        }
        setCities(found);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return cities;
}

function CarrierMark({ carrier }: { carrier: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <span
        aria-hidden="true"
        className="font-mono text-[10px] font-bold text-[var(--color-fg-muted)]"
      >
        {carrier}
      </span>
      <img
        src={airlineLogoUrl(carrier)}
        alt=""
        width={32}
        height={32}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          'absolute inset-0 size-full bg-[var(--color-surface)] object-contain p-1',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </span>
  );
}

function DayOffset({ days }: { days: number }) {
  if (days <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-0.5 align-super text-[10px] font-bold text-[var(--color-fg-muted)]"
      >
        +{days}
      </span>
      <span className="sr-only">
        {' '}
        (llega {days} {days === 1 ? 'día' : 'días'} después)
      </span>
    </>
  );
}

function Place({
  time,
  date,
  airport,
  city,
  dayOffset = 0,
  showDate,
}: {
  time: string;
  date: string;
  airport: string;
  city?: string;
  dayOffset?: number;
  showDate: boolean;
}) {
  return (
    <>
      <div className="text-right">
        <p className="text-sm font-semibold leading-5 tabular-nums text-[var(--color-fg)]">
          {time}
          <DayOffset days={dayOffset} />
        </p>
        {showDate ? (
          <p className="text-[11px] leading-4 text-[var(--color-fg-muted)]">{date}</p>
        ) : null}
      </div>
      <div className="flex justify-center pt-1.5" aria-hidden="true">
        <span className="size-2.5 rounded-full border-2 border-[var(--color-fg-muted)] bg-[var(--color-surface)]" />
      </div>
      <p className="min-w-0 text-sm leading-5 text-[var(--color-fg)]">
        <span className="font-semibold">{airport}</span>
        {city ? <span className="text-[var(--color-fg-muted)]"> · {city}</span> : null}
      </p>
    </>
  );
}

function SegmentBlock({
  segment,
  cities,
}: {
  segment: TimelineSegmentView;
  cities: Readonly<Record<string, string>>;
}) {
  const facts = [
    segment.cabin,
    segment.bookingClass ? `Clase ${segment.bookingClass}` : undefined,
    segment.aircraft ? `Avión ${segment.aircraft}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const crossesDate = segment.departure.date !== segment.arrival.date;

  return (
    <li className="grid grid-cols-[3.75rem_1.25rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[4.5rem_1.5rem_minmax(0,1fr)] sm:gap-x-3">
      <Place
        time={segment.departure.time}
        date={segment.departure.date}
        airport={segment.departure.airport}
        city={cities[segment.departure.airport]}
        showDate={crossesDate}
      />

      <p className="pt-3 text-right text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
        {segment.durationMinutes === null ? null : (
          <>
            <span className="sr-only">Duración </span>
            {formatDurationShort(segment.durationMinutes)}
          </>
        )}
      </p>
      <div className="flex justify-center" aria-hidden="true">
        <span className="w-px bg-[var(--color-border-strong)]" />
      </div>
      <div className="my-2 flex min-w-0 items-start gap-2.5 rounded-lg bg-[var(--color-surface-muted)]/60 px-3 py-2.5">
        <CarrierMark key={segment.carrier} carrier={segment.carrier} />
        <div className="min-w-0 text-xs leading-5">
          <p className="font-medium text-[var(--color-fg)]">
            {segment.airline}{' '}
            <span className="font-mono text-[var(--color-fg-muted)]">· {segment.flight}</span>
          </p>
          {segment.operatedBy ? (
            <p className="font-medium text-[var(--color-fg)]">Operado por {segment.operatedBy}</p>
          ) : null}
          {facts.length > 0 ? (
            <p className="text-[var(--color-fg-muted)]">{facts.join(' · ')}</p>
          ) : null}
        </div>
      </div>

      <Place
        time={segment.arrival.time}
        date={segment.arrival.date}
        airport={segment.arrival.airport}
        city={cities[segment.arrival.airport]}
        dayOffset={segment.arrival.dayOffset}
        showDate={crossesDate}
      />
    </li>
  );
}

function ConnectionBlock({ connection }: { connection: TimelineConnectionView }) {
  const alerts = connectionAlerts(connection);
  return (
    <li className="grid grid-cols-[3.75rem_1.25rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[4.5rem_1.5rem_minmax(0,1fr)] sm:gap-x-3">
      <span />
      <div className="flex justify-center" aria-hidden="true">
        <span className="w-px border-l border-dashed border-[var(--color-border-strong)]" />
      </div>
      <div className="my-2 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
            alerts.length > 0
              ? 'bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
              : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
          )}
        >
          <Clock aria-hidden="true" className="size-3.5" />
          {connectionLabel(connection)}
        </span>
        {alerts.map((alert) => (
          <span
            key={alert}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-warning)]/40 px-2 py-0.5 text-[11px] font-semibold text-[var(--color-fg)]"
          >
            <TriangleAlert aria-hidden="true" className="size-3" />
            {alert}
          </span>
        ))}
      </div>
    </li>
  );
}

const CHIP_ICON: Readonly<Record<InclusionKey, LucideIcon>> = {
  'personal-item': ShoppingBag,
  'carry-on': Briefcase,
  'checked-bag': Luggage,
  change: RefreshCw,
  refund: RotateCcw,
};

const STATE_ICON = {
  yes: Check,
  partial: CircleDollarSign,
  no: X,
  unknown: CircleHelp,
} as const;

/** Lo que incluye la tarifa, como fichas. El texto dice el estado; el color sólo acompaña. */
export function InclusionChips({
  chips,
  className,
}: {
  chips: readonly InclusionChip[];
  className?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Qué incluye la tarifa" className={cn('flex flex-wrap gap-1.5', className)}>
      {chips.map((chip) => {
        const Icon = CHIP_ICON[chip.key];
        const StateIcon = STATE_ICON[chip.state];
        return (
          <li
            key={chip.key}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              chip.state === 'yes' && 'bg-[var(--color-success)]/12 text-[var(--color-fg)]',
              chip.state === 'partial' && 'bg-[var(--color-warning)]/15 text-[var(--color-fg)]',
              chip.state === 'no' && 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
              chip.state === 'unknown' &&
                'border border-dashed border-[var(--color-border-strong)] text-[var(--color-fg-muted)]',
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span>
              {chip.text}
              {chip.detail ? (
                <span className="font-normal text-[var(--color-fg-muted)]"> · {chip.detail}</span>
              ) : null}
            </span>
            <StateIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
          </li>
        );
      })}
    </ul>
  );
}

function LegCard({
  leg,
  cities,
  headingLevel,
}: {
  leg: TimelineLegView;
  cities: Readonly<Record<string, string>>;
  headingLevel: 'h2' | 'h3';
}) {
  const Heading = headingLevel;
  const headingId = `leg-${leg.index}-title`;
  return (
    <article
      aria-labelledby={headingId}
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="rounded-md bg-[var(--color-primary)]/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg)]">
            {leg.label}
          </span>
          <Heading id={headingId} className="text-sm font-semibold text-[var(--color-fg)]">
            {leg.origin} → {leg.destination}
          </Heading>
          <span className="text-xs capitalize text-[var(--color-fg-muted)]">{leg.longDate}</span>
        </div>
        <p className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          {leg.durationMinutes === null ? null : (
            <span className="tabular-nums">{formatDurationShort(leg.durationMinutes)}</span>
          )}
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              leg.stops === 0
                ? 'bg-[var(--color-success)]/12 text-[var(--color-fg)]'
                : 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]',
            )}
          >
            {stopsLabel(leg.stops)}
          </span>
        </p>
      </header>

      <ol className="px-3 py-3 sm:px-5" aria-label={`Vuelos de ${leg.label.toLowerCase()}`}>
        {leg.items.map((item) =>
          item.kind === 'segment' ? (
            <SegmentBlock key={item.segment.key} segment={item.segment} cities={cities} />
          ) : (
            <ConnectionBlock key={item.connection.key} connection={item.connection} />
          ),
        )}
      </ol>

      {leg.fares.length > 0 || leg.inclusions.length > 0 ? (
        <footer className="space-y-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-4 py-3 sm:px-5">
          {leg.fares.map((fare) => (
            <p key={fare.key} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-fg)]">
                <Armchair aria-hidden="true" className="size-3.5 text-[var(--color-fg-muted)]" />
                Tarifa {fare.name}
              </span>
              {fare.details.length > 0 ? (
                <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                  {fare.details.join(' · ')}
                </span>
              ) : null}
            </p>
          ))}
          {leg.inclusions.length > 0 ? (
            <div>
              {leg.inclusionsSource === 'offer' ? (
                <p className="mb-1.5 text-[11px] text-[var(--color-fg-subtle)]">
                  Condiciones del viaje completo
                </p>
              ) : null}
              <InclusionChips chips={leg.inclusions} />
            </div>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function ItineraryTimeline({
  legs,
  headingLevel = 'h3',
  className,
}: {
  legs: readonly TimelineLegView[];
  headingLevel?: 'h2' | 'h3';
  className?: string;
}) {
  const codes = legs.flatMap((leg) =>
    leg.items.flatMap((item) =>
      item.kind === 'segment' ? [item.segment.departure.airport, item.segment.arrival.airport] : [],
    ),
  );
  const cities = useAirportCities(codes);

  if (legs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
        El proveedor no informó el detalle de los vuelos.
      </p>
    );
  }
  return (
    <div className={cn('space-y-3', className)}>
      {legs.map((leg) => (
        <LegCard key={leg.index} leg={leg} cities={cities} headingLevel={headingLevel} />
      ))}
    </div>
  );
}

/** El esqueleto del itinerario mientras carga. */
export function ItineraryTimelineSkeleton({ legs = 1 }: { legs?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: legs }, (_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        >
          <div className="h-4 w-48 rounded bg-[var(--color-surface-muted)]" />
          <div className="mt-5 space-y-3">
            <div className="h-4 w-2/3 rounded bg-[var(--color-surface-muted)]" />
            <div className="ml-24 h-12 rounded-lg bg-[var(--color-surface-muted)]" />
            <div className="h-4 w-1/2 rounded bg-[var(--color-surface-muted)]" />
          </div>
        </div>
      ))}
    </div>
  );
}
