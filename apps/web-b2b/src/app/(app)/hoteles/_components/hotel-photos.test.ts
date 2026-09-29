import { describe, expect, it } from 'vitest';
import { HOTEL_IMAGE_PROXY_PATH, hotelImageProxyUrl } from '../../../../lib/hotel-image-proxy';
import type { HotelOffer, HotelRoompack } from '../actions';
import {
  PHOTO_MAX_ATTEMPTS,
  applyPhotoBatch,
  failPhotoBatch,
  initialPhotoState,
  isProxyImagePath,
  isRetryableStatus,
  markLoading,
  nextPhotoBatch,
  nextPhotoWakeUp,
  parsePhotoBatchReply,
  photoBatchBody,
  photoRefsOf,
  requestPhotoBatch,
  type PhotoState,
  type PhotoTarget,
} from './hotel-photos';

const PHOTO = hotelImageProxyUrl('https://api.tbotechnology.in/imageresource.aspx?img=abc')!;

function pack(provider: string): HotelRoompack {
  return {
    id: `${provider}-1`,
    provider: { name: provider, offerRef: 'R' },
    board: 'RO',
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: 100, currency: 'USD' }, taxesDetail: [] },
  };
}

function offer(hotelId: string, extra: Partial<HotelOffer> = {}): HotelOffer {
  return { hotelId, roompacks: [pack('tbo-hotels')], ...extra };
}

function target(key: string, hotelId = key): PhotoTarget {
  return { key, refs: [{ providerCode: 'tbo-hotels', hotelId }] };
}

describe('isProxyImagePath — lo único que se le pasa a next/image', () => {
  it('la ruta del proxy propio, igual que la arma lib/hotel-image-proxy', () => {
    expect(PHOTO.startsWith(HOTEL_IMAGE_PROXY_PATH)).toBe(true);
    expect(isProxyImagePath(PHOTO)).toBe(true);
  });

  it('nada remoto, con query ni con otra ruta', () => {
    expect(isProxyImagePath('https://api.tbotechnology.in/imageresource.aspx?img=abc')).toBe(false);
    expect(isProxyImagePath(`${PHOTO}?w=1`)).toBe(false);
    expect(isProxyImagePath('/api/hotels/images/../../secret')).toBe(false);
    expect(isProxyImagePath('/otra/ruta/abc')).toBe(false);
    expect(isProxyImagePath(undefined)).toBe(false);
  });
});

describe('initialPhotoState', () => {
  it('la foto que vino con la búsqueda está lista', () => {
    expect(initialPhotoState(offer('1', { mainImage: { url: PHOTO } }))).toEqual({
      status: 'ready',
      url: PHOTO,
      attempts: 0,
    });
  });

  it('sin foto, a pedir; una URL que no es del proxy no se usa', () => {
    expect(initialPhotoState(offer('1')).status).toBe('idle');
    expect(
      initialPhotoState(offer('1', { mainImage: { url: 'https://x.test/a.jpg' } })).status,
    ).toBe('idle');
  });

  it('una tarjeta que no dice de qué proveedor es no se puede pedir: marcador', () => {
    expect(initialPhotoState({ hotelId: '1', roompacks: [] }).status).toBe('none');
  });
});

describe('photoRefsOf', () => {
  it('con varios proveedores, el código de cada uno', () => {
    expect(
      photoRefsOf(
        offer('X', {
          providerHotels: [
            { provider: 'despegar-hotels', hotelId: '55' },
            { provider: 'tbo-hotels', hotelId: '1001' },
          ],
        }),
      ),
    ).toEqual([
      { providerCode: 'despegar-hotels', hotelId: '55' },
      { providerCode: 'tbo-hotels', hotelId: '1001' },
    ]);
  });
});

