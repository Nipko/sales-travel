import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { proxyHotelRooms } from '../hotel-rooms-proxy';

/*
 * `GET /api/hotels/rooms/<clave del hotel>?lang=`: fotos, tamaño y descripción de cada habitación de
 * un hotel (hotel-rooms-proxy.ts). Con la sesión del vendedor, como cualquier llamado al API, y sin
 * caché: lo que el API todavía está trayendo vuelve `pending` y se pregunta de nuevo.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;
  const lang = new URL(req.url).searchParams.get('lang');
  const reply = await proxyHotelRooms(key, lang, apiWithStatus);
  return NextResponse.json(reply.body, {
    status: reply.status,
    headers: { 'cache-control': 'no-store' },
  });
}
