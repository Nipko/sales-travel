/*
 * El proxy de fotos de hoteles del panel: `GET /api/hotels/images/<clave>` (estrategia de fotos del
 * 2026-09-29; docs/tbo/05 §10).
 *
 * El API responde la foto principal de cada hotel como una ruta de ESTE panel, nunca como la URL del
 * proveedor. La clave es la URL del proveedor en base64url: no es un secreto (como la clave del
 * hotel en la URL del detalle), es para que el navegador del vendedor —o el del cliente final, en
 * una cotización— no le hable al host de fotos del proveedor. Así:
 *
 * - no se le manda la dirección del panel ni la IP del vendedor al proveedor, y la marca blanca no
 *   muestra `tbotechnology.in` en cada imagen;
 * - la foto sale desde el propio origen, compatible con la CSP (`img-src 'self'`), y con `next/image`
 *   (`images.localPatterns` de next.config) se sirve en tamaños de miniatura y queda en su caché;
 * - una foto que el proveedor ya no sirve se ve igual que una que nunca existió: 404 y el marcador.
 *
 * NO es un proxy abierto: sólo sale a buscar URLs `https`, sin credenciales ni puerto propio, de los
 * dominios de fotos del proveedor (y sus subdominios), sigue a lo sumo tres redirecciones y sólo si
 * cada una se queda en esos dominios, corta a los 8 s y a los 5 MB, y sólo devuelve bytes que SON
 * una imagen (por su firma, no por lo que diga la cabecera). Nunca SVG: podría llevar scripts. Y
 * nunca más de {@link HOTEL_IMAGE_MAX_CONCURRENT_FETCHES} descargas a la vez, con la caché acotada en
 * bytes y en entradas: siendo pública, no puede usarse para dispararle al proveedor ni para llenar
 * la memoria del panel.
 *
 * La ruta es pública (el middleware no toca `/api/*`): el optimizador de `next/image` la pide por
 * dentro sin la cookie de sesión. No expone nada que el vendedor no vea ya, y lo que puede pedir un
 * tercero está acotado a las fotos del proveedor.
 */

export const HOTEL_IMAGE_PROXY_PATH = '/api/hotels/images/';

/**
 * Dominios de fotos de los proveedores de hoteles. ESPEJO de `TBO_IMAGE_HOST_SUFFIXES` del ACL de
 * TBO (`providers/tbo-hotels/src/static/image-hosts.ts`), que es lo que el API declara en el perfil
 * del proveedor: el panel no depende de los paquetes del backend, y el test de este archivo repite
 * los casos del API para que no se separen.
 */
export const HOTEL_IMAGE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  'tbotechnology.in',
  'tboholidays.com',
]);

export const HOTEL_IMAGE_SOURCE_MAX_LENGTH = 1_024;
export const HOTEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const HOTEL_IMAGE_FETCH_TIMEOUT_MS = 8_000;
export const HOTEL_IMAGE_MAX_REDIRECTS = 3;

/** Cuánto vale una foto en la caché del proceso, y cuánto se recuerda que una no se pudo traer. */
export const HOTEL_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const HOTEL_IMAGE_FAILURE_TTL_MS = 5 * 60 * 1_000;
/** Techo de la caché en memoria: las miniaturas las cachea además `next/image` en disco. */
export const HOTEL_IMAGE_CACHE_MAX_BYTES = 48 * 1024 * 1024;
/**
 * Techo de ENTRADAS de la caché: una foto que falló no pesa bytes, pero su clave sí ocupa memoria,
 * y la ruta es pública. Sin este techo, un tercero que pide miles de URLs distintas del proveedor
 * que no existen llenaría la memoria del proceso con recuerdos de fallos.
 */
export const HOTEL_IMAGE_CACHE_MAX_ENTRIES = 4_000;
/**
 * Descargas al proveedor en curso, como mucho. La ruta es pública (el optimizador la pide sin la
 * cookie) y el host de fotos de TBO es el mismo de su API: sin techo, un tercero podría hacer que
 * el panel le dispare al proveedor todos los pedidos que quiera, y es nuestra IP la que TBO vería.
 * Lo que pasa del techo responde 503 sin guardarse: la tarjeta muestra el marcador y la próxima
 * vista la trae.
 */
