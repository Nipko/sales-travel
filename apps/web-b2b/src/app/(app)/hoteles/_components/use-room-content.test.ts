import { describe, expect, it, vi } from 'vitest';
import { encodeHotelKey } from './hotel-key';
import type { RoomContentReply } from './room-content-view';
import {
  ROOM_CONTENT_CACHE_MAX,
  ROOM_CONTENT_ENDPOINT,
  ROOM_CONTENT_MAX_RETRIES,
  initialRoomContentState,
  loadRoomContent,
  rememberRoomContent,
  rememberedRoomContent,
  requestRoomContent,
  wantsRoomContent,
} from './use-room-content';

/*
 * Las habitaciones de un hotel pedidas en segundo plano: sólo si algún proveedor del hotel da
 * contenido, con reintentos acotados mientras el API lo trae del proveedor, y recordadas por hotel
 * durante la pestaña.
 */

const TBO_KEY = encodeHotelKey([{ provider: 'tbo-hotels', hotelId: '1402689' }]) ?? '';
const DESPEGAR_KEY = encodeHotelKey([{ provider: 'despegar-hotels', hotelId: '555' }]) ?? '';

const PENDING: RoomContentReply = {
  byProvider: { 'tbo-hotels': { status: 'pending', retryAfterMs: 3_000, rooms: [] } },
};
const READY: RoomContentReply = {
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
          sizeM2: null,
          description: null,
          images: ['/api/hotels/images/aGVsbG8'],
        },
      ],
    },
  },
};

describe('qué se pide', () => {
  it('sólo hoteles con un proveedor que da contenido por habitación', () => {
    expect(wantsRoomContent(TBO_KEY)).toBe(true);
    expect(wantsRoomContent(DESPEGAR_KEY)).toBe(false);
    expect(wantsRoomContent('no-es-una-clave!')).toBe(false);
    expect(wantsRoomContent(undefined)).toBe(false);
  });

  it('el primer pintado: nada, cargando o lo recordado', () => {
    const key = encodeHotelKey([{ provider: 'tbo-hotels', hotelId: 'inicial' }]) ?? '';
    expect(initialRoomContentState(DESPEGAR_KEY, true)).toEqual({ status: 'idle' });
    expect(initialRoomContentState(key, false)).toEqual({ status: 'idle' });
    expect(initialRoomContentState(key, true)).toEqual({ status: 'loading' });
    rememberRoomContent(key, READY);
    expect(initialRoomContentState(key, true)).toEqual({ status: 'done', reply: READY });
  });
});

describe('lo recordado', () => {
  it('lo que sigue pending no se recuerda', () => {
    const key = encodeHotelKey([{ provider: 'tbo-hotels', hotelId: 'pendiente' }]) ?? '';
    rememberRoomContent(key, PENDING);
    expect(rememberedRoomContent(key)).toBeUndefined();
  });

  it(`hasta ${ROOM_CONTENT_CACHE_MAX} hoteles: el menos usado sale primero`, () => {
    const keys = Array.from(
      { length: ROOM_CONTENT_CACHE_MAX + 1 },
      (_, i) => encodeHotelKey([{ provider: 'tbo-hotels', hotelId: `h${i}` }]) ?? '',
    );
    keys.slice(0, ROOM_CONTENT_CACHE_MAX).forEach((k) => rememberRoomContent(k, READY));
    // Usar el primero lo deja como el más reciente: el que sale es el segundo.
    expect(rememberedRoomContent(keys[0]!)).toBe(READY);
    rememberRoomContent(keys[ROOM_CONTENT_CACHE_MAX]!, READY);
    expect(rememberedRoomContent(keys[0]!)).toBe(READY);
    expect(rememberedRoomContent(keys[1]!)).toBeUndefined();
    expect(rememberedRoomContent(keys[ROOM_CONTENT_CACHE_MAX]!)).toBe(READY);
  });
});

