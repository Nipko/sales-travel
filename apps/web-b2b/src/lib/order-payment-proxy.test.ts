import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from './api';
import {
  NO_STORE,
  PAYMENT_INVALID_ORDER,
  PAYMENT_LINK_INVALID_BODY,
  PAYMENT_OPTIONS_UNREADABLE,
  proxyPaymentLink,
  proxyPaymentOptions,
} from './order-payment-proxy';

const ORDEN = '7d2f0c1e-5b7a-4c2e-9a51-3f8e2d6b4a10';

function llamada(reply: ApiResponse) {
  return vi.fn((_path: string, _init: RequestInit): Promise<ApiResponse> => Promise.resolve(reply));
}

function pedido(body: string): Request {
  return new Request('http://panel.test/api/orders/x/payment-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('proxyPaymentOptions', () => {
  it('pide con GET y reenvía la respuesta tal cual', async () => {
    const body = { provider: 'latam-ndc', methods: [] };
    const call = llamada({ kind: 'json', status: 200, body });

    expect(await proxyPaymentOptions(ORDEN, call)).toEqual({ status: 200, body });
    expect(call).toHaveBeenCalledWith(`/orders/${ORDEN}/payment-options`, { method: 'GET' });
    expect(NO_STORE).toEqual({ 'cache-control': 'no-store' });
  });

  it('un id que no es de una reserva no llega al API', async () => {
    const call = llamada({ kind: 'json', status: 200, body: {} });

    expect(await proxyPaymentOptions('../pay', call)).toEqual({
      status: 400,
      body: PAYMENT_INVALID_ORDER,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('lo que no se puede leer sale como 5xx en tú', async () => {
    const call = llamada({ kind: 'not-json', status: 404, message: 'html' });

    expect(await proxyPaymentOptions(ORDEN, call)).toEqual({
      status: 502,
      body: { statusCode: 502, message: PAYMENT_OPTIONS_UNREADABLE },
    });
  });
});

describe('proxyPaymentLink', () => {
  it('sólo viaja el correo, recortado', async () => {
    const call = llamada({ kind: 'json', status: 201, body: { success: true, warnings: [] } });

    const reply = await proxyPaymentLink(
      pedido(JSON.stringify({ email: '  ana@correo.com ', card: '4111' })),
      ORDEN,
      call,
    );

    expect(reply).toEqual({ status: 201, body: { success: true, warnings: [] } });
    expect(call).toHaveBeenCalledWith(`/orders/${ORDEN}/payment-link`, {
      method: 'POST',
      body: JSON.stringify({ email: 'ana@correo.com' }),
    });
  });

  it('403 y 409 llegan con su estado y su texto', async () => {
    const body = {
      statusCode: 409,
      message: 'Sólo se envía enlace de pago a una reserva sin pagar.',
    };
    const call = llamada({ kind: 'json', status: 409, body });

    expect(
      await proxyPaymentLink(pedido(JSON.stringify({ email: 'a@b.co' })), ORDEN, call),
    ).toEqual({ status: 409, body });
  });

  it('sin correo válido, o sin JSON, no llega al API', async () => {
    const call = llamada({ kind: 'json', status: 201, body: {} });

    for (const raw of [
      '{',
      '[]',
      '{}',
      JSON.stringify({ email: 'nope' }),
      JSON.stringify({ email: 3 }),
    ]) {
      expect(await proxyPaymentLink(pedido(raw), ORDEN, call)).toEqual({
        status: 400,
        body: PAYMENT_LINK_INVALID_BODY,
      });
    }
    expect(await proxyPaymentLink(pedido('{"email":"a@b.co"}'), 'no-uuid', call)).toEqual({
      status: 400,
      body: PAYMENT_INVALID_ORDER,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('sin respuesta legible no se sabe si salió: 5xx', async () => {
    const call = llamada({ kind: 'unreachable', status: 503, message: 'No pudimos conectar.' });

    expect(await proxyPaymentLink(pedido('{"email":"a@b.co"}'), ORDEN, call)).toEqual({
      status: 503,
      body: { statusCode: 503, message: 'No pudimos conectar.' },
    });
  });
});
