import { describe, expect, it, vi } from 'vitest';
import { loadSuggestions } from './location-suggest-cache';

describe('loadSuggestions', () => {
  it('cachea lo que el API contestó, incluida una lista vacía de verdad', async () => {
    const cache = new Map<string, string[]>();
    const fetcher = vi.fn(() => Promise.resolve({ ok: true, items: [] as string[] }));
    await loadSuggestions(cache, 'zz', fetcher);
    const again = await loadSuggestions(cache, 'zz', fetcher);
    expect(again).toEqual({ ok: true, items: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('no cachea un error: la próxima vez vuelve a consultar', async () => {
    const cache = new Map<string, string[]>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, items: [] })
      .mockResolvedValueOnce({ ok: true, items: ['Bogotá'] });
    expect(await loadSuggestions(cache, 'bog', fetcher)).toEqual({ ok: false, items: [] });
    expect(cache.has('bog')).toBe(false);
    expect(await loadSuggestions(cache, 'bog', fetcher)).toEqual({ ok: true, items: ['Bogotá'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('una excepción del fetcher es un error, no una promesa rechazada', async () => {
    const cache = new Map<string, string[]>();
    const res = await loadSuggestions(cache, 'mia', () => Promise.reject(new Error('red')));
    expect(res).toEqual({ ok: false, items: [] });
    expect(cache.size).toBe(0);
  });
});
