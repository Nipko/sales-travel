import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

/**
 * Plataforma → Salud: cómo respondieron los proveedores a las búsquedas (0095). Sólo lectura y sin
 * parámetros: si quien pide es superadmin lo decide el API.
 */
export async function GET(): Promise<NextResponse> {
  const res = await api<unknown>('/admin/system/providers');
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