describe('requestRoomContent', () => {
  it('pide la ruta del panel con la clave y el idioma, sin caché', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ byProvider: { 'tbo-hotels': { status: 'none' } } })),
    );
    const signal = new AbortController().signal;
    const reply = await requestRoomContent(TBO_KEY, signal, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(`${ROOM_CONTENT_ENDPOINT}${TBO_KEY}?lang=es`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    expect(reply).toEqual({ byProvider: { 'tbo-hotels': { status: 'none', rooms: [] } } });
  });

  it('un error, una red caída o algo que no se entiende: undefined, nunca lanza', async () => {
    const signal = new AbortController().signal;
    const as = (f: () => Promise<Response>) => f as unknown as typeof fetch;
    expect(
      await requestRoomContent(
        TBO_KEY,
        signal,
        as(() => Promise.resolve(new Response(null, { status: 503 }))),
      ),
    ).toBeUndefined();
    expect(
      await requestRoomContent(
        TBO_KEY,
        signal,
        as(() => Promise.reject(new TypeError('red'))),
      ),
    ).toBeUndefined();
    expect(
      await requestRoomContent(
        TBO_KEY,
        signal,
        as(() => Promise.resolve(new Response('<html>'))),
      ),
    ).toBeUndefined();
  });
});

describe('loadRoomContent', () => {
  const noWait = vi.fn(() => Promise.resolve(undefined));

  it('listo a la primera: completo, sin reintentos ni esperas', async () => {
    const request = vi.fn(() => Promise.resolve(READY));
    const updates: RoomContentReply[] = [];
    const res = await loadRoomContent(
      TBO_KEY,
      new AbortController().signal,
      (r) => updates.push(r),
      {
        request,
        sleep: noWait,
      },
    );
    expect(res).toEqual({ reply: READY, complete: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
  });

  it('pending: muestra lo que hay, espera lo que pidió el API y vuelve a preguntar', async () => {
    const replies = [PENDING, READY];
    const request = vi.fn(() => Promise.resolve(replies.shift()));
    const sleep = vi.fn(() => Promise.resolve(undefined));
    const updates: RoomContentReply[] = [];
    const res = await loadRoomContent(
      TBO_KEY,
      new AbortController().signal,
      (r) => updates.push(r),
      {
        request,
        sleep,
      },
    );
    expect(res).toEqual({ reply: READY, complete: true });
    expect(updates).toEqual([PENDING]);
    expect(sleep).toHaveBeenCalledWith(3_000, expect.any(AbortSignal));
  });

  it(`hasta ${ROOM_CONTENT_MAX_RETRIES} reintentos; después, sin fotos y sin recordarlo`, async () => {
    const request = vi.fn(() => Promise.resolve(PENDING));
    const res = await loadRoomContent(TBO_KEY, new AbortController().signal, () => undefined, {
      request,
      sleep: noWait,
    });
    expect(request).toHaveBeenCalledTimes(1 + ROOM_CONTENT_MAX_RETRIES);
    expect(res.complete).toBe(false);
    expect(res.reply.byProvider['tbo-hotels']?.status).toBe('none');
  });

  it('un reintento que falla termina con lo que ya había, sin esqueleto', async () => {
    const replies: (RoomContentReply | undefined)[] = [PENDING, undefined];
    const request = vi.fn(() => Promise.resolve(replies.shift()));
    const res = await loadRoomContent(TBO_KEY, new AbortController().signal, () => undefined, {
      request,
      sleep: noWait,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(res).toEqual({
      reply: { byProvider: { 'tbo-hotels': { status: 'none', rooms: [] } } },
      complete: false,
    });
  });

  it('el primer pedido falla: vacío e incompleto', async () => {
    const res = await loadRoomContent(TBO_KEY, new AbortController().signal, () => undefined, {
      request: () => Promise.resolve(undefined),
    });
    expect(res).toEqual({ reply: { byProvider: {} }, complete: false });
  });

  it('cortado mientras espera: no vuelve a preguntar', async () => {
    const run = new AbortController();
    const request = vi.fn(() => Promise.resolve(PENDING));
    const res = await loadRoomContent(TBO_KEY, run.signal, () => undefined, {
      request,
      sleep: () => Promise.resolve(run.abort()),
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(res.complete).toBe(false);
  });

  it('la espera de verdad termina sola o al cortar', async () => {
    vi.useFakeTimers();
    try {
      const replies = [PENDING, READY];
      const done = loadRoomContent(TBO_KEY, new AbortController().signal, () => undefined, {
        request: () => Promise.resolve(replies.shift()),
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await done).toEqual({ reply: READY, complete: true });

      const run = new AbortController();
      const cut = loadRoomContent(TBO_KEY, run.signal, () => undefined, {
        request: () => Promise.resolve(PENDING),
      });
      await vi.advanceTimersByTimeAsync(10);
      run.abort();
      expect((await cut).complete).toBe(false);

      const already = new AbortController();
      already.abort();
      const before = loadRoomContent(TBO_KEY, already.signal, () => undefined, {
        request: () => Promise.resolve(PENDING),
      });
      expect((await before).complete).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
