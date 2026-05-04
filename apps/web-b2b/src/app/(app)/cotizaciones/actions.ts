'use server';

import { api } from '../../../lib/api';

interface Money {
  amountMinor: number;
  currency: string;
}

interface Segment {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  cabin: string;
  bookingClass: string;
}

interface Itinerary {
  segments: Segment[];
  totalDurationMinutes: number;
  stops: number;
}

export interface Offer {
  id: string;
  tenantId: string;
  products: string[];
  provider: { name: string; offerRef: string };
  total: Money;
  baseFare: Money;
  taxes: Money;
  itineraries?: Itinerary[];
  fetchedAt: string;
  expiresAt: string;
}

export interface SearchResult {
  ok: boolean;
  offers: Offer[];
  error?: string;
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: FormDataEntryValue | null, fallback: number): number {
  const v = asString(value);
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function searchFlightsAction(
  _prev: SearchResult,
  formData: FormData,
): Promise<SearchResult> {
  const origin = asString(formData.get('origin')).toUpperCase().trim();
  const destination = asString(formData.get('destination')).toUpperCase().trim();
  const departureDate = asString(formData.get('departureDate'));
  const returnDate = asString(formData.get('returnDate'));
  const cabin = asString(formData.get('cabin')) || 'economy';
  const currency = asString(formData.get('currency')).toUpperCase() || 'USD';

  if (!origin || !destination || !departureDate) {
    return { ok: false, offers: [], error: 'Origen, destino y fecha de ida son obligatorios.' };
  }

  const body: Record<string, unknown> = {
    origin,
    destination,
    departureDate,
    paxCount: {
      adults: asInt(formData.get('adults'), 1),
      children: asInt(formData.get('children'), 0),
      infants: asInt(formData.get('infants'), 0),
    },
    cabin,
    currency,
  };
  if (returnDate) body.returnDate = returnDate;

  const res = await api<{ offers: Offer[] }>('/search/flights', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { ok: false, offers: [], error: res.error.message };
  }

  return { ok: true, offers: res.data.offers };
}
