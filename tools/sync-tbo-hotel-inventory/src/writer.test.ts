import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TboCatalogHotel, TboHotelContent } from '@sales-travel/tbo-hotels';
import type { QueryResult, QueryResultRow } from 'pg';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contentHash } from './content-rules.js';
import type { HotelMatchRow } from './match-rules.js';
import { PgCatalogStore, advisoryLockKey, type Queryable } from './writer.js';

/**
 * El SQL que emite el escritor, sin Postgres: una conexión falsa que registra cada sentencia y
 * responde lo que el escenario necesita. Lo que se fija aquí es la FORMA (transacción por ciudad,
 * todo filtrado por proveedor, ningún DELETE, placeholders bien numerados); la semántica contra un
 * Postgres real la cubre `writer.integration.test.ts` en CI.
 */

const PROVIDER = 'tbo-hotels';
/** Borrar filas o tablas, en SQL. `drop-exceeded` (un veredicto) no cuenta. */
const DESTRUCTIVE_SQL = /\b(DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|SCHEMA|INDEX))\b/i;
const RUN_START = new Date('2026-09-25T08:00:00.000Z');

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Reply = { readonly rows?: readonly QueryResultRow[]; readonly rowCount?: number } | Error;

class RecordingDb implements Queryable {
  readonly statements: Statement[] = [];

  constructor(private readonly reply: (s: Statement) => Reply | undefined = () => undefined) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const statement = { text: text.replace(/\s+/g, ' ').trim(), values };
    this.statements.push(statement);
    const reply = this.reply(statement);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      command: '',
      oid: 0,
      fields: [],
      rows: (reply?.rows ?? []) as R[],
      rowCount: reply?.rowCount ?? 0,
    });
  }

  texts(): string[] {
    return this.statements.map((s) => s.text);
  }
}

function hotel(hotelId: string, extra: Partial<TboCatalogHotel> = {}): TboCatalogHotel {
  return {
    hotelId,
    name: `Hotel ${hotelId}`,
    stars: 3,
    location: { lat: -34.6, lng: -58.4 },
    address: 'Calle 1',
    zipcode: '1000',
    countryCode: 'AR',
    cityCode: '900001',
    ...extra,
  };
}

/** Responde a las lecturas de `writeCityHotels`: activos antes, puntos después, filas barridas. */
function cityReplies(options: {
  readonly before: readonly string[];
  readonly points?: readonly { latitude: number | null; longitude: number | null }[];
  readonly swept?: number;
  readonly failOn?: RegExp;
}): (s: Statement) => Reply | undefined {
  return (s) => {
    if (options.failOn?.test(s.text) === true) return new Error('fallo simulado de Postgres');
    if (s.text.startsWith('SELECT hotel_id FROM hotel_inventory')) {
      return { rows: options.before.map((hotel_id) => ({ hotel_id })) };
    }
    if (s.text.startsWith('SELECT latitude, longitude')) return { rows: options.points ?? [] };
    if (s.text.startsWith('UPDATE hotel_inventory SET active = false')) {
      return { rowCount: options.swept ?? 0 };
    }
    if (s.text.startsWith('INSERT INTO hotel_inventory')) {
      return { rowCount: (s.values.length - 2) / 9 };
    }
    return undefined;
  };
}

