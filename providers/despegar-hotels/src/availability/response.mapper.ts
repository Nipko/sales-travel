import { type BoardType, Money } from '@sales-travel/canonical';
import type {
  CancellationStatus,
  HotelCancellation,
  HotelOffer,
  HotelPrice,
  HotelRoomItem,
  HotelRoompack,
} from '../types';

// ---- Raw shapes (JSON de Despegar) ----
interface RawPriceDetail {
  currency?: string;
  total?: number | string;
  taxes?: number | string;
  taxes_detail?: { code?: string; amount?: number | string }[];
  charge_at_destination?: number | string;
  agency_commission?: { amount?: number | string; percentage?: number | string };
}
interface RawCancellationRule {
  type?: string;
  penalty?: { percentage?: number; night_count?: number };
  anticipation?: { from?: number; to?: number };
}
interface RawCancellation {
  status?: string;
  hours_before_penalty?: number;
  vendor_notes?: string;
  cancellation_policy_rules?: RawCancellationRule[];
}
interface RawRoom {
  name?: string;
  reference?: number;
  room_type_id?: string;
  max_capacity?: number;
  bed_options?: (string | { id?: number; description?: string })[];
  choice_id?: string;
}
interface RawRoompack {
  id?: string;
  meal_plan?: { id?: string };
  rooms?: RawRoom[];
  cancellation_policy?: RawCancellation;
  price_detail?: RawPriceDetail;
}
interface RawHotelItem {
  id?: number | string;
  hotel_info?: {
    name?: string;
    type?: string;
    stars?: number;
    location?: { latitude?: number; longitude?: number };
  };
  roompacks?: RawRoompack[];
}
interface RawAvailabilityResponse {
  items?: RawHotelItem[];
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Mapea el meal_plan de Despegar al BoardType canónico (RO/BB/HB/FB/AI). Best-effort por palabra. */
export function mapMealPlan(id: string | undefined): BoardType {
  const v = (id ?? '').toUpperCase();
  if (v.includes('ALL')) return 'AI';
  if (v.includes('FULL')) return 'FB';
  if (v.includes('HALF')) return 'HB';
  if (v.includes('BREAKFAST') || v.includes('DESAYUNO') || v === 'BB') return 'BB';
  return 'RO';
}

function mapStatus(s: string | undefined): CancellationStatus {
  if (s === 'fully_refundable' || s === 'partially_refundable') return s;
  return 'non_refundable';
}

function mapCancellation(cp: RawCancellation | undefined): HotelCancellation {
  const status = mapStatus(cp?.status);
  return {
    refundable: status !== 'non_refundable',
    status,
    hoursBeforePenalty: cp?.hours_before_penalty,
    vendorNotes: cp?.vendor_notes,
    rules: (cp?.cancellation_policy_rules ?? []).map((r) => ({
      type: r.type ?? '',
      penaltyPercentage: r.penalty?.percentage,
      penaltyNights: r.penalty?.night_count,
      fromHours: r.anticipation?.from,
      toHours: r.anticipation?.to,
    })),
  };
}

function mapPrice(pd: RawPriceDetail | undefined): HotelPrice {
  const currency = pd?.currency ?? 'USD';
  const price: HotelPrice = {
    total: Money.fromMajor(num(pd?.total), currency),
    taxesDetail: (pd?.taxes_detail ?? []).map((t) => ({
      code: t.code ?? '',
      amount: Money.fromMajor(num(t.amount), currency),
    })),
  };
  if (pd?.taxes != null) price.taxes = Money.fromMajor(num(pd.taxes), currency);
  if (pd?.charge_at_destination != null) {
    price.chargeAtDestination = Money.fromMajor(num(pd.charge_at_destination), currency);
  }
  if (pd?.agency_commission) {
    price.agencyCommission = {
      amount: Money.fromMajor(num(pd.agency_commission.amount), currency),
      percentage: num(pd.agency_commission.percentage),
    };
  }
  return price;
}

function mapRoom(r: RawRoom): HotelRoomItem {
  const bedOptions = (r.bed_options ?? [])
    .map((b) => (typeof b === 'string' ? b : (b.description ?? '')))
    .filter(Boolean);
  return {
    name: r.name ?? '',
    reference: r.reference ?? 0,
    roomTypeId: r.room_type_id,
    maxCapacity: r.max_capacity,
    bedOptions,
    choiceId: r.choice_id,
  };
}

export function mapRoompack(rp: RawRoompack): HotelRoompack {
  return {
    id: rp.id ?? '',
    board: mapMealPlan(rp.meal_plan?.id),
    rooms: (rp.rooms ?? []).map(mapRoom),
    cancellation: mapCancellation(rp.cancellation_policy),
    price: mapPrice(rp.price_detail),
  };
}

function mapHotelItem(it: RawHotelItem): HotelOffer {
  const loc = it.hotel_info?.location;
  return {
    hotelId: String(it.id ?? ''),
    name: it.hotel_info?.name,
    stars: it.hotel_info?.stars,
    type: it.hotel_info?.type,
    location:
      loc?.latitude != null && loc?.longitude != null
        ? { lat: loc.latitude, lng: loc.longitude }
        : undefined,
    roompacks: (it.roompacks ?? []).map(mapRoompack),
  };
}

export function mapAvailability(raw: RawAvailabilityResponse): HotelOffer[] {
  return (raw.items ?? []).map(mapHotelItem);
}
