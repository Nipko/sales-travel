/**
 * La URL con que el panel pide una foto de hotel: la de NUESTRO proxy, nunca la del proveedor
 * (docs/tbo/05 §10, imágenes; estrategia de fotos del 2026-09-29).
 *
 * - **Por qué un proxy.** El navegador del vendedor —y el del cliente final, en una cotización— no
 *   le habla al host de fotos del proveedor: no le llega la dirección del panel ni su IP, la marca
 *   blanca no muestra `tbotechnology.in` en cada imagen, y la foto queda en una caché propia en
 *   tamaños de miniatura, compatible con la CSP (`img-src 'self'`).
 * - **Qué lleva la ruta.** La URL del proveedor en base64url: una clave de presentación, no un
 *   secreto (como la clave del hotel en la URL del detalle). El proxy de la web la decodifica y SÓLO
 *   sale a buscar URLs `https` de los dominios del proveedor: con cualquier otra responde 404, así
 *   que no es un proxy abierto.
 * - **Qué se admite aquí.** Lo mismo que el proxy: `https`, sin credenciales ni puerto propio, de un
 *   dominio del proveedor (`imageHosts` de su perfil) o un subdominio suyo, y de un largo acotado.
 *   Una foto que no pasa no sale: la tarjeta muestra el marcador de "sin foto".
 */

/** Prefijo de la ruta del proxy en el panel (`apps/web-b2b/src/app/api/hotels/images/[key]`). */
export const HOTEL_IMAGE_PROXY_PATH = '/api/hotels/images/';

/** Tope de largo de la URL del proveedor: la ruta resultante tiene que caber en cualquier proxy. */
export const HOTEL_IMAGE_SOURCE_MAX_LENGTH = 1_024;

function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((suffix) => {
    const s = suffix.toLowerCase();
    return host === s || host.endsWith(`.${s}`);
  });
}

/** La URL del proveedor si el proxy la puede servir, normalizada por `URL`; si no, `undefined`. */
export function proxiableImageUrl(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== 'string' || hosts.length === 0) return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > HOTEL_IMAGE_SOURCE_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  if (!hostAllowed(url.hostname, hosts)) return undefined;
  if (url.href.length > HOTEL_IMAGE_SOURCE_MAX_LENGTH) return undefined;
  return url.href;
}

/** `/api/hotels/images/<base64url>` de una foto del proveedor, o `undefined` si no se puede servir. */
export function hotelImageProxyUrl(value: unknown, hosts: readonly string[]): string | undefined {
  const url = proxiableImageUrl(value, hosts);
  if (url === undefined) return undefined;
  return `${HOTEL_IMAGE_PROXY_PATH}${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/** La foto principal de un hotel, servida por el proxy. */
export interface HotelMainImage {
  /** Ruta relativa del panel: `/api/hotels/images/<clave>`. */
  readonly url: string;
}

/** Lo que la búsqueda de fotos candidatas necesita de cada fila (`HotelCatalogStore`). */
export interface MainImageCandidate {
  readonly wantProvider: string;
  readonly wantHotel: string;
  readonly providerCode: string;
  readonly imageCount: number;
  readonly firstImages: readonly unknown[];
}

/** La foto elegida de un hotel y cuántas tiene el contenido del que sale. */
export interface PickedMainImage extends HotelMainImage {
  readonly count: number;
}

/**
 * La foto principal de cada hotel pedido, por `providerCode hotelId` (`hotelRefKey`): la primera
 * que el proxy puede servir de la primera fila candidata que tenga una. Las filas llegan en orden de
 * preferencia (las del propio proveedor y después las de hoteles equivalentes, RF-34), así que un
 * hotel de un proveedor sin fotos toma la del MISMO hotel en otro, nunca la de otro hotel.
 */
export function pickMainImages(
  candidates: readonly MainImageCandidate[],
  hostsOf: (providerCode: string) => readonly string[],
): Map<string, PickedMainImage> {
  const out = new Map<string, PickedMainImage>();
  for (const candidate of candidates) {
    const key = `${candidate.wantProvider} ${candidate.wantHotel}`;
    if (out.has(key)) continue;
    const hosts = hostsOf(candidate.providerCode);
    for (const src of candidate.firstImages) {
      const url = hotelImageProxyUrl(src, hosts);
      if (url !== undefined) {
        out.set(key, { url, count: candidate.imageCount });
        break;
      }
    }
  }
  return out;
}
