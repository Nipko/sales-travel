'use server';

import type { LocationKind } from '../../../lib/airport-cities';
import { api } from '../../../lib/api';

interface Money {
  amountMinor: number;
  currency: string;
}

interface Segment {
  carrier: string;
  operatingCarrier?: string;
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

export interface FareComponent {
  brand?: {
    code?: string;
    name?: string;
    programCode?: string;
    programId?: number;
  };
  fareBasisCode?: string;
  bookingClasses?: string[];
  /** Índices sobre todos los segmentos de `itineraries`, aplanados en orden. */
  segmentRefs: number[];
  origin?: string;
  destination?: string;
  cabin?: string;
  /**
   * Qué incluye la marca de ESTE componente (espejo de `FareInclusion` del canónico). Ausente =
   * no informado; `not-offered` = no lo incluye. Ver `lib/fare-attributes.ts`.
   */
  includes?: FareInclusion[];
}

export interface FareInclusion {
  kind: 'personal-item' | 'carry-on' | 'checked-bag' | 'change' | 'refund' | 'seat' | 'other';
  status: 'included' | 'charge' | 'not-offered';
  label: string;
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
  provider: {
    name: string;
    offerRef: string;
    source?: string;
    raw?: Record<string, unknown>;
    /**
     * `test` = la cotizó una cuenta de pruebas del proveedor: no emite tiquetes reales. Lo escribe
     * el API desde la cuenta que resolvió; ausente es real. Ver `lib/test-content.ts`.
     */
    environment?: 'test' | 'live';
  };
  total: Money;
  baseFare: Money;
  taxes: Money;
  // Precio de venta con la cascada de markup del consolidador (opcional; `total` es el neto).
  pricing?: OfferPricing;
  /** Neto del proveedor por tipo de pasajero. Espejo de `FareBreakdownEntry` del canónico. */
  fareBreakdown?: {
    paxType: 'ADT' | 'CHD' | 'INF';
    paxCount: number;
    basePerPax: Money;
    taxesPerPax: Money;
  }[];
  itineraries?: Itinerary[];
  fareFamily?: { name: string; cabin: string };
  /** Fuente de verdad cuando ida y vuelta llevan familias distintas. */
  fareComponents?: FareComponent[];
  /**
   * Las tres piezas, cada una OPCIONAL. Espejo del modelo canónico.
   *
   * Ausente = «el proveedor no lo informó». `0` = «no incluye». No son lo mismo y no se pueden
   * pintar igual: ver `lib/baggage.ts`.
   */
  baggage?: {
    personalItem?: number;
    carryOn?: { qty: number; weightKg?: number };
    checked?: { qty: number; weightKg?: number };
  };
  /** Cada campo ausente = «no informado». El cargo es por pasajero: ver `lib/fare-policy.ts`. */
  policies?: {
    changeable?: boolean;
    refundable?: boolean;
    changeFee?: Money;
    refundFee?: Money;
  };
  fetchedAt: string;
  expiresAt: string;
  /** Sólo `'provider'` autoriza a presentar `expiresAt` como vigencia de la tarifa. */
  expiresAtSource?: 'provider' | 'platform-policy';
}

/** Qué pasó con un proveedor en esta búsqueda. Espejo de ProviderOutcome en el API. */
export type ProviderStatus = 'ok' | 'empty' | 'error' | 'simulated' | 'skipped';

/**
 * Por qué un proveedor no llegó a ser llamado. `platform-disabled`: el superadmin lo apagó para
 * esta agencia, su red o todos; `reason` trae el texto ya humanizado.
 */
export type ProviderSkipReason = 'opt-in-disabled' | 'platform-disabled' | 'fallback-not-needed';

export interface ProviderOutcome {
  code: string;
  status: ProviderStatus;
  count: number;
  /** Semántica POR PROVEEDOR: estas tarifas son inventadas. */
  simulated: boolean;
  /** Motivo ya humanizado por el API: cuando `status === 'error'` o en `platform-disabled`. */
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

/** `city` o `airport` del combobox; cualquier otra cosa (teclear un código) es «sin dato». */
function asLocationKind(value: unknown): LocationKind | undefined {
  return value === 'city' || value === 'airport' ? value : undefined;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function searchFlightsAction(
  _prev: SearchResult,
  formData: FormData,
): Promise<SearchResult> {
  const origin = asString(formData.get('origin')).toUpperCase().trim();
  const destination = asString(formData.get('destination')).toUpperCase().trim();
  const originKind = asLocationKind(formData.get('originKind'));
  const destinationKind = asLocationKind(formData.get('destinationKind'));
  const departureDate = asString(formData.get('departureDate'));
  const returnDate = asString(formData.get('returnDate'));
  const tripType = asString(formData.get('tripType')) || 'roundtrip';
  const cabin = asString(formData.get('cabin')) || 'economy';
  const adults = asInt(formData.get('adults'), 1);
  const children = asInt(formData.get('children'), 0);
  const infants = asInt(formData.get('infants'), 0);
  const infantsWithSeat = asInt(formData.get('infantsWithSeat'), 0);
  const childAgesRaw = asString(formData.get('childAges')).trim();
  const childAges = childAgesRaw === '' ? [] : childAgesRaw.split(',').map((v) => Number(v));

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
    return fallo('Ingresa una fecha de ida válida.');
  }
  const today = todayISO();
  if (departureDate < today) {
    return fallo('La fecha de ida no puede ser anterior a hoy.');
  }
  const isRoundtrip = tripType === 'roundtrip';
  if (isRoundtrip) {
    if (!DATE_RE.test(returnDate)) {
      return fallo('Ingresa la fecha de vuelta o cambia a "Solo ida".');
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
  // Una edad por niño, de 2 a 11: con ella Sabre cotiza el precio real del niño (docs/sabre/16).
  if (
    childAges.length !== children ||
    childAges.some((age) => !Number.isInteger(age) || age < 2 || age > 11)
  ) {
    return fallo('Elige la edad de cada niño (de 2 a 11 años).');
  }
  if (infantsWithSeat < 0 || infantsWithSeat > infants) {
    return fallo('Revisa cuántos infantes viajan con asiento.');
  }
  const totalPax = adults + children + infants;
  if (totalPax > 9) {
    return fallo('Máximo 9 pasajeros por reserva (límite GDS).');
  }

  const body: Record<string, unknown> = {
    origin,
    destination,
    ...(originKind ? { originKind } : {}),
    ...(destinationKind ? { destinationKind } : {}),
    departureDate,
    paxCount: {
      adults,
      children,
      infants,
      ...(children > 0 ? { childAges } : {}),
      ...(infantsWithSeat > 0 ? { infantsWithSeat } : {}),
    },
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
      'No se pudo conectar al servicio de búsqueda. Verifica que el API esté corriendo.',
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

/** Las vueltas para una ida elegida. `supported: false` = el proveedor no sabe anclar. */
export interface ReturnSearchResult {
  ok: boolean;
  supported: boolean;
  offers: Offer[];
  error?: string;
}

/**
 * Paso 2 de ida y vuelta: con la ida y su tarifa elegidas, las vueltas que combinan con ella y el
 * total de cada combinación (Anchored Search en Sabre, docs/sabre/15 §5). La moneda la pone el
 * API con la de la agencia, como en la búsqueda.
 */
export async function searchReturnsAction(
  outbound: Offer,
  criteria: {
    origin: string;
    destination: string;
    originKind?: LocationKind;
    destinationKind?: LocationKind;
    departureDate: string;
    returnDate?: string;
    paxCount: {
      adults: number;
      children: number;
      infants: number;
      childAges?: number[];
      infantsWithSeat?: number;
    };
    cabin: string;
  },
): Promise<ReturnSearchResult> {
  if (criteria.returnDate === undefined) {
    return { ok: false, supported: false, offers: [], error: 'La búsqueda no es de ida y vuelta.' };
  }
  const searchCriteria = {
    origin: criteria.origin,
    destination: criteria.destination,
    ...(criteria.originKind ? { originKind: criteria.originKind } : {}),
    ...(criteria.destinationKind ? { destinationKind: criteria.destinationKind } : {}),
    departureDate: criteria.departureDate,
    returnDate: criteria.returnDate,
    paxCount: criteria.paxCount,
    cabin: criteria.cabin,
    currency: outbound.total.currency,
  };

  let res: Awaited<ReturnType<typeof api<{ supported: boolean; offers: Offer[] }>>>;
  try {
    res = await api<{ supported: boolean; offers: Offer[] }>('/search/flights/returns', {
      method: 'POST',
      body: JSON.stringify({ outbound, searchCriteria }),
    });
  } catch {
    return {
      ok: false,
      supported: false,
      offers: [],
      error: 'No se pudo conectar al servicio de búsqueda.',
    };
  }
  if (!res.ok) return { ok: false, supported: false, offers: [], error: res.error.message };
  return { ok: true, supported: res.data.supported, offers: res.data.offers };
}
