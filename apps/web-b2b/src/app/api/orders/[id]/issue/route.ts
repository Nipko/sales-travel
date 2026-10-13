import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { proxyOrderIssue } from './issue-proxy';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyOrderIssue(req, id, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