/** Cada `$n` del texto existe en `values` y cada valor se usa: nada corrido de lugar. */
function expectPlaceholdersMatch(s: Statement): void {
  const used = new Set([...s.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  expect(Math.max(0, ...used)).toBe(s.values.length);
  expect(used.size).toBe(s.values.length);
}

describe('writeCityHotels: una transacción corta por ciudad (05 §6.5)', () => {
  it('BEGIN, activos antes, upsert, barrido, centroide, checkpoint y COMMIT, en ese orden', async () => {
    const db = new RecordingDb(
      cityReplies({
        before: ['a', 'b'],
        points: [
          { latitude: 1, longitude: 2 },
          { latitude: 3, longitude: 4 },
        ],
        swept: 1,
      }),
    );
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });

    const result = await store.writeCityHotels({
      cityCode: '900001',
      hotels: [hotel('a'), hotel('c')],
      unreadable: 0,
      runStart: RUN_START,
      maxDrop: 0.5,
    });

    expect(result).toEqual({
      upserted: 2,
      previouslyActive: 2,
      missing: 1,
      verdict: 'swept',
      deactivated: 1,
      hotelCount: 2,
      checkpointAdvanced: true,
    });
    const texts = db.texts();
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toMatch(
      /^SELECT hotel_id FROM hotel_inventory WHERE provider_code = \$1 AND provider_city_code = \$2 AND active$/,
    );
    expect(texts[2]).toMatch(
      /^INSERT INTO hotel_inventory .* ON CONFLICT \(provider_code, hotel_id\) DO UPDATE/,
    );
    expect(texts[3]).toMatch(
      /^UPDATE hotel_inventory SET active = false WHERE provider_code = \$1 AND provider_city_code = \$2 AND active AND \(last_seen_at IS NULL OR last_seen_at < \$3\)$/,
    );
    expect(texts[4]).toMatch(
      /^SELECT latitude, longitude FROM hotel_inventory WHERE provider_code = \$1/,
    );
    expect(texts[5]).toMatch(/^UPDATE hotel_provider_city SET hotel_count = \$3/);
    expect(texts[6]).toBe('COMMIT');
    expect(texts).toHaveLength(7);

    const insert = db.statements[2] as Statement;
    expectPlaceholdersMatch(insert);
    // Por hotel: proveedor, id, país, nombre, estrellas, lat, lng, dirección, CP; al final la
    // ciudad de la REQUEST y el inicio de la corrida, una sola vez.
    expect(insert.values.slice(0, 9)).toEqual([
      PROVIDER,
      'a',
      'AR',
      'Hotel a',
      3,
      -34.6,
      -58.4,
      'Calle 1',
      '1000',
    ]);
    expect(insert.values.slice(-2)).toEqual(['900001', RUN_START]);
    expect(insert.text).toContain('active = true');
    expect(insert.text).toContain('provider_city_code = EXCLUDED.provider_city_code');
    expect(db.statements[3]?.values).toEqual([PROVIDER, '900001', RUN_START]);
    expect(db.statements[5]?.values).toEqual([PROVIDER, '900001', 2, 2, 3, true]);
  });

  it('anomalía de caída: ni UPDATE de barrido ni avance del checkpoint', async () => {
    const db = new RecordingDb(cityReplies({ before: ['a', 'b', 'c', 'd'] }));
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });

    const result = await store.writeCityHotels({
      cityCode: '900001',
      hotels: [hotel('a')],
      unreadable: 0,
      runStart: RUN_START,
      maxDrop: 0.5,
    });

    expect(result).toMatchObject({
      verdict: 'drop-exceeded',
      deactivated: 0,
      checkpointAdvanced: false,
    });
    expect(db.texts().some((t) => t.includes('SET active = false'))).toBe(false);
    expect(db.statements.at(-2)?.values.at(-1)).toBe(false);
    expect(db.texts().at(-1)).toBe('COMMIT');
  });

  it('respuesta vacía de una ciudad sin hoteles: sin INSERT, checkpoint al día y conteo 0', async () => {
    const db = new RecordingDb(cityReplies({ before: [] }));
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    const result = await store.writeCityHotels({
      cityCode: '900009',
      hotels: [],
      unreadable: 0,
      runStart: RUN_START,
      maxDrop: 0.5,
    });
    expect(result).toMatchObject({
      verdict: 'nothing-missing',
      hotelCount: 0,
      checkpointAdvanced: true,
    });
    expect(db.texts().some((t) => t.startsWith('INSERT'))).toBe(false);
    expect(db.statements.at(-2)?.values).toEqual([PROVIDER, '900009', 0, null, null, true]);
  });

  it('RF-30 CA 1: si Postgres falla a mitad, ROLLBACK y el error sube; nunca COMMIT', async () => {
    for (const failOn of [/^INSERT INTO hotel_inventory/, /^UPDATE hotel_provider_city/]) {
      const db = new RecordingDb(cityReplies({ before: ['a', 'b'], swept: 1, failOn }));
      const store = new PgCatalogStore(db, { providerCode: PROVIDER });
      await expect(
        store.writeCityHotels({
          cityCode: '900001',
          hotels: [hotel('a'), hotel('c')],
          unreadable: 0,
          runStart: RUN_START,
          maxDrop: 0.5,
        }),
      ).rejects.toThrow('fallo simulado de Postgres');
      expect(db.texts().at(-1)).toBe('ROLLBACK');
      expect(db.texts()).not.toContain('COMMIT');
    }
  });

  it('un id repetido en la respuesta va una sola vez (ON CONFLICT no admite la misma clave dos veces)', async () => {
    const db = new RecordingDb(cityReplies({ before: [] }));
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    await store.writeCityHotels({
      cityCode: '900001',
      hotels: [hotel('a'), hotel('a', { name: 'otro' }), hotel('b')],
      unreadable: 0,
      runStart: RUN_START,
      maxDrop: 0.5,
    });
    const insert = db.statements.find((s) => s.text.startsWith('INSERT')) as Statement;
    expect(insert.values).toHaveLength(2 * 9 + 2);
    expect(insert.values[3]).toBe('Hotel a');
  });

  it('una ciudad grande va en lotes de 500 con los placeholders bien numerados', async () => {
    const db = new RecordingDb(cityReplies({ before: [] }));
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    const hotels = Array.from({ length: 1_201 }, (_, i) => hotel(`h${i}`));
    const result = await store.writeCityHotels({
      cityCode: '900001',
      hotels,
      unreadable: 0,
      runStart: RUN_START,
      maxDrop: 0.5,
    });
    const inserts = db.statements.filter((s) => s.text.startsWith('INSERT'));
    expect(inserts.map((s) => (s.values.length - 2) / 9)).toEqual([500, 500, 201]);
    inserts.forEach(expectPlaceholdersMatch);
    expect(result.upserted).toBe(1_201);
  });
});

describe('upsertCities (E2)', () => {
  it('nombre normalizado, sin repetidos y sin tocar el checkpoint de E3', async () => {
    const db = new RecordingDb((s) => (s.text.startsWith('INSERT') ? { rowCount: 2 } : undefined));
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    const written = await store.upsertCities('BR', [
      { code: '1', name: 'São Paulo', countryCode: 'BR' },
      { code: '1', name: 'Sao Paulo (repetida)', countryCode: 'BR' },
      { code: '2', name: 'Rio de Janeiro', countryCode: 'BR' },
    ]);
    expect(written).toBe(2);
    expect(db.texts()[0]).toBe('BEGIN');
    expect(db.texts().at(-1)).toBe('COMMIT');
    const insert = db.statements[1] as Statement;
    expectPlaceholdersMatch(insert);
    expect(insert.values).toEqual([
      PROVIDER,
      '1',
      'BR',
      'São Paulo',
      'sao paulo',
      PROVIDER,
      '2',
      'BR',
      'Rio de Janeiro',
      'rio de janeiro',
    ]);
    expect(insert.text).toMatch(/ON CONFLICT \(provider_code, provider_city_code\) DO UPDATE/);
    expect(insert.text).not.toMatch(/synced_at|hotel_count|centroid|last_status_code/);
  });

  it('sin ciudades no abre transacción', async () => {
    const db = new RecordingDb();
    expect(await new PgCatalogStore(db, { providerCode: PROVIDER }).upsertCities('BR', [])).toBe(0);
    expect(db.statements).toHaveLength(0);
  });
});

