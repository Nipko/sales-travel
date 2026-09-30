import { describe, expect, it, vi } from 'vitest';
import {
  HOTEL_IMAGE_MAX_BYTES,
  HOTEL_IMAGE_PROXY_PATH,
  HotelImageMemoryCache,
  fetchHotelImage,
  hotelImageProxyUrl,
  hotelImageSourceOf,
  proxiableHotelImageUrl,
  serveHotelImage,
  sniffImageType,
  type ImageFetch,
} from './hotel-image-proxy';

/**
 * El proxy de fotos del panel: qué claves se aceptan, a dónde sale, qué bytes devuelve y cómo los
 * cachea. Los casos de dominios son los mismos del API (`apps/api/src/hotels/hotel-image-proxy.test.ts`)
 * y del ACL de TBO: si se separan, el API mandaría rutas que el panel no sirve.
 */

const FOTO = 'https://api.tbotechnology.in/imageresource.aspx?img=9eMP+0FIICgCIk6ZClzZH9Cs+1gw=';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function clave(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function imagen(
  bytes: Uint8Array<ArrayBuffer> = JPEG,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/jpeg', ...headers },
  });
}

describe('dominios: los mismos casos que el API y el ACL de TBO', () => {
  it.each([
    ['la de TBO', FOTO, true],
    ['un subdominio de TBO', 'https://img.tboholidays.com/a.jpg', true],
    ['http', 'http://api.tbotechnology.in/imageresource.aspx?img=a', false],
    ['otro dominio', 'https://img.example/1.jpg', false],
    ['un dominio que sólo termina igual', 'https://eviltbotechnology.in/a.jpg', false],
    ['TBO como subdominio de otro', 'https://tbotechnology.in.evil.example/a.jpg', false],
    ['credenciales embebidas', 'https://u:p@api.tbotechnology.in/a.jpg', false],
    ['un puerto propio', 'https://api.tbotechnology.in:444/a.jpg', false],
    ['un esquema que no es web', 'javascript:alert(1)', false],
  ])('%s', (_caso, url, sirve) => {
    expect(proxiableHotelImageUrl(url) !== undefined).toBe(sirve);
  });
});

describe('la clave de la ruta', () => {
  it('ida y vuelta con la misma codificación que el API (base64url sin relleno)', () => {
    const url = hotelImageProxyUrl(FOTO);
    expect(url).toBe(`${HOTEL_IMAGE_PROXY_PATH}${clave(new URL(FOTO).href)}`);
    expect(hotelImageSourceOf(clave(new URL(FOTO).href))).toBe(new URL(FOTO).href);
  });

  it('rechaza claves que no son base64url, que no decodifican a una URL servible o no normalizadas', () => {
    expect(hotelImageSourceOf('')).toBeUndefined();
    expect(hotelImageSourceOf('no/es+base64')).toBeUndefined();
    expect(hotelImageSourceOf(clave('https://img.example/1.jpg'))).toBeUndefined();
    // La misma foto con otra grafía: se rechaza para que no llene la caché de variantes.
    expect(
      hotelImageSourceOf(clave('https://API.tbotechnology.in/imageresource.aspx?img=a')),
    ).toBeUndefined();
    expect(hotelImageSourceOf('A'.repeat(5_000))).toBeUndefined();
  });
});

