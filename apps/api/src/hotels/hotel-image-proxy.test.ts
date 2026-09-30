import { TBO_IMAGE_HOST_SUFFIXES, tboImageUrl } from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import {
  HOTEL_IMAGE_PROXY_PATH,
  hotelImageProxyUrl,
  pickMainImages,
  proxiableImageUrl,
  type MainImageCandidate,
} from './hotel-image-proxy.js';

/**
 * La URL del proxy de fotos (docs/tbo/05 §10): qué foto del proveedor se puede servir y cómo viaja
 * en la ruta del panel. El proxy de la web decodifica la misma clave y aplica la misma lista de
 * dominios (`apps/web-b2b/src/lib/hotel-image-proxy.ts`, con estos mismos casos en su test).
 */

const TBO = [...TBO_IMAGE_HOST_SUFFIXES];
const FOTO = 'https://api.tbotechnology.in/imageresource.aspx?img=9eMP+0FIICgCIk6ZClzZH9Cs+1gw=';

const CASOS: readonly (readonly [string, unknown])[] = [
  ['la de TBO', FOTO],
  ['un subdominio de TBO', 'https://img.tboholidays.com/a.jpg'],
  ['http', 'http://api.tbotechnology.in/imageresource.aspx?img=a'],
  ['otro dominio', 'https://img.example/1.jpg'],
  ['un dominio que sólo termina igual', 'https://eviltbotechnology.in/a.jpg'],
  ['credenciales embebidas', 'https://u:p@api.tbotechnology.in/a.jpg'],
  ['un puerto propio', 'https://api.tbotechnology.in:444/a.jpg'],
  ['vacío', ''],
  ['algo que no es una URL', 'no es una url'],
  ['un número', 7],
];

describe('proxiableImageUrl', () => {
  it.each(CASOS)('decide igual que el ACL de TBO con sus dominios: %s', (_caso, url) => {
    expect(proxiableImageUrl(url, TBO)).toBe(tboImageUrl(url));
  });

  it('una URL que normalizada pasa el tope no sale, aunque escrita entre', () => {
    // Cada espacio se vuelve `%20`: 1.000 caracteres escritos, más de 1.024 normalizados.
    const larga = `https://api.tbotechnology.in/${' '.repeat(400)}${'a'.repeat(560)}`;
    expect(larga.length).toBeLessThanOrEqual(1_024);
    expect(proxiableImageUrl(larga, TBO)).toBeUndefined();
  });

  it('sin dominios declarados, ninguna foto del proveedor pasa', () => {
    expect(proxiableImageUrl(FOTO, [])).toBeUndefined();
  });
});

describe('hotelImageProxyUrl', () => {
  it('la ruta del panel con la URL en base64url, que se decodifica tal cual', () => {
    const url = hotelImageProxyUrl(FOTO, TBO);
    expect(url?.startsWith(HOTEL_IMAGE_PROXY_PATH)).toBe(true);
    const clave = (url ?? '').slice(HOTEL_IMAGE_PROXY_PATH.length);
    // Sólo el alfabeto base64url: va en un segmento de ruta sin escapar.
    expect(clave).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(clave, 'base64url').toString('utf8')).toBe(new URL(FOTO).href);
  });

  it('una foto que el proxy no serviría no genera ruta', () => {
    expect(hotelImageProxyUrl('https://img.example/1.jpg', TBO)).toBeUndefined();
  });
});

describe('pickMainImages', () => {
  const hostsOf = (code: string): readonly string[] =>
    code === 'tbo-hotels' ? TBO : code === 'otro-hotels' ? ['cdn.otro.example'] : [];

  function fila(overrides: Partial<MainImageCandidate>): MainImageCandidate {
    return {
      wantProvider: 'tbo-hotels',
      wantHotel: 'H1',
      providerCode: 'tbo-hotels',
      imageCount: 3,
      firstImages: [FOTO],
      ...overrides,
    };
  }

  it('la primera fila con una foto servible gana; las siguientes del mismo hotel no', () => {
    const fotos = pickMainImages(
      [
        fila({ firstImages: ['https://evil.example/x.jpg'] }),
        fila({
          providerCode: 'otro-hotels',
          imageCount: 9,
          firstImages: ['https://cdn.otro.example/h.jpg'],
        }),
        fila({ imageCount: 1 }),
      ],
      hostsOf,
    );
    expect(fotos.get('tbo-hotels H1')).toEqual({
      url: hotelImageProxyUrl('https://cdn.otro.example/h.jpg', ['cdn.otro.example']),
      count: 9,
    });
  });

  it('cada foto se valida con los dominios del proveedor DUEÑO de la foto', () => {
    // Una foto de TBO guardada como si fuera de otro proveedor no pasa con los dominios de ése.
    const fotos = pickMainImages([fila({ providerCode: 'otro-hotels' })], hostsOf);
    expect(fotos.size).toBe(0);
  });
});
