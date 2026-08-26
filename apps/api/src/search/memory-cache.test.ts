import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

/** Los mismos números que declara el adaptador; si cambian allá, este test debe fallar. */
const MAX_ENTRIES = 5_000;
const EVICTION_RATIO = 0.1;

/** El `Map` interno es privado; el tamaño es la única forma de observar la eviction. */
function storeOf(cache: MemoryCacheAdapter): Map<string, unknown> {
  return (cache as unknown as { store: Map<string, unknown> }).store;
}

describe('MemoryCacheAdapter', () => {
  let cache: MemoryCacheAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    // El adaptador avisa por log cuando la caché se llena: es un caso esperado acá.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    cache = new MemoryCacheAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('get / set / delete', () => {
    it('devuelve null para una clave que nunca se escribió', async () => {
      await expect(cache.get('no-existe')).resolves.toBeNull();
    });

    it('devuelve el valor guardado, incluidos objetos', async () => {
      await cache.set('k', { offers: [1, 2], simulated: false });
      await expect(cache.get<{ offers: number[]; simulated: boolean }>('k')).resolves.toEqual({
        offers: [1, 2],
        simulated: false,
      });
    });

    it('guarda por REFERENCIA, no por copia (documenta el comportamiento actual)', async () => {
      const valor = { offers: [1] };
      await cache.set('k', valor);
      valor.offers.push(2);
      // Quien mute lo que cacheó, muta lo cacheado. Hoy es así y nadie depende de lo
      // contrario; si algún día se clona, este test avisa del cambio.
      await expect(cache.get<{ offers: number[] }>('k')).resolves.toEqual({ offers: [1, 2] });
    });

    it('delete quita la entrada y es idempotente', async () => {
      await cache.set('k', 'v');
      await cache.delete('k');
      await expect(cache.get('k')).resolves.toBeNull();
      await expect(cache.delete('k')).resolves.toBeUndefined();
    });
  });

  describe('TTL', () => {
    it('el valor vive dentro de la ventana y desaparece al cumplirse el TTL', async () => {
      await cache.set('k', 'v', 90);

      vi.advanceTimersByTime(89_999);
      await expect(cache.get('k')).resolves.toBe('v');

      // El corte es `expiresAt <= now`: al milisegundo exacto del TTL ya está vencida.
      vi.advanceTimersByTime(1);
      await expect(cache.get('k')).resolves.toBeNull();
    });

    it('el TTL por defecto es de 60 s', async () => {
      await cache.set('k', 'v');

      vi.advanceTimersByTime(59_999);
      await expect(cache.get('k')).resolves.toBe('v');
      vi.advanceTimersByTime(1);
      await expect(cache.get('k')).resolves.toBeNull();
    });

    it('leer una entrada vencida la borra del store (no se acumula basura)', async () => {
      await cache.set('k', 'v', 1);
      vi.advanceTimersByTime(1_000);

      await cache.get('k');
      expect(storeOf(cache).size).toBe(0);
    });

    it('reescribir la clave renueva el TTL', async () => {
      await cache.set('k', 'v1', 10);
      vi.advanceTimersByTime(9_000);
      await cache.set('k', 'v2', 10);

      vi.advanceTimersByTime(9_000);
      await expect(cache.get('k')).resolves.toBe('v2');
    });

    it('TTL de 0 vence de inmediato', async () => {
      await cache.set('k', 'v', 0);
      await expect(cache.get('k')).resolves.toBeNull();
    });
  });

  describe('invalidatePattern', () => {
    beforeEach(async () => {
      await cache.set('search:flights:t1:aaa', 1);
      await cache.set('search:flights:t1:bbb', 2);
      await cache.set('search:flights:t2:ccc', 3);
      await cache.set('search:hotels:t1:ddd', 4);
    });

    it("'*' al final invalida por tenant y deja intactos los demás", async () => {
      await cache.invalidatePattern('search:flights:t1:*');

      await expect(cache.get('search:flights:t1:aaa')).resolves.toBeNull();
      await expect(cache.get('search:flights:t1:bbb')).resolves.toBeNull();
      await expect(cache.get('search:flights:t2:ccc')).resolves.toBe(3);
      await expect(cache.get('search:hotels:t1:ddd')).resolves.toBe(4);
    });

    it("'*' en el medio invalida por vertical a través de todos los tenants", async () => {
      await cache.invalidatePattern('search:flights:*:*');

      await expect(cache.get('search:flights:t1:aaa')).resolves.toBeNull();
      await expect(cache.get('search:flights:t2:ccc')).resolves.toBeNull();
      await expect(cache.get('search:hotels:t1:ddd')).resolves.toBe(4);
    });

    it("'*' solo vacía la caché entera", async () => {
      await cache.invalidatePattern('*');
      expect(storeOf(cache).size).toBe(0);
    });

    it('un patrón sin comodín borra sólo la clave exacta (está anclado)', async () => {
      await cache.invalidatePattern('search:flights:t1');

      // Anclado con ^…$: 'search:flights:t1' NO es prefijo de nada que se borre.
      expect(storeOf(cache).size).toBe(4);
    });

    it('un patrón que no matchea nada no borra nada', async () => {
      await cache.invalidatePattern('search:cars:*');
      expect(storeOf(cache).size).toBe(4);
    });
  });

  describe('escapeRe: los metacaracteres de la clave son literales', () => {
    it("'.' no actúa como comodín de un carácter", async () => {
      await cache.set('rates:v1.0:bog', 'exacta');
      await cache.set('rates:v1X0:bog', 'vecina');

      await cache.invalidatePattern('rates:v1.0:*');

      await expect(cache.get('rates:v1.0:bog')).resolves.toBeNull();
      await expect(cache.get('rates:v1X0:bog')).resolves.toBe('vecina');
    });

    it("'+' no actúa como cuantificador", async () => {
      await cache.set('tag:c+d', 'exacta');
      await cache.set('tag:cd', 'vecina');
      await cache.set('tag:ccd', 'otra');

      await cache.invalidatePattern('tag:c+d');

      await expect(cache.get('tag:c+d')).resolves.toBeNull();
      await expect(cache.get('tag:cd')).resolves.toBe('vecina');
      await expect(cache.get('tag:ccd')).resolves.toBe('otra');
    });

    it("'(' ')' '[' ']' '$' '^' '|' '?' '\\' no rompen la expresión regular", async () => {
      const rara = 'k:(a)[b]$c^d|e?f\\g';
      await cache.set(rara, 'exacta');
      await cache.set('k:otra', 'vecina');

      await expect(cache.invalidatePattern(`${rara}*`)).resolves.toBeUndefined();
      await expect(cache.get(rara)).resolves.toBeNull();
      await expect(cache.get('k:otra')).resolves.toBe('vecina');
    });
  });

  describe(`eviction al llegar a ${MAX_ENTRIES}`, () => {
    it('purga primero lo vencido y no descarta nada vivo si con eso alcanza', async () => {
      for (let i = 0; i < MAX_ENTRIES; i++) await cache.set(`vieja:${i}`, i, 1);
      vi.advanceTimersByTime(1_000);

      await cache.set('nueva', 'v', 60);

      expect(storeOf(cache).size).toBe(1);
      await expect(cache.get('nueva')).resolves.toBe('v');
    });

    it(`llena de entradas vivas, descarta el ${EVICTION_RATIO * 100}% más viejo`, async () => {
      for (let i = 0; i < MAX_ENTRIES; i++) await cache.set(`k:${i}`, i, 3_600);
      expect(storeOf(cache).size).toBe(MAX_ENTRIES);

      await cache.set('k:nueva', 'v', 3_600);

      const descartadas = Math.ceil(MAX_ENTRIES * EVICTION_RATIO);
      expect(storeOf(cache).size).toBe(MAX_ENTRIES - descartadas + 1);

      // El Map conserva orden de inserción: se van las primeras, sobreviven las últimas.
      await expect(cache.get('k:0')).resolves.toBeNull();
      await expect(cache.get(`k:${descartadas - 1}`)).resolves.toBeNull();
      await expect(cache.get(`k:${descartadas}`)).resolves.toBe(descartadas);
      await expect(cache.get('k:nueva')).resolves.toBe('v');
    });
  });
});
