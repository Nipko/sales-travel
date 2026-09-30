import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { HotelContentService } from './hotel-content.service.js';

/**
 * Ficha de un hotel contra Postgres real (docs/tbo/09 PR-3.6; migración 0041).
 *
 * Lo que la base de mentira no puede probar: que la app lee `hotel_content` y `hotel_inventory`
 * como `app_user`, que sólo tiene `SELECT` sobre el catálogo (0041); que `pg` entrega el JSONB ya
 * parseado y el `TIME` como `'HH:MM:SS'`, y el `NUMERIC` de las estrellas como texto; y que la
 * lectura no escribe nada (una escritura como `app_user` fallaría con 42501).
 *
 * El proveedor y los hoteles son sintéticos y únicos por corrida: el catálogo es de plataforma y
 * quien corra esto contra su base local no puede tocar filas reales. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('contenido de hotel contra Postgres, leído como app_user', () => {
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `it-contenido-${sfx}`;
  const CON_TODO = `IT${sfx}H1`;
  const SOLO_INGLES = `IT${sfx}H2`;
  const SIN_CONTENIDO = `IT${sfx}H3`;
  const TENANT = '11111111-1111-4111-8111-111111111111';

  const admin = new pg.Pool();
  // Cada conexión de la app asume `app_user` antes de la primera consulta, como en producción.
  const comoApp = new pg.Pool();
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });

  const service = new HotelContentService(
    hotelRegistry(
      [new StubHotelProviderFactory({ code: PROVEEDOR, searchProfile: { idSpace: 'provider' } })],
      hotelFlags(true),
    ),
    { db } as unknown as DatabaseService,
    new CircuitBreakerService(),
    new MemoryCacheAdapter(),
  );

  async function contenido(
    hotelId: string,
    lang: string,
    source: string,
    extra: { images?: unknown; checkIn?: string | null } = {},
  ): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_content
         (provider_code, hotel_id, lang, name, description_html, sections, facilities,
          attractions_html, images, phone, website_url, check_in_time, check_out_time, source,
          content_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11, $12::time,
               $13::time, $14, 'hash')`,
      [
        PROVEEDOR,
        hotelId,
        lang,
        `Hotel ${lang}`,
        `<p>HeadLine : Cerca (${lang})</p>`,
        JSON.stringify([{ label: 'HeadLine', text: `Cerca (${lang})` }]),
        JSON.stringify(['Piscina']),
        '<ul><li>Museo</li></ul>',
        JSON.stringify(extra.images ?? ['https://img.example/1.jpg', 'http://img.example/2.jpg']),
        '+57 1 000',
        'https://hotel.example/',
        extra.checkIn === undefined ? '15:00' : extra.checkIn,
        '12:00',
        source,
      ],
    );
  }

  beforeAll(async () => {
    await admin.query(
      `INSERT INTO hotel_inventory
         (provider_code, hotel_id, name, stars, address, zipcode, country_code, latitude, longitude)
       VALUES ($1, $2, 'Sofitel Legend', 4.5, 'Abtal El Tahrir Street ', '81511', 'EG', 24.08166, 32.88985)`,
      [PROVEEDOR, CON_TODO],
    );
    await contenido(CON_TODO, 'es', 'details');
    await contenido(CON_TODO, 'en', 'details');
    await contenido(SOLO_INGLES, 'en', 'listing', { images: [], checkIn: null });
  });

  afterAll(async () => {
    await admin.query('DELETE FROM hotel_content WHERE provider_code = $1', [PROVEEDOR]);
    await admin.query('DELETE FROM hotel_inventory WHERE provider_code = $1', [PROVEEDOR]);
    await db.destroy();
    await admin.end();
  });

  it('el detalle en español: JSONB parseado, `TIME` a `HH:mm`, estrellas a número, sólo `https`', async () => {
    const ficha = await service.getContent(TENANT, {
      providerCode: PROVEEDOR,
      hotelId: CON_TODO,
      lang: 'es',
    });

    expect(ficha).toEqual({
      providerCode: PROVEEDOR,
      hotelId: CON_TODO,
      requestedLang: 'es',
      lang: 'es',
      langFallback: false,
      origin: 'catalog',
      name: 'Sofitel Legend',
      stars: 4.5,
      address: 'Abtal El Tahrir Street',
      zipcode: '81511',
      countryCode: 'EG',
      location: { lat: 24.08166, lng: 32.88985 },
      descriptionHtml: '<p>HeadLine : Cerca (es)</p>',
      sections: [{ label: 'HeadLine', text: 'Cerca (es)' }],
      facilities: ['Piscina'],
      attractionsHtml: '<ul><li>Museo</li></ul>',
      images: ['https://img.example/1.jpg'],
      phone: '+57 1 000',
      websiteUrl: 'https://hotel.example/',
      checkInTime: '15:00',
      checkOutTime: '12:00',
    });
  });

  it('en portugués, sin fila: el respaldo en inglés, y `lang` lo dice', async () => {
    const ficha = await service.getContent(TENANT, {
      providerCode: PROVEEDOR,
      hotelId: SOLO_INGLES,
      lang: 'pt',
    });

    expect(ficha).toMatchObject({
      requestedLang: 'pt',
      lang: 'en',
      langFallback: true,
      origin: 'catalog',
      name: 'Hotel en',
      images: [],
      checkInTime: null,
    });
  });

  it('sin contenido ni fila de catálogo: la ficha vacía, sin error', async () => {
    const ficha = await service.getContent(TENANT, {
      providerCode: PROVEEDOR,
      hotelId: SIN_CONTENIDO,
      lang: 'es',
    });

    expect(ficha).toMatchObject({ origin: 'none', lang: null, name: null, images: [] });
  });

  it('`app_user` sólo lee: la conexión de la app no puede escribir el contenido', async () => {
    const err: unknown = await comoApp
      .query(`UPDATE hotel_content SET name = 'x' WHERE provider_code = $1`, [PROVEEDOR])
      .catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('42501');
  });
});
