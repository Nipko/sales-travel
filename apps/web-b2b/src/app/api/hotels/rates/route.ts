import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../lib/api';
import { proxyHotelRates } from './hotel-rates-proxy';

/*
 * `POST /api/hotels/rates`: las tarifas de un proveedor del hotel para la estadía de la búsqueda
 * (hotel-rates-proxy.ts). Con la sesión del vendedor y sin caché: cada pedido es una búsqueda nueva.
 */

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = undefined;
  }
  const reply = await proxyHotelRates(raw, apiWithStatus);
  return NextResponse.json(reply.body, {
    status: reply.status,
    headers: { 'cache-control': 'no-store' },
  });
}
