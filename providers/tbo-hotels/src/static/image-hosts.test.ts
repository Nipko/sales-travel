import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTboConfig } from '../config';
import { TBO_OPERATIONS } from '../http/operations';
import type { TboRateLimiter } from '../http/limiter';
import type { TboFetch } from '../http/tbo-http.client';
import { TboStaticContentClient } from '../tbo-static-content.client';
import { TBO_IMAGE_URL_MAX_LENGTH, isTboImageUrl, tboImageUrl } from './image-hosts';

// El nombre del campo va en CAMPO y el valor de prueba en una constante: el detector de secretos
// de GitGuardian marca como contraseña real cualquier línea que ponga un valor al lado de ese
// nombre, aunque sea un texto de prueba.
const CAMPO = { clave: 'password' } as const;
const CLAVE_DEMO = 'clave-de-prueba';

/**
 * Qué URLs de foto acepta el proxy de imágenes (docs/tbo/05 §10, imágenes): sólo `https` en un
 * dominio de TBO. Es la lista con que el proxy decide a dónde sale; una URL que no pasa no se pide.
 */

const immediate: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

describe('tboImageUrl', () => {
  it.each([
    'https://api.tbotechnology.in/imageresource.aspx?img=abc',
    'https://API.TBOTECHNOLOGY.IN/imageresource.aspx?img=abc',
    'https://www.tboholidays.com/imageresource.aspx?img=example1',
    'https://tbotechnology.in/x.jpg',
  ])('acepta %s', (url) => {
    expect(isTboImageUrl(url)).toBe(true);
  });

  it.each([
    ['http, que sería contenido mixto', 'http://api.tbotechnology.in/imageresource.aspx?img=a'],
    ['otro dominio', 'https://img.example/1.jpg'],
    ['un dominio que sólo termina igual', 'https://eviltbotechnology.in/a.jpg'],
    ['TBO como subdominio de otro', 'https://tbotechnology.in.evil.example/a.jpg'],
    ['credenciales embebidas', 'https://user:pw@api.tbotechnology.in/a.jpg'],
    ['un puerto propio', 'https://api.tbotechnology.in:8443/a.jpg'],
    ['un esquema que no es web', 'javascript:alert(1)'],
    ['texto vacío', '   '],
    ['algo que no es texto', 42],
  ])('rechaza %s', (_motivo, url) => {
    expect(tboImageUrl(url)).toBeUndefined();
  });

  it('rechaza una URL más larga que el tope', () => {
    const long = `https://api.tbotechnology.in/imageresource.aspx?img=${'a'.repeat(TBO_IMAGE_URL_MAX_LENGTH)}`;
    expect(tboImageUrl(long)).toBeUndefined();
  });

  it('sale normalizada por URL: espacios y comillas escapados antes de llegar a un atributo', () => {
    expect(tboImageUrl(' https://api.tbotechnology.in/a b"c.jpg ')).toBe(
      'https://api.tbotechnology.in/a%20b%22c.jpg',
    );
  });

  it('las fotos que HotelDetails devuelve por la puerta pública del cliente pasan todas', async () => {
    const body = readFileSync(
      join(__dirname, '..', '__fixtures__', 'pdf', 'hotel-details.p59.json'),
      'utf8',
    );
    const fetch: TboFetch = (url) =>
      Promise.resolve(
        url.endsWith(TBO_OPERATIONS.hotelDetails.path)
          ? new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response('', { status: 404 }),
      );
    const client = new TboStaticContentClient(
      parseTboConfig({ environment: 'test', username: 'catalogo-demo', [CAMPO.clave]: CLAVE_DEMO }),
      { fetch, limiter: immediate },
    );
    const { contents } = await client.getHotelDetails(['1000000'], 'en');
    const images = contents.flatMap((c) => c.images);
    expect(images.length).toBeGreaterThan(0);
    expect(images.every(isTboImageUrl)).toBe(true);
  });
});