describe('nextPhotoBatch — tandas en el orden en que se ven', () => {
  const idle: PhotoState = { status: 'idle', attempts: 0 };

  it('hasta el tope de códigos del API, en orden', () => {
    const order = Array.from({ length: 30 }, (_, i) => target(`k${i}`));
    const states = new Map(order.map((t) => [t.key, idle]));
    const batch = nextPhotoBatch(order, states, 0);
    expect(batch).toHaveLength(24);
    expect(batch[0]?.key).toBe('k0');
  });

  it('salta las listas, las que se están pidiendo y las pending que todavía no tocan', () => {
    const order = [target('a'), target('b'), target('c'), target('d')];
    const states = new Map<string, PhotoState>([
      ['a', { status: 'ready', url: PHOTO, attempts: 0 }],
      ['b', { status: 'loading', attempts: 1 }],
      ['c', { status: 'pending', attempts: 1, retryAt: 5_000 }],
      ['d', idle],
    ]);
    expect(nextPhotoBatch(order, states, 1_000).map((t) => t.key)).toEqual(['d']);
    expect(nextPhotoBatch(order, states, 5_000).map((t) => t.key)).toEqual(['c', 'd']);
  });

  it('el cuerpo no repite un código', () => {
    expect(photoBatchBody([target('a', '1'), target('b', '1')])).toEqual({
      lang: 'es',
      hotels: [{ providerCode: 'tbo-hotels', hotelId: '1' }],
    });
  });
});

describe('parsePhotoBatchReply', () => {
  it('lee ready, pending y none; una foto que no es del proxy cuenta como none', () => {
    const reply = parsePhotoBatchReply({
      lang: 'es',
      retryAfterMs: 3000,
      items: [
        { providerCode: 'tbo-hotels', hotelId: '1', status: 'ready', mainImage: { url: PHOTO } },
        { providerCode: 'tbo-hotels', hotelId: '2', status: 'pending', mainImage: null },
        {
          providerCode: 'tbo-hotels',
          hotelId: '3',
          status: 'ready',
          mainImage: { url: 'https://evil.test/x.jpg' },
        },
        'basura',
      ],
    });
    expect(reply?.retryAfterMs).toBe(3000);
    expect(reply?.items.get('tbo-hotels~1')).toEqual({ status: 'ready', url: PHOTO });
    expect(reply?.items.get('tbo-hotels~2')).toEqual({ status: 'pending' });
    expect(reply?.items.get('tbo-hotels~3')).toEqual({ status: 'none' });
  });

  it('sin lista, nada', () => {
    expect(parsePhotoBatchReply({ message: 'x' })).toBeUndefined();
    expect(parsePhotoBatchReply(null)).toBeUndefined();
  });
});

