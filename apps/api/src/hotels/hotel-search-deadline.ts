/*
 * El plazo de cada ola de la búsqueda de hoteles (auditoría 19, §4.2 «Tiempos»).
 *
 * Mientras el breaker de un proveedor está cerrado, y en cada sonda tras abrirse, la búsqueda
 * esperaba a ese proveedor hasta su propio timeout (TBO: `ResponseTime` + 3 s = 13 s). Con el plazo,
 * el que no respondió a tiempo sale como `error` con un motivo legible y la búsqueda devuelve lo
 * de los demás: es la misma degradación parcial de `fanOut` (`allSettled`), con un techo.
 *
 * El plazo NO cuenta como fallo para el breaker. La llamada sigue su curso por detrás, dentro de
 * `breaker.execute`, y el breaker registra lo que pase de verdad: si termina en el timeout del
 * cliente HTTP, cuenta ese fallo (una sola vez); si responde tarde pero bien, el proveedor está vivo
 * y cerrar el circuito es lo correcto. Contar además el plazo sumaría dos fallos por una misma
 * llamada, y abriría el circuito de un proveedor lento pero sano: sus hoteles desaparecerían 30 s
 * de todas las búsquedas en vez de faltar sólo en las que no esperó.
 */

/**
 * Cuánto espera la búsqueda a cada proveedor de una ola. Por debajo del timeout de Search de TBO
 * (13 s con el `ResponseTime` por defecto) y dentro de los 6–8 s que pide la auditoría.
 */
export const HOTEL_SEARCH_WAVE_DEADLINE_MS = 8_000;

/** El proveedor no respondió dentro del plazo de la ola. Su llamada sigue por detrás. */
export class HotelSearchDeadlineError extends Error {
  constructor(
    readonly providerCode: string,
    readonly deadlineMs: number,
  ) {
    super(
      `No respondió en ${Math.round(deadlineMs / 1_000)} s y la búsqueda siguió sin sus hoteles. Busca de nuevo para volver a consultarlo.`,
    );
    this.name = 'HotelSearchDeadlineError';
  }
}

/**
 * `work` o, si no termina en `deadlineMs`, el rechazo con {@link HotelSearchDeadlineError}. No
 * cancela `work`: su resultado tardío se descarta, y su rechazo tardío queda atendido (no es un
 * `unhandledRejection`).
 */
export function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  providerCode: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HotelSearchDeadlineError(providerCode, deadlineMs)),
      deadlineMs,
    );
    timer.unref?.();
  });
  work.catch(() => undefined);
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
