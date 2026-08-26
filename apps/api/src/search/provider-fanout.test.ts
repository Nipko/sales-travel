import type { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { dedupeCheapest, fanOut, type ProviderRun } from './provider-fanout.js';

/**
 * Logger silencioso: `fanOut` avisa por `warn` de cada proveedor caído y sin esto los
 * casos de fallo ensucian la salida del runner con ruido que no es una regresión.
 */
function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { warn } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function ok<T>(code: string, items: T[]): ProviderRun<T> {
  return { code, run: () => Promise.resolve(items) };
}

function fails(code: string, message: string): ProviderRun<string> {
  return { code, run: () => Promise.reject(new Error(message)) };
}

describe('fanOut', () => {
  it('dos proveedores OK: agrega los items de ambos y no reporta fallos', async () => {
    const res = await fanOut([ok('prov-a', ['a1', 'a2']), ok('prov-b', ['b1'])], silentLogger());

    expect(res.items).toEqual(['a1', 'a2', 'b1']);
    expect(res.succeeded).toEqual(['prov-a', 'prov-b']);
    expect(res.failed).toEqual([]);
  });

  it('degradación parcial: 1 OK + 1 falla devuelve lo que hay y el motivo del caído', async () => {
    const logger = silentLogger();
    const res = await fanOut<string>([ok('prov-a', ['a1']), fails('prov-b', 'timeout')], logger);

    expect(res.items).toEqual(['a1']);
    expect(res.succeeded).toEqual(['prov-a']);
    expect(res.failed).toEqual([{ code: 'prov-b', reason: 'timeout' }]);
    // El fallo no viaja sólo al log: la respuesta lo lleva para que la UI diga qué falta.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('un rechazo que no es Error se estringiza en `reason`', async () => {
    // El cast miente al compilador A PROPÓSITO: reproduce a un cliente HTTP que rechaza
    // con un string en vez de con un Error, que es justo la rama que `fanOut` cubre con
    // `String(res.reason)` y la que un mock bien tipado nunca ejercitaría.
    const motivoCrudo = 'caída dura' as unknown as Error;

    const res = await fanOut<string>(
      [{ code: 'prov-a', run: () => Promise.reject(motivoCrudo) }],
      silentLogger(),
    );

    expect(res.failed).toEqual([{ code: 'prov-a', reason: 'caída dura' }]);
  });

  it('ambos fallan: items vacío, succeeded vacío y los dos motivos', async () => {
    const res = await fanOut<string>(
      [fails('prov-a', 'HTTP 503'), fails('prov-b', 'HTTP 500')],
      silentLogger(),
    );

    expect(res.items).toEqual([]);
    expect(res.succeeded).toEqual([]);
    expect(res.failed).toEqual([
      { code: 'prov-a', reason: 'HTTP 503' },
      { code: 'prov-b', reason: 'HTTP 500' },
    ]);
  });

  it('sin proveedores devuelve el resultado vacío sin explotar', async () => {
    const res = await fanOut<string>([], silentLogger());
    expect(res).toEqual({ items: [], succeeded: [], failed: [] });
  });

  it('llama a los proveedores EN PARALELO, no en secuencia', async () => {
    // Prueba por dependencia mutua, no por reloj: el primer proveedor sólo puede terminar
    // DESPUÉS de que el segundo haya arrancado. Si `fanOut` los ejecutara en secuencia
    // esperaría al primero para siempre y el test moriría por timeout — que es
    // exactamente la regresión que hay que detectar.
    let arrancóElSegundo!: () => void;
    const segundoArrancado = new Promise<void>((resolve) => {
      arrancóElSegundo = resolve;
    });

    const res = await fanOut<string>(
      [
        {
          code: 'prov-a',
          run: async () => {
            await segundoArrancado;
            return ['a1'];
          },
        },
        {
          code: 'prov-b',
          run: () => {
            arrancóElSegundo();
            return Promise.resolve(['b1']);
          },
        },
      ],
      silentLogger(),
    );

    expect(res.items).toEqual(['a1', 'b1']);
    expect(res.succeeded).toEqual(['prov-a', 'prov-b']);
  }, 2_000);

  it('conserva el orden de `runs` en items y en succeeded, no el de llegada', async () => {
    let liberarPrimero!: () => void;
    const esperaPrimero = new Promise<void>((resolve) => {
      liberarPrimero = resolve;
    });

    const res = await fanOut<string>(
      [
        {
          code: 'lento',
          run: async () => {
            await esperaPrimero;
            return ['lento-1'];
          },
        },
        {
          code: 'rápido',
          run: () => {
            liberarPrimero();
            return Promise.resolve(['rápido-1']);
          },
        },
      ],
      silentLogger(),
    );

    expect(res.items).toEqual(['lento-1', 'rápido-1']);
    expect(res.succeeded).toEqual(['lento', 'rápido']);
  }, 2_000);
});

interface Tarifa {
  key: string;
  precio: number;
  proveedor: string;
}

describe('dedupeCheapest', () => {
  const keyOf = (t: Tarifa): string => t.key;
  const priceOf = (t: Tarifa): number => t.precio;

  it('se queda con la más barata de dos ofertas equivalentes', () => {
    const out = dedupeCheapest(
      [
        { key: 'BOG-LIM', precio: 300, proveedor: 'a' },
        { key: 'BOG-LIM', precio: 250, proveedor: 'b' },
      ],
      keyOf,
      priceOf,
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.proveedor).toBe('b');
  });

  it('conserva la primera cuando el precio empata (no hay motivo para cambiar)', () => {
    const out = dedupeCheapest(
      [
        { key: 'BOG-LIM', precio: 300, proveedor: 'a' },
        { key: 'BOG-LIM', precio: 300, proveedor: 'b' },
      ],
      keyOf,
      priceOf,
    );

    expect(out[0]?.proveedor).toBe('a');
  });

  it('no mezcla claves distintas y respeta el orden de primera aparición', () => {
    const out = dedupeCheapest(
      [
        { key: 'BOG-LIM', precio: 300, proveedor: 'a' },
        { key: 'BOG-GRU', precio: 900, proveedor: 'b' },
        { key: 'BOG-LIM', precio: 100, proveedor: 'c' },
      ],
      keyOf,
      priceOf,
    );

    expect(out.map((t) => t.key)).toEqual(['BOG-LIM', 'BOG-GRU']);
    expect(out[0]?.proveedor).toBe('c');
  });

  it('lista vacía devuelve lista vacía', () => {
    expect(dedupeCheapest<Tarifa>([], keyOf, priceOf)).toEqual([]);
  });
});
