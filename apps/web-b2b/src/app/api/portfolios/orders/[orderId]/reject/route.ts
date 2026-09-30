import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../../lib/api';
import { walletProxyReply } from '../../../../../../lib/wallet-proxy';
import { isUuid } from '../../../../../../lib/wallets';

type Params = { params: Promise<{ orderId: string }> };

/**
 * Cancelar con el proveedor y liberar la retención desde Cartera B2B. Reenvía el motivo máquina del
 * API: con `PORTFOLIO_RELEASE_BUSY` el proveedor ya canceló y sólo falta liberar el saldo, y la
 * pantalla no puede decir "no se canceló" (0060: la liberación bloquea las carteras de toda la red).
 */
export async function POST(_req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId } = await params;
  if (!isUuid(orderId)) return NextResponse.json({ error: 'Reserva inválida.' }, { status: 400 });
  const res = await apiWithStatus(`/portfolios/orders/${orderId.toLowerCase()}/reject`, {
    method: 'POST',
  });
  const reply = walletProxyReply(res);
  return NextResponse.json(reply.body, { status: reply.status });
}
