import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { proxyHotelContentBatch } from '../../../../../lib/hotel-content-batch';

export async function POST(req: Request) {
  const reply = await proxyHotelContentBatch(req, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
