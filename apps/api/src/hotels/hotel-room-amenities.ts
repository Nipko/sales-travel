/**
 * Los servicios de cada habitación que da el PreBook ("Free WiFi", "Minibar"), como salen al
 * navegador en `POST /hotels/prebook` (TBO-12). Son texto libre del proveedor, en su idioma: se
 * muestran como etiquetas para distinguir habitaciones antes de reservar y no deciden nada (quedan
 * fuera de la comparación C1 y del snapshot del Book).
 *
 * El tope es del contrato con la web y no de un proveedor: cualquier adapter que los dé sale igual.
 */

/** Servicios por habitación, a lo sumo, contados después de quitar los repetidos. */
export const ROOM_AMENITIES_MAX = 60;

/** Caracteres de cada servicio (puntos de código, no unidades UTF-16), con «…» si se recorta. */
export const ROOM_AMENITY_MAX_CHARS = 80;

/** Controles C0 y C1: no se ven en una etiqueta y cortan líneas donde no hay que cortar. */
// eslint-disable-next-line no-control-regex -- la clase existe justamente para quitarlos.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/** Medio par UTF-16 sin su otra mitad: lo deja un recorte por largo justo sobre un emoji. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Un servicio como etiqueta: una línea, sin bordes en blanco y recortado; vacío no es servicio. */
function amenityLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(LONE_SURROGATE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  // Por puntos de código: un recorte por unidades UTF-16 puede partir un emoji en dos.
  const chars = Array.from(text);
  if (chars.length <= ROOM_AMENITY_MAX_CHARS) return text;
  return `${chars
    .slice(0, ROOM_AMENITY_MAX_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * La lista de UNA habitación: sin repetidos (sin distinguir mayúsculas ni formas compatibles de
 * Unicode, sobre el texto que se ve) y con el tope, en el orden del proveedor.
 */
function roomAmenityList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= ROOM_AMENITIES_MAX) break;
    const label = amenityLabel(value);
    if (label === undefined) continue;
    const key = label.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Las listas por habitación como salen al navegador, en el mismo orden. `undefined` si ninguna
 * habitación tiene un servicio que mostrar: el checkout no pinta un bloque vacío.
 */
export function roomAmenitiesOf(lists: readonly (readonly unknown[])[]): string[][] | undefined {
  const rooms = lists.map(roomAmenityList);
  return rooms.some((room) => room.length > 0) ? rooms : undefined;
}
