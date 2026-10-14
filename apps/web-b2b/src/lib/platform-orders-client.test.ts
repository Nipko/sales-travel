import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORDERS_FILTERS } from './platform-orders';
import {
  cancelPlatformOrder,
  loadPlatformCancellationEstimate,
  loadPlatformOrder,
  loadPlatformOrders,
  retrievePlatformOrder,
  retryPlatformOrderCancellation,
  sendPlatformOrderConfirmation,
} from './platform-orders-client';
import { DETAIL_PAYLOAD, ORDER_1, rowPayload } from './platform-orders.fixture';

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function mockFetch(res: Response | Error) {
  const fn = vi.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPlatformOrders', () => {
  it('pide al BFF con los filtros y devuelve la página leída', async () => {
    const fetch = mockFetch(reply(200, { orders: [rowPayload()], nextCursor: null }));
    const res = await loadPlatformOrders({ ...DEFAULT_ORDERS_FILTERS, attention: true }, 'c1');
    expect(fetch).toHaveBeenCalledWith('/api/admin/orders?attention=true&cursor=c1', {
      cache: 'no-store',
    });
    expect(res).toMatchObject({ ok: true, data: { nextCursor: null } });
  });

  it('un 403 y un 5xx dicen cosas distintas', async () => {
    mockFetch(reply(403, { error: 'Forbidden' }));
    expect(await loadPlatformOrders(DEFAULT_ORDERS_FILTERS)).toEqual({
      ok: false,
      status: 403,
      message: 'Sólo el superadmin de la plataforma ve las reservas de toda la red.',
    });
    mockFetch(reply(502, '<!doctype html><title>Bad gateway</title>'));
    expect(await loadPlatformOrders(DEFAULT_ORDERS_FILTERS)).toEqual({
      ok: false,
      status: 502,
      message: 'No pudimos cargar las reservas. Reintenta en unos segundos.',
    });
  });

  it('el 400 del API sale con su texto', async () => {
    mockFetch(reply(400, { error: 'la fecha "hasta" no puede ser anterior a "desde"' }));
    expect(await loadPlatformOrders(DEFAULT_ORDERS_FILTERS)).toMatchObject({
      ok: false,
      message: 'la fecha "hasta" no puede ser anterior a "desde"',
    });
  });

  it('sin conexión o con una respuesta ilegible, un mensaje claro; nunca lanza', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    expect(await loadPlatformOrders(DEFAULT_ORDERS_FILTERS)).toMatchObject({
      ok: false,
      status: 0,
    });
    mockFetch(reply(200, { orders: 'x' }));
    expect(await loadPlatformOrders(DEFAULT_ORDERS_FILTERS)).toEqual({
      ok: false,
      status: 200,
      message: 'El servidor respondió algo que no pudimos leer. Recarga la página.',
    });
  });
});

