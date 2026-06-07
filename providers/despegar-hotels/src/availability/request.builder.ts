import type { AvailabilityQuery, HotelDetailQuery, RoomDistribution } from '../types';

/**
 * Formato `distribution` de Despegar: por habitación `adults[-childAge]...`, habitaciones
 * separadas por `!`. Ej: [{adults:2},{adults:2,childrenAges:[10]}] → "2!2-10".
 */
export function buildDistribution(rooms: RoomDistribution[]): string {
  return rooms
    .map((r) => {
      const ages = (r.childrenAges ?? []).map((a) => `-${a}`).join('');
      return `${Math.max(1, r.adults)}${ages}`;
    })
    .join('!');
}

type Query = Record<string, string | number | boolean | undefined>;

export function buildAvailabilityQuery(q: AvailabilityQuery): Query {
  return {
    checkin_date: q.checkinDate,
    checkout_date: q.checkoutDate,
    currency: q.currency,
    hotels: q.hotelIds.join(','),
    distribution: buildDistribution(q.rooms),
    country_code: q.countryCode,
    language: q.language,
    ttl: q.ttl,
    refundable_only: q.refundableOnly,
  };
}

export function buildDetailQuery(q: HotelDetailQuery): Query {
  return {
    checkin_date: q.checkinDate,
    checkout_date: q.checkoutDate,
    currency: q.currency,
    distribution: buildDistribution(q.rooms),
    roompack_id: q.roompackId,
    country_code: q.countryCode,
    language: q.language,
    ttl: q.ttl,
    refundable_only: q.refundableOnly,
  };
}
