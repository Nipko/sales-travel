import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function GET() {
  const res = await api<any>('/portfolios/transactions');
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
