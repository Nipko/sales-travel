/**
 * Qué fotos de Despegar abren de verdad. `/content-api/hotels` lista fotos que su CDN
 * (`media.staticontent.com`) ya no tiene: responde 404 «The picture … was not found». Medido el
 * 2026-11-19: en 15 de 43 hoteles la primera foto estaba rota, y en algunos, todas. Como la tarjeta
 * usa la primera foto, un hotel con fotos buenas salía «sin foto».
 *
 * Cada foto se prueba con un HEAD antes de guardar el contenido (una vez: después sale del
 * catálogo). Sólo se descarta lo que el CDN niega (4xx o una respuesta que no es imagen); un
 * timeout o un error de red no prueban nada y la foto se queda. Si las primeras
 * {@link DEAD_STREAK} salen rotas, el hotel no tiene fotos servibles: probar el resto sería gastar
 * llamadas en lo mismo.
 */

/** Fotos que se prueban y guardan por hotel: más de las que muestra la galería de la ficha. */
export const DESPEGAR_PICTURES_PER_HOTEL = 24;
/** Fotos por habitación: la tarjeta muestra una miniatura y la ficha unas pocas. */
export const DESPEGAR_PICTURES_PER_ROOM = 6;
/** Rotas al hilo desde la primera: el hotel no tiene fotos que sirvan. */
export const DEAD_STREAK = 8;
/** HEADs en vuelo a la vez, entre todos los hoteles de un lote. */
export const PICTURE_CHECK_CONCURRENCY = 24;
export const PICTURE_CHECK_TIMEOUT_MS = 4_000;

export type PictureState = 'alive' | 'dead' | 'unknown';

/** Prueba UNA foto. Nunca lanza. */
export type PictureProbe = (url: string) => Promise<PictureState>;

/** Las fotos que abren, en el orden en que llegaron. */
export type PictureFilter = (urls: readonly string[], max: number) => Promise<string[]>;

/** Un semáforo mínimo: como mucho `limit` tareas a la vez. */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** El HEAD contra el CDN. `fetch` se inyecta para los tests. */
export function httpPictureProbe(
  fetchImpl?: typeof fetch,
  timeoutMs: number = PICTURE_CHECK_TIMEOUT_MS,
): PictureProbe {
  return async (url) => {
    try {
      const res = await (fetchImpl ?? globalThis.fetch)(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 408 y 429 son del momento, no de la foto.
      if (res.status === 408 || res.status === 429) return 'unknown';
      if (res.status >= 400 && res.status < 500) return 'dead';
      if (!res.ok) return 'unknown';
      const type = res.headers.get('content-type') ?? '';
      return type === '' || type.startsWith('image/') ? 'alive' : 'dead';
    } catch {
      return 'unknown';
    }
  };
}

/**
 * El filtro que usa el adaptador: prueba hasta `max` fotos de cada lista con un tope de HEADs en
 * vuelo compartido. Las primeras {@link DEAD_STREAK} se esperan antes de seguir, para no salir a
 * probar el resto de un hotel cuyas fotos están todas rotas.
 */
export function pictureFilter(
  probe: PictureProbe,
  concurrency: number = PICTURE_CHECK_CONCURRENCY,
): PictureFilter {
  const run = limiter(concurrency);
  const check = (urls: readonly string[]): Promise<PictureState[]> =>
    Promise.all(urls.map((u) => run(() => probe(u))));
  return async (urls, max) => {
    const candidates = urls.slice(0, max);
    const head = candidates.slice(0, DEAD_STREAK);
    const headStates = await check(head);
    if (head.length >= DEAD_STREAK && headStates.every((s) => s === 'dead')) return [];
    const tailStates = await check(candidates.slice(DEAD_STREAK));
    const states = [...headStates, ...tailStates];
    return candidates.filter((_, i) => states[i] !== 'dead');
  };
}

/** Sin probar: las primeras `max`, como llegan (tests y adaptadores sin red hacia el CDN). */
export const keepPictures: PictureFilter = (urls, max) => Promise.resolve(urls.slice(0, max));