describe('deactivateMissing (E5)', () => {
  function replies(rows: readonly { hotel_id: string; stale: boolean }[]) {
    return (s: Statement): Reply | undefined => {
      if (s.text.startsWith('SELECT hotel_id, (last_seen_at IS NULL')) return { rows };
      if (s.text.startsWith('UPDATE')) return { rowCount: (s.values[1] as string[]).length };
      return undefined;
    };
  }

  it('sólo los activos que ninguna ciudad listó desde `seenSince` y no están en la lista global', async () => {
    const db = new RecordingDb(
      replies([
        { hotel_id: 'a', stale: true },
        { hotel_id: 'b', stale: true },
        { hotel_id: 'c', stale: false },
        { hotel_id: 'd', stale: true },
        { hotel_id: 'e', stale: true },
      ]),
    );
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    const result = await store.deactivateMissing({
      hotelCodes: ['a', 'd', 'e', 'zzz'],
      unreadable: 0,
      seenSince: RUN_START,
      maxDrop: 0.5,
    });
    // Faltan `b` y `c`; `c` lo respalda su ciudad, así que sólo `b` se apaga.
    expect(result).toEqual({ previouslyActive: 5, missing: 2, verdict: 'swept', deactivated: 1 });
    const update = db.statements.find((s) => s.text.startsWith('UPDATE')) as Statement;
    expect(update.values).toEqual([PROVIDER, ['b'], RUN_START]);
    expect(update.text).toMatch(
      /WHERE provider_code = \$1 AND active AND hotel_id = ANY\(\$2::text\[\]\)/,
    );
  });

  it('una lista truncada se mide contra todos los activos, no sólo contra los que se pueden apagar', async () => {
    // 10 activos, 2 sin respaldo reciente. La lista trae 4: faltan 6 de 10 (60 %), aunque de los
    // apagables falte uno solo (10 % del total).
    const rows = [
      { hotel_id: 's1', stale: true },
      { hotel_id: 's2', stale: true },
      ...Array.from({ length: 8 }, (_, i) => ({ hotel_id: `f${i}`, stale: false })),
    ];
    const db = new RecordingDb(replies(rows));
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).deactivateMissing({
      hotelCodes: ['s1', 'f0', 'f1', 'f2'],
      unreadable: 0,
      seenSince: RUN_START,
      maxDrop: 0.5,
    });
    expect(result).toEqual({
      previouslyActive: 10,
      missing: 6,
      verdict: 'drop-exceeded',
      deactivated: 0,
    });
    expect(db.texts().some((t) => t.startsWith('UPDATE'))).toBe(false);
  });

  it('lista con códigos ilegibles: no desactiva nada', async () => {
    const db = new RecordingDb(
      replies([
        { hotel_id: 'a', stale: true },
        { hotel_id: 'b', stale: true },
      ]),
    );
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).deactivateMissing({
      hotelCodes: ['a'],
      unreadable: 3,
      seenSince: RUN_START,
      maxDrop: 0.5,
    });
    expect(result.verdict).toBe('incomplete-response');
    expect(db.texts().some((t) => t.startsWith('UPDATE'))).toBe(false);
  });
});

describe('lecturas y lock', () => {
  it('listCityCandidates: demanda por el mapa ACEPTADO desde el espacio de ids de Despegar', async () => {
    const synced = new Date('2026-09-01T00:00:00Z');
    const db = new RecordingDb(() => ({
      rows: [
        {
          provider_city_code: '900001',
          country_code: 'AR',
          hotel_count: 3,
          synced_at: synced,
          last_status_code: 200,
          demand: 4,
        },
      ],
    }));
    const since = new Date('2026-09-11T00:00:00Z');
    const candidates = await new PgCatalogStore(db, { providerCode: PROVIDER }).listCityCandidates({
      countries: ['AR', 'AL'],
      demandSince: since,
    });
    expect(candidates).toEqual([
      {
        code: '900001',
        countryCode: 'AR',
        hotelCount: 3,
        syncedAt: synced,
        lastStatusCode: 200,
        demand: 4,
      },
    ]);
    const s = db.statements[0] as Statement;
    // Sin `TBO_SYNC_CITIES`, `NULL`: todas las ciudades de los países.
    expect(s.values).toEqual([PROVIDER, ['AR', 'AL'], since, 'despegar-hotels', null]);
    expectPlaceholdersMatch(s);
    expect(s.text).toContain("m.status = 'accepted'");
    expect(s.text).toContain("s.criteria->>'destinationId'");
    expect(s.text).toContain('AND ($5::text[] IS NULL OR c.provider_city_code = ANY($5::text[]))');
  });

  it('TBO_SYNC_CITIES: E3 y E4 leen sólo esas ciudades, dentro de los países', async () => {
    const db = new RecordingDb();
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    const since = new Date('2026-09-11T00:00:00Z');
    await store.listCityCandidates({ countries: ['AR'], cities: ['900001'], demandSince: since });
    await store.listContentCandidates({
      countries: ['AR'],
      cities: ['900001', '900002'],
      demandSince: since,
      onlyDemand: false,
    });
    const [cities, contents] = db.statements as [Statement, Statement];
    expect(cities.values).toEqual([PROVIDER, ['AR'], since, 'despegar-hotels', ['900001']]);
    expect(cities.text).toContain('c.country_code::text = ANY($2::text[])');
    expect(contents.values).toEqual([
      PROVIDER,
      ['AR'],
      since,
      'despegar-hotels',
      false,
      ['900001', '900002'],
    ]);
    expect(contents.text).toContain(
      'AND ($6::text[] IS NULL OR h.provider_city_code = ANY($6::text[]))',
    );
    for (const s of db.statements) expectPlaceholdersMatch(s);
  });

  it('el lock es de la sesión, con una clave por proveedor en el rango de int4', async () => {
    const db = new RecordingDb((s) =>
      s.text.includes('try') ? { rows: [{ locked: true }] } : undefined,
    );
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    expect(await store.tryLock()).toBe(true);
    await store.unlock();
    const [take, release] = db.statements;
    expect(take?.values).toEqual(release?.values);
    expect(take?.values).toEqual([...advisoryLockKey(PROVIDER)]);
    for (const part of advisoryLockKey(PROVIDER)) {
      expect(Number.isInteger(part) && part >= -(2 ** 31) && part < 2 ** 31).toBe(true);
    }
    expect(advisoryLockKey(PROVIDER)).not.toEqual(advisoryLockKey('otro-proveedor'));
    expect(advisoryLockKey(PROVIDER)).toEqual(advisoryLockKey(PROVIDER));
  });

  it('sin fila o con `false`, el lock no se tomó', async () => {
    const db = new RecordingDb((s) =>
      s.text.includes('try') ? { rows: [{ locked: false }] } : undefined,
    );
    expect(await new PgCatalogStore(db, { providerCode: PROVIDER }).tryLock()).toBe(false);
    expect(await new PgCatalogStore(new RecordingDb(), { providerCode: PROVIDER }).tryLock()).toBe(
      false,
    );
  });
});

