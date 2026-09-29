'use server';

import { api } from '../../../lib/api';
import { toCountryAlpha2 } from '../../../lib/countries';
import {
  SUGGESTIONS_UNAVAILABLE,
  parseSuggestionItems,
  suggestionsErrorMessage,
  suggestionsQuery,
  type DestinationSuggestionsResult,
} from './_components/destination-suggestions';
import {
  parseCurrencyField,
  parseSearchCurrencies,
  type SearchCurrencies,
} from './_components/search-currency';

/*
 * Espejo del contrato NEUTRAL de hoteles (`packages/canonical/src/hotel-offer.ts`) tal como sale
 * por `POST /hotels/availability`. Regla de lectura, la misma que el contrato: un campo opcional
 * ausente es "el proveedor no lo informó", nunca "no aplica".
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

/**
 * Un destino del autocompletado. `id` es lo que la búsqueda recibe como `destinationId`: un número
 * del autocompletado de la plataforma o, en una agencia sin él, una ciudad del catálogo local de un
 * proveedor (`tbo-hotels:150184`). El API lo resuelve; aquí sólo viaja.
 */
export interface GeoSuggestion {
  id: number | string;
  gid: string;
  type: number;
  display: string;
  city?: string;
  country?: string;
}

export interface HotelTax {
  code: string;
  amount: Money;
}

/**
 * Suplemento de una tarifa: a pagar en el hotel o ya incluido. `amount` va en la moneda DEL
 * SUPLEMENTO, que puede no ser la de la tarifa: nunca se suma al total ni se convierte.
 */
export interface HotelFee {
  /** Habitación, base 1. Ausente: aplica a toda la reserva. */
  roomIndex?: number;
  description: string;
  descriptionRaw?: string;
  amount: Money;
  /** Presente cuando la moneda no tiene 2 decimales: se muestra esto y no `amount`. */
  amountText?: string;
}

export interface HotelCancellationRule {
  type: string;
  penaltyPercentage?: number;
  penaltyNights?: number;
  fromHours?: number;
  toHours?: number;
  /** Inicio del tramo en hora LOCAL del hotel, sin zona: `YYYY-MM-DDTHH:mm:ss`. */
  fromLocalDateTime?: string;
  fromDateRaw?: string;
  penaltyAmount?: Money;
  roomIndex?: number;
}

/**
 * De dónde salen las políticas: sin tramos (`none`), de una búsqueda (`search-indicative`, sujetas
 * a confirmación) o del PreBook (`prebook-final`). Ausente: no declarado, y sólo `prebook-final`
 * autoriza presentarlas como definitivas.
 */
export type HotelPolicySource = 'none' | 'search-indicative' | 'prebook-final';

export interface HotelCancellation {
  refundable: boolean;
  status: 'non_refundable' | 'partially_refundable' | 'fully_refundable';
  hoursBeforePenalty?: number;
  vendorNotes?: string;
  rules: HotelCancellationRule[];
  policySource?: HotelPolicySource;
  /** Fin de la cancelación sin cargo en hora local del hotel. */
  freeCancellationUntilLocal?: string;
}

/** Desglose del proveedor. `total` es el NETO: el precio de venta está en `HotelRoompack.pricing`. */
export interface HotelPrice {
  total: Money;
  taxes?: Money;
  taxesDetail: HotelTax[];
  /** Un único cargo en destino en la moneda de la tarifa (Despegar). */
  chargeAtDestination?: Money;
  agencyCommission?: { amount: Money; percentage: number };
  minimumSellingPrice?: Money;
  /** Cargo por huésped adicional: sólo para el vendedor y nunca sumado. */
  extraGuestCharges?: Money;
  nightly?: Money[][];
}

/** Waterfall aplicado a la tarifa, visto por ESTE tenant. Sin neto ni margen de los ancestros. */
export interface HotelPricing {
  /** Lo que le cuesta a este tenant: neto del proveedor más el markup de su red por encima. */
  costMinor: number;
  /** Precio de VENTA al cliente final. */
  finalMinor: number;
  /** Margen propio del tenant. */
  ownMarkupMinor: number;
  currency: string;
}

