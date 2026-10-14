import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

/**
 * Sistema › Procesos: si el barrido de post-venta, la conciliación y los catálogos están corriendo.
 * Sólo lectura y sin parámetros: si quien pide es superadmin lo decide el API.
 */
export async function GET(): Promise<NextResponse> {
  const res = await api<unknown>('/admin/system/jobs');
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
