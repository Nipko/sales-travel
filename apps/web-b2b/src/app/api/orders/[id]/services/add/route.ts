import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../../lib/api';
import { proxyServicesChange } from '../services-change-proxy';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyServicesChange(req, id, 'add', apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