export interface HotelRoomOccupancy {
  adults: number;
  childrenAges: number[];
}

export interface HotelRoomItem {
  name: string;
  reference: number;
  roomTypeId?: string;
  maxCapacity?: number;
  bedOptions: string[];
  choiceId?: string;
  occupancy?: HotelRoomOccupancy;
  promotions?: string[];
}

/** De qué proveedor es una tarifa y con qué referencia se reserva. */
export interface HotelProviderRef {
  /** Código del proveedor en el registry (`despegar-hotels`), no su nombre legible. */
  name: string;
  offerRef: string;
  /** Opaco para la web: se reenvía tal cual al paso siguiente de la venta. */
  raw?: Readonly<Record<string, unknown>>;
}

export interface HotelRoompack {
  id: string;
  /**
   * De qué proveedor es ESTA tarifa. Viaja siempre; pintarlo o no lo decide
   * `showProviderInResults`. Opcional sólo para tolerar un API anterior a la búsqueda
   * multi-proveedor: sin él no se pinta nada.
   */
  provider?: HotelProviderRef;
  board: 'RO' | 'BB' | 'HB' | 'FB' | 'AI';
  /** Etiqueta del régimen del proveedor ("Desayuno para 1 persona"). Gana sobre `board`. */
  boardLabel?: string;
  mealTypeRaw?: string;
  rooms: HotelRoomItem[];
  cancellation: HotelCancellation;
  price: HotelPrice;
  /** Ausente si el tenant no tiene reglas de markup ni hay piso: venta = neto. */
  pricing?: HotelPricing;
  /** Hasta cuándo se puede reservar sin volver a buscar. Instante con zona. */
  expiresAt?: string;
  atPropertyCharges?: HotelFee[];
  includedSupplements?: HotelFee[];
  includesTransfers?: boolean;
  inclusionText?: string;
}

export interface HotelProviderHotel {
  provider: string;
  hotelId: string;
}

export interface HotelOffer {
  hotelId: string;
  name?: string;
  stars?: number;
  type?: string;
  address?: string;
  location?: { lat: number; lng: number };
  roompacks: HotelRoompack[];
  /** Presente sólo cuando la tarjeta reúne el mismo hotel de varios proveedores. */
  providerHotels?: HotelProviderHotel[];
}

export interface RoomDistribution {
  adults: number;
  childrenAges: number[];
}

/** Por qué un proveedor no aportó tarifas a esta búsqueda. Espejo de `HotelSkipReason`. */
export type HotelProviderSkipReason =
  | 'opt-in-disabled'
  | 'platform-disabled'
  | 'fallback-not-needed'
  | 'catalog-empty'
  | 'no-destination-map'
  | 'foreign-hotel-ids'
  | 'occupancy-limits'
  | 'guest-nationality-missing'
  | 'currency-mismatch';

/** Qué pasó con cada proveedor en esta búsqueda. Espejo de `HotelProviderOutcome` en el API. */
export interface HotelProviderOutcome {
  code: string;
  status: 'ok' | 'empty' | 'error' | 'skipped' | 'unavailable';
  count: number;
  /** Motivo ya humanizado por el API. */
  reason?: string;
  skipReason?: HotelProviderSkipReason;
  unavailableReason?: 'no-credentials' | 'incomplete-account';
  /** Tarifas que respondió y no se muestran por venir en otra moneda. */
  droppedForCurrency?: number;
  /** En qué monedas vinieron esas tarifas. Un API anterior al selector de moneda no lo manda. */
  droppedCurrencies?: string[];
  /** Respondió sólo una parte de sus hoteles: `reason` dice qué faltó. */
  partial?: true;
}

/** Lo que se buscó, para leer los resultados sin mirar el formulario, que el vendedor ya pudo cambiar. */
export interface HotelSearchCriteriaView {
  checkinDate: string;
  checkoutDate: string;
  nights: number;
  rooms: number;
  guests: number;
  guestNationality: string;
  /** Una por habitación, en el orden de la búsqueda: el detalle del hotel vuelve a pedirla igual. */
  occupancy: RoomDistribution[];
  refundableOnly: boolean;
  /**
   * La moneda que se pidió (D-TBO-15). Ausente: no se eligió ninguna y el API buscó en la de la
   * agencia. El detalle del hotel vuelve a pedir la misma.
   */
  currency?: string;
}

