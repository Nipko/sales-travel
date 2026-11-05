import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

/** Una reserva lleva datos de pasajeros (enmascarados, pero de personas): ningún caché la guarda. */
const ORDER_NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await api<{ order: unknown }>(`/orders/${encodeURIComponent(id)}`);
  if (!res.ok) {
    return NextResponse.json(
      { error: res.error.message },
      { status: res.error.status, headers: ORDER_NO_STORE },
    );
  }
  // El API contesta `{ order: null }` cuando la reserva no es de este tenant o no existe.
  if (res.data.order === null || res.data.order === undefined) {
    return NextResponse.json(
      { error: 'No encontramos esta reserva.' },
      { status: 404, headers: ORDER_NO_STORE },
    );
  }
  return NextResponse.json(res.data, { headers: ORDER_NO_STORE });
}
