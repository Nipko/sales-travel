import { hotelImageCache, serveHotelImage } from '../../../../../lib/hotel-image-proxy';

/*
 * `GET /api/hotels/images/<clave>`: la foto de un hotel por el proxy propio del panel
 * (lib/hotel-image-proxy.ts). Pública a propósito —el optimizador de `next/image` la pide sin la
 * cookie de sesión— y acotada a las fotos de los dominios del proveedor.
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;
  return serveHotelImage(key, { fetch: (url, init) => fetch(url, init), cache: hotelImageCache });
}
