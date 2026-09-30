import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from './api';
import {
  HOTEL_CONTENT_BATCH_MAX_HOTELS,
  parseHotelContentBatchRequest,
  proxyHotelContentBatch,
} from './hotel-content-batch';

/** El proxy del contenido por lote: rearma el cuerpo con lo que el API acepta y reenvía la respuesta. */

const HOTEL = { providerCode: 'tbo-hotels', hotelId: '1010099' };

function pedido(body: unknown): Request {
  return new Request('http://panel.test/api/hotels/content/batch', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('parseHotelContentBatchRequest', () => {
  it('rearma idioma y hoteles; lo demás no pasa', () => {
    expect(
      parseHotelContentBatchRequest({
        lang: 'PT',
        hotels: [{ ...HOTEL, url: 'https://evil.example' }],
        extra: 1,
      }),
    ).toEqual({ lang: 'pt', hotels: [HOTEL] });
    expect(parseHotelContentBatchRequest({ hotels: [HOTEL] })?.lang).toBe('es');
  });

  it('rechaza lo que el API rechazaría', () => {
    const muchos = Array.from({ length: HOTEL_CONTENT_BATCH_MAX_HOTELS + 1 }, () => HOTEL);
    for (const raw of [
      null,
      { hotels: [] },
      { hotels: muchos },
      { hotels: [HOTEL], lang: 'fr' },
      { hotels: [{ providerCode: 'TBO', hotelId: '1' }] },
      { hotels: [{ providerCode: 'tbo-hotels', hotelId: '../1' }] },
      { hotels: ['tbo-hotels:1'] },
    ]) {
      expect(parseHotelContentBatchRequest(raw)).toBeUndefined();
    }
  });
});

describe('proxyHotelContentBatch', () => {
  it('reenvía el cuerpo rearmado y devuelve la respuesta del API tal cual', async () => {
    const respuesta = { lang: 'es', items: [], retryAfterMs: 3000 };
    const call = vi.fn((_path: string, _init: RequestInit) =>
      Promise.resolve<ApiResponse>({ kind: 'json', status: 201, body: respuesta }),
    );

    const reply = await proxyHotelContentBatch(pedido({ hotels: [HOTEL], sobra: true }), call);

    expect(call).toHaveBeenCalledWith('/hotels/content/batch', {
      method: 'POST',
      body: JSON.stringify({ lang: 'es', hotels: [HOTEL] }),
    });
    expect(reply).toEqual({ status: 201, body: respuesta });
  });

  it('un cuerpo que no es JSON o no tiene la forma: 400 sin llamar al API', async () => {
    const call = vi.fn();
    expect((await proxyHotelContentBatch(pedido('{roto'), call)).status).toBe(400);
    expect((await proxyHotelContentBatch(pedido({ hotels: 'x' }), call)).status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });

  it('si el API no responde JSON, queda el estado y un mensaje', async () => {
    const call = vi.fn(() =>
      Promise.resolve<ApiResponse>({ kind: 'unreachable', status: 503, message: 'sin conexión' }),
    );
    expect(await proxyHotelContentBatch(pedido({ hotels: [HOTEL] }), call)).toEqual({
      status: 503,
      body: { statusCode: 503, message: 'sin conexión' },
    });
  });
});
