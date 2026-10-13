import { describe, expect, it, vi } from 'vitest';
import { encodeHotelKey } from '../../../(app)/hoteles/_components/hotel-key';
import type { ApiResponse } from '../../../../lib/api';
import { proxyHotelRooms, roomContentLang } from './hotel-rooms-proxy';

/*
 * `GET /api/hotels/rooms/<clave>`: una consulta al API por cada proveedor del hotel que da contenido
 * por habitación, la respuesta verificada, y cualquier error como `none`: las fotos nunca rompen la
 * ficha.
 */

const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };
const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const KEY = encodeHotelKey([DESPEGAR, TBO]) ?? '';
const PHOTO = '/api/hotels/images/aHR0cHM6Ly93d3cudGJvaG9saWRheXMuY29tL3IuanBn';

const json = (body: unknown, status = 200): ApiResponse => ({ kind: 'json', status, body });

describe('proxyHotelRooms', () => {
  it('pide sólo los proveedores que dan contenido, en el idioma pedido', async () => {
    const call = vi.fn((_path: string, _init: RequestInit) =>
      Promise.resolve(
        json({
          status: 'ready',
          rooms: [
            {
              roomKey: '11',
              roomId: '11',
              nameKey: 'doble',
              name: 'Doble',
              sizeText: null,
              sizeM2: 25,
              description: 'Dos camas.',
              images: [PHOTO, 'https://www.tboholidays.com/r.jpg'],
            },
          ],
        }),
      ),
    );
    const reply = await proxyHotelRooms(KEY, 'PT', call);
    expect(call.mock.calls).toEqual([
      ['/hotels/content/tbo-hotels/1402689/rooms?lang=pt', { method: 'GET' }],
    ]);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      byProvider: {
        'tbo-hotels': {
          status: 'ready',
          rooms: [
            {
              roomKey: '11',
              roomId: '11',
              nameKey: 'doble',
              name: 'Doble',
              sizeText: null,
              sizeM2: 25,
              description: 'Dos camas.',
              images: [PHOTO],
            },
          ],
        },
      },
    });
    expect(JSON.stringify(reply.body)).not.toContain('tboholidays.com');
  });

  it('un error del API, algo que no es JSON o una excepción: none para ese proveedor', async () => {
    for (const res of [
      json({ statusCode: 429, message: 'Demasiadas' }, 429),
      json({ statusCode: 403 }, 403),
      { kind: 'not-json', status: 502, message: 'Bad Gateway' } as const,
      { kind: 'unreachable', status: 503, message: 'caído' } as const,
    ]) {
      const reply = await proxyHotelRooms(KEY, null, () => Promise.resolve(res));
      expect(reply).toEqual({
        status: 200,
        body: { byProvider: { 'tbo-hotels': { status: 'none', rooms: [] } } },
      });
    }
    const thrown = await proxyHotelRooms(KEY, null, () => Promise.reject(new Error('boom')));
    expect(thrown.body).toEqual({ byProvider: { 'tbo-hotels': { status: 'none', rooms: [] } } });
  });

  it('un hotel sin proveedores con contenido no llama a nadie', async () => {
    const call = vi.fn(() => Promise.resolve(json({})));
    const reply = await proxyHotelRooms(encodeHotelKey([DESPEGAR]) ?? '', 'es', call);
    expect(call).not.toHaveBeenCalled();
    expect(reply).toEqual({ status: 200, body: { byProvider: {} } });
  });

  it('una clave que no es nuestra: 400, sin llegar al API', async () => {
    const call = vi.fn(() => Promise.resolve(json({})));
    const reply = await proxyHotelRooms('../../admin', 'es', call);
    expect(reply.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('roomContentLang', () => {
  it('es, pt o en; cualquier otra cosa, español', () => {
    expect(roomContentLang(' EN ')).toBe('en');
    expect(roomContentLang('pt')).toBe('pt');
    expect(roomContentLang('fr')).toBe('es');
    expect(roomContentLang(null)).toBe('es');
  });
});
