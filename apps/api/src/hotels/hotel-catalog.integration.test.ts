import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Catálogo de hoteles multi-proveedor (migración 0041) contra Postgres real.
 *
 * El riesgo de la 0041 no está en las tablas nuevas, que nadie usa todavía: está en el job
 * nocturno de Despegar, que hace `DELETE` + `INSERT` de 12 columnas sobre `hotel_inventory` y
 * no sabe que la tabla ganó tres. Si una columna nueva naciera sin default, o el default no
 * dejara las filas activas, la búsqueda de hoteles de mañana volvería vacía y el síntoma sería
 * "catálogo no sincronizado", no un error de la migración. Por eso el caso central replica el
 * `INSERT` del sync tal cual, y la sonda de abajo vigila que la réplica no se quede vieja.
 *
 * Los códigos de proveedor son sintéticos a propósito: el `DELETE` del sync borra todo un
 * `provider_code`, y quien corra esto contra su base local no puede perder su catálogo real.
 *
 * Requiere las migraciones 0001, 0022 y 0041. Se SALTA sin PGHOST; los permisos se prueban con
 * `SET ROLE app_user`, así que alcanza con el superusuario que usa CI.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const RAIZ = join(__dirname, '..', '..', '..', '..');
const MIGRACION = join(RAIZ, 'db', 'migrations', '0041_hotel_catalog_multi_provider.sql');
const SYNC_DESPEGAR = join(RAIZ, 'tools', 'sync-hotel-inventory', 'src', 'index.ts');

/** Columnas del `INSERT` de `replaceInventory` (tools/sync-hotel-inventory/src/index.ts). */
const COLUMNAS_DEL_SYNC = [
  'provider_code',
  'hotel_id',
  'city_id',
  'country_code',
  'name',
  'stars',
  'property_type',
  'latitude',
  'longitude',
  'address',
  'zipcode',
  'merged_ids',
] as const;

/** Cada tabla con una columna de proveedor que exista en ella, para armar escrituras válidas. */
const COLUMNA_DE_PROVEEDOR = {
  hotel_inventory: 'provider_code',
  hotel_provider_city: 'provider_code',
  hotel_destination_map: 'target_provider_code',
  hotel_match: 'provider_code',
  hotel_content: 'provider_code',
  hotel_room_content: 'provider_code',
} as const;

type TablaDelCatalogo = keyof typeof COLUMNA_DE_PROVEEDOR;

const TABLAS_DEL_CATALOGO = Object.keys(COLUMNA_DE_PROVEEDOR) as TablaDelCatalogo[];

interface FilaDelSync {
  hotelId: string;
  cityId: number | null;
  name: string | null;
  stars: number | null;
  propertyType: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  zipcode: string | null;
  mergedIds: unknown[];
}

interface FilaLeida {
  hotel_id: string;
  provider_city_code: string | null;
  active: boolean;
  last_seen_at: Date | null;
}

/**
 * Réplica de `replaceInventory` del sync de Despegar, incluidas su transacción y la forma de los
 * placeholders (`$12::jsonb`). El `provider_code` va por parámetro, igual que en el sync (lo lee
 * de `DESPEGAR_PROVIDER_CODE`).
 */
