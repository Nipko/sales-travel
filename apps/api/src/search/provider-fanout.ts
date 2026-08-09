import { Logger } from '@nestjs/common';

export interface ProviderRun<T> {
  code: string;
  run: () => Promise<T[]>;
}

export interface FanoutResult<T> {
  items: T[];
  /** Proveedores que respondieron bien. */
  succeeded: string[];
  /** Los que fallaron, con el motivo legible. La UI puede decir qué falta. */
  failed: { code: string; reason: string }[];
}

/**
 * Consulta N proveedores EN PARALELO y agrega lo que responda cada uno.
 *
 * Antes había un proveedor hardcodeado por vertical y ninguna forma de sumar otro sin
 * tocar el servicio. Peor: si ese único proveedor fallaba, la búsqueda entera fallaba.
 *
 * `Promise.allSettled` da degradación PARCIAL: si Amadeus responde y LATAM no, el
 * vendedor ve lo de Amadeus y un aviso de qué falta, en vez de una pantalla de error.
 * Devolver resultados incompletos EN SILENCIO sería peor que fallar — por eso `failed`
 * viaja en la respuesta y no sólo al log.
 */
export async function fanOut<T>(
  runs: ProviderRun<T>[],
  logger = new Logger('ProviderFanout'),
): Promise<FanoutResult<T>> {
  const settled = await Promise.allSettled(runs.map((r) => r.run()));

  const items: T[] = [];
  const succeeded: string[] = [];
  const failed: { code: string; reason: string }[] = [];

  settled.forEach((res, i) => {
    const code = runs[i]!.code;
    if (res.status === 'fulfilled') {
      items.push(...res.value);
      succeeded.push(code);
    } else {
      const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
      failed.push({ code, reason });
      logger.warn(`proveedor ${code} falló en el fan-out: ${reason}`);
    }
  });

  return { items, succeeded, failed };
}

/**
 * Deduplica ofertas equivalentes de proveedores distintos, quedándose con la más barata.
 *
 * Dos GDS pueden vender el MISMO vuelo: sin esto el vendedor ve la misma opción repetida
 * y no sabe cuál elegir. La clave la define el llamador porque qué hace equivalentes a
 * dos ofertas depende de la vertical (itinerario en vuelos, hotel+roompack en hoteles).
 */
export function dedupeCheapest<T>(
  items: T[],
  keyOf: (item: T) => string,
  priceOf: (item: T) => number,
): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const current = best.get(key);
    if (!current || priceOf(item) < priceOf(current)) best.set(key, item);
  }
  return [...best.values()];
}