export interface HotelSearchResult {
  ok: boolean;
  hotels: HotelOffer[];
  /** Parte por proveedor. Vacío = un API anterior a la búsqueda multi-proveedor. */
  providers: HotelProviderOutcome[];
  /**
   * El ajuste "Origen de las tarifas en los resultados", ya resuelto por el API con la herencia
   * de la red. Es el mismo que en vuelos. Un API que no lo mande deja las pastillas apagadas, que
   * es el lado seguro.
   */
  showProviderInResults: boolean;
  criteria?: HotelSearchCriteriaView;
  /** Cuándo llegó la respuesta (epoch en ms): cambia en cada búsqueda aunque el resultado sea igual. */
  receivedAt?: number;
  error?: string;
}

/** Sobre del endpoint. `providers` y el booleano son ADITIVOS: `{ hotels }` no cambió. */
interface HotelSearchEnvelope {
  hotels: HotelOffer[];
  providers?: HotelProviderOutcome[];
  showProviderInResults?: boolean;
}

/** Salida de error del formulario, con el sobre completo para no olvidar ningún campo. */
function fallo(error: string): HotelSearchResult {
  return { ok: false, hotels: [], providers: [], showProviderInResults: false, error };
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `destinationId` de una ciudad del catálogo local de un proveedor. El API revalida la forma. */
const PROVIDER_DESTINATION_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*:[A-Za-z0-9._-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nightsBetween(checkinDate: string, checkoutDate: string): number {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(checkoutDate) - toUtc(checkinDate)) / 86_400_000);
}

/**
 * Autocomplete de destino (ciudad/hotel). Llamado por el combobox con debounce.
 *
 * Una consulta que falló vuelve con `error` y no como lista vacía: vacía quiere decir "no hay
 * ciudades que coincidan", y el vendedor probaría otro nombre en vez de esperar o avisar.
 */
export async function suggestDestinationsAction(
  query: string,
): Promise<DestinationSuggestionsResult> {
  const q = typeof query === 'string' ? suggestionsQuery(query) : undefined;
  if (q === undefined) return { items: [] };
  const res = await api<unknown>(`/hotels/suggestions?q=${encodeURIComponent(q)}`);
  if (!res.ok) return { items: [], error: suggestionsErrorMessage(res.error.status) };
  const items = parseSuggestionItems(res.data);
  return items === undefined ? { items: [], error: SUGGESTIONS_UNAVAILABLE } : { items };
}

/**
 * Las monedas en que la agencia puede buscar hoteles (D-TBO-15): la suya y USD. `null` si no se
 * pudieron leer; el formulario busca entonces en la de la agencia, que el API pone sola.
 */
export async function hotelSearchCurrenciesAction(): Promise<SearchCurrencies | null> {
  const res = await api<unknown>('/hotels/currencies');
  if (!res.ok) return null;
  return parseSearchCurrencies(res.data) ?? null;
}

/** Lo mínimo de un cliente del CRM para prellenar la búsqueda: nada de documentos ni contacto. */
export interface CustomerForHotelSearch {
  name: string;
  /** Como la guarda el CRM, en alfa-3 (`'COL'`) o en texto libre heredado. */
  nationality: string | null;
}

/**
 * Nombre y nacionalidad de un cliente del CRM para prellenar la nacionalidad del pasajero
 * principal (RF-06). El resto de la ficha no sale del servidor: la búsqueda no lo necesita.
 */
