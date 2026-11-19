import {
  isBookableRoompack,
  mapNotices,
  mapRoompack,
  type RawCategorizedNotices,
} from '../availability/response.mapper';
import type { HotelOffer } from '../types';

interface RawDetailResponse {
  id?: number | string;
  hotel_info?: { type?: string };
  roompacks?: Parameters<typeof mapRoompack>[0][];
  categorized_notices?: RawCategorizedNotices;
}

/**
 * Mapea el detalle de un hotel (availability/{hotel_id}). Los rooms traen `choice_id` para
 * reservar; los avisos del hotel (`categorized_notices`) se muestran en el checkout.
 */
export function mapHotelDetail(
  input: RawDetailResponse | { items?: RawDetailResponse[] },
  requestedHotelId?: string,
): HotelOffer {
  // Hay respuestas envueltas en `items`, como el listado: el detalle es el primero.
  const wrapped = (input as { items?: unknown }).items;
  const raw: RawDetailResponse =
    Array.isArray(wrapped) && (input as RawDetailResponse).roompacks === undefined
      ? ((wrapped[0] ?? {}) as RawDetailResponse)
      : (input as RawDetailResponse);
  const offer: HotelOffer = {
    // Sin `id` en la respuesta, el que se pidió: un hotel sin id deja todas sus tarifas sin reservar.
    hotelId: raw.id === undefined || raw.id === '' ? (requestedHotelId ?? '') : String(raw.id),
    type: raw.hotel_info?.type,
    // El código de régimen crudo sólo en el detalle: es lo que compara el PreBook (C1/C2).
    roompacks: (raw.roompacks ?? []).filter(isBookableRoompack).map((rp) => {
      const pack = mapRoompack(rp);
      return rp.meal_plan?.id ? { ...pack, mealPlanId: rp.meal_plan.id } : pack;
    }),
  };
  const notices = mapNotices(raw.categorized_notices);
  if (notices.length > 0) offer.notices = notices;
  return offer;
}
