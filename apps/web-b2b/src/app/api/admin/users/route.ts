import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function GET() {
  const res = await api<unknown>('/admin/users');
  if (!res.ok) {
    return NextResponse.json({ users: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}

export async function POST(req: Request) {
  const body = (await req.json()) as unknown;
  const res = await api<unknown>('/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