function content(hotelId: string, extra: Partial<TboHotelContent> = {}): TboHotelContent {
  return {
    hotelId,
    lang: 'es',
    source: 'details',
    name: `Hotel ${hotelId}`,
    descriptionHtml: '<p>HeadLine : Centro</p>',
    descriptionText: 'HeadLine : Centro',
    sections: [{ label: 'HeadLine', text: 'Centro' }],
    facilities: ['Free WiFi'],
    unavailableFacilities: ['Wheelchair accessible'],
    attractionsHtml: null,
    images: ['https://api.tbotechnology.in/imageresource.aspx?img=a'],
    phone: null,
    websiteUrl: null,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    ...extra,
  };
}

describe('writeHotelContents (E3 listing y E4 details): content_hash y listing nunca sobre details', () => {
  const FETCHED = new Date('2026-09-25T08:30:00.000Z');

  function storedReplies(
    rows: readonly { hotel_id: string; lang: string; source: string; content_hash: string }[],
    failOn?: RegExp,
  ): (s: Statement) => Reply | undefined {
    return (s) => {
      if (failOn?.test(s.text) === true) return new Error('fallo simulado de Postgres');
      if (s.text.startsWith('SELECT hotel_id, lang, source, content_hash')) return { rows };
      return undefined;
    };
  }

  it('lee lo guardado, escribe sólo lo nuevo o cambiado y confirma lo igual con fetched_at', async () => {
    const same = content('same');
    const changed = content('changed', { name: 'Nuevo nombre' });
    const upgraded = content('upgraded', { lang: 'en' });
    const db = new RecordingDb(
      storedReplies([
        { hotel_id: 'same', lang: 'es', source: 'details', content_hash: contentHash(same) },
        { hotel_id: 'changed', lang: 'es', source: 'details', content_hash: 'viejo' },
        {
          hotel_id: 'upgraded',
          lang: 'en',
          source: 'listing',
          content_hash: contentHash(upgraded),
        },
      ]),
    );
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });

    const result = await store.writeHotelContents({
      contents: [same, changed, upgraded, content('new'), content('new')],
      fetchedAt: FETCHED,
    });

    expect(result).toEqual({ inserted: 1, rewritten: 2, touched: 1, unchanged: 0, protected: 0 });
    const texts = db.texts();
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toMatch(
      /^SELECT hotel_id, lang, source, content_hash FROM hotel_content WHERE provider_code = \$1 AND hotel_id = ANY\(\$2::text\[\]\)$/,
    );
    expect(db.statements[1]?.values).toEqual([PROVIDER, ['same', 'changed', 'upgraded', 'new']]);
    expect(texts[2]).toMatch(
      /^INSERT INTO hotel_content .* ON CONFLICT \(provider_code, hotel_id, lang\) DO UPDATE/,
    );
    expect(texts[3]).toMatch(
      /^UPDATE hotel_content SET fetched_at = \$2 WHERE provider_code = \$1/,
    );
    expect(texts[4]).toBe('COMMIT');
    expect(texts).toHaveLength(5);

    // Sólo `changed`, `upgraded` y `new` (una vez) van al upsert; `same` no se reescribe.
    const insert = db.statements[2] as Statement;
    expectPlaceholdersMatch(insert);
    expect((insert.values.length - 1) / 15).toBe(3);
    expect(insert.values.filter((_, i) => i % 15 === 1).slice(0, 3)).toEqual([
      'changed',
      'upgraded',
      'new',
    ]);
    // JSONB como JSON (no como array de Postgres) y horarios como TIME.
    expect(insert.values.slice(5, 7)).toEqual([
      JSON.stringify([{ label: 'HeadLine', text: 'Centro' }]),
      JSON.stringify(['Free WiFi']),
    ]);
    expect(insert.text).toContain('$6::jsonb,$7::jsonb');
    expect(insert.text).toContain('$12::time,$13::time');
    expect(insert.values.at(-1)).toBe(FETCHED);
    // La base repite las reglas: sólo reescribe si cambió y nunca un listing sobre un details.
    expect(insert.text).toContain(
      "WHERE (hotel_content.content_hash IS DISTINCT FROM EXCLUDED.content_hash OR hotel_content.source IS DISTINCT FROM EXCLUDED.source) AND NOT (hotel_content.source = 'details' AND EXCLUDED.source = 'listing')",
    );

    const touch = db.statements[3] as Statement;
    expectPlaceholdersMatch(touch);
    expect(touch.text).toContain("source = 'details'");
    expect(touch.values).toEqual([PROVIDER, FETCHED, ['same'], ['es'], [contentHash(same)]]);
  });

  it('criterio de PR-3.3: todo igual a lo guardado no emite INSERT', async () => {
    const rows = [content('a'), content('b')];
    const db = new RecordingDb(
      storedReplies(
        rows.map((row) => ({
          hotel_id: row.hotelId,
          lang: row.lang,
          source: 'details',
          content_hash: contentHash(row),
        })),
      ),
    );
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).writeHotelContents({
      contents: rows,
      fetchedAt: FETCHED,
    });
    expect(result).toMatchObject({ inserted: 0, rewritten: 0, touched: 2 });
    expect(db.texts().some((t) => t.startsWith('INSERT'))).toBe(false);
  });

  it('un listing sobre un details no se escribe; uno igual a sí mismo tampoco', async () => {
    const listing = content('a', { lang: 'en', source: 'listing', images: [] });
    const sameListing = content('b', { lang: 'en', source: 'listing', images: [] });
    const db = new RecordingDb(
      storedReplies([
        { hotel_id: 'a', lang: 'en', source: 'details', content_hash: 'cualquiera' },
        { hotel_id: 'b', lang: 'en', source: 'listing', content_hash: contentHash(sameListing) },
      ]),
    );
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).writeHotelContents({
      contents: [listing, sameListing],
      fetchedAt: FETCHED,
    });
    expect(result).toEqual({ inserted: 0, rewritten: 0, touched: 0, unchanged: 1, protected: 1 });
    expect(db.texts()).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT hotel_id, lang, source, content_hash/),
      'COMMIT',
    ]);
  });

  it('sin contenido no abre transacción; si Postgres falla, ROLLBACK', async () => {
    const empty = new RecordingDb();
    await new PgCatalogStore(empty, { providerCode: PROVIDER }).writeHotelContents({
      contents: [],
      fetchedAt: FETCHED,
    });
    expect(empty.statements).toHaveLength(0);

    const db = new RecordingDb(storedReplies([], /^INSERT INTO hotel_content/));
    await expect(
      new PgCatalogStore(db, { providerCode: PROVIDER }).writeHotelContents({
        contents: [content('a')],
        fetchedAt: FETCHED,
      }),
    ).rejects.toThrow('fallo simulado de Postgres');
    expect(db.texts().at(-1)).toBe('ROLLBACK');
    expect(db.texts()).not.toContain('COMMIT');
  });

  it('muchas filas van en lotes de 200 con los placeholders bien numerados', async () => {
    const db = new RecordingDb(storedReplies([]));
    const rows = Array.from({ length: 450 }, (_, i) => content(`h${i}`));
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).writeHotelContents({
      contents: rows,
      fetchedAt: FETCHED,
    });
    expect(result.inserted).toBe(450);
    const inserts = db.statements.filter((s) => s.text.startsWith('INSERT'));
    expect(inserts.map((s) => (s.values.length - 1) / 15)).toEqual([200, 200, 50]);
    inserts.forEach(expectPlaceholdersMatch);
  });
});

