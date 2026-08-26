import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';

/**
 * El contrato entre el ESCRITOR de `search_logs` y la función de cuota, contra Postgres real.
 *
 * Antes esto no se podía probar: la telemetría escribía una sola fila por búsqueda, así que
 * "N búsquedas × M proveedores cuentan N" se cumplía trivialmente y `COUNT(DISTINCT
 * COALESCE(search_group_id, id))` de la 0035 nunca llegaba a ejercitarse. Con una fila por
 * proveedor, el criterio pasa a significar algo: son las dos mitades —el INSERT y el
 * COUNT— las que tienen que estar de acuerdo, y sólo la base de datos real lo demuestra.
 *
 * Los códigos de proveedor son stubs anónimos a propósito: esto vale para cualquier segundo
 * proveedor, no para uno concreto.
 *
 * Requiere las migraciones 0032 y 0035. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const ALFA = 'alfa-air';
const BETA = 'beta-air';
const VENTANA_MIN = 60;

d('search_logs: una fila por proveedor, una búsqueda en la cuota', () => {
  const pool = new pg.Pool();
  const database = new DatabaseService();
  const sfx = randomBytes(4).toString('hex');
  let telemetry: SearchTelemetryService;
  let tenantId: string;

  /** Registra una búsqueda a los proveedores dados (una fila por cada uno). */
  async function buscar(codes: string[]): Promise<void> {
    await telemetry.record({
      tenantId,
      vertical: 'flights',
      providers: codes.map((providerCode, i) => ({
        providerCode,
        durationMs: 100 * (i + 1),
        resultCount: i,
        outcome: i > 0 ? 'ok' : 'empty',
      })),
      criteria: { origin: 'BOG', destination: 'LIM' },
    });
  }

  /** Fila anterior a la 0035: sin grupo. Cada una es una búsqueda por sí sola. */
  async function filaLegacy(): Promise<void> {
    await pool.query(
      `INSERT INTO search_logs (tenant_id, vertical, provider_code, duration_ms, result_count, outcome)
       VALUES ($1, 'flights', $2, 100, 1, 'ok')`,
      [tenantId, ALFA],
    );
  }

  async function cuota(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count_recent_searches($1::uuid, $2) AS n`,
      [tenantId, VENTANA_MIN],
    );
    return Number(rows[0]!.n);
  }

  async function filas(): Promise<{ search_group_id: string | null; provider_code: string }[]> {
    const { rows } = await pool.query<{ search_group_id: string | null; provider_code: string }>(
      `SELECT search_group_id, provider_code FROM search_logs WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows;
  }

  beforeAll(async () => {
    database.onModuleInit();
    telemetry = new SearchTelemetryService(database);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'consolidator') RETURNING id`,
      [`stl-${sfx}`],
    );
    tenantId = rows[0]!.id;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM search_logs WHERE tenant_id = $1`, [tenantId]);
  });

  afterAll(async () => {
    if (tenantId) await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]); // cascada
    await database.onModuleDestroy();
    await pool.end();
  });

  it('N búsquedas × 2 proveedores => 2N filas, N grupos y N en la cuota', async () => {
    const N = 3;
    for (let i = 0; i < N; i++) await buscar([ALFA, BETA]);

    const rows = await filas();
    expect(rows).toHaveLength(2 * N);
    expect(new Set(rows.map((r) => r.search_group_id)).size).toBe(N);
    expect(rows.every((r) => r.search_group_id !== null)).toBe(true);

    // Lo que paga la agencia: la cuota cuenta BÚSQUEDAS, no llamadas a proveedor. Sumar un
    // segundo proveedor no puede recortar a la mitad el plan de nadie.
    expect(await cuota()).toBe(N);
  });

  it('la telemetría por proveedor existe: cada código tiene sus propias filas', async () => {
    const N = 3;
    for (let i = 0; i < N; i++) await buscar([ALFA, BETA]);

    const rows = await filas();
    expect(rows.filter((r) => r.provider_code === ALFA)).toHaveLength(N);
    expect(rows.filter((r) => r.provider_code === BETA)).toHaveLength(N);
    // Ninguna fila con los códigos concatenados: eso era lo que hacía inservible la tabla.
    expect(rows.some((r) => r.provider_code.includes('+'))).toBe(false);
  });

  it('las filas viejas sin search_group_id siguen contando 1 cada una', async () => {
    // Sin el COALESCE de la 0035, `COUNT(DISTINCT search_group_id)` las descartaría a todas
    // y la cuota de un tenant activo se reiniciaría sola en el momento del deploy.
    await filaLegacy();
    await filaLegacy();

    expect(await filas()).toHaveLength(2);
    expect(await cuota()).toBe(2);
  });

  it('mezcla filas viejas y nuevas sin contarse de más', async () => {
    await filaLegacy();
    await buscar([ALFA, BETA]);
    await buscar([ALFA, BETA]);

    expect(await filas()).toHaveLength(5); // 1 legacy + 2 × 2
    expect(await cuota()).toBe(3); // 1 legacy + 2 grupos
  });

  it('un fan-out enteramente fallido no consume cuota pero deja el rastro por proveedor', async () => {
    // `count_recent_searches` excluye `outcome = 'error'`: no se le factura al tenant una
    // búsqueda que el proveedor no atendió, pero el fallo tiene que quedar registrado.
    await telemetry.record({
      tenantId,
      vertical: 'flights',
      providers: [ALFA, BETA].map((providerCode) => ({
        providerCode,
        durationMs: 5_000,
        resultCount: 0,
        outcome: 'error' as const,
        errorCode: 'ProviderCallError',
      })),
    });

    expect(await filas()).toHaveLength(2);
    expect(await cuota()).toBe(0);
  });

  it('sin proveedores activos la búsqueda igual cuenta 1', async () => {
    await telemetry.record({ tenantId, vertical: 'flights', providers: [] });

    const rows = await filas();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_code).toBe('none');
    expect(await cuota()).toBe(1);
  });
});
