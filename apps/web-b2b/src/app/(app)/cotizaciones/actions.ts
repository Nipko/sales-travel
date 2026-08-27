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

export interface OfferPricing {
  costMinor: number;
  finalMinor: number;
  ownMarkupMinor: number;
  currency: string;
}

export interface Offer {
  id: string;
  tenantId: string;
  products: string[];
  provider: { name: string; offerRef: string };
  total: Money;
  baseFare: Money;
  taxes: Money;
  // Precio de venta con la cascada de markup del consolidador (opcional; `total` es el neto).
  pricing?: OfferPricing;
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

/** Qué pasó con un proveedor en esta búsqueda. Espejo de ProviderOutcome en el API. */
export type ProviderStatus = 'ok' | 'empty' | 'error' | 'simulated' | 'skipped';

/** Por qué un proveedor habilitado no llegó a ser llamado. */
export type ProviderSkipReason = 'opt-in-disabled' | 'fallback-not-needed';

export interface ProviderOutcome {
  code: string;
  status: ProviderStatus;
  count: number;
  /** Semántica POR PROVEEDOR: estas tarifas son inventadas. */
  simulated: boolean;
  /** Motivo ya humanizado por el API. Sólo cuando `status === 'error'`. */
  reason?: string;
  skipReason?: ProviderSkipReason;
}

export interface SearchResult {
  ok: boolean;
  offers: Offer[];
  error?: string;
  /**
   * Semántica VIEJA, conservada: TODO el resultado es falso porque a la agencia le faltan
   * credenciales. Los precios son INVENTADOS y no se pueden cotizar a un cliente. La
   * señal por proveedor —la única correcta cuando hay más de uno— viaja en `providers`.
   */
  simulated?: boolean;
  /**
   * Parte de daños del fan-out. Vacío = el API es anterior al contrato multi-proveedor y
   * la UI cae a `simulated` global; nunca significa "ningún proveedor participó".
   */
  providers: ProviderOutcome[];
  /**
   * El ajuste del panel de administracion, ya resuelto por el API con la herencia aplicada.
   * Lo decide el API y no la pantalla: quien manda es el tenant PADRE cuando la agencia
   * hereda, y eso solo se sabe recorriendo el arbol.
   *
   * Por omision `false`. Un API viejo que no mande el campo deja las pastillas apagadas, que
   * es el lado seguro: no nombrar al proveedor es un ajuste comercial de la casa.
   */
  showProviderInResults: boolean;
}

/**
 * Sobre del endpoint. `providers` es ADITIVO: `{ offers, simulated }` conserva forma y
 * significado, así que un API todavía sin fan-out sigue funcionando contra esta UI.
 */
interface FlightSearchEnvelope {
  offers: Offer[];
  simulated?: boolean;
  providers?: ProviderOutcome[];
  showProviderInResults?: boolean;
}

/**
 * Salida de error del formulario. Existe para que ampliar `SearchResult` no obligue a tocar
 * una docena de returns idénticos —y a olvidarse de alguno—.
 */
function fallo(error: string): SearchResult {
  return { ok: false, offers: [], providers: [], showProviderInResults: false, error };
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
  const adults = asInt(formData.get('adults'), 1);
  const children = asInt(formData.get('children'), 0);
  const infants = asInt(formData.get('infants'), 0);

  // --- Validaciones ---
  if (!IATA_RE.test(origin)) {
    return fallo('Selecciona un origen válido (ej. BOG, GRU, MIA).');
  }
  if (!IATA_RE.test(destination)) {
    return fallo('Selecciona un destino válido.');
  }
  if (origin === destination) {
    return fallo('Origen y destino deben ser distintos.');
  }
  if (!DATE_RE.test(departureDate)) {
    return fallo('Ingresá una fecha de ida válida.');
  }
  const today = todayISO();
  if (departureDate < today) {
    return fallo('La fecha de ida no puede ser anterior a hoy.');
  }
  const isRoundtrip = tripType === 'roundtrip';
  if (isRoundtrip) {
    if (!DATE_RE.test(returnDate)) {
      return fallo('Ingresá la fecha de vuelta o cambiá a "Solo ida".');
    }
    if (returnDate < departureDate) {
      return fallo('La fecha de vuelta no puede ser anterior a la de ida.');
    }
  }
  if (adults < 1) {
    return fallo('Mínimo un adulto por reserva.');
  }
  if (infants > adults) {
    return fallo('No puede haber más infantes que adultos (uno por adulto).');
  }
  const totalPax = adults + children + infants;
  if (totalPax > 9) {
    return fallo('Máximo 9 pasajeros por reserva (límite GDS).');
  }

  const body: Record<string, unknown> = {
    origin,
    destination,
    departureDate,
    paxCount: { adults, children, infants },
    cabin,
  };
  if (isRoundtrip) body.returnDate = returnDate;

  let res: Awaited<ReturnType<typeof api<FlightSearchEnvelope>>>;
  try {
    res = await api<FlightSearchEnvelope>('/search/flights', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    return fallo(
      'No se pudo conectar al servicio de búsqueda. Verificá que el API esté corriendo.',
    );
  }

  if (!res.ok) {
    return {
      ok: false,
      offers: [],
      providers: [],
      showProviderInResults: false,
      error: res.error.message,
    };
  }
  return {
    ok: true,
    offers: res.data.offers,
    simulated: res.data.simulated === true,
    providers: res.data.providers ?? [],
    showProviderInResults: res.data.showProviderInResults === true,
  };
}
