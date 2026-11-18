import { type BoardType, Money } from '@sales-travel/canonical';
import { num } from '../internal/coerce';
import type {
  CancellationStatus,
  HotelCancellation,
  HotelNotice,
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
  charge_at_destination_detail?: { code?: string; amount?: number | string }[];
  taxes_at_destination?: number | string;
  agency_commission?: { amount?: number | string; percentage?: number | string };
  binding_public_rate_enabled?: boolean;
  binding_public_rate_value?: number | string;
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
  promo?: unknown;
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
export interface RawNoticeGroup {
  title?: string;
  notices?: unknown[];
}
export interface RawCategorizedNotices {
  primary?: RawNoticeGroup | RawNoticeGroup[];
  secondary?: RawNoticeGroup | RawNoticeGroup[];
}
interface RawAvailabilityResponse {
  items?: RawHotelItem[];
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
  if (pd?.charge_at_destination_detail?.length) {
    price.chargeAtDestinationDetail = pd.charge_at_destination_detail.map((c) => ({
      code: c.code ?? '',
      amount: Money.fromMajor(num(c.amount), currency),
    }));
  }
  if (pd?.taxes_at_destination != null) {
    price.taxesAtDestination = Money.fromMajor(num(pd.taxes_at_destination), currency);
  }
  // Con el piso activo, el valor es el precio MÍNIMO al que se puede vender; `total` sigue
  // siendo el neto (certificación HotelDO, punto 12).
  if (pd?.binding_public_rate_enabled === true && num(pd.binding_public_rate_value) > 0) {
    price.minimumSellingPrice = Money.fromMajor(num(pd.binding_public_rate_value), currency);
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

function firstText(v: unknown, keys: readonly string[]): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of keys) {
      const t = o[k];
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  }
  return undefined;
}

export function mapRoompack(rp: RawRoompack): HotelRoompack {
  const pack: HotelRoompack = {
    id: rp.id ?? '',
    board: mapMealPlan(rp.meal_plan?.id),
    rooms: (rp.rooms ?? []).map(mapRoom),
    cancellation: mapCancellation(rp.cancellation_policy),
    price: mapPrice(rp.price_detail),
  };
  const promo = firstText(rp.promo, ['description', 'name', 'title']);
  if (promo) pack.promo = promo;
  return pack;
}

/**
 * Despegar recomienda descartar los roompacks con alguna habitación sin `room_type_id`: no se
 * pueden asociar al contenido de la habitación (docs/despegar/01 § Availability). Se aplica en el
 * detalle, que es la puerta de la reserva.
 */
export function isBookableRoompack(rp: RawRoompack): boolean {
  const rooms = rp.rooms ?? [];
  return (
    rooms.length > 0 &&
    rooms.every((r) => typeof r.room_type_id === 'string' && r.room_type_id !== '')
  );
}

function mapNoticeGroups(
  g: RawNoticeGroup | RawNoticeGroup[] | undefined,
  level: HotelNotice['level'],
): HotelNotice[] {
  const groups = Array.isArray(g) ? g : g ? [g] : [];
  return groups.flatMap((group) =>
    (group.notices ?? [])
      .map((n) => firstText(n, ['description', 'text', 'value', 'message']))
      .filter((t): t is string => t !== undefined)
      .map((text) => {
        const notice: HotelNotice = { level, text };
        const title = group.title?.trim();
        if (title) notice.title = title;
        return notice;
      }),
  );
}

/** Avisos del hotel (`categorized_notices`): obligatorios en el checkout y en el voucher. */
export function mapNotices(raw: RawCategorizedNotices | undefined): HotelNotice[] {
  return [
    ...mapNoticeGroups(raw?.primary, 'primary'),
    ...mapNoticeGroups(raw?.secondary, 'secondary'),
  ];
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
    // El listado muestra todo lo que trae Despegar; el filtro de `room_type_id` va en el detalle,
    // que es desde donde se reserva.
    roompacks: (it.roompacks ?? []).map(mapRoompack),
  };
}

export function mapAvailability(raw: RawAvailabilityResponse): HotelOffer[] {
  return (raw.items ?? []).map(mapHotelItem);
}
