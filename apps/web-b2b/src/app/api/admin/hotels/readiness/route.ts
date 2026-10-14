import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

/**
 * Qué le falta a cada sucursal para probar una reserva de hotel (`GET /admin/hotels/readiness`).
 * Reenvía la sesión y nada más: quién la puede leer (sólo superadmin) lo decide el API.
 */
export async function GET(): Promise<NextResponse> {
  const res = await api<unknown>('/admin/hotels/readiness');
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