describe('loadPlatformOrder', () => {
  it('lee la ficha', async () => {
    const fetch = mockFetch(reply(200, DETAIL_PAYLOAD));
    const res = await loadPlatformOrder(ORDER_1);
    expect(fetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_1}`, { cache: 'no-store' });
    expect(res.ok && res.data.order.orderNumber).toBe(1042);
  });

  it('una reserva que no existe', async () => {
    mockFetch(reply(404, { error: 'Not Found' }));
    expect(await loadPlatformOrder(ORDER_1)).toMatchObject({
      ok: false,
      message: 'Esa reserva no existe o ya no está disponible.',
    });
  });
});

const OPERATION = '40000000-0000-4000-8000-000000000001';

function postOf(fetch: ReturnType<typeof mockFetch>) {
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { body: string }];
  return { url, method: init.method, body: JSON.parse(init.body) as unknown };
}

describe('las acciones de post-venta', () => {
  it('reenviar: POST con el motivo, devuelve a quién salió', async () => {
    const fetch = mockFetch(reply(200, { sent: true, to: 'ana@cliente.com' }));
    const res = await sendPlatformOrderConfirmation(ORDER_1, 'Lo pidió el cliente');
    expect(postOf(fetch)).toEqual({
      url: `/api/admin/orders/${ORDER_1}/send-confirmation`,
      method: 'POST',
      body: { reason: 'Lo pidió el cliente' },
    });
    expect(res).toEqual({ ok: true, data: { sent: true, to: 'ana@cliente.com' } });
  });

  it('consultar: la lectura y la ficha actualizada', async () => {
    const fetch = mockFetch(
      reply(200, { reading: { found: true, status: 'Confirmed' }, detail: DETAIL_PAYLOAD }),
    );
    const res = await retrievePlatformOrder(ORDER_1, 'Revisar el estado');
    expect(postOf(fetch).url).toBe(`/api/admin/orders/${ORDER_1}/retrieve`);
    expect(res.ok && res.data.found).toBe(true);
    expect(res.ok && res.data.detail?.order.orderNumber).toBe(1042);
  });

  it('el error del API sale en tú; una respuesta ilegible, como ilegible', async () => {
    mockFetch(
      reply(409, {
        error: 'Sólo se puede enviar la confirmación de una reserva confirmada o emitida.',
      }),
    );
    expect(await sendPlatformOrderConfirmation(ORDER_1, 'Lo pidió el cliente')).toEqual({
      ok: false,
      status: 409,
      message: 'Sólo se puede enviar la confirmación de una reserva confirmada o emitida.',
    });
    mockFetch(reply(403, { error: 'Forbidden' }));
    expect(await retrievePlatformOrder(ORDER_1, 'Revisar el estado')).toMatchObject({
      ok: false,
      message: 'Sólo el superadmin de la plataforma puede hacer esto.',
    });
    mockFetch(reply(200, { sent: 'yes' }));
    expect(await sendPlatformOrderConfirmation(ORDER_1, 'Lo pidió el cliente')).toMatchObject({
      ok: false,
      message: 'El servidor respondió algo que no pudimos leer. Recarga la página.',
    });
    mockFetch(new TypeError('Failed to fetch'));
    expect(await retrievePlatformOrder(ORDER_1, 'Revisar el estado')).toMatchObject({
      ok: false,
      status: 0,
    });
  });

  it('reintentar y cancelar: el desenlace de la cancelación', async () => {
    let fetch = mockFetch(reply(200, { success: true, warnings: [] }));
    expect(await retryPlatformOrderCancellation(ORDER_1, OPERATION, 'La agencia no entra')).toEqual(
      { kind: 'done', inProgress: false },
    );
    expect(postOf(fetch)).toEqual({
      url: `/api/admin/orders/${ORDER_1}/operations/${OPERATION}/retry`,
      method: 'POST',
      body: { reason: 'La agencia no entra' },
    });

    fetch = mockFetch(reply(400, { error: 'El número de orden no coincide.' }));
    expect(await cancelPlatformOrder(ORDER_1, 'Pedido del cliente', 1042)).toEqual({
      kind: 'failed',
      message: 'El número de orden no coincide.',
    });
    expect(postOf(fetch).body).toEqual({ reason: 'Pedido del cliente', orderNumber: 1042 });

    mockFetch(new TypeError('Failed to fetch'));
    expect(await cancelPlatformOrder(ORDER_1, 'Pedido del cliente', 1042)).toMatchObject({
      kind: 'unknown',
    });
  });

  it('la penalidad estimada: GET, leída como la lee la agencia', async () => {
    const fetch = mockFetch(
      reply(200, { orderId: ORDER_1, estimate: { kind: 'unavailable', reason: 'no-snapshot' } }),
    );
    expect(await loadPlatformCancellationEstimate(ORDER_1)).toEqual({
      ok: true,
      data: { kind: 'unavailable', reason: 'no-snapshot' },
    });
    expect(fetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_1}/cancellation-estimate`, {
      cache: 'no-store',
      method: 'GET',
    });
  });
});
