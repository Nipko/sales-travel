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
  fareFamily?: { name: string; cabin: string };
  baggage?: {
    personalItem: number;
    carryOn: { qty: number; weightKg?: number };
    checked: { qty: number; weightKg?: number };
  };
  policies?: { changeable: boolean; refundable: boolean };
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

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const IATA_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function searchFlightsAction(
  _prev: SearchResult,
  formData: FormData,
): Promise<SearchResult> {
  const origin = asString(formData.get('origin')).toUpperCase().trim();
  const destination = asString(formData.get('destination')).toUpperCase().trim();
  const departureDate = asString(formData.get('departureDate'));
  const returnDate = asString(formData.get('returnDate'));
  const tripType = asString(formData.get('tripType')) || 'roundtrip';
  const cabin = asString(formData.get('cabin')) || 'economy';
  const currency = asString(formData.get('currency')).toUpperCase() || 'COP';
  const adults = asInt(formData.get('adults'), 1);
  const children = asInt(formData.get('children'), 0);
  const infants = asInt(formData.get('infants'), 0);

  // --- Validaciones ---
  if (!IATA_RE.test(origin)) {
    return { ok: false, offers: [], error: 'Seleccioná un origen válido (ej. BOG, GRU, MIA).' };
  }
  if (!IATA_RE.test(destination)) {
    return { ok: false, offers: [], error: 'Seleccioná un destino válido.' };
  }
  if (origin === destination) {
    return { ok: false, offers: [], error: 'Origen y destino deben ser distintos.' };
  }
  if (!DATE_RE.test(departureDate)) {
    return { ok: false, offers: [], error: 'Ingresá una fecha de ida válida.' };
  }
  const today = todayISO();
  if (departureDate < today) {
    return { ok: false, offers: [], error: 'La fecha de ida no puede ser anterior a hoy.' };
  }
  const isRoundtrip = tripType === 'roundtrip';
  if (isRoundtrip) {
    if (!DATE_RE.test(returnDate)) {
      return {
        ok: false,
        offers: [],
        error: 'Ingresá la fecha de vuelta o cambiá a "Solo ida".',
      };
    }
    if (returnDate < departureDate) {
      return {
        ok: false,
        offers: [],
        error: 'La fecha de vuelta no puede ser anterior a la de ida.',
      };
    }
  }
  if (adults < 1) {
    return { ok: false, offers: [], error: 'Mínimo un adulto por reserva.' };
  }
  if (infants > adults) {
    return {
      ok: false,
      offers: [],
      error: 'No puede haber más infantes que adultos (uno por adulto).',
    };
  }
  const totalPax = adults + children + infants;
  if (totalPax > 9) {
    return {
      ok: false,
      offers: [],
      error: 'Máximo 9 pasajeros por reserva (límite GDS).',
    };
  }

  const body: Record<string, unknown> = {
    origin,
    destination,
    departureDate,
    paxCount: { adults, children, infants },
    cabin,
    currency,
  };
  if (isRoundtrip) body.returnDate = returnDate;

  let res: Awaited<ReturnType<typeof api<{ offers: Offer[] }>>>;
  try {
    res = await api<{ offers: Offer[] }>('/search/flights', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      offers: [],
      error: 'No se pudo conectar al servicio de búsqueda. Verificá que el API esté corriendo.',
    };
  }

  if (!res.ok) {
    return { ok: false, offers: [], error: res.error.message };
  }
  return { ok: true, offers: res.data.offers };
}
