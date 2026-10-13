import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../../../../lib/api';
import { VOID_UNREADABLE, proxyTicketVoid } from './void-proxy';

/*
 * `POST /api/orders/:id/void` (SAB-09): sin cuerpo —el API decide con su propia consulta en vivo—,
 * con estado, cuerpo y `reason` completos. Sin respuesta legible no se sabe si la anulación salió:
 * sale como 5xx y pidiendo no repetirla, nunca como un 2xx o un 4xx.
 */

describe('proxyTicketVoid', () => {
  it('pide la anulación con POST y sin cuerpo, y reenvía la respuesta tal cual', async () => {
    const body = {
      outcome: 'VOIDED',
      message: 'Tiquetes anulados. La reserva quedó cancelada.',
      orderStatus: 'cancelled',
    };
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 200, body }),
    );

    const reply = await proxyTicketVoid('o-1', call);

    expect(reply).toEqual({ status: 200, body });
    expect(call).toHaveBeenCalledWith('/orders/o-1/void', { method: 'POST' });
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('un 409 llega con su motivo máquina, que es lo que lee la pantalla', async () => {
    const body = {
      statusCode: 409,
      error: 'Conflict',
      message: 'No pudimos confirmar la anulación. No reintentes.',
      reason: 'TICKET_VOID_UNVERIFIED',
    };
    const reply = await proxyTicketVoid('o-1', () =>
      Promise.resolve({ kind: 'json', status: 409, body }),
    );
    expect(reply).toEqual({ status: 409, body });
  });

  it('sin respuesta legible sale como 5xx y pide no repetirla: pudo salir', async () => {
    const caido = await proxyTicketVoid('o-1', () =>
      Promise.resolve({ kind: 'unreachable', status: 503, message: 'Revisá tu conexión' }),
    );
    const html = await proxyTicketVoid('o-1', () =>
      Promise.resolve({ kind: 'not-json', status: 404, message: 'página' }),
    );
    expect(caido).toEqual({ status: 503, body: { statusCode: 503, message: VOID_UNREADABLE } });
    expect(html).toEqual({ status: 502, body: { statusCode: 502, message: VOID_UNREADABLE } });
    expect(VOID_UNREADABLE).toMatch(/No la repitas/);
  });

  it('el id viaja escapado: no puede cambiar la ruta del API', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 200, body: {} }),
    );
    await proxyTicketVoid('../cancel', call);
    expect(call.mock.calls[0]?.[0]).toBe('/orders/..%2Fcancel/void');
  });
});
