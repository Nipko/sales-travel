import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST() {
  const jar = await cookies();
  jar.delete('st_session');
  jar.delete('st_tenant');
  return NextResponse.json({ ok: true });
}
