import { createHash } from 'node:crypto';
import type { TboHotelContent } from './content.types';

/**
 * La huella de `hotel_content.content_hash` (0041) del contenido de TBO, en UN solo lugar.
 *
 * La escriben dos procesos: el sync de catálogo (E3 `listing` y E4 `details`) y el API, que guarda
 * lo que trae de HotelDetails bajo demanda para las fotos de los resultados (05 §6.3). Con dos
 * cálculos, uno de los dos vería "cambió" en cada fila del otro y la reescribiría entera en cada
 * corrida; con uno solo, una fila igual se reconoce venga de donde venga.
 *
 * Versión de la huella: cambiarla obliga a reescribir todo el contenido en la próxima pasada, que es
 * lo que hace falta si cambia qué columnas entran en ella.
 */
export const TBO_CONTENT_HASH_VERSION = 'tbo-content-v1';

/**
 * SHA-256 de las columnas que se guardan, en un orden fijo. TBO no ofrece deltas (05 §10) y cada
 * refresco trae todo; con la huella, una fila que no cambió no se reescribe.
 *
 * `source`, `lang` y `hotelId` no entran: son la clave de la fila o se deciden aparte (un `listing`
 * que pasa a `details` se reescribe siempre). El texto plano y los servicios negados tampoco: no
 * son columnas de la tabla.
 */
export function tboHotelContentHash(content: TboHotelContent): string {
  const canonical = JSON.stringify([
    TBO_CONTENT_HASH_VERSION,
    content.name,
    content.descriptionHtml,
    content.sections.map((section) => [section.label, section.text]),
    content.facilities,
    content.attractionsHtml,
    content.images,
    content.phone,
    content.websiteUrl,
    content.checkInTime,
    content.checkOutTime,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
