import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

/**
 * La penalidad estimada de cancelar una reserva de hotel, que se muestra antes de confirmar
 * (docs/tbo/08 RF-25; D-TBO-26 A). No llama al proveedor: el API la calcula con la política que la
 * orden guardó del PreBook.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await api<unknown>(`/orders/${encodeURIComponent(id)}/cancellation-estimate`);
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
