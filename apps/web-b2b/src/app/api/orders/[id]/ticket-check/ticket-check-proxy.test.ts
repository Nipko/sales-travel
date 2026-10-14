import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../../../../lib/api';
import {
  NO_STORE,
  TICKET_CHECK_INVALID_ORDER,
  TICKET_CHECK_UNREADABLE,
  proxyTicketCheck,
} from './ticket-check-proxy';

const ORDEN = '7d2f0c1e-5b7a-4c2e-9a51-3f8e2d6b4a10';

/*
 * `GET /api/orders/:id/ticket-check` (SAB-09): las condiciones se leen en vivo y no se cachean; el
 * estado y el cuerpo del API pasan completos, y lo que no se puede leer sale como 5xx en tú.
 */

const CONSULTA = {
  checkedAt: '2026-10-13T15:00:00.000Z',
  tickets: [{ number: '0016802004060', voidable: 'yes', refundable: 'unknown' }],
  voidAvailable: true,
  voidStatus: 'available',
};

describe('proxyTicketCheck', () => {
  it('pide la orden con GET y reenvía el 200 tal cual', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 200, body: CONSULTA }),
    );

    const reply = await proxyTicketCheck(ORDEN, call);

    expect(reply).toEqual({ status: 200, body: CONSULTA });
    expect(call).toHaveBeenCalledWith(`/orders/${ORDEN}/ticket-check`, { method: 'GET' });
  });

  it('un rechazo del API llega con su estado y su texto', async () => {
    const body = {
      statusCode: 409,
      message: 'Las condiciones de los tiquetes sólo se consultan en una reserva emitida.',
    };
    const reply = await proxyTicketCheck(ORDEN, () =>
      Promise.resolve({ kind: 'json', status: 409, body }),
    );
    expect(reply).toEqual({ status: 409, body });
  });

  it('sin respuesta legible sale como 5xx, con un texto que se puede leer', async () => {
    const caido = await proxyTicketCheck(ORDEN, () =>
      Promise.resolve({ kind: 'unreachable', status: 503, message: 'Revisa tu conexión' }),
    );
    const html = await proxyTicketCheck(ORDEN, () =>
      Promise.resolve({ kind: 'not-json', status: 404, message: 'página' }),
    );
    expect(caido).toEqual({
      status: 503,
      body: { statusCode: 503, message: TICKET_CHECK_UNREADABLE },
    });
    expect(html.status).toBe(502);
  });

  it('un id que no es de una reserva no llega al API: 400', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 200, body: CONSULTA }),
    );
    for (const id of ['../void', 'o-1', '']) {
      await expect(proxyTicketCheck(id, call)).resolves.toEqual({
        status: 400,
        body: TICKET_CHECK_INVALID_ORDER,
      });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('la respuesta no se guarda en ningún caché: la ventana cambia con el reloj', () => {
    expect(NO_STORE).toEqual({ 'cache-control': 'no-store' });
  });
});