describe('sniffImageType: sólo bytes que SON una imagen', () => {
  it('reconoce jpeg, png, gif, webp y avif; nada más', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('\0\0\0\x20ftypavif'))).toBe('image/avif');
    expect(sniffImageType(new TextEncoder().encode('<svg onload="x()"></svg>'))).toBeUndefined();
    expect(sniffImageType(new TextEncoder().encode('<!doctype html>'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});

describe('fetchHotelImage', () => {
  it('pide la URL tal cual, sin seguir redirecciones solo, y devuelve el tipo por la firma', async () => {
    const fetch = vi.fn<ImageFetch>(() =>
      Promise.resolve(imagen(PNG, { 'content-type': 'application/octet-stream' })),
    );
    const foto = await fetchHotelImage(new URL(FOTO).href, fetch);
    expect(foto).toEqual({ kind: 'image', body: PNG, contentType: 'image/png' });
    expect(fetch.mock.calls[0]?.[0]).toBe(new URL(FOTO).href);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', method: 'GET' });
  });

  it('sigue una redirección sólo si se queda en los dominios del proveedor', async () => {
    const adentro = vi.fn<ImageFetch>((url) =>
      Promise.resolve(
        url.includes('cdn')
          ? imagen()
          : new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.tbotechnology.in/x.jpg' },
            }),
      ),
    );
    expect((await fetchHotelImage(FOTO, adentro)).kind).toBe('image');

    const afuera = vi.fn<ImageFetch>(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      ),
    );
    expect(await fetchHotelImage(FOTO, afuera)).toEqual({ kind: 'failed' });
    expect(afuera).toHaveBeenCalledTimes(1);
  });

  it('corta en cadenas de redirecciones, en errores, en lo que no es imagen y en lo que pasa el tope', async () => {
    const bucle = vi.fn<ImageFetch>(() =>
      Promise.resolve(new Response(null, { status: 301, headers: { location: FOTO } })),
    );
    expect(await fetchHotelImage(FOTO, bucle)).toEqual({ kind: 'failed' });
    expect(bucle).toHaveBeenCalledTimes(4);

    const caido = vi.fn<ImageFetch>(() => Promise.reject(new Error('ECONNRESET')));
    expect(await fetchHotelImage(FOTO, caido)).toEqual({ kind: 'failed' });

    const html = vi.fn<ImageFetch>(() =>
      Promise.resolve(
        new Response('<html>error</html>', {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    );
    expect(await fetchHotelImage(FOTO, html)).toEqual({ kind: 'failed' });

    const noEncontrada = vi.fn<ImageFetch>(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    expect(await fetchHotelImage(FOTO, noEncontrada)).toEqual({ kind: 'failed' });

    const enorme = vi.fn<ImageFetch>(() =>
      Promise.resolve(imagen(JPEG, { 'content-length': String(HOTEL_IMAGE_MAX_BYTES + 1) })),
    );
    expect(await fetchHotelImage(FOTO, enorme)).toEqual({ kind: 'failed' });

    const sinLargo = new Uint8Array(HOTEL_IMAGE_MAX_BYTES + 10);
    sinLargo.set(JPEG);
    const mentirosa = vi.fn<ImageFetch>(() =>
      Promise.resolve(new Response(sinLargo, { status: 200 })),
    );
    expect(await fetchHotelImage(FOTO, mentirosa)).toEqual({ kind: 'failed' });
  });
});

describe('serveHotelImage: la respuesta de la ruta', () => {
  it('la foto con caché de navegador, sin volver a pedirla mientras dura la caché', async () => {
    const fetch = vi.fn<ImageFetch>(() => Promise.resolve(imagen()));
    const cache = new HotelImageMemoryCache();
    const key = clave(new URL(FOTO).href);

    const res = await serveHotelImage(key, { fetch, cache });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);

    await serveHotelImage(key, { fetch, cache });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('una clave inválida no sale a ningún lado: 404 sin cuerpo', async () => {
    const fetch = vi.fn<ImageFetch>();
    const res = await serveHotelImage(clave('https://img.example/1.jpg'), {
      fetch,
      cache: new HotelImageMemoryCache(),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('una foto que falla da 404 y se recuerda poco: no se vuelve a pedir enseguida', async () => {
    const fetch = vi.fn<ImageFetch>(() => Promise.resolve(new Response(null, { status: 500 })));
    const cache = new HotelImageMemoryCache();
    const key = clave(new URL(FOTO).href);
    expect((await serveHotelImage(key, { fetch, cache })).status).toBe(404);
    expect((await serveHotelImage(key, { fetch, cache })).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('pedidos simultáneos de la misma foto hacen UNA descarga', async () => {
    let soltar: (r: Response) => void = () => undefined;
    const fetch = vi.fn<ImageFetch>(() => new Promise<Response>((resolve) => (soltar = resolve)));
    const cache = new HotelImageMemoryCache();
    const key = clave('https://api.tbotechnology.in/imageresource.aspx?img=simultanea');
    const a = serveHotelImage(key, { fetch, cache });
    const b = serveHotelImage(key, { fetch, cache });
    await Promise.resolve();
    soltar(imagen());
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('con el techo de descargas en curso, una foto nueva es 503 sin salir ni guardarse', async () => {
    const soltar: ((r: Response) => void)[] = [];
    const fetch = vi.fn<ImageFetch>(() => new Promise<Response>((resolve) => soltar.push(resolve)));
    const cache = new HotelImageMemoryCache();
    const deps = { fetch, cache, maxConcurrentFetches: 2 };
    const url = (n: number) => `https://api.tbotechnology.in/imageresource.aspx?img=techo${n}`;

    const a = serveHotelImage(clave(url(1)), deps);
    const b = serveHotelImage(clave(url(2)), deps);
    const tercera = await serveHotelImage(clave(url(3)), deps);

    expect(tercera.status).toBe(503);
    expect(tercera.headers.get('cache-control')).toBe('no-store');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.get(url(3))).toBeUndefined();
    // La misma foto que ya está en camino no cuenta como otra descarga: la espera.
    const otraVez = serveHotelImage(clave(url(1)), deps);
    for (const s of soltar) s(imagen());
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect((await otraVez).status).toBe(200);
    // Terminadas, hay lugar otra vez.
    expect(
      (
        await serveHotelImage(clave(url(3)), {
          ...deps,
          fetch: vi.fn<ImageFetch>(() => Promise.resolve(imagen())),
        })
      ).status,
    ).toBe(200);
  });
});

describe('HotelImageMemoryCache', () => {
  it('techo en bytes: desaloja lo menos usado; vencido no sirve', () => {
    let t = 0;
    const cache = new HotelImageMemoryCache(20, () => t);
    const foto = (n: number) => ({
      kind: 'image' as const,
      body: new Uint8Array(n),
      contentType: 'image/jpeg',
    });
    cache.set('a', foto(8), 1_000);
    cache.set('b', foto(8), 1_000);
    cache.get('a');
    cache.set('c', foto(8), 1_000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.bytes).toBeLessThanOrEqual(20);
    // Una más grande que el techo no entra ni desaloja nada.
    cache.set('d', foto(30), 1_000);
    expect(cache.get('d')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    t = 2_000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('techo en entradas: los fallos no pesan bytes, pero no se acumulan sin fin', () => {
    const cache = new HotelImageMemoryCache(1_000, () => 0, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) cache.set(k, { kind: 'failed' }, 1_000);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('e')).toEqual({ kind: 'failed' });
  });
});
