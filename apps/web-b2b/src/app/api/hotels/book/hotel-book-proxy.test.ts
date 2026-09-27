import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../../../lib/api';
import { proxyHotelBook } from './hotel-book-proxy';

const KEY = '0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b';
const ORDER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const BODY = {
  providerCode: 'tbo-hotels',
  prebookRef: 'b1d4c1c2-6a8e-4c7f-9d0e-3f2a1b0c9d8e',
  acceptedTotal: { amountMinor: 32134, currency: 'USD' },
  atPropertyAcknowledged: true,
  rooms: [{ guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'Juan', lastName: 'Perez' }] }],
  contact: { email: 'juan@correo.com', phone: { countryCode: '+57', number: '3001234567' } },
};

const call = vi.fn<(path: string, init: RequestInit) => Promise<ApiResponse>>();

function request(body: unknown, key: string | null = KEY): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) headers.set('idempotency-key', key);
  return new Request('http://panel.test/api/hotels/book', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  call.mockReset();
});

describe('POST /api/hotels/book — la ruta proxy del Book (RF-22)', () => {
  it('reenvía la Idempotency-Key del intento y el cuerpo neutral', async () => {
    call.mockResolvedValue({ kind: 'json', status: 201, body: { orderId: ORDER_ID } });
    await proxyHotelBook(request({ ...BODY, sobra: 1 }), call);
    expect(call).toHaveBeenCalledTimes(1);
    const [path, init] = call.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/hotels/book');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it('distingue 201 de 202: el estado viaja tal cual', async () => {
    const pending = { orderId: ORDER_ID, status: 'pending', reason: 'book-in-progress' };
    call.mockResolvedValue({ kind: 'json', status: 202, body: pending });
    expect(await proxyHotelBook(request(BODY), call)).toEqual({ status: 202, body: pending });

    const confirmed = { orderId: ORDER_ID, status: 'confirmed', providerBookingId: 'FL1IMA' };
    call.mockResolvedValue({ kind: 'json', status: 201, body: confirmed });
    expect(await proxyHotelBook(request(BODY), call)).toEqual({ status: 201, body: confirmed });
  });

  it('devuelve el cuerpo de error COMPLETO: precio nuevo, orden existente y marcas', async () => {
    const repriced = {
      statusCode: 409,
      error: 'Conflict',
      message: 'El precio de la tarifa subió al revalidarla antes de reservar.',
      reason: 'PRICE_INCREASED',
      details: {
        acceptedTotal: { amountMinor: 32134, currency: 'USD' },
        currentTotal: { amountMinor: 33000, currency: 'USD' },
        prebookRef: 'c2d4c1c2-6a8e-4c7f-9d0e-3f2a1b0c9d8e',
      },
    };
    call.mockResolvedValue({ kind: 'json', status: 409, body: repriced });
    expect(await proxyHotelBook(request(BODY), call)).toEqual({ status: 409, body: repriced });

    const duplicate = {
      statusCode: 409,
      message: 'Esta solicitud de creación ya fue recibida.',
      orderId: ORDER_ID,
      duplicateRequest: true,
      retryForbidden: true,
      reconciliationRequired: true,
    };
    call.mockResolvedValue({ kind: 'json', status: 409, body: duplicate });
    expect(await proxyHotelBook(request(BODY), call)).toEqual({ status: 409, body: duplicate });
  });

  it('sin respuesta del API, conserva el estado y un mensaje: el navegador no repite', async () => {
    call.mockResolvedValue({ kind: 'not-json', status: 524, message: 'Se cortó.' });
    expect(await proxyHotelBook(request(BODY), call)).toEqual({
      status: 524,
      body: { statusCode: 524, message: 'Se cortó.' },
    });
    call.mockResolvedValue({ kind: 'unreachable', status: 503, message: 'Sin conexión.' });
    expect(await proxyHotelBook(request(BODY), call)).toMatchObject({ status: 503 });
  });

  it('sin Idempotency-Key UUID no llama al API', async () => {
    expect(await proxyHotelBook(request(BODY, null), call)).toMatchObject({ status: 400 });
    expect(await proxyHotelBook(request(BODY, 'no-es-uuid'), call)).toMatchObject({
      status: 400,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('un cuerpo que no es el neutral, o que no es JSON, no llega al API', async () => {
    expect(await proxyHotelBook(request('{roto'), call)).toMatchObject({ status: 400 });
    expect(
      await proxyHotelBook(request({ prebookId: 'PB-1', externalBookingReference: 'x' }), call),
    ).toMatchObject({ status: 400 });
    expect(call).not.toHaveBeenCalled();
  });
});
