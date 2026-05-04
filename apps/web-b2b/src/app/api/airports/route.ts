import { NextResponse } from 'next/server';

const INTERNAL = process.env.INTERNAL_API_URL ?? 'http://api:3000';

/**
 * Proxy del autocomplete a la api NestJS por la red interna.
 * Esto evita CORS y mantiene el patrón "el browser solo habla con Next.js".
 */
export async function GET(req: Request): Promise<NextResponse> {
  const reqUrl = new URL(req.url);
  const q = reqUrl.searchParams.get('q') ?? '';
  const limit = reqUrl.searchParams.get('limit') ?? '8';

  const apiUrl = new URL(`${INTERNAL.replace(/\/$/, '')}/api/airports`);
  if (q) apiUrl.searchParams.set('q', q);
  apiUrl.searchParams.set('limit', limit);

  const res = await fetch(apiUrl.toString(), { cache: 'no-store' });
  const body = (await res.json().catch(() => ({ items: [] }))) as unknown;
  return NextResponse.json(body, { status: res.status });
}
