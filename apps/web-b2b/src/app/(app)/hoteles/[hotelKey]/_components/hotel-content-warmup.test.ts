import { describe, expect, it, vi } from 'vitest';
import type { PhotoBatchOutcome, PhotoRef, PhotoTarget } from '../../_components/hotel-photos';
import type { HotelContentResult } from '../actions';
import type { HotelContent } from './hotel-content-view';
import {
  abortableSleep,
  refsToWarm,
  rereadContent,
  warmHotelContent,
  type WarmDeps,
} from './hotel-content-warmup';

const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };
const TBO_REF: PhotoRef = { providerCode: 'tbo-hotels', hotelId: '1402689' };
const DESPEGAR_REF: PhotoRef = { providerCode: 'despegar-hotels', hotelId: '555' };
const PHOTO = '/api/hotels/images/Zm90bw';

function content(
  ref: { provider: string; hotelId: string },
  extra: Partial<HotelContent> = {},
): HotelContent {
  return {
    providerCode: ref.provider,
    hotelId: ref.hotelId,
    requestedLang: 'es',
    lang: 'es',
    origin: 'catalog',
    name: 'Hotel Plaza',
    stars: null,
    address: null,
    zipcode: null,
    countryCode: null,
    location: null,
    descriptionHtml: null,
    sections: [],
    facilities: [],
    attractionsHtml: null,
    images: [],
    phone: null,
    websiteUrl: null,
    checkInTime: null,
    checkOutTime: null,
    ...extra,
  };
}

function result(...outcomes: HotelContentResult['outcomes']): HotelContentResult {
  return { ok: outcomes.some((o) => o.content !== undefined), outcomes };
}

describe('refsToWarm — qué hoteles pedir al proveedor', () => {
  it('la ficha sin fotos del catálogo (o sin nada): se pide', () => {
    const r = result({ ref: TBO, content: content(TBO, { origin: 'none' }) });
    expect(refsToWarm([TBO], r)).toEqual([TBO_REF]);
    const english = result({
      ref: TBO,
      content: content(TBO, { origin: 'catalog', lang: 'en', descriptionHtml: '<p>Hi</p>' }),
    });
    expect(refsToWarm([TBO], english)).toEqual([TBO_REF]);
  });

  it('con fotos, o si el proveedor ya respondió sin ellas, no se pide nada', () => {
    expect(
      refsToWarm([TBO], result({ ref: TBO, content: content(TBO, { images: [PHOTO] }) })),
    ).toEqual([]);
    expect(
      refsToWarm([TBO], result({ ref: TBO, content: content(TBO, { origin: 'provider' }) })),
    ).toEqual([]);
  });

  it('si la ficha que se muestra (de otro proveedor del mismo hotel) ya tiene fotos, nada', () => {
    const r = result(
      { ref: DESPEGAR, content: content(DESPEGAR, { origin: 'none' }) },
      { ref: TBO, content: content(TBO, { images: [PHOTO] }) },
    );
    expect(refsToWarm([DESPEGAR, TBO], r)).toEqual([]);
  });

  it('sin fotos en ninguna, se piden todas las que respondieron (el API elige cuál sabe darlas)', () => {
    const r = result(
      { ref: DESPEGAR, content: content(DESPEGAR, { origin: 'none' }) },
      { ref: TBO, content: content(TBO, { origin: 'none' }) },
    );
    expect(refsToWarm([DESPEGAR, TBO], r)).toEqual([DESPEGAR_REF, TBO_REF]);
  });

  it('si la ficha del primero falló, no: la pantalla ofrece reintentar', () => {
    const r = result(
      { ref: DESPEGAR, error: 'caído' },
      { ref: TBO, content: content(TBO, { origin: 'none' }) },
    );
    expect(refsToWarm([DESPEGAR, TBO], r)).toEqual([]);
    expect(refsToWarm([TBO], undefined)).toEqual([]);
  });
});

describe('rereadContent — una relectura que falla no borra lo que se veía', () => {
  const before = result({ ref: TBO, content: content(TBO) });
  it('con la ficha del primero, la nueva', () => {
    const after = result({ ref: TBO, content: content(TBO, { images: [PHOTO] }) });
    expect(rereadContent([TBO], before, after)).toBe(after);
  });
  it('sin ella, o sin respuesta, la de antes', () => {
    expect(rereadContent([TBO], before, result({ ref: TBO, error: 'caído' }))).toBe(before);
    expect(rereadContent([TBO], before, undefined)).toBe(before);
  });
});

type Reply = PhotoBatchOutcome;

