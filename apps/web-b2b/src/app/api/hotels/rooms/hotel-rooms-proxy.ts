import { decodeHotelKey } from '../../../(app)/hoteles/_components/hotel-key';
import {
  ROOM_CONTENT_NONE,
  ROOM_CONTENT_PROVIDERS,
  parseRoomContent,
  type RoomContentReply,
  type RoomContentResult,
} from '../../../(app)/hoteles/_components/room-content-view';
import type { ApiResponse } from '../../../../lib/api';

/*
 * `GET /api/hotels/rooms/<clave del hotel>?lang=` del panel → `GET /hotels/content/:proveedor/
 * :hotel/rooms?lang=` del API (TBO-06), una vez por cada proveedor del hotel que da contenido por
 * habitación: fotos, tamaño y descripción de cada tipo de habitación (TBO-07).
 *
 * Es una ruta y no una acción del servidor a propósito. El cliente de Next despacha las acciones
 * del servidor de a una: la respuesta del API puede tardar hasta 6 s (y volver `pending` para
 * preguntar otra vez), y en ese rato «Buscar de nuevo» en la ficha o «Ver más hoteles» en los
 * resultados quedarían esperando detrás de unas fotos. Por eso mismo las fotos de los resultados
 * van por `POST /api/hotels/content/batch`.
 *
 * La clave se decodifica y se vuelve a validar aquí (es lo que manda el navegador) y la respuesta
 * de cada proveedor pasa por `parseRoomContent`: sólo rutas del proxy propio y texto plano llegan al
 * navegador. Cualquier error de un proveedor es `none` para ese proveedor: las fotos de las
 * habitaciones nunca rompen la ficha.
 */

const LANGS = ['es', 'pt', 'en'] as const;
type Lang = (typeof LANGS)[number];

export interface HotelRoomsProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

const INVALID_KEY = 'No reconocemos ese hotel. Ábrelo desde los resultados de una búsqueda.';

/** El idioma pedido si es uno de los del contenido; si no, el del panel. */
export function roomContentLang(raw: string | null): Lang {
  const lang = raw?.trim().toLowerCase();
  return (LANGS as readonly string[]).includes(lang ?? '') ? (lang as Lang) : 'es';
}

async function roomsOf(
  provider: string,
  hotelId: string,
  lang: Lang,
  call: ApiCall,
): Promise<RoomContentResult> {
  const path = `/hotels/content/${encodeURIComponent(provider)}/${encodeURIComponent(hotelId)}/rooms?lang=${lang}`;
  try {
    const res = await call(path, { method: 'GET' });
    return res.kind === 'json' && res.status === 200
      ? parseRoomContent(res.body)
      : ROOM_CONTENT_NONE;
  } catch {
    return ROOM_CONTENT_NONE;
  }
}

export async function proxyHotelRooms(
  hotelKey: string,
  lang: string | null,
  call: ApiCall,
): Promise<HotelRoomsProxyReply> {
  const refs = decodeHotelKey(hotelKey);
  if (refs === undefined) {
    return { status: 400, body: { statusCode: 400, error: 'Bad Request', message: INVALID_KEY } };
  }
  const language = roomContentLang(lang);
  const entries = await Promise.all(
    refs
      .filter((ref) => ROOM_CONTENT_PROVIDERS.has(ref.provider))
      .map(
        async (ref) =>
          [ref.provider, await roomsOf(ref.provider, ref.hotelId, language, call)] as const,
      ),
  );
  const body: RoomContentReply = { byProvider: Object.fromEntries(entries) };
  return { status: 200, body };
}
