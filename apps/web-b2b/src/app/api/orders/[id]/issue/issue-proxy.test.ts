import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../../../../lib/api';
import { issueBodyOf, proxyOrderIssue } from './issue-proxy';

/*
 * `POST /api/orders/:id/issue` (SAB-08): valida el cuerpo en el borde y reenvía estado y cuerpo
 * completos. Sin respuesta legible no se inventa un éxito ni un rechazo: sale como 5xx.
 */

function pedido(body: unknown): Request {
  return new Request('http://panel.test/api/orders/o-1/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const CUERPO = { expectedTotalMinor: 34012, currency: 'USD' };

describe('issueBodyOf', () => {
  it('acepta el total entero y la moneda ISO', () => {
    expect(issueBodyOf(CUERPO)).toEqual(CUERPO);
  });

  it.each([
    ['una clave de más (una tarjeta colada)', { ...CUERPO, payment: { card: '4111111111111111' } }],
    ['un total con decimales', { ...CUERPO, expectedTotalMinor: 340.12 }],
    ['un total negativo', { ...CUERPO, expectedTotalMinor: -1 }],
    ['un total como texto', { ...CUERPO, expectedTotalMinor: '34012' }],
    ['una moneda en minúsculas', { ...CUERPO, currency: 'usd' }],
    ['sin moneda', { expectedTotalMinor: 34012 }],
    ['una lista', [CUERPO]],
    ['nada', null],
  ])('rechaza %s', (_caso, raw) => {
    expect(issueBodyOf(raw)).toBeNull();
  });
});

describe('proxyOrderIssue', () => {
  it('reenvía el cuerpo validado a la orden, y el 202 tal cual', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({
          kind: 'json',
          status: 202,
          body: { operationId: 'op-1', status: 'pending' },
        }),
    );

    const reply = await proxyOrderIssue(pedido(CUERPO), 'o-1', call);

    expect(reply).toEqual({ status: 202, body: { operationId: 'op-1', status: 'pending' } });
    expect(call).toHaveBeenCalledWith('/orders/o-1/issue', {
      method: 'POST',
      body: JSON.stringify(CUERPO),
    });
  });

  it('un 409 llega con su mensaje', async () => {
    const reply = await proxyOrderIssue(pedido(CUERPO), 'o-1', () =>
      Promise.resolve({
        kind: 'json',
        status: 409,
        body: { message: 'Ya hay una emisión en curso para esta reserva.' },
      }),
    );
    expect(reply.status).toBe(409);
  });

  it('un cuerpo inválido no sale: 400 sin llamar al API', async () => {
    const call = vi.fn();
    for (const body of ['{no es json', { ...CUERPO, payment: {} }]) {
      const reply = await proxyOrderIssue(pedido(body), 'o-1', call);
      expect(reply.status).toBe(400);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('sin respuesta legible sale como 5xx: el pedido pudo entrar', async () => {
    const caido = await proxyOrderIssue(pedido(CUERPO), 'o-1', () =>
      Promise.resolve({ kind: 'unreachable', status: 503, message: 'sin api' }),
    );
    const html = await proxyOrderIssue(pedido(CUERPO), 'o-1', () =>
      Promise.resolve({ kind: 'not-json', status: 404, message: 'página' }),
    );
    expect(caido.status).toBe(503);
    expect(html.status).toBe(502);
  });

  it('el id viaja escapado: no puede cambiar la ruta del API', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 202, body: { operationId: 'x' } }),
    );
    await proxyOrderIssue(pedido(CUERPO), '../pay', call);
    expect(call.mock.calls[0]?.[0]).toBe('/orders/..%2Fpay/issue');
  });
});
