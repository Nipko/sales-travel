import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

/**
 * La franja de avisos del panel: los anuncios vigentes para quien mira en su nodo activo (el API lo
 * toma de la sesión y del nodo que manda el panel). Sólo lectura y sin parámetros. Si falla, la
 * franja no muestra nada: el error no le dice nada al usuario.
 */
export async function GET(): Promise<NextResponse> {
  const res = await api<unknown>('/announcements/active');
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
