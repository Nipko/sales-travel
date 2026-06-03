import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function GET() {
  const res = await api<unknown>('/tenants/network');
  if (!res.ok) {
    return NextResponse.json({ tenants: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
