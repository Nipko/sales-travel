import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * La caché de búsquedas en Redis (docs/platform/18): prefijo propio, TTL, y que una caída de Redis
 * nunca rompa la búsqueda (cae a la memoria del proceso).
 */

interface FakeClient {
  store: Map<string, { value: string; ex?: number }>;
  fail: boolean;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, opts?: { EX?: number }) => Promise<string>;
  del: (...keys: string[]) => Promise<number>;
  scan: (cursor: string, opts: { MATCH?: string }) => Promise<[string, string[]]>;
}

const fake: FakeClient = {
  store: new Map(),
  fail: false,
  get(key) {
    if (this.fail) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(this.store.get(key)?.value ?? null);
  },
  set(key, value, opts) {
    if (this.fail) return Promise.reject(new Error('ECONNREFUSED'));
    this.store.set(key, { value, ...(opts?.EX === undefined ? {} : { ex: opts.EX }) });
    return Promise.resolve('OK');
  },
  del(...keys) {
    if (this.fail) return Promise.reject(new Error('ECONNREFUSED'));
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return Promise.resolve(n);
  },
  scan(_cursor, opts) {
    const re = new RegExp(`^${(opts.MATCH ?? '*').split('*').join('.*')}$`);
    return Promise.resolve(['0', [...this.store.keys()].filter((k) => re.test(k))]);
  },
};

vi.mock('bullmq', () => ({
  RedisConnection: class {
    get client() {
      return Promise.resolve(fake);
    }
    close() {
      return Promise.resolve();
    }
  },
}));

import { SearchCacheAdapter } from './search-cache.adapter.js';

describe('SearchCacheAdapter con Redis', () => {
  beforeEach(() => {
    process.env['REDIS_HOST'] = 'redis';
    fake.store.clear();
    fake.fail = false;
  });
  afterEach(() => {
    delete process.env['REDIS_HOST'];
  });

  it('guarda con prefijo propio y TTL, y lee lo guardado', async () => {
    const cache = new SearchCacheAdapter();
    await cache.set('search:flights:t:abc', { offers: [1] }, 600);
    expect(fake.store.get('st:cache:search:flights:t:abc')).toEqual({
      value: JSON.stringify({ offers: [1] }),
      ex: 600,
    });
    expect(await cache.get('search:flights:t:abc')).toEqual({ offers: [1] });
    expect(await cache.get('otra')).toBeNull();
  });

  it('borra una clave y por patrón', async () => {
    const cache = new SearchCacheAdapter();
    await cache.set('search:flights:t1:a', 1);
    await cache.set('search:flights:t1:b', 2);
    await cache.set('search:fares:t1:c', 3);
    await cache.delete('search:flights:t1:a');
    expect(await cache.get('search:flights:t1:a')).toBeNull();
    await cache.invalidatePattern('search:flights:*');
    expect(await cache.get('search:flights:t1:b')).toBeNull();
    expect(await cache.get('search:fares:t1:c')).toBe(3);
  });

  it('si Redis falla, sigue con la memoria del proceso: la búsqueda no se cae', async () => {
    const cache = new SearchCacheAdapter();
    fake.fail = true;
    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get('k')).toEqual({ a: 1 });
    await cache.delete('k');
    expect(await cache.get('k')).toBeNull();
    await cache.invalidatePattern('*');
    await cache.onModuleDestroy();
  });
});

describe('SearchCacheAdapter sin Redis configurado', () => {
  it('usa la memoria del proceso', async () => {
    delete process.env['REDIS_HOST'];
    const cache = new SearchCacheAdapter();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    await cache.delete('k');
    expect(await cache.get('k')).toBeNull();
    await cache.invalidatePattern('*');
    await cache.onModuleDestroy();
  });
});