export const HOTEL_IMAGE_MAX_CONCURRENT_FETCHES = 32;

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return HOTEL_IMAGE_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** La URL del proveedor si el proxy la puede servir, normalizada por `URL`; si no, `undefined`. */
export function proxiableHotelImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > HOTEL_IMAGE_SOURCE_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  if (!hostAllowed(url.hostname)) return undefined;
  if (url.href.length > HOTEL_IMAGE_SOURCE_MAX_LENGTH) return undefined;
  return url.href;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(key: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return undefined;
  const padded = key.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * La ruta del proxy para una foto del proveedor, o `undefined` si el proxy no la serviría. Es la
 * misma que arma el API (`apps/api/src/hotels/hotel-image-proxy.ts`): sirve para pasar por el proxy
 * las fotos de la ficha del hotel, que el API entrega como URLs del proveedor.
 */
export function hotelImageProxyUrl(src: unknown): string | undefined {
  const url = proxiableHotelImageUrl(src);
  return url === undefined ? undefined : `${HOTEL_IMAGE_PROXY_PATH}${toBase64Url(url)}`;
}

/** La URL del proveedor que lleva una clave del proxy, o `undefined` si no es una que se sirva. */
export function hotelImageSourceOf(key: string): string | undefined {
  // Una clave de más de lo que puede ocupar la URL más larga no se decodifica siquiera.
  if (key.length === 0 || key.length > Math.ceil((HOTEL_IMAGE_SOURCE_MAX_LENGTH * 4) / 3) + 4) {
    return undefined;
  }
  const decoded = fromBase64Url(key);
  const url = proxiableHotelImageUrl(decoded);
  // La clave tiene que ser EXACTAMENTE la de esa URL normalizada: sin variantes que llenen la caché.
  return url !== undefined && url === decoded ? url : undefined;
}

// ───────────────────────── Qué bytes son una imagen ─────────────────────────

/** El tipo de imagen por la firma de sus primeros bytes, o `undefined` si no es uno que se sirva. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const at = (i: number): number => bytes[i] ?? -1;
  const ascii = (from: number, text: string): boolean =>
    [...text].every((c, i) => at(from + i) === c.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif';
  return undefined;
}

// ───────────────────────── Caché del proceso ─────────────────────────

export type HotelImageEntry =
  | { readonly kind: 'image'; readonly body: Uint8Array<ArrayBuffer>; readonly contentType: string }
  | { readonly kind: 'failed' };

interface Stored {
  readonly entry: HotelImageEntry;
  readonly expiresAt: number;
  readonly size: number;
}

/**
 * Caché en memoria por URL del proveedor, con techo en BYTES y en ENTRADAS y desalojo del más viejo
 * (el orden de inserción de `Map`, renovado en cada acierto). Un contenedor, una caché: con dos
 * réplicas cada una tendría la suya, que para fotos da igual.
 */
export class HotelImageMemoryCache {
  readonly #store = new Map<string, Stored>();
  #bytes = 0;

  constructor(
    private readonly maxBytes = HOTEL_IMAGE_CACHE_MAX_BYTES,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = HOTEL_IMAGE_CACHE_MAX_ENTRIES,
  ) {}

  get(src: string): HotelImageEntry | undefined {
    const hit = this.#store.get(src);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.#delete(src, hit);
      return undefined;
    }
    // Recién usada: al final de la cola de desalojo.
    this.#store.delete(src);
    this.#store.set(src, hit);
    return hit.entry;
  }

  set(src: string, entry: HotelImageEntry, ttlMs: number): void {
    const size = entry.kind === 'image' ? entry.body.byteLength : 0;
    if (size > this.maxBytes) return;
    const previous = this.#store.get(src);
    if (previous !== undefined) this.#delete(src, previous);
    this.#store.set(src, { entry, expiresAt: this.now() + ttlMs, size });
    this.#bytes += size;
    for (const [key, stored] of this.#store) {
      if (this.#bytes <= this.maxBytes && this.#store.size <= this.maxEntries) break;
      this.#delete(key, stored);
    }
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#store.size;
  }

  #delete(src: string, stored: Stored): void {
    this.#store.delete(src);
    this.#bytes -= stored.size;
  }
}

