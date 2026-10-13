import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORDERS_FILTERS } from './platform-orders';
import { loadPlatformOrder, loadPlatformOrders } from './platform-orders-client';
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