describe('listContentCandidates (E4)', () => {
  it('activos de los países de la corrida, demanda del mapa aceptado y sólo contenido details', async () => {
    const es = new Date('2026-08-01T00:00:00Z');
    const en = new Date('2026-09-01T00:00:00Z');
    const db = new RecordingDb(() => ({
      rows: [
        { hotel_id: 'a', demand: 3, detail_langs: ['en', 'es'], detail_fetched_at: [en, es] },
        { hotel_id: 'b', demand: 0, detail_langs: [], detail_fetched_at: [] },
      ],
    }));
    const since = new Date('2026-09-11T00:00:00Z');
    const candidates = await new PgCatalogStore(db, {
      providerCode: PROVIDER,
    }).listContentCandidates({ countries: ['AR'], demandSince: since, onlyDemand: true });

    expect(candidates).toEqual([
      { hotelId: 'a', demand: 3, detailsFetchedAt: { en, es } },
      { hotelId: 'b', demand: 0, detailsFetchedAt: {} },
    ]);
    const s = db.statements[0] as Statement;
    expect(s.values).toEqual([PROVIDER, ['AR'], since, 'despegar-hotels', true, null]);
    expectPlaceholdersMatch(s);
    expect(s.text).toContain('WHERE h.provider_code = $1 AND h.active');
    expect(s.text).toContain("hc.source = 'details'");
    expect(s.text).toContain("m.status = 'accepted'");
    expect(s.text).toContain('(NOT $5::boolean OR COALESCE(d.searches, 0) > 0)');
  });
});

describe('Guarda: nunca DELETE (05 §6.5; 08 RF-30)', () => {
  function writerSqlTexts(): string[] {
    const path = fileURLToPath(new URL('./writer.ts', import.meta.url));
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    );
    const sqlTexts: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        sqlTexts.push(node.text);
      if (ts.isTemplateExpression(node)) {
        sqlTexts.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return sqlTexts;
  }

  it('ningún texto SQL de writer.ts borra filas', () => {
    const sqlTexts = writerSqlTexts();
    expect(sqlTexts.some((text) => text.includes('INSERT INTO hotel_inventory'))).toBe(true);
    expect(sqlTexts.some((text) => text.includes('INSERT INTO hotel_content'))).toBe(true);
    expect(sqlTexts.filter((text) => DESTRUCTIVE_SQL.test(text))).toEqual([]);
    // La guarda distingue: el texto con el que el sync de Despegar reemplaza su catálogo sí casa.
    expect(DESTRUCTIVE_SQL.test('DELETE FROM hotel_inventory WHERE provider_code = $1')).toBe(true);
  });

  it('N10: el detalle por habitación sigue apagado, ningún SQL toca hotel_room_content', () => {
    expect(writerSqlTexts().filter((text) => /hotel_room_content/i.test(text))).toEqual([]);
  });

  it('ninguna sentencia emitida en estos escenarios borra, y toda escritura lleva el proveedor', async () => {
    const db = new RecordingDb(cityReplies({ before: ['a', 'b'], swept: 1 }));
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    await store.upsertCities('AR', [{ code: '900001', name: 'Buenos Aires', countryCode: 'AR' }]);
    await store.writeCityHotels({
      cityCode: '900001',
      hotels: [hotel('a'), hotel('c')],
      unreadable: 0,
      runStart: RUN_START,
      maxDrop: 0.5,
    });
    await store.recordCityFailure('900002', 429);
    await store.deactivateMissing({
      hotelCodes: ['a'],
      unreadable: 0,
      seenSince: RUN_START,
      maxDrop: 1,
    });
    await store.writeHotelContents({
      contents: [content('a'), content('c', { source: 'listing', lang: 'en' })],
      fetchedAt: RUN_START,
    });
    await store.listContentCandidates({
      countries: ['AR'],
      demandSince: RUN_START,
      onlyDemand: false,
    });

    // Filas por sentencia y parámetros compartidos al final, por tabla.
    const shape: Readonly<Record<string, readonly [number, number]>> = {
      hotel_inventory: [9, 2],
      hotel_provider_city: [5, 0],
      hotel_content: [15, 1],
    };
    for (const s of db.statements) {
      expect(s.text).not.toMatch(DESTRUCTIVE_SQL);
      if (/^(UPDATE|SELECT hotel_id|SELECT latitude|SELECT h\.hotel_id)/.test(s.text)) {
        expect(s.text).toContain('provider_code = $1');
        expect(s.values[0]).toBe(PROVIDER);
      }
      if (s.text.startsWith('INSERT')) {
        const table = /^INSERT INTO (\w+)/.exec(s.text)?.[1] ?? '';
        const [columns, shared] = shape[table] ?? [0, 0];
        expect(columns).toBeGreaterThan(0);
        for (let i = 0; i < s.values.length - shared; i += columns) {
          expect(s.values[i]).toBe(PROVIDER);
        }
      }
    }
    expect(db.texts().some((t) => t.startsWith('INSERT INTO hotel_content'))).toBe(true);
  });
});

