import { NextResponse } from 'next/server';
import { api } from '../../../lib/api';

/**
 * El estado de los proveedores que usa la agencia activa (0096): agregados de la red, sin llamar a
 * ningún proveedor. Lo pinta el indicador de la barra superior.
 */
export async function GET(): Promise<NextResponse> {
  const res = await api<unknown>('/search/provider-status');
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
