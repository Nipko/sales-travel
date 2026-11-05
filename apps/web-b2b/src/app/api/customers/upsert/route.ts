import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../lib/api';
import { proxyCustomerUpsert } from '../../../../lib/customer-search-proxy';

export async function POST(req: Request) {
  const reply = await proxyCustomerUpsert(req, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