describe('E6: lecturas de equivalencias y del mapa de destinos', () => {
  it('listHotelMatchScope: el alcance entero del proveedor y los pares por rejilla y haversine', async () => {
    const db = new RecordingDb((s) => {
      if (s.text.startsWith('SELECT h.hotel_id')) {
        return { rows: [{ hotel_id: 'T1' }, { hotel_id: 'T2' }] };
      }
      if (s.text.startsWith('WITH tgt AS')) {
        return {
          rows: [
            {
              target_id: 'T1',
              target_name: 'Alvear Palace',
              target_stars: 5,
              target_lat: -34.58,
              target_lng: -58.39,
              source_id: 'D1',
              source_name: 'Hotel Alvear Palace',
              source_stars: null,
              source_lat: -34.5802,
              source_lng: -58.39,
            },
          ],
        };
      }
      return undefined;
    });
    const scope = await new PgCatalogStore(db, { providerCode: PROVIDER }).listHotelMatchScope({
      countries: ['AR'],
      maxDistanceM: 150,
    });

    expect(scope).toEqual({
      targetHotelIds: ['T1', 'T2'],
      pairs: [
        {
          target: {
            hotelId: 'T1',
            name: 'Alvear Palace',
            stars: 5,
            location: { lat: -34.58, lng: -58.39 },
          },
          source: {
            hotelId: 'D1',
            name: 'Hotel Alvear Palace',
            stars: null,
            location: { lat: -34.5802, lng: -58.39 },
          },
        },
      ],
    });
    const [scopeQuery, pairsQuery] = db.statements as [Statement, Statement];
    // Activos o no: un hotel dado de baja tiene que perder su equivalencia.
    expect(scopeQuery.text).not.toContain('active');
    expect(scopeQuery.values).toEqual([PROVIDER, ['AR']]);
    expect(pairsQuery.values).toEqual([PROVIDER, ['AR'], 'despegar-hotels', 0.01, 150]);
    expect(pairsQuery.text).toContain('CROSS JOIN generate_series(-1, 1) AS d_lat(v)');
    expect(pairsQuery.text).toContain('2 * 6371000 * asin(least(1, sqrt(');
    expect(pairsQuery.text).toContain('WHERE distance_m <= $5');
    expect(pairsQuery.text.match(/\bactive\b/g)).toHaveLength(2);
    for (const s of db.statements) expectPlaceholdersMatch(s);
    expect(db.texts()).not.toContain('BEGIN');
  });

  it('listHotelMatches: toda la tabla, con el score como número', async () => {
    const db = new RecordingDb(() => ({
      rows: [
        {
          canonical_hotel_id: 'despegar-hotels:D1',
          provider_code: PROVIDER,
          hotel_id: 'T1',
          method: 'heuristic',
          score: 0.857,
          status: 'accepted',
        },
      ],
    }));
    expect(await new PgCatalogStore(db, { providerCode: PROVIDER }).listHotelMatches()).toEqual([
      {
        canonicalHotelId: 'despegar-hotels:D1',
        providerCode: PROVIDER,
        hotelId: 'T1',
        method: 'heuristic',
        score: 0.857,
        status: 'accepted',
      },
    ]);
    expect(db.statements[0]?.text).toMatch(/score::float8 AS score, status FROM hotel_match$/);
  });

  it('listDestinationScope: centroides por mediana, ciudades intentadas y solapamiento sólo aceptado', async () => {
    const db = new RecordingDb((s) => {
      if (s.text.startsWith('SELECT city_id::text')) {
        return {
          rows: [
            { city_id: '6585', hotel_count: 12, centroid_lat: -34.6, centroid_lng: -58.4 },
            { city_id: '7777', hotel_count: 2, centroid_lat: null, centroid_lng: null },
          ],
        };
      }
      if (s.text.startsWith('SELECT provider_city_code')) {
        return {
          rows: [
            {
              provider_city_code: '900001',
              country_code: 'AR',
              hotel_count: 40,
              centroid_lat: -34.61,
              centroid_lng: -58.38,
              attempted: true,
            },
          ],
        };
      }
      if (s.text.startsWith('SELECT s.city_id::text')) {
        return { rows: [{ source_city_id: '6585', target_city_code: '900001', matched: 7 }] };
      }
      if (s.text.startsWith('SELECT source_city_id')) {
        return {
          rows: [
            {
              source_city_id: '6585',
              target_city_code: '900001',
              method: 'manual',
              score: null,
              status: 'accepted',
            },
          ],
        };
      }
      return undefined;
    });
    const scope = await new PgCatalogStore(db, { providerCode: PROVIDER }).listDestinationScope({
      countries: ['AR', 'UY'],
    });

    expect(scope).toEqual({
      sources: [
        { cityId: '6585', hotelCount: 12, centroid: { lat: -34.6, lng: -58.4 } },
        { cityId: '7777', hotelCount: 2, centroid: null },
      ],
      targets: [
        {
          cityCode: '900001',
          countryCode: 'AR',
          hotelCount: 40,
          centroid: { lat: -34.61, lng: -58.38 },
          attempted: true,
        },
      ],
      overlaps: [{ sourceCityId: '6585', targetCityCode: '900001', matched: 7 }],
      stored: [
        {
          sourceCityId: '6585',
          targetCityCode: '900001',
          method: 'manual',
          score: null,
          status: 'accepted',
        },
      ],
    });
    const [sources, targets, overlaps, stored] = db.statements as [
      Statement,
      Statement,
      Statement,
      Statement,
    ];
    expect(sources.values).toEqual(['despegar-hotels']);
    expect(sources.text).toContain(
      'percentile_cont(0.5) WITHIN GROUP (ORDER BY latitude) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)',
    );
    expect(targets.values).toEqual([PROVIDER, ['AR', 'UY']]);
    expect(overlaps.values).toEqual([PROVIDER, 'despegar-hotels', ['AR', 'UY']]);
    expect(overlaps.text).toContain("ms.status = 'accepted'");
    expect(overlaps.text).toContain("mt.status = 'accepted'");
    expect(stored.values).toEqual(['despegar-hotels', PROVIDER]);
    for (const s of db.statements) expectPlaceholdersMatch(s);
  });

  it('listUnmappedDestinations: por búsquedas, sin mapa aceptado, marcando los ambiguos', async () => {
    const db = new RecordingDb(() => ({
      rows: [{ destination_id: '8888', searches: 9, pending_review: true }],
    }));
    const since = new Date('2026-09-11T00:00:00Z');
    const unmapped = await new PgCatalogStore(db, {
      providerCode: PROVIDER,
    }).listUnmappedDestinations({ since, limit: 20 });

    expect(unmapped).toEqual([{ destinationId: '8888', searches: 9, pendingReview: true }]);
    const s = db.statements[0] as Statement;
    expect(s.values).toEqual([PROVIDER, 'despegar-hotels', since, 20]);
    expect(s.text).toContain("AND m.status = 'accepted')");
    expect(s.text).toContain("AND a.status = 'ambiguous') AS pending_review");
    expect(s.text).toContain('count(DISTINCT COALESCE(s.search_group_id, s.id))');
    expectPlaceholdersMatch(s);
  });
});