// ───────────────────────── Salida al proveedor ─────────────────────────

export type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Lee el cuerpo sin pasar de `max` bytes; `undefined` si lo pasa o se corta. */
async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return undefined;
  const reader = res.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Trae UNA foto del proveedor: `https`, redirecciones sólo dentro de sus dominios, plazo y tope de
 * bytes, y sólo si los bytes son una imagen. Nunca lanza: lo que no sirve es `failed`.
 */
export async function fetchHotelImage(
  src: string,
  fetchImpl: ImageFetch,
): Promise<HotelImageEntry> {
  const signal = AbortSignal.timeout(HOTEL_IMAGE_FETCH_TIMEOUT_MS);
  let current = src;
  try {
    for (let hop = 0; hop <= HOTEL_IMAGE_MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.8' },
        cache: 'no-store',
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (location === null) return { kind: 'failed' };
        let next: string | undefined;
        try {
          next = proxiableHotelImageUrl(new URL(location, current).href);
        } catch {
          next = undefined;
        }
        if (next === undefined) return { kind: 'failed' };
        current = next;
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: 'failed' };
      }
      const body = await readCapped(res, HOTEL_IMAGE_MAX_BYTES);
      if (body === undefined || body.byteLength === 0) return { kind: 'failed' };
      const contentType = sniffImageType(body);
      return contentType === undefined ? { kind: 'failed' } : { kind: 'image', body, contentType };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Fotos en vuelo por URL: diez tarjetas que piden la misma foto a la vez (o el optimizador de
 * `next/image` con varios tamaños) esperan UNA descarga.
 */
const inFlight = new Map<string, Promise<HotelImageEntry>>();

export interface HotelImageDeps {
  readonly fetch: ImageFetch;
  readonly cache: HotelImageMemoryCache;
  /** Descargas simultáneas al proveedor; por defecto {@link HOTEL_IMAGE_MAX_CONCURRENT_FETCHES}. */
  readonly maxConcurrentFetches?: number;
}

/**
 * La respuesta de la ruta para una clave: la foto con caché de navegador, 404 sin cuerpo si no hay
 * foto, o 503 sin guardar si ya hay demasiadas descargas en curso.
 */
export async function serveHotelImage(key: string, deps: HotelImageDeps): Promise<Response> {
  const src = hotelImageSourceOf(key);
  if (src === undefined) return notFound();

  let entry = deps.cache.get(src);
  if (entry === undefined) {
    let pending = inFlight.get(src);
    if (pending === undefined) {
      if (inFlight.size >= (deps.maxConcurrentFetches ?? HOTEL_IMAGE_MAX_CONCURRENT_FETCHES)) {
        return busy();
      }
      pending = fetchHotelImage(src, deps.fetch).finally(() => inFlight.delete(src));
      inFlight.set(src, pending);
    }
    entry = await pending;
    deps.cache.set(
      src,
      entry,
      entry.kind === 'image' ? HOTEL_IMAGE_CACHE_TTL_MS : HOTEL_IMAGE_FAILURE_TTL_MS,
    );
  }
  if (entry.kind === 'failed') return notFound();
  return new Response(entry.body, {
    status: 200,
    headers: {
      'content-type': entry.contentType,
      'content-length': String(entry.body.byteLength),
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

function busy(): Response {
  // Ni el navegador ni el optimizador lo guardan: en unos segundos la foto puede salir.
  return new Response(null, {
    status: 503,
    headers: {
      'cache-control': 'no-store',
      'retry-after': '5',
      'x-content-type-options': 'nosniff',
    },
  });
}

function notFound(): Response {
  // Se recuerda poco: una foto que falló puede volver, y una clave inválida no cambia.
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' },
  });
}

/** La caché del proceso del panel. */
export const hotelImageCache = new HotelImageMemoryCache();
