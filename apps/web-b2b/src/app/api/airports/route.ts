import { NextResponse } from 'next/server';
import { clientOriginHeaders } from '../../../lib/api';

const INTERNAL = process.env.INTERNAL_API_URL ?? 'http://api:3000';

/**
 * Proxy del autocomplete a la api NestJS por la red interna.
 * Esto evita CORS y mantiene el patrón "el browser solo habla con Next.js".
 *
 * No pasa por `api()` (no necesita sesión ni tenant), pero sí manda el origen del usuario: sin él
 * el api ve la IP del contenedor y el autocomplete de TODOS los usuarios comparte un cupo del
 * throttler, que cualquiera agota desde afuera (la ruta es anónima).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const reqUrl = new URL(req.url);
  const q = reqUrl.searchParams.get('q') ?? '';
  const limit = reqUrl.searchParams.get('limit') ?? '8';

  const apiUrl = new URL(`${INTERNAL.replace(/\/$/, '')}/api/airports`);
  if (q) apiUrl.searchParams.set('q', q);
  apiUrl.searchParams.set('limit', limit);

  const res = await fetch(apiUrl.toString(), {
    cache: 'no-store',
    headers: clientOriginHeaders(req.headers, process.env.INTERNAL_PROXY_SECRET),
  });
  const body = (await res.json().catch(() => ({ items: [] }))) as unknown;
  return NextResponse.json(body, { status: res.status });
}