describe('applyPhotoBatch y failPhotoBatch — reintentos acotados', () => {
  const batch = [target('a', '1'), target('b', '2'), target('c', '3')];
  const loading = markLoading(new Map(), batch);

  it('ready pinta, pending espera retryAfterMs, none deja el marcador', () => {
    const reply = parsePhotoBatchReply({
      retryAfterMs: 3000,
      items: [
        { providerCode: 'tbo-hotels', hotelId: '1', status: 'ready', mainImage: { url: PHOTO } },
        { providerCode: 'tbo-hotels', hotelId: '2', status: 'pending', mainImage: null },
        { providerCode: 'tbo-hotels', hotelId: '3', status: 'none', mainImage: null },
      ],
    })!;
    const next = applyPhotoBatch(loading, batch, reply, 10_000);
    expect(next.get('a')).toEqual({ status: 'ready', url: PHOTO, attempts: 1 });
    expect(next.get('b')).toEqual({ status: 'pending', attempts: 1, retryAt: 13_000 });
    expect(next.get('c')).toEqual({ status: 'none', attempts: 1 });
    expect(nextPhotoWakeUp(next)).toBe(13_000);
  });

  it('la tarjeta con varios códigos toma la foto de cualquiera', () => {
    const multi: PhotoTarget = {
      key: 'm',
      refs: [
        { providerCode: 'despegar-hotels', hotelId: '9' },
        { providerCode: 'tbo-hotels', hotelId: '1' },
      ],
    };
    const reply = parsePhotoBatchReply({
      items: [
        { providerCode: 'despegar-hotels', hotelId: '9', status: 'none', mainImage: null },
        { providerCode: 'tbo-hotels', hotelId: '1', status: 'ready', mainImage: { url: PHOTO } },
      ],
    })!;
    expect(applyPhotoBatch(markLoading(new Map(), [multi]), [multi], reply, 0).get('m')?.url).toBe(
      PHOTO,
    );
  });

  it(`después de ${PHOTO_MAX_ATTEMPTS} intentos, el marcador`, () => {
    let states: Map<string, PhotoState> = new Map([['a', { status: 'idle', attempts: 0 }]]);
    const one = [target('a', '1')];
    const pending = parsePhotoBatchReply({
      retryAfterMs: 0,
      items: [{ providerCode: 'tbo-hotels', hotelId: '1', status: 'pending', mainImage: null }],
    })!;
    for (let i = 0; i < PHOTO_MAX_ATTEMPTS; i += 1) {
      states = applyPhotoBatch(markLoading(states, one), one, pending, i * 10_000);
    }
    expect(states.get('a')).toEqual({ status: 'none', attempts: PHOTO_MAX_ATTEMPTS });
    expect(nextPhotoWakeUp(states)).toBeUndefined();
  });

  it('una foto lista no vuelve atrás: ni se marca pedida ni la pisa una respuesta tardía', () => {
    const ready: PhotoState = { status: 'ready', url: PHOTO, attempts: 1 };
    const one = [target('a', '1')];
    const states = new Map([['a', ready]]);
    expect(markLoading(states, one).get('a')).toBe(ready);
    const none = parsePhotoBatchReply({
      items: [{ providerCode: 'tbo-hotels', hotelId: '1', status: 'none', mainImage: null }],
    })!;
    expect(applyPhotoBatch(states, one, none, 0).get('a')).toBe(ready);
    expect(failPhotoBatch(states, one, 0, false).get('a')).toBe(ready);
  });

  it('un retryAfterMs de 0 no es un bucle: espera al menos un segundo', () => {
    const one = [target('a', '1')];
    const reply = parsePhotoBatchReply({
      retryAfterMs: 0,
      items: [{ providerCode: 'tbo-hotels', hotelId: '1', status: 'pending', mainImage: null }],
    })!;
    expect(applyPhotoBatch(markLoading(new Map(), one), one, reply, 0).get('a')?.retryAt).toBe(
      1_000,
    );
  });

  it('un fallo pasajero se reintenta; uno que no se arregla insistiendo deja el marcador', () => {
    expect(failPhotoBatch(loading, batch, 0, true).get('a')).toMatchObject({ status: 'pending' });
    expect(failPhotoBatch(loading, batch, 0, false).get('a')).toEqual({
      status: 'none',
      attempts: 1,
    });
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});

describe('requestPhotoBatch — nunca lanza', () => {
  const signal = new AbortController().signal;
  const one = [target('a', '1')];
  const fakeFetch = (respond: (url: string, init: RequestInit) => Response) =>
    ((url: string, init: RequestInit) =>
      Promise.resolve(respond(url, init))) as unknown as typeof fetch;

  it('manda el cuerpo que acepta el API y lee la respuesta', async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = fakeFetch((url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
      return new Response(
        JSON.stringify({
          items: [
            {
              providerCode: 'tbo-hotels',
              hotelId: '1',
              status: 'ready',
              mainImage: { url: PHOTO },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const out = await requestPhotoBatch(one, signal, fake);
    expect(calls[0]?.url).toBe('/api/hotels/content/batch');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      lang: 'es',
      hotels: [{ providerCode: 'tbo-hotels', hotelId: '1' }],
    });
    expect(out.ok && out.reply.items.get('tbo-hotels~1')?.status).toBe('ready');
  });

  it('red caída: se reintenta; 429 con Retry-After: se espera lo que dice', async () => {
    const down = (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch;
    expect(await requestPhotoBatch(one, signal, down)).toEqual({ ok: false, retryable: true });

    const busy = fakeFetch(
      () => new Response(null, { status: 429, headers: { 'retry-after': '7' } }),
    );
    expect(await requestPhotoBatch(one, signal, busy)).toEqual({
      ok: false,
      retryable: true,
      retryAfterMs: 7_000,
    });
  });

  it('un 400 o una respuesta ilegible no se reintentan', async () => {
    const bad = fakeFetch(() => new Response('{}', { status: 400 }));
    expect(await requestPhotoBatch(one, signal, bad)).toEqual({ ok: false, retryable: false });
    const junk = fakeFetch(() => new Response('no json', { status: 200 }));
    expect(await requestPhotoBatch(one, signal, junk)).toEqual({ ok: false, retryable: false });
  });
});
