import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../lib/api';
import { proxyCustomerSearch } from '../../../../lib/customer-search-proxy';

export async function GET(req: Request) {
  const reply = await proxyCustomerSearch(new URL(req.url).searchParams, apiWithStatus);
  // Datos personales: ni el navegador ni un proxy intermedio los guardan.
  return NextResponse.json(reply.body, {
    status: reply.status,
    headers: { 'cache-control': 'no-store' },
  });
}
