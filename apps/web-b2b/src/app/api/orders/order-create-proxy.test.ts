import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '../../../lib/api';
import { proxyOrderCreate } from './order-create-proxy';

function req(body: unknown): Request {
  return new Request('http://localhost/api/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('proxyOrderCreate', () => {
  it('un 409 de conciliación llega con TODAS sus marcas, no sólo el mensaje', async () => {
    const conflicto = {
      statusCode: 409,
      error: 'Conflict',
      message:
        'La creación quedó pendiente de conciliación con el proveedor. No vuelvas a reservar.',
      orderId: 'order-1',
      retryForbidden: true,
      reconciliationRequired: true,
    };
    const reply = await proxyOrderCreate(req({ quotationId: 'q1' }), () =>
      Promise.resolve<ApiResponse>({ kind: 'json', status: 409, body: conflicto }),
    );
    expect(reply).toEqual({ status: 409, body: conflicto });
  });

  it('reenvía el cuerpo tal cual al API', async () => {
    let enviado = '';
    await proxyOrderCreate(req({ quotationId: 'q1' }), (_path, init) => {
      enviado = typeof init.body === 'string' ? init.body : '';
      return Promise.resolve<ApiResponse>({ kind: 'json', status: 201, body: {} });
    });
    expect(JSON.parse(enviado)).toEqual({ quotationId: 'q1' });
  });

  it('sin respuesta del API conserva el estado para que el navegador no reabra el formulario', async () => {
    const reply = await proxyOrderCreate(req({}), () =>
      Promise.resolve<ApiResponse>({ kind: 'unreachable', status: 503, message: 'sin red' }),
    );
    expect(reply.status).toBe(503);
  });

  it('un 2xx o 4xx ilegible sale como 5xx: puede haber un PNR detrás', async () => {
    for (const status of [201, 408]) {
      const reply = await proxyOrderCreate(req({}), () =>
        Promise.resolve<ApiResponse>({ kind: 'not-json', status, message: 'respuesta ilegible' }),
      );
      expect(reply.status).toBeGreaterThanOrEqual(500);
    }
  });
});
