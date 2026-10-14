import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

/**
 * La franja de avisos del panel: los anuncios vigentes para quien mira en su nodo activo (el API lo
 * toma de la sesión y del nodo que manda el panel). Sólo lectura y sin parámetros. Si falla, la
 * franja no muestra nada: el error no le dice nada al usuario.
 *
 * Con `x-session-ping: passive`, como el ping de la guardia de sesión: la franja pregunta sola cada
 * 5 minutos, y sin esa cabecera cada pregunta refrescaba `last_seen_at`, así que una pestaña
 * abandonada a la vista nunca vencía por inactividad ni liberaba su puesto.
 */
export async function GET(): Promise<NextResponse> {
  const res = await api<unknown>('/announcements/active', {
    headers: { 'x-session-ping': 'passive' },
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
