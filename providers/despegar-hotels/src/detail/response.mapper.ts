import { mapRoompack } from '../availability/response.mapper';
import type { HotelOffer } from '../types';

interface RawDetailResponse {
  id?: number | string;
  hotel_info?: { type?: string };
  roompacks?: Parameters<typeof mapRoompack>[0][];
}

/** Mapea el detalle de un hotel (availability/{hotel_id}). Los rooms traen `choice_id` para reservar. */
export function mapHotelDetail(raw: RawDetailResponse): HotelOffer {
  return {
    hotelId: String(raw.id ?? ''),
    type: raw.hotel_info?.type,
    roompacks: (raw.roompacks ?? []).map(mapRoompack),
  };
}
