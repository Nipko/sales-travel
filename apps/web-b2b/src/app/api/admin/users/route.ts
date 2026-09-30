import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function GET() {
  const res = await api<unknown>('/admin/users');
  if (!res.ok) {
    return NextResponse.json({ users: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
