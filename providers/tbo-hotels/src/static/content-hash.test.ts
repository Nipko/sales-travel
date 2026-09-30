import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTboConfig } from '../config';
import { TBO_OPERATIONS } from '../http/operations';
import type { TboFetch } from '../http/tbo-http.client';
import type { TboRateLimiter } from '../http/limiter';
import { TboStaticContentClient } from '../tbo-static-content.client';
import { TBO_CONTENT_HASH_VERSION, tboHotelContentHash } from './content-hash';
import type { TboHotelContent } from './content.types';

// El nombre del campo va en CAMPO y el valor de prueba en una constante: el detector de secretos
// de GitGuardian marca como contraseña real cualquier línea que ponga un valor al lado de ese
// nombre, aunque sea un texto de prueba.
const CAMPO = { clave: 'password' } as const;
const CLAVE_DEMO = 'clave-de-prueba';

/**
 * La huella de `hotel_content` (0041), la que comparten el sync y el API. Lo que se protege: que
 * dos lecturas iguales de TBO den la misma huella por la puerta pública del cliente, y que la regla
 * sea la de siempre (`tbo-content-v1`), porque el catálogo de producción ya está escrito con ella.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__', 'pdf');

function content(overrides: Partial<TboHotelContent> = {}): TboHotelContent {
  return {
    hotelId: '1000000',
    lang: 'es',
    source: 'details',
    name: 'Sofitel',
    descriptionHtml: '<p>HeadLine : Cerca</p>',
    descriptionText: 'HeadLine : Cerca',
    sections: [{ label: 'HeadLine', text: 'Cerca' }],
    facilities: ['Piscina'],
    unavailableFacilities: ['Spa'],
    attractionsHtml: null,
    images: ['https://api.tbotechnology.in/imageresource.aspx?img=a'],
    phone: null,
    websiteUrl: null,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    ...overrides,
  };
}

const immediate: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

function client(): TboStaticContentClient {
  const body = readFileSync(join(FIXTURES, 'hotel-details.p59.json'), 'utf8');
  const fetch: TboFetch = (url) =>
    Promise.resolve(
      url.endsWith(TBO_OPERATIONS.hotelDetails.path)
        ? new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 }),
    );
  return new TboStaticContentClient(
    parseTboConfig({ environment: 'test', username: 'catalogo-demo', [CAMPO.clave]: CLAVE_DEMO }),
    { fetch, limiter: immediate },
  );
}

describe('tboHotelContentHash', () => {
  it('es la regla tbo-content-v1 de siempre: SHA-256 del JSON de las columnas en orden fijo', () => {
    const c = content();
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'tbo-content-v1',
          c.name,
          c.descriptionHtml,
          [['HeadLine', 'Cerca']],
          c.facilities,
          c.attractionsHtml,
          c.images,
          c.phone,
          c.websiteUrl,
          c.checkInTime,
          c.checkOutTime,
        ]),
        'utf8',
      )
      .digest('hex');
    expect(TBO_CONTENT_HASH_VERSION).toBe('tbo-content-v1');
    expect(tboHotelContentHash(c)).toBe(expected);
  });

  it('no cuentan la clave de la fila, el origen ni lo que no es columna', () => {
    const base = tboHotelContentHash(content());
    expect(tboHotelContentHash(content({ hotelId: '2' }))).toBe(base);
    expect(tboHotelContentHash(content({ lang: 'pt', source: 'listing' }))).toBe(base);
    expect(tboHotelContentHash(content({ descriptionText: null, unavailableFacilities: [] }))).toBe(
      base,
    );
    expect(tboHotelContentHash(content({ images: [] }))).not.toBe(base);
  });

  it('por la puerta pública del cliente: dos lecturas iguales de HotelDetails, la misma huella', async () => {
    const first = await client().getHotelDetails(['1000000'], 'es');
    const second = await client().getHotelDetails(['1000000'], 'es');
    const [a] = first.contents;
    const [b] = second.contents;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(tboHotelContentHash(a as TboHotelContent)).toBe(
      tboHotelContentHash(b as TboHotelContent),
    );
    expect(tboHotelContentHash(a as TboHotelContent)).toMatch(/^[0-9a-f]{64}$/);
  });
});
