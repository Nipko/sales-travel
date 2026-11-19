import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/api', () => ({ api: apiMock }));

import { hotelImageProxyUrl } from '../../../../lib/hotel-image-proxy';
import { encodeHotelKey } from '../_components/hotel-key';
import { hotelContentAction } from './actions';

const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };
const KEY = encodeHotelKey([DESPEGAR, TBO]) ?? '';

function contentView(ref: { provider: string; hotelId: string }) {
  return {
    providerCode: ref.provider,
    hotelId: ref.hotelId,
    requestedLang: 'es',
    lang: 'es',
    origin: 'catalog',
    name: 'Hotel Plaza',
    images: [
      'https://api.tbotechnology.in/imageresource.aspx?img=1.jpg',
      'http://api.tbotechnology.in/imageresource.aspx?img=2.jpg',
      'https://img.example/3.jpg',
    ],
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
    // Por el proxy propio: la URL del proveedor no llega al navegador, y lo que no es `https` de
    // un dominio de fotos del proveedor no entra.
    const photos = res.outcomes[1]?.content?.images ?? [];
    expect(photos).toEqual([
      hotelImageProxyUrl('https://api.tbotechnology.in/imageresource.aspx?img=1.jpg'),
    ]);
    expect(photos[0]).toMatch(/^\/api\/hotels\/images\/[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(res)).not.toContain('tbotechnology.in');
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
