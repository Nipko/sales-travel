import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/api', () => ({ api: apiMock }));

import { encodeHotelKey } from '../_components/hotel-key';
import { hotelContentAction, hotelRatesAction } from './actions';

const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };
const KEY = encodeHotelKey([DESPEGAR, TBO]) ?? '';

const STAY = {
  checkinDate: '2026-10-12',
  checkoutDate: '2026-10-15',
  rooms: [{ adults: 2, childrenAges: [5] }],
  guestNationality: 'CO',
  refundableOnly: true,
};

function contentView(ref: { provider: string; hotelId: string }) {
  return {
    providerCode: ref.provider,
    hotelId: ref.hotelId,
    requestedLang: 'es',
    lang: 'es',
    origin: 'catalog',
    name: 'Hotel Plaza',
    images: ['https://img.example/1.jpg', 'http://img.example/2.jpg'],
    sections: [],
    facilities: [],
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('hotelContentAction — la ficha de cada proveedor del hotel', () => {
  it('pide la ficha de cada hotel de la clave, en español', async () => {
    apiMock.mockImplementation((path: string) => {
      const ref = path.includes('tbo-hotels') ? TBO : DESPEGAR;
      return Promise.resolve({ ok: true, data: contentView(ref) });
    });
    const res = await hotelContentAction(KEY);
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/hotels/content/despegar-hotels/555?lang=es',
      '/hotels/content/tbo-hotels/1402689?lang=es',
    ]);
    expect(res.ok).toBe(true);
    expect(res.outcomes[1]?.content?.images).toEqual(['https://img.example/1.jpg']);
  });

  it('una clave que no es nuestra no llega al API', async () => {
    const res = await hotelContentAction('../../admin');
    expect(res).toMatchObject({ ok: false, outcomes: [] });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('el fallo de una ficha no tapa la otra', async () => {
    apiMock.mockImplementation((path: string) =>
      path.includes('tbo-hotels')
        ? Promise.resolve({ ok: false, error: { status: 502, message: 'caído' } })
        : Promise.resolve({ ok: true, data: contentView(DESPEGAR) }),
    );
    const res = await hotelContentAction(KEY);
    expect(res.ok).toBe(true);
    expect(res.outcomes.map((o) => [o.ref.provider, o.content !== undefined, o.error])).toEqual([
      ['despegar-hotels', true, undefined],
      ['tbo-hotels', false, 'caído'],
    ]);
  });
});

describe('hotelRatesAction — las tarifas de la estadía (D-TBO-19 A)', () => {
  it('una búsqueda de ESE hotel por proveedor, con la nacionalidad en el cuerpo', async () => {
    apiMock.mockImplementation((_path: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { hotelId: string };
      return Promise.resolve({ ok: true, data: { hotelId: body.hotelId, roompacks: [] } });
    });
    const res = await hotelRatesAction(KEY, STAY);
    expect(res.ok).toBe(true);
    expect(typeof res.receivedAt).toBe('number');
    const calls = apiMock.mock.calls as [string, { method: string; body: string }][];
    expect(calls.map(([path, init]) => [path, init.method])).toEqual([
      ['/hotels/detail', 'POST'],
      ['/hotels/detail', 'POST'],
    ]);
    expect(JSON.parse(calls[1]![1].body)).toEqual({
      hotelId: '1402689',
      provider: 'tbo-hotels',
      checkinDate: '2026-10-12',
      checkoutDate: '2026-10-15',
      rooms: [{ adults: 2, childrenAges: [5] }],
      guestNationality: 'CO',
      refundableOnly: true,
    });
  });

  it('sin estadía válida no se busca: nunca una nacionalidad por defecto (RF-06)', async () => {
    const res = await hotelRatesAction(KEY, { ...STAY, guestNationality: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Faltan los datos de la búsqueda. Buscá de nuevo desde Hoteles.');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('un proveedor que falla queda con su motivo y el otro sigue', async () => {
    apiMock.mockImplementation((_path: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { provider: string; hotelId: string };
      return body.provider === 'tbo-hotels'
        ? Promise.resolve({ ok: false, error: { status: 503, message: 'TBO no está disponible.' } })
        : Promise.resolve({ ok: true, data: { hotelId: body.hotelId, roompacks: [] } });
    });
    const res = await hotelRatesAction(KEY, STAY);
    expect(res.ok).toBe(true);
    expect(res.outcomes[1]).toEqual({ ref: TBO, error: 'TBO no está disponible.' });
  });

  it('una respuesta sin tarifas legibles no se pinta como oferta', async () => {
    apiMock.mockResolvedValue({ ok: true, data: { hotels: [] } });
    const res = await hotelRatesAction(KEY, STAY);
    expect(res.ok).toBe(false);
    expect(res.outcomes.every((o) => o.offer === undefined && o.error)).toBe(true);
  });
});