export async function customerForHotelSearchAction(
  customerId: string,
): Promise<CustomerForHotelSearch | null> {
  if (!UUID_RE.test(customerId)) return null;
  const res = await api<{
    customer?: { firstName?: unknown; lastName?: unknown; nationality?: unknown };
  }>(`/customers/${encodeURIComponent(customerId)}`);
  if (!res.ok || !res.data.customer) return null;
  const { firstName, lastName, nationality } = res.data.customer;
  const name = [firstName, lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
  return {
    name: name || 'el cliente',
    nationality: typeof nationality === 'string' && nationality.trim() !== '' ? nationality : null,
  };
}

function parseRooms(raw: string): RoomDistribution[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => {
        const room = r as { adults?: unknown; childrenAges?: unknown };
        const adults = Number(room.adults);
        const ages = Array.isArray(room.childrenAges)
          ? room.childrenAges.map((a) => Number(a)).filter((a) => Number.isFinite(a))
          : [];
        return { adults: Number.isFinite(adults) ? adults : 0, childrenAges: ages };
      })
      .filter((r) => r.adults >= 1);
  } catch {
    return [];
  }
}

/** El destino del combobox: el número de la plataforma, o la ciudad de un proveedor tal cual. */
function parseDestinationId(raw: string): number | string | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  return PROVIDER_DESTINATION_RE.test(raw) ? raw : undefined;
}

function parseHotelIds(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export async function searchHotelsAction(
  _prev: HotelSearchResult,
  formData: FormData,
): Promise<HotelSearchResult> {
  const checkinDate = asString(formData.get('checkinDate'));
  const checkoutDate = asString(formData.get('checkoutDate'));
  const rooms = parseRooms(asString(formData.get('rooms')));
  const hotelIds = parseHotelIds(asString(formData.get('hotelIds')));
  const destinationId = parseDestinationId(asString(formData.get('destinationId')));
  const refundableOnly = asString(formData.get('refundableOnly')) === 'on';
  const nationalityRaw = asString(formData.get('guestNationality'));
  const guestNationality = toCountryAlpha2(nationalityRaw);
  const currencyField = parseCurrencyField(asString(formData.get('currency')));

  // --- Validaciones de borde (el API revalida con Zod) ---
  if (!DATE_RE.test(checkinDate)) return fallo('Ingresá una fecha de entrada válida.');
  if (!DATE_RE.test(checkoutDate)) return fallo('Ingresá una fecha de salida válida.');
  if (checkinDate < todayISO()) return fallo('La fecha de entrada no puede ser anterior a hoy.');
  if (checkoutDate <= checkinDate) return fallo('La salida debe ser posterior a la entrada.');
  if (rooms.length === 0) return fallo('Indicá al menos una habitación con un adulto.');
  if (hotelIds.length === 0 && destinationId === undefined) {
    return fallo('Elegí un destino del autocompletado o indicá IDs de hotel.');
  }
  // Nunca un valor por defecto: hay proveedores que tarifan según la nacionalidad (RF-06).
  if (nationalityRaw.trim() === '') {
    return fallo('Indicá la nacionalidad del pasajero principal.');
  }
  if (guestNationality === undefined) {
    return fallo('No reconocemos esa nacionalidad: elegila de la lista.');
  }
  if (!currencyField.ok) return fallo('Elegí la moneda de la búsqueda de la lista.');
  const { currency } = currencyField;

  const body: Record<string, unknown> = { checkinDate, checkoutDate, rooms, guestNationality };
  if (hotelIds.length > 0) body.hotelIds = hotelIds;
  if (destinationId !== undefined) body.destinationId = destinationId;
  if (refundableOnly) body.refundableOnly = true;
  if (currency !== undefined) body.currency = currency;

  const res = await api<HotelSearchEnvelope>('/hotels/availability', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) return fallo(res.error.message);
  return {
    ok: true,
    hotels: res.data.hotels,
    providers: res.data.providers ?? [],
    // `=== true`, como vuelos: cualquier otra cosa (ausente, null, texto) es oculto.
    showProviderInResults: res.data.showProviderInResults === true,
    criteria: {
      checkinDate,
      checkoutDate,
      nights: nightsBetween(checkinDate, checkoutDate),
      rooms: rooms.length,
      guests: rooms.reduce((n, r) => n + r.adults + r.childrenAges.length, 0),
      guestNationality,
      occupancy: rooms,
      refundableOnly,
      ...(currency === undefined ? {} : { currency }),
    },
    receivedAt: Date.now(),
  };
}