async function reemplazarComoElSync(
  pool: pg.Pool,
  providerCode: string,
  filas: FilaDelSync[],
): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM hotel_inventory WHERE provider_code = $1', [providerCode]);
    const cols = COLUMNAS_DEL_SYNC.length;
    const values: unknown[] = [];
    const placeholders = filas.map((r, idx) => {
      values.push(
        providerCode,
        r.hotelId,
        r.cityId,
        null,
        r.name,
        r.stars,
        r.propertyType,
        r.latitude,
        r.longitude,
        r.address,
        r.zipcode,
        JSON.stringify(r.mergedIds),
      );
      const o = idx * cols;
      const params = COLUMNAS_DEL_SYNC.map((_, i) => `$${o + i + 1}`);
      params[cols - 1] = `${params[cols - 1]}::jsonb`;
      return `(${params.join(',')})`;
    });
    await c.query(
      `INSERT INTO hotel_inventory
         (${COLUMNAS_DEL_SYNC.join(', ')})
       VALUES ${placeholders.join(',')}`,
      values,
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

function hotelDespegar(hotelId: string, cityId: number): FilaDelSync {
  return {
    hotelId,
    cityId,
    name: `Hotel ${hotelId}`,
    stars: 4.5,
    propertyType: 'HOTEL',
    latitude: 4.6097,
    longitude: -74.0817,
    address: 'Calle 1 # 2-3',
    zipcode: '110111',
    mergedIds: [Number(hotelId) + 1000],
  };
}

d('catálogo de hoteles multi-proveedor (0041)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  const DESPEGAR = `sync-despegar-${sfx}`;
  const OTRO = `otro-hotel-${sfx}`;
  const CIUDAD_DESPEGAR = 9_000_001;

  async function filasDe(providerCode: string): Promise<FilaLeida[]> {
    const { rows } = await pool.query<FilaLeida>(
      `SELECT hotel_id, provider_city_code, active, last_seen_at
         FROM hotel_inventory WHERE provider_code = $1 ORDER BY hotel_id`,
      [providerCode],
    );
    return rows;
  }

  /** Upsert por ciudad con barrido, el modelo de escritura de un proveedor que no reemplaza todo. */
  async function upsertCiudadDelOtro(
    cityCode: string,
    hotelIds: string[],
    corrida: Date,
  ): Promise<void> {
    for (const hotelId of hotelIds) {
      await pool.query(
        `INSERT INTO hotel_inventory (provider_code, hotel_id, provider_city_code, active, last_seen_at)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (provider_code, hotel_id) DO UPDATE
           SET provider_city_code = EXCLUDED.provider_city_code,
               active = true,
               last_seen_at = EXCLUDED.last_seen_at`,
        [OTRO, hotelId, cityCode, corrida],
      );
    }
    await pool.query(
      `UPDATE hotel_inventory SET active = false
        WHERE provider_code = $1 AND provider_city_code = $2 AND last_seen_at < $3`,
      [OTRO, cityCode, corrida],
    );
  }

  /** Ejecuta `sql` como `app_user` y devuelve el SQLSTATE del error, o `'ok'`. */
  async function comoApp(sql: string, params: unknown[] = []): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(sql, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** SQLSTATE de un INSERT hecho como superusuario (para los CHECK), sin dejar la fila. */
  async function insertar(sql: string, params: unknown[]): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  afterAll(async () => {
    await pool.query('DELETE FROM hotel_inventory WHERE provider_code = ANY($1)', [
      [DESPEGAR, OTRO],
    ]);
    await pool.end();
  });

  it('el DELETE + INSERT de 12 columnas del sync sigue funcionando y las filas nacen activas', async () => {
    await reemplazarComoElSync(pool, DESPEGAR, [
      hotelDespegar('101', CIUDAD_DESPEGAR),
      hotelDespegar('102', CIUDAD_DESPEGAR),
      hotelDespegar('103', CIUDAD_DESPEGAR),
    ]);

    const filas = await filasDe(DESPEGAR);
    expect(filas.map((f) => f.hotel_id)).toEqual(['101', '102', '103']);
    expect(filas.every((f) => f.active)).toBe(true);
    // Despegar sigue en su espacio de ids (`city_id`) y no participa del barrido.
    expect(filas.every((f) => f.provider_city_code === null && f.last_seen_at === null)).toBe(true);
  });

  it('dos noches seguidas con el mismo inventario dejan el mismo conteo de filas', async () => {
    const inventario = [
      hotelDespegar('201', CIUDAD_DESPEGAR),
      hotelDespegar('202', CIUDAD_DESPEGAR),
    ];

    await reemplazarComoElSync(pool, DESPEGAR, inventario);
    const primera = (await filasDe(DESPEGAR)).length;
    await reemplazarComoElSync(pool, DESPEGAR, inventario);

    expect(primera).toBe(2);
    expect(await filasDe(DESPEGAR)).toHaveLength(primera);
  });

  it('para Despegar la baja sigue siendo el borrado: un hotel que deja de venir no queda inactivo', async () => {
    await reemplazarComoElSync(pool, DESPEGAR, [
      hotelDespegar('301', CIUDAD_DESPEGAR),
      hotelDespegar('302', CIUDAD_DESPEGAR),
    ]);
    await reemplazarComoElSync(pool, DESPEGAR, [hotelDespegar('301', CIUDAD_DESPEGAR)]);

    const filas = await filasDe(DESPEGAR);
    expect(filas.map((f) => f.hotel_id)).toEqual(['301']);
    expect(filas[0]?.active).toBe(true);
  });

  it('el upsert con barrido de otro proveedor y el reemplazo de Despegar no se pisan', async () => {
    const ayer = new Date('2026-01-01T08:00:00Z');
    const hoy = new Date('2026-01-02T08:00:00Z');
    await upsertCiudadDelOtro('C-7', ['a1', 'a2'], ayer);
    await reemplazarComoElSync(pool, DESPEGAR, [hotelDespegar('401', CIUDAD_DESPEGAR)]);

    // Hoy el otro proveedor ya no lista a2: queda inactivo, no borrado.
    await upsertCiudadDelOtro('C-7', ['a1'], hoy);
    // Y la noche de Despegar no toca las filas del otro.
    await reemplazarComoElSync(pool, DESPEGAR, [hotelDespegar('402', CIUDAD_DESPEGAR)]);

    expect(await filasDe(OTRO)).toEqual([
      { hotel_id: 'a1', provider_city_code: 'C-7', active: true, last_seen_at: hoy },
      { hotel_id: 'a2', provider_city_code: 'C-7', active: false, last_seen_at: ayer },
    ]);
    expect((await filasDe(DESPEGAR)).map((f) => [f.hotel_id, f.active])).toEqual([['402', true]]);
  });

  it('la consulta por ciudad del proveedor usa el índice parcial sólo si pide activos', async () => {
    const c = await pool.connect();
    const plan = async (sql: string, params: unknown[]): Promise<string> => {
      const { rows } = await c.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${sql}`,
        params,
      );
      return JSON.stringify(rows[0]?.['QUERY PLAN']);
    };
    try {
      await c.query('BEGIN');
      // Con un puñado de filas el planificador recorre la PK en orden de `hotel_id` y filtra, y
      // el test no diría nada. Con 100 ciudades de 20 hoteles y estadísticas, la forma de la
      // consulta decide. Todo se deshace con el ROLLBACK.
      await c.query(
        `INSERT INTO hotel_inventory (provider_code, hotel_id, provider_city_code, last_seen_at)
         SELECT $1, 'v' || g, 'C-' || (g % 100), now() FROM generate_series(1, 2000) AS g`,
        [OTRO],
      );
      await c.query('ANALYZE hotel_inventory');
      await c.query('SET LOCAL enable_seqscan = off');
      const base =
        'SELECT hotel_id FROM hotel_inventory WHERE provider_code = $1 AND provider_city_code = $2';

      expect(
        await plan(`${base} AND active = $3 ORDER BY hotel_id LIMIT 50`, [OTRO, 'C-7', true]),
      ).toContain('idx_hotel_inventory_provider_city');
      // Sin `active` el índice no es elegible: la búsqueda que lo omita, además de leer los
      // inactivos, recorre otro índice.
      expect(await plan(`${base} ORDER BY hotel_id LIMIT 50`, [OTRO, 'C-7'])).not.toContain(
        'idx_hotel_inventory_provider_city',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('app_user lee las seis tablas del catálogo y no puede escribir en ninguna', async () => {
    const resultado: Record<string, Record<string, string>> = {};
    for (const tabla of TABLAS_DEL_CATALOGO) {
      const col = COLUMNA_DE_PROVEEDOR[tabla];
      resultado[tabla] = {
        select: await comoApp(`SELECT count(*) FROM ${tabla}`),
        insert: await comoApp(`INSERT INTO ${tabla} (${col}) VALUES ($1)`, [OTRO]),
        update: await comoApp(`UPDATE ${tabla} SET ${col} = ${col} WHERE ${col} = $1`, [OTRO]),
        delete: await comoApp(`DELETE FROM ${tabla} WHERE ${col} = $1`, [OTRO]),
      };
    }

    // 42501 = insufficient_privilege. Antes de la 0041, hotel_inventory daba 'ok' en las tres
    // escrituras por el default de privilegios de 0001.
    const soloLectura = { select: 'ok', insert: '42501', update: '42501', delete: '42501' };
    expect(resultado).toEqual(Object.fromEntries(TABLAS_DEL_CATALOGO.map((t) => [t, soloLectura])));
  });

  it('las tablas nuevas son de plataforma: sin tenant_id y sin RLS', async () => {
    const { rows } = await pool.query<{ tabla: string; rls: boolean; tenant: boolean }>(
      `SELECT c.relname AS tabla,
              c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant
         FROM pg_class c
        WHERE c.relname = ANY($1) AND c.relkind = 'r'
        ORDER BY c.relname`,
      [[...TABLAS_DEL_CATALOGO]],
    );
    expect(rows).toHaveLength(TABLAS_DEL_CATALOGO.length);
    expect(rows.filter((r) => r.rls || r.tenant)).toEqual([]);
  });

  it('los CHECK rechazan valores fuera de contrato', async () => {
    const contenido = (lang: string, source: string): Promise<string> =>
      insertar(
        `INSERT INTO hotel_content (provider_code, hotel_id, lang, source, content_hash)
         VALUES ($1, 'h1', $2, $3, 'x')`,
        [OTRO, lang, source],
      );
    const habitacion = (roomId: string): Promise<string> =>
      insertar(
        `INSERT INTO hotel_room_content (provider_code, hotel_id, room_id, lang)
         VALUES ($1, 'h1', $2, 'es')`,
        [OTRO, roomId],
      );
    const destino = (method: string, status: string): Promise<string> =>
      insertar(
        `INSERT INTO hotel_destination_map
           (source_provider_code, source_city_id, target_provider_code, target_city_code, method, score, status)
         VALUES ($1, '9000001', $2, 'C-7', $3, 0.875, $4)`,
        [DESPEGAR, OTRO, method, status],
      );
    const equivalencia = (method: string, status: string): Promise<string> =>
      insertar(
        `INSERT INTO hotel_match (canonical_hotel_id, provider_code, hotel_id, method, score, status)
         VALUES ('canon-1', $1, 'h1', $2, 0.9, $3)`,
        [OTRO, method, status],
      );

    // 23514 = check_violation.
    expect({
      contenidoDetalle: await contenido('es', 'details'),
      contenidoListado: await contenido('en', 'listing'),
      idiomaDelProveedor: await contenido('ES', 'details'),
      origenDesconocido: await contenido('es', 'scraping'),
      habitacionMapeada: await habitacion('197354'),
      habitacionSinMapeo: await habitacion('0'),
      destinoAceptado: await destino('overlap', 'accepted'),
      destinoManualAmbiguo: await destino('manual', 'ambiguous'),
      destinoMetodoRaro: await destino('nombre', 'accepted'),
      destinoEstadoRaro: await destino('overlap', 'maybe'),
      equivalenciaEnRevision: await equivalencia('heuristic', 'review'),
      equivalenciaMetodoRaro: await equivalencia('nombre', 'accepted'),
      equivalenciaEstadoRaro: await equivalencia('giata', 'maybe'),
    }).toEqual({
      contenidoDetalle: 'ok',
      contenidoListado: 'ok',
      idiomaDelProveedor: '23514',
      origenDesconocido: '23514',
      habitacionMapeada: 'ok',
      habitacionSinMapeo: '23514',
      destinoAceptado: 'ok',
      destinoManualAmbiguo: 'ok',
      destinoMetodoRaro: '23514',
      destinoEstadoRaro: '23514',
      equivalenciaEnRevision: 'ok',
      equivalenciaMetodoRaro: '23514',
      equivalenciaEstadoRaro: '23514',
    });
  });

  it('las claves impiden la fusión doble y el contenido duplicado, y active nunca es NULL', async () => {
    // 23505 = unique_violation, 23502 = not_null_violation. Cada caso es una sola sentencia
    // para que `insertar` la deshaga entera.
    expect({
      // Un hotel en dos grupos canónicos sería una fusión falsa: la PK es (proveedor, hotel), no
      // incluye el canónico.
      hotelEnDosCanonicos: await insertar(
        `INSERT INTO hotel_match (canonical_hotel_id, provider_code, hotel_id, method, status)
         VALUES ('canon-1', $1, 'h1', 'heuristic', 'accepted'),
                ('canon-2', $1, 'h1', 'heuristic', 'accepted')`,
        [OTRO],
      ),
      // Una fila por hotel e idioma: 'details' gana sobre 'listing' por upsert, no por convivir.
      contenidoDosVecesEnUnIdioma: await insertar(
        `INSERT INTO hotel_content (provider_code, hotel_id, lang, source, content_hash)
         VALUES ($1, 'h1', 'en', 'details', 'x'), ($1, 'h1', 'en', 'listing', 'y')`,
        [OTRO],
      ),
      // `WHERE active = true` trataría un NULL como inactivo sin que nadie lo haya dado de baja.
      activoNulo: await insertar(
        `INSERT INTO hotel_inventory (provider_code, hotel_id, active) VALUES ($1, 'n1', NULL)`,
        [OTRO],
      ),
    }).toEqual({
      hotelEnDosCanonicos: '23505',
      contenidoDosVecesEnUnIdioma: '23505',
      activoNulo: '23502',
    });
  });
});

// ---------------------------------------------------------------------------
// Sondas sin base de datos: sin Postgres todo lo de arriba se SALTA, y un salto silencioso no
// puede contar como verde. Estas dos vigilan lo que el bloque de arriba da por supuesto.
// ---------------------------------------------------------------------------

describe('catálogo de hoteles 0041, sin base de datos', () => {
  it('la réplica escribe las mismas 12 columnas que el sync real de Despegar', () => {
    const fuente = readFileSync(SYNC_DESPEGAR, 'utf8');

    const insert = /INSERT INTO hotel_inventory\s*\(([^)]*)\)/.exec(fuente);
    expect(insert, 'el sync ya no hace INSERT INTO hotel_inventory (...)').not.toBeNull();
    const columnas = (insert?.[1] ?? '').split(',').map((col) => col.trim());

    // Si el sync cambia sus columnas, la réplica deja de probar lo que corre cada noche.
    expect(columnas).toEqual([...COLUMNAS_DEL_SYNC]);
    expect(fuente).toContain('DELETE FROM hotel_inventory WHERE provider_code = $1');
  });

  it('toda tabla del catálogo queda con SELECT para app_user y sin escritura', () => {
    const sql = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');
    const lista = (re: RegExp): string[] =>
      (re.exec(sql)?.[1] ?? '').split(',').map((t) => t.trim());

    const creadas = [...sql.matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1]);
    const conSelect = lista(/GRANT SELECT ON ([\w\s,]+?)\s+TO app_user/);
    const sinEscritura = lista(/REVOKE INSERT, UPDATE, DELETE ON ([\w\s,]+?)\s+FROM app_user/);

    // Una tabla nueva que se olvide de estas dos listas nace con INSERT/UPDATE/DELETE para la app
    // por el ALTER DEFAULT PRIVILEGES de 0001.
    expect([...creadas, 'hotel_inventory'].sort()).toEqual([...TABLAS_DEL_CATALOGO].sort());
    expect(conSelect.sort()).toEqual([...TABLAS_DEL_CATALOGO].sort());
    expect(sinEscritura.sort()).toEqual([...TABLAS_DEL_CATALOGO].sort());
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
  });
});
