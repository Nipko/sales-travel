import { describe, expect, it, vi } from 'vitest';
import {
  DEAD_STREAK,
  httpPictureProbe,
  pictureFilter,
  type PictureFilterReport,
  type PictureState,
} from './despegar-picture-check';

const url = (i: number): string => `https://media.staticontent.com/media/pictures/p${i}`;

function probeOf(states: Record<string, PictureState>) {
  return vi.fn((u: string) => Promise.resolve(states[u] ?? 'alive'));
}

describe('pictureFilter', () => {
  it('saca las fotos rotas y deja las buenas en su orden: la primera que abre va a la tarjeta', async () => {
    const probe = probeOf({ [url(0)]: 'dead', [url(2)]: 'dead' });
    const out = await pictureFilter(probe)([url(0), url(1), url(2), url(3)], 24);
    expect(out).toEqual([url(1), url(3)]);
  });

  it('un timeout o un error de red no prueban nada: la foto se queda', async () => {
    const probe = probeOf({ [url(0)]: 'unknown' });
    expect(await pictureFilter(probe)([url(0), url(1)], 24)).toEqual([url(0), url(1)]);
  });

  it('con las primeras rotas al hilo, el hotel queda sin fotos y no se prueba el resto', async () => {
    const urls = Array.from({ length: 40 }, (_, i) => url(i));
    const probe = vi.fn(() => Promise.resolve('dead' as const));
    expect(await pictureFilter(probe)(urls, 24)).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(DEAD_STREAK);
  });

  it('prueba y guarda como mucho `max`', async () => {
    const urls = Array.from({ length: 40 }, (_, i) => url(i));
    const probe = probeOf({});
    expect(await pictureFilter(probe)(urls, 6)).toEqual(urls.slice(0, 6));
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('respeta el tope de HEADs en vuelo', async () => {
    let active = 0;
    let peak = 0;
    const probe = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return 'alive' as const;
    });
    const filter = pictureFilter(probe, 3);
    const urls = Array.from({ length: 10 }, (_, i) => url(i));
    await Promise.all([filter(urls, 10), filter(urls, 10)]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('pictureFilter: el reporte para el log', () => {
  it('cuenta rotas, dudosas y guardadas, y da la primera rota de muestra', async () => {
    const reports: PictureFilterReport[] = [];
    const probe = probeOf({ [url(1)]: 'dead', [url(2)]: 'unknown', [url(3)]: 'dead' });
    await pictureFilter(probe, 24, (r) => reports.push(r))([url(0), url(1), url(2), url(3)], 24);
    expect(reports).toEqual([
      { received: 4, checked: 4, dead: 2, unknown: 1, kept: 2, firstDead: url(1) },
    ]);
  });

  it('con las primeras rotas al hilo, reporta el hotel sin ninguna', async () => {
    const reports: PictureFilterReport[] = [];
    const urls = Array.from({ length: 30 }, (_, i) => url(i));
    await pictureFilter(
      vi.fn(() => Promise.resolve('dead' as const)),
      24,
      (r) => reports.push(r),
    )(urls, 24);
    expect(reports).toEqual([
      {
        received: 30,
        checked: DEAD_STREAK,
        dead: DEAD_STREAK,
        unknown: 0,
        kept: 0,
        firstDead: url(0),
      },
    ]);
  });

  it('una lista vacía no reporta nada', async () => {
    const onReport = vi.fn();
    await pictureFilter(probeOf({}), 24, onReport)([], 24);
    expect(onReport).not.toHaveBeenCalled();
  });
});

describe('httpPictureProbe', () => {
  const respond = (status: number, type?: string) =>
    vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status,
          headers: type === undefined ? {} : { 'content-type': type },
        }),
      ),
    ) as unknown as typeof fetch;

  it('HEAD: imagen viva, 404 rota, 429 / 5xx no se sabe', async () => {
    expect(await httpPictureProbe(respond(200, 'image/jpeg'))(url(0))).toBe('alive');
    expect(await httpPictureProbe(respond(404, 'application/json'))(url(0))).toBe('dead');
    expect(await httpPictureProbe(respond(429))(url(0))).toBe('unknown');
    expect(await httpPictureProbe(respond(503))(url(0))).toBe('unknown');
  });

  it('un 200 que no es imagen (la página de error en JSON) es una foto rota', async () => {
    expect(await httpPictureProbe(respond(200, 'application/json'))(url(0))).toBe('dead');
  });

  it('un fallo de red no es una foto rota', async () => {
    const boom = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    expect(await httpPictureProbe(boom)(url(0))).toBe('unknown');
  });

  it('sale con HEAD', async () => {
    const f = respond(200, 'image/webp');
    await httpPictureProbe(f)(url(0));
    expect(f).toHaveBeenCalledWith(url(0), expect.objectContaining({ method: 'HEAD' }));
  });
});
