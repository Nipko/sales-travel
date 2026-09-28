import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../lib/api';
import { proxyHotelBook } from './hotel-book-proxy';

export async function POST(req: Request) {
  const reply = await proxyHotelBook(req, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
