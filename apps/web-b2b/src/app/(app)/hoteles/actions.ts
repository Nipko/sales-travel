'use server';

import { api } from '../../../lib/api';

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface GeoSuggestion {
  id: number;
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

export interface HotelCancellationRule {
  type: string;
  penaltyPercentage?: number;
  penaltyNights?: number;
  fromHours?: number;
  toHours?: number;
}

export interface HotelCancellation {
  refundable: boolean;
  status: 'non_refundable' | 'partially_refundable' | 'fully_refundable';
  hoursBeforePenalty?: number;
  vendorNotes?: string;
  rules: HotelCancellationRule[];
}

export interface HotelPrice {
  total: Money;
  taxes?: Money;
  taxesDetail: HotelTax[];
  chargeAtDestination?: Money;
  agencyCommission?: { amount: Money; percentage: number };
}

export interface HotelRoomItem {
  name: string;
  reference: number;
  roomTypeId?: string;
  maxCapacity?: number;
  bedOptions: string[];
  choiceId?: string;
}

export interface HotelRoompack {
  id: string;
  board: 'RO' | 'BB' | 'HB' | 'FB' | 'AI';
  rooms: HotelRoomItem[];
  cancellation: HotelCancellation;
  price: HotelPrice;
}

export interface HotelOffer {
  hotelId: string;
  name?: string;
  stars?: number;
  type?: string;
  location?: { lat: number; lng: number };
  roompacks: HotelRoompack[];
}

export interface RoomDistribution {
  adults: number;
  childrenAges: number[];
}

export interface HotelSearchResult {
  ok: boolean;
  hotels: HotelOffer[];
  error?: string;
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Autocomplete de destino (ciudad/hotel). Llamado por el combobox con debounce. */
export async function suggestDestinationsAction(query: string): Promise<GeoSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await api<{ items: GeoSuggestion[] }>(
    `/hotels/suggestions?q=${encodeURIComponent(q)}`,
  );
  return res.ok ? res.data.items : [];
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
  const destinationRaw = asString(formData.get('destinationId'));
  const destinationId = /^\d+$/.test(destinationRaw) ? Number(destinationRaw) : undefined;
  const refundableOnly = asString(formData.get('refundableOnly')) === 'on';

  // --- Validaciones de borde (el API revalida con Zod) ---
  if (!DATE_RE.test(checkinDate)) {
    return { ok: false, hotels: [], error: 'Ingresá una fecha de entrada válida.' };
  }
  if (!DATE_RE.test(checkoutDate)) {
    return { ok: false, hotels: [], error: 'Ingresá una fecha de salida válida.' };
  }
  if (checkinDate < todayISO()) {
    return { ok: false, hotels: [], error: 'La fecha de entrada no puede ser anterior a hoy.' };
  }
  if (checkoutDate <= checkinDate) {
    return { ok: false, hotels: [], error: 'La salida debe ser posterior a la entrada.' };
  }
  if (rooms.length === 0) {
    return { ok: false, hotels: [], error: 'Indicá al menos una habitación con un adulto.' };
  }
  if (hotelIds.length === 0 && destinationId === undefined) {
    return {
      ok: false,
      hotels: [],
      error: 'Elegí un destino del autocompletado o indicá IDs de hotel.',
    };
  }

  const body: Record<string, unknown> = { checkinDate, checkoutDate, rooms };
  if (hotelIds.length > 0) body.hotelIds = hotelIds;
  if (destinationId !== undefined) body.destinationId = destinationId;
  if (refundableOnly) body.refundableOnly = true;

  const res = await api<{ hotels: HotelOffer[] }>('/hotels/availability', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) return { ok: false, hotels: [], error: res.error.message };
  return { ok: true, hotels: res.data.hotels };
}
