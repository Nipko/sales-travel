import type { Offer, Segment } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';

/**
 * Fixtures determinísticas para modo mock. Devuelve 3 offers canónicas
 * basadas en los criterios de búsqueda. Esto se reemplaza por la
 * conversión real del DTO de LATAM cuando se enchufe el HTTP client.
 */
export function buildMockOffers(criteria: FlightSearchCriteria, tenantId: string): Offer[] {
  const now = new Date();
  const ttlMinutes = 30;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const fetchedAt = now.toISOString();

  const variants = [
    { hours: 6, fareCents: 28900, bookingClass: 'L' as const, cabin: 'economy' as const },
    { hours: 7, fareCents: 32500, bookingClass: 'V' as const, cabin: 'economy' as const },
    { hours: 9, fareCents: 41200, bookingClass: 'B' as const, cabin: 'economy' as const },
  ];

  const totalPax = criteria.paxCount.adults + criteria.paxCount.children;

  return variants.map((v) => {
    const outbound = buildSegment({
      origin: criteria.origin,
      destination: criteria.destination,
      date: criteria.departureDate,
      durationHours: v.hours,
      bookingClass: v.bookingClass,
      cabin: v.cabin,
      flightNumber: `${800 + variants.indexOf(v) * 4}`,
    });
    const segments: Segment[] = [outbound];
    const itineraries = [
      {
        segments: [outbound],
        totalDurationMinutes: outbound.durationMinutes,
        stops: 0,
      },
    ];

    if (criteria.returnDate) {
      const inbound = buildSegment({
        origin: criteria.destination,
        destination: criteria.origin,
        date: criteria.returnDate,
        durationHours: v.hours,
        bookingClass: v.bookingClass,
        cabin: v.cabin,
        flightNumber: `${801 + variants.indexOf(v) * 4}`,
      });
      segments.push(inbound);
      itineraries.push({
        segments: [inbound],
        totalDurationMinutes: inbound.durationMinutes,
        stops: 0,
      });
    }

    const baseFare = v.fareCents * totalPax;
    const taxes = Math.round(baseFare * 0.18);

    const offer: Offer = {
      id: randomUUID(),
      tenantId,
      products: ['flight'],
      provider: {
        name: 'latam-ndc',
        offerRef: `LA-MOCK-${randomUUID().slice(0, 8)}`,
      },
      total: { amountMinor: baseFare + taxes, currency: criteria.currency },
      baseFare: { amountMinor: baseFare, currency: criteria.currency },
      taxes: { amountMinor: taxes, currency: criteria.currency },
      itineraries,
      fetchedAt,
      expiresAt,
    };
    return offer;
  });
}

function buildSegment(args: {
  origin: string;
  destination: string;
  date: string;
  durationHours: number;
  bookingClass: 'L' | 'V' | 'B';
  cabin: 'economy';
  flightNumber: string;
}): Segment {
  const dep = new Date(`${args.date}T08:00:00.000-05:00`);
  const arr = new Date(dep.getTime() + args.durationHours * 60 * 60_000);
  return {
    carrier: 'LA',
    flightNumber: args.flightNumber,
    origin: args.origin,
    destination: args.destination,
    departureAt: dep.toISOString().replace(/\.\d{3}Z$/, '-05:00'),
    arrivalAt: arr.toISOString().replace(/\.\d{3}Z$/, '-05:00'),
    durationMinutes: args.durationHours * 60,
    cabin: args.cabin,
    bookingClass: args.bookingClass,
  };
}