function ok(
  items: Record<string, 'ready' | 'pending' | 'none'>,
  retryAfterMs?: number,
): PhotoBatchOutcome {
  const map = new Map<string, { status: 'ready' | 'pending' | 'none'; url?: string }>();
  for (const [key, status] of Object.entries(items)) {
    map.set(key, status === 'ready' ? { status, url: PHOTO } : { status });
  }
  return {
    ok: true,
    reply: { items: map, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  };
}

function deps(replies: Reply[]): WarmDeps & {
  calls: PhotoRef[][];
  waits: number[];
} {
  const calls: PhotoRef[][] = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    request: (batch: readonly PhotoTarget[]) => {
      calls.push(batch.flatMap((t) => [...t.refs]));
      const next = replies.shift();
      return next === undefined
        ? Promise.reject(new Error('sin respuesta preparada'))
        : Promise.resolve(next);
    },
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

const TBO_KEY = 'tbo-hotels~1402689';
const DESPEGAR_KEY = 'despegar-hotels~555';

describe('warmHotelContent — el contenido por lote, con reintentos acotados', () => {
  it('listo a la primera: hay que releer la ficha', async () => {
    const d = deps([ok({ [TBO_KEY]: 'ready' })]);
    await expect(warmHotelContent([TBO_REF], new AbortController().signal, d)).resolves.toBe(
      'ready',
    );
    expect(d.calls).toEqual([[TBO_REF]]);
    expect(d.waits).toEqual([]);
  });

  it('pending: espera lo que dice el API y vuelve a pedir sólo lo que sigue pendiente', async () => {
    const d = deps([
      ok({ [TBO_KEY]: 'pending', [DESPEGAR_KEY]: 'none' }, 3_000),
      ok({ [TBO_KEY]: 'ready' }),
    ]);
    await expect(
      warmHotelContent([DESPEGAR_REF, TBO_REF], new AbortController().signal, d),
    ).resolves.toBe('ready');
    expect(d.calls).toEqual([[DESPEGAR_REF, TBO_REF], [TBO_REF]]);
    expect(d.waits).toEqual([3_000]);
  });

  it('todo none: no insiste', async () => {
    const d = deps([ok({ [TBO_KEY]: 'none' })]);
    await expect(warmHotelContent([TBO_REF], new AbortController().signal, d)).resolves.toBe(
      'none',
    );
    expect(d.calls).toHaveLength(1);
  });

  it('a lo sumo tres intentos, sin esperar después del último', async () => {
    // Sigue `pending` en los tres: el cuarto (que diría `ready`) no se pide.
    const d = deps([
      ok({ [TBO_KEY]: 'pending' }),
      ok({ [TBO_KEY]: 'pending' }),
      ok({ [TBO_KEY]: 'pending' }),
      ok({ [TBO_KEY]: 'ready' }),
    ]);
    await expect(warmHotelContent([TBO_REF], new AbortController().signal, d)).resolves.toBe(
      'none',
    );
    expect(d.calls).toHaveLength(3);
    // Sin `retryAfterMs`, la espera por defecto; nunca menos de 1 s.
    expect(d.waits).toEqual([4_000, 4_000]);
  });

  it('un hotel que el API no nombra en la respuesta no se vuelve a pedir', async () => {
    const d = deps([ok({ [DESPEGAR_KEY]: 'pending' }, 3_000), ok({ [DESPEGAR_KEY]: 'none' })]);
    await expect(
      warmHotelContent([DESPEGAR_REF, TBO_REF], new AbortController().signal, d),
    ).resolves.toBe('none');
    expect(d.calls).toEqual([[DESPEGAR_REF, TBO_REF], [DESPEGAR_REF]]);
  });

  it('un 429 o la red se reintentan con su espera; un 400 no', async () => {
    const retry = deps([
      { ok: false, retryable: true, retryAfterMs: 0 },
      ok({ [TBO_KEY]: 'ready' }),
    ]);
    await expect(warmHotelContent([TBO_REF], new AbortController().signal, retry)).resolves.toBe(
      'ready',
    );
    expect(retry.waits).toEqual([1_000]);

    const fatal = deps([{ ok: false, retryable: false }]);
    await expect(warmHotelContent([TBO_REF], new AbortController().signal, fatal)).resolves.toBe(
      'none',
    );
    expect(fatal.calls).toHaveLength(1);
  });

  it('un pedido que lanza cuenta como un fallo pasajero, nunca rompe la ficha', async () => {
    const d = deps([]);
    await expect(
      warmHotelContent([TBO_REF], new AbortController().signal, { ...d, maxAttempts: 2 }),
    ).resolves.toBe('none');
    expect(d.calls).toHaveLength(2);
  });

  it('cortado (se reintentó la ficha o se salió): no pide más', async () => {
    const controller = new AbortController();
    const d = deps([ok({ [TBO_KEY]: 'pending' }), ok({ [TBO_KEY]: 'ready' })]);
    const request = d.request!;
    const outcome = warmHotelContent([TBO_REF], controller.signal, {
      ...d,
      request: async (batch, signal) => {
        const reply = await request(batch, signal);
        controller.abort();
        return reply;
      },
    });
    await expect(outcome).resolves.toBe('none');
    expect(d.calls).toHaveLength(1);
  });
});

describe('abortableSleep', () => {
  it('termina al cortarse, sin esperar el plazo', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      const sleeping = abortableSleep(60_000, controller.signal).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(false);
      controller.abort();
      await sleeping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
