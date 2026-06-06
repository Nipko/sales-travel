import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function POST() {
  const res = await api<unknown>('/auth/resend-verification', { method: 'POST' });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