describe('E6: escrituras que nunca pisan lo manual', () => {
  const COMPUTED = new Date('2026-09-25T08:40:00.000Z');

  function match(
    providerCode: string,
    hotelId: string,
    extra: Partial<HotelMatchRow> = {},
  ): HotelMatchRow {
    return {
      canonicalHotelId: `despegar-hotels:D-${hotelId}`,
      providerCode,
      hotelId,
      method: 'heuristic',
      score: 0.9,
      status: 'accepted',
      ...extra,
    };
  }

  function counting(insert: number, update: number): (s: Statement) => Reply | undefined {
    return (s) => {
      if (s.text.startsWith('INSERT')) return { rowCount: insert };
      if (s.text.startsWith('UPDATE')) return { rowCount: update };
      return undefined;
    };
  }

  it('writeHotelMatches: upsert heuristic con WHERE sobre el método, bajas por proveedor, una transacción', async () => {
    const db = new RecordingDb(counting(2, 1));
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).writeHotelMatches({
      upserts: [match(PROVIDER, 'T1'), match('despegar-hotels', 'D1', { status: 'review' })],
      demotions: [
        { providerCode: PROVIDER, hotelId: 'T9' },
        { providerCode: 'despegar-hotels', hotelId: 'D9' },
      ],
      computedAt: COMPUTED,
    });

    expect(result).toEqual({ written: 2, demoted: 2 });
    const texts = db.texts();
    expect(texts[0]).toBe('BEGIN');
    expect(texts.at(-1)).toBe('COMMIT');
    const [insert, demoteTbo, demoteDespegar] = db.statements.slice(1, -1) as [
      Statement,
      Statement,
      Statement,
    ];
    expect(insert.text).toMatch(/VALUES \(\$1,\$2,\$3,'heuristic',\$4::numeric,\$5,\$11\),/);
    expect(insert.text).toMatch(/WHERE hotel_match\.method = 'heuristic'$/);
    expect(insert.values).toEqual([
      'despegar-hotels:D-T1',
      PROVIDER,
      'T1',
      0.9,
      'accepted',
      'despegar-hotels:D-D1',
      'despegar-hotels',
      'D1',
      0.9,
      'review',
      COMPUTED,
    ]);
    for (const [s, provider, id] of [
      [demoteTbo, PROVIDER, 'T9'],
      [demoteDespegar, 'despegar-hotels', 'D9'],
    ] as const) {
      expect(s.text).toContain("SET status = 'rejected'");
      expect(s.text).toContain("AND method = 'heuristic'");
      expect(s.values).toEqual([provider, [id], COMPUTED]);
    }
    for (const s of db.statements) expectPlaceholdersMatch(s);
  });

  it('writeHotelMatches: sin filas no abre transacción; con un proveedor ajeno falla antes; si Postgres falla, ROLLBACK', async () => {
    const empty = new RecordingDb();
    const store = new PgCatalogStore(empty, { providerCode: PROVIDER });
    expect(
      await store.writeHotelMatches({ upserts: [], demotions: [], computedAt: COMPUTED }),
    ).toEqual({ written: 0, demoted: 0 });
    await expect(
      store.writeHotelMatches({
        upserts: [match('otro-bedbank', 'X1')],
        demotions: [],
        computedAt: COMPUTED,
      }),
    ).rejects.toThrow(/proveedor/);
    expect(empty.statements).toEqual([]);

    const failing = new RecordingDb((s) =>
      s.text.startsWith('UPDATE hotel_match') ? new Error('fallo simulado de Postgres') : undefined,
    );
    await expect(
      new PgCatalogStore(failing, { providerCode: PROVIDER }).writeHotelMatches({
        upserts: [match(PROVIDER, 'T1')],
        demotions: [{ providerCode: PROVIDER, hotelId: 'T9' }],
        computedAt: COMPUTED,
      }),
    ).rejects.toThrow('fallo simulado');
    expect(failing.texts().at(-1)).toBe('ROLLBACK');
    expect(failing.texts()).not.toContain('COMMIT');
  });

  it('writeHotelMatches: muchas filas van en lotes de 1.000 con los placeholders bien numerados', async () => {
    const db = new RecordingDb();
    await new PgCatalogStore(db, { providerCode: PROVIDER }).writeHotelMatches({
      upserts: Array.from({ length: 1_001 }, (_, i) => match(PROVIDER, `T${i}`)),
      demotions: [],
      computedAt: COMPUTED,
    });
    const inserts = db.statements.filter((s) => s.text.startsWith('INSERT INTO hotel_match'));
    expect(inserts.map((s) => s.values.length)).toEqual([5_001, 6]);
    for (const s of inserts) expectPlaceholdersMatch(s);
  });

  it('writeDestinationMap: upsert que no pisa manual, bajas por par y la fecha una sola vez', async () => {
    const db = new RecordingDb(counting(2, 1));
    const result = await new PgCatalogStore(db, { providerCode: PROVIDER }).writeDestinationMap({
      upserts: [
        {
          sourceCityId: '6585',
          targetCityCode: '900001',
          method: 'overlap',
          score: 0.75,
          status: 'accepted',
        },
        {
          sourceCityId: '8888',
          targetCityCode: '900003',
          method: 'centroid',
          score: 0.8,
          status: 'ambiguous',
        },
      ],
      demotions: [{ sourceCityId: '6585', targetCityCode: '900009' }],
      computedAt: COMPUTED,
    });

    expect(result).toEqual({ written: 2, demoted: 1 });
    const [begin, insert, demote, commit] = db.statements as [
      Statement,
      Statement,
      Statement,
      Statement,
    ];
    expect([begin.text, commit.text]).toEqual(['BEGIN', 'COMMIT']);
    expect(insert.text).toMatch(
      /VALUES \(\$1,\$3,\$2,\$4,\$5,\$6::numeric,\$7,\$13\),\(\$1,\$8,\$2,\$9,/,
    );
    expect(insert.text).toMatch(/WHERE hotel_destination_map\.method <> 'manual'$/);
    expect(insert.values).toEqual([
      'despegar-hotels',
      PROVIDER,
      '6585',
      '900001',
      'overlap',
      0.75,
      'accepted',
      '8888',
      '900003',
      'centroid',
      0.8,
      'ambiguous',
      COMPUTED,
    ]);
    expect(demote.text).toContain("AND method <> 'manual'");
    expect(demote.text).toContain('SELECT * FROM unnest($4::text[], $5::text[])');
    expect(demote.values).toEqual(['despegar-hotels', PROVIDER, COMPUTED, ['6585'], ['900009']]);
    for (const s of db.statements) expectPlaceholdersMatch(s);
  });

  it('writeDestinationMap: nunca escribe una fila manual, ni abre transacción sin filas', async () => {
    const db = new RecordingDb();
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    await expect(
      store.writeDestinationMap({
        upserts: [
          {
            sourceCityId: '1',
            targetCityCode: '2',
            method: 'manual',
            score: null,
            status: 'accepted',
          },
        ],
        demotions: [],
        computedAt: COMPUTED,
      }),
    ).rejects.toThrow(/manual/);
    expect(
      await store.writeDestinationMap({ upserts: [], demotions: [], computedAt: COMPUTED }),
    ).toEqual({ written: 0, demoted: 0 });
    expect(db.statements).toEqual([]);
  });

  it('E6 no escribe el catálogo: ninguna sentencia suya toca hotel_inventory, ciudades ni contenido', async () => {
    const db = new RecordingDb();
    const store = new PgCatalogStore(db, { providerCode: PROVIDER });
    await store.listHotelMatchScope({ countries: ['AR'], maxDistanceM: 150 });
    await store.listHotelMatches();
    await store.writeHotelMatches({
      upserts: [match(PROVIDER, 'T1')],
      demotions: [{ providerCode: 'despegar-hotels', hotelId: 'D9' }],
      computedAt: COMPUTED,
    });
    await store.listDestinationScope({ countries: ['AR'] });
    await store.writeDestinationMap({
      upserts: [
        {
          sourceCityId: '1',
          targetCityCode: '2',
          method: 'centroid',
          score: 0.5,
          status: 'accepted',
        },
      ],
      demotions: [{ sourceCityId: '1', targetCityCode: '3' }],
      computedAt: COMPUTED,
    });
    await store.listUnmappedDestinations({ since: COMPUTED, limit: 20 });

    const writes = db.statements.filter((s) => /^(INSERT INTO|UPDATE) /.test(s.text));
    expect(writes).toHaveLength(4);
    for (const s of db.statements) {
      expect(s.text).not.toMatch(DESTRUCTIVE_SQL);
    }
    for (const s of writes) {
      expect(s.text).toMatch(/^(INSERT INTO|UPDATE) (hotel_match|hotel_destination_map)\b/);
      if (s.text.includes('hotel_match')) expect(s.text).toContain("'heuristic'");
      else expect(s.text).toContain("<> 'manual'");
    }
  });
});
