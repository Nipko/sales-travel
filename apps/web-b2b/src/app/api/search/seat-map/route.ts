import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

/**
 * El mapa de asientos de la oferta que se está por reservar (SAB-16). El BFF sólo reenvía: la
 * oferta y los criterios los valida el API (`SeatMapBodySchema`, estricto), que además vuelve a
 * leer el mapa al reservar. Un error vuelve con el texto del API, que ya está escrito para el
 * vendedor («La elección de asiento no está disponible para esta tarifa…»).
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return NextResponse.json(
      { error: 'El pedido del mapa de asientos no es válido.' },
      { status: 400 },
    );
  }
  const res = await api<unknown>('/search/seat-map', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }

  return NextResponse.json(res.data);
}
