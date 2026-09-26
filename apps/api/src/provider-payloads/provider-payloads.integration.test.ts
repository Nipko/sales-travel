import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import { PROVIDER_PAYLOAD_ENVIRONMENTS, type DB } from '../database/database.types.js';
import {
  PROVIDER_PAYLOADS_MAX_RETENTION_DAYS,
  loadProviderPayloadsConfig,
} from './provider-payloads.config.js';
import { ProviderPayloadsService } from './provider-payloads.service.js';
import { ProviderPayloadsStore } from './provider-payloads.store.js';
import {
  PROVIDER_PAYLOAD_EVENTS,
  PROVIDER_PAYLOAD_READER_ROLES,
} from './provider-payloads.types.js';

/**
 * Bóveda de payloads (migración 0043) contra Postgres real (docs/tbo/09 PR-4.9).
 *
 * Lo que sólo la base puede probar: quién lee (la RLS, que como superusuario no existe, así que
 * cada lectura de la app corre con `SET LOCAL ROLE app_user`), que `app_user` no puede ni cambiar
 * ni borrar una fila, que la retención corta es un CHECK y no una promesa, que la purga borra lo
 * vencido y nada más, y que la lectura de la app deja su evento en la misma transacción.
 *
 * La red: una plataforma, un consolidador dueño de la cuenta, una agencia que la hereda y otro
 * consolidador ajeno. Requiere las migraciones hasta la 0043. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const MIGRACION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'db',
  'migrations',
  '0043_provider_payloads.sql',
);

const DIA_MS = 86_400_000;

/** SQLSTATE con que falla `p`, o `'ok'`. */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'sin-codigo';
  }
}

/** `DatabaseService` cuya lectura con contexto corre como `app_user`, como en producción. */
class DatabaseServiceComoApp extends DatabaseService {
  override withRequestContext<T>(
    ctx: { userId?: string; tenantId?: string },
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return super.withRequestContext(ctx, async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      return fn(trx);
    });
  }
}

d('bóveda de payloads (0043) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new DatabaseServiceComoApp();
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `payload-it-${sfx}`;
  const rid = (n: string) => `${sfx}-${n}`;

  let plataforma: string;
  let consolidador: string;
  let agencia: string;
  let otroConsolidador: string;
  let cuenta: string;
  const usuarios: Record<string, string> = {};

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre],
    );
    return rows[0]!.id;
  }

  async function crearUsuario(nombre: string, tenantId: string, role: string): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`payloads-${nombre}-${sfx}@test.local`],
    );
    const id = rows[0]!.id;
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [
      tenantId,
      id,
      role,
    ]);
    usuarios[nombre] = id;
  }

  function fila(requestId: string, owner: string, extra: Record<string, unknown> = {}) {
    return {
      provider_code: PROVEEDOR,
      request_id: requestId,
      attempt: 1,
      operation: 'book',
      environment: 'live',
      owner_tenant_id: owner,
      sent_at: new Date(),
      duration_ms: 10,
      http_status: 200,
      outcome: 'SUCCESS',
      key_id: '0123456789abcdef',
      request_bytes: 3,
      request_enc: Buffer.from([1, 2, 3]),
      expires_at: new Date(Date.now() + DIA_MS),
      ...extra,
    };
  }

  function insertar(c: pg.Pool | pg.PoolClient, columnas: Record<string, unknown>) {
    const nombres = Object.keys(columnas);
    return c.query(
      `INSERT INTO provider_payloads (${nombres.join(', ')})
       VALUES (${nombres.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(columnas),
    );
  }

  /** Corre `fn` como `app_user` con ese usuario (o ninguno). Por defecto deshace todo. */
  async function comoApp<T>(
    userId: string | null,
    fn: (c: pg.PoolClient) => Promise<T>,
    confirmar = false,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      if (userId !== null) {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      }
      const out = await fn(c);
      await c.query(confirmar ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  function visiblesPara(userId: string | null): Promise<string[]> {
    return comoApp(userId, async (c) => {
      const { rows } = await c.query<{ request_id: string }>(
        'SELECT request_id FROM provider_payloads WHERE provider_code = $1 ORDER BY request_id',
        [PROVEEDOR],
      );
      return rows.map((r) => r.request_id);
    });
  }

  beforeAll(async () => {
    database.onModuleInit();
    plataforma = await crearTenant(`pp-p-${sfx}`, 'platform', null);
    consolidador = await crearTenant(`pp-c-${sfx}`, 'consolidator', null);
    agencia = await crearTenant(`pp-a-${sfx}`, 'agency', consolidador);
    otroConsolidador = await crearTenant(`pp-o-${sfx}`, 'consolidator', null);

    // La plataforma NO es ancestro de los consolidadores: sus roles se leen como globales.
    await crearUsuario('plataforma', plataforma, 'platform_admin');
    await crearUsuario('consolidador', consolidador, 'consolidator_admin');
    await crearUsuario('tenantAdmin', consolidador, 'tenant_admin');
    await crearUsuario('agencia', agencia, 'agency_admin');
    await crearUsuario('otro', otroConsolidador, 'consolidator_admin');

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, credentials_enc, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [consolidador, PROVEEDOR, Buffer.from('no-es-un-secreto')],
    );
    cuenta = rows[0]!.id;

    await insertar(
      pool,
      fila(rid('c-live'), consolidador, { provider_account_id: cuenta, tenant_id: agencia }),
    );
    await insertar(pool, fila(rid('o-live'), otroConsolidador));
    // Vencida: sigue en la tabla hasta la purga, pero no se lee.
    await insertar(
      pool,
      fila(rid('c-vencida'), consolidador, {
        created_at: new Date(Date.now() - 10 * DIA_MS),
        expires_at: new Date(Date.now() - DIA_MS),
      }),
    );
  });

  afterAll(async () => {
    // parent_tenant_id es ON DELETE RESTRICT: de hoja a raíz. Cada tenant se lleva sus filas.
    for (const id of [agencia, consolidador, otroConsolidador, plataforma]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    const ids = Object.values(usuarios);
    if (ids.length > 0) await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('app_user no es superusuario ni salta la RLS', async () => {
    const rol = await comoApp(null, async (c) => {
      const { rows } = await c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      return rows[0];
    });
    // Si esto falla, los casos de lectura de abajo no prueban nada.
    expect(rol).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('lee el consolidator_admin dueño de la cuenta y la plataforma; nadie más, y lo vencido nadie', async () => {
    expect({
      consolidador: await visiblesPara(usuarios['consolidador']!),
      plataforma: await visiblesPara(usuarios['plataforma']!),
      otroConsolidador: await visiblesPara(usuarios['otro']!),
      // Más estrecho que can_read_membership(): otro admin del mismo nodo no lee.
      tenantAdminDelDueno: await visiblesPara(usuarios['tenantAdmin']!),
      // Aunque la llamada fue suya: la respuesta trae la tarifa neta del dueño de la cuenta.
      agenciaQueHereda: await visiblesPara(usuarios['agencia']!),
      sinUsuario: await visiblesPara(null),
    }).toEqual({
      consolidador: [rid('c-live')],
      plataforma: [rid('c-live'), rid('o-live')],
      otroConsolidador: [rid('o-live')],
      tenantAdminDelDueno: [],
      agenciaQueHereda: [],
      sinUsuario: [],
    });
  });

  it('app_user escribe sin contexto, pero no cambia ni borra una fila', async () => {
    expect({
      insertar: await sqlstate(comoApp(null, (c) => insertar(c, fila(rid('app'), consolidador)))),
      actualizar: await sqlstate(
        comoApp(usuarios['plataforma']!, (c) =>
          c.query(`UPDATE provider_payloads SET outcome = 'X' WHERE request_id = $1`, [
            rid('c-live'),
          ]),
        ),
      ),
      borrar: await sqlstate(
        comoApp(usuarios['plataforma']!, (c) =>
          c.query('DELETE FROM provider_payloads WHERE request_id = $1', [rid('c-live')]),
        ),
      ),
      vaciar: await sqlstate(comoApp(null, (c) => c.query('TRUNCATE provider_payloads'))),
    }).toEqual({ insertar: 'ok', actualizar: '42501', borrar: '42501', vaciar: '42501' });
  });

  it('la retención corta y el formato son CHECK de la base', async () => {
    const intento = (extra: Record<string, unknown>) =>
      sqlstate(
        comoApp(null, (c) =>
          insertar(c, fila(rid(`chk-${randomBytes(2).toString('hex')}`), consolidador, extra)),
        ),
      );

    // 23514 = check_violation; 23505 = unique_violation.
    expect({
      noventaYUnDias: await intento({ expires_at: new Date(Date.now() + 91 * DIA_MS) }),
      yaVencidaAlEntrar: await intento({ expires_at: new Date(Date.now() - 1_000) }),
      entornoRaro: await intento({ environment: 'produccion' }),
      cifradoSinTamano: await intento({ request_bytes: null }),
      requestIdConEspacios: await intento({ request_id: 'Xiomara Quintanilla' }),
      intentoCero: await intento({ attempt: 0 }),
      claveRara: await intento({ key_id: 'no-es-hex' }),
      repetida: await sqlstate(
        comoApp(null, (c) => insertar(c, fila(rid('c-live'), consolidador))),
      ),
    }).toEqual({
      noventaYUnDias: '23514',
      yaVencidaAlEntrar: '23514',
      entornoRaro: '23514',
      cifradoSinTamano: '23514',
      requestIdConEspacios: '23514',
      intentoCero: '23514',
      claveRara: '23514',
      repetida: '23505',
    });
  });

  it('borrar la cuenta no borra la evidencia: queda sin cuenta hasta vencer', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // La cuenta no tiene órdenes (0042 lo impediría): sólo payloads.
      await c.query('DELETE FROM provider_accounts WHERE id = $1', [cuenta]);
      const { rows } = await c.query<{ provider_account_id: string | null }>(
        'SELECT provider_account_id FROM provider_payloads WHERE request_id = $1',
        [rid('c-live')],
      );
      expect(rows).toEqual([{ provider_account_id: null }]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('la purga es la única vía de borrado: app_user la ejecuta, PUBLIC no, y sólo borra lo vencido', async () => {
    const privilegios = await pool.query<{
      publico_purga: boolean;
      publico_lectura: boolean;
      app: boolean;
    }>(
      `SELECT has_function_privilege('public', 'purge_expired_provider_payloads(integer)', 'EXECUTE') AS publico_purga,
              has_function_privilege('public', 'can_read_provider_payloads(uuid)', 'EXECUTE') AS publico_lectura,
              has_function_privilege('app_user', 'purge_expired_provider_payloads(integer)', 'EXECUTE') AS app`,
    );
    expect(privilegios.rows[0]).toEqual({
      publico_purga: false,
      publico_lectura: false,
      app: true,
    });

    const borradas = await comoApp(
      null,
      async (c) => {
        const { rows } = await c.query<{ n: number }>(
          'SELECT purge_expired_provider_payloads(10000) AS n',
        );
        return rows[0]?.n ?? 0;
      },
      true,
    );
    const { rows } = await pool.query<{ request_id: string }>(
      'SELECT request_id FROM provider_payloads WHERE provider_code = $1 ORDER BY request_id',
      [PROVEEDOR],
    );

    expect(borradas).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.request_id)).toEqual([rid('c-live'), rid('o-live')]);
  });

  describe('servicio y store reales', () => {
    const audit = new AuditService(database);
    const service = new ProviderPayloadsService(
      new ProviderPayloadsStore(database, audit),
      loadProviderPayloadsConfig({
        PROVIDER_PAYLOADS_KEY: randomBytes(32).toString('base64'),
        PROVIDER_PAYLOADS_RETENTION_DAYS: '14',
      }),
      audit,
    );
    const RQ = JSON.stringify({
      CustomerNames: [{ FirstName: 'Xiomara', LastName: 'Quintanilla' }],
    });

    it('guarda cifrado, con el vencimiento calculado por la base', async () => {
      await service.record({
        providerCode: PROVEEDOR,
        requestId: rid('svc'),
        attempt: 1,
        operation: 'book',
        environment: 'test',
        ownerTenantId: consolidador,
        providerAccountId: cuenta,
        sentAt: new Date(),
        durationMs: 5,
        httpStatus: 200,
        outcome: 'SUCCESS',
        requestBody: RQ,
      });

      const { rows } = await pool.query<{
        request_enc: Buffer;
        dias: number;
        response_bytes: number | null;
      }>(
        `SELECT request_enc, response_bytes,
                extract(epoch FROM expires_at - created_at) / 86400 AS dias
           FROM provider_payloads WHERE request_id = $1`,
        [rid('svc')],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.dias)).toBe(14);
      expect(rows[0]!.response_bytes).toBeNull();
      expect(rows[0]!.request_enc.toString('latin1')).not.toContain('Xiomara');
    });

    it('la exportación lee con la RLS del lector y deja su evento en la misma transacción', async () => {
      const delDueno = await service.exportByRequestId(rid('svc'), {
        userId: usuarios['consolidador']!,
        tenantId: consolidador,
      });
      const deLaAgencia = await service.exportByRequestId(rid('svc'), {
        userId: usuarios['agencia']!,
        tenantId: agencia,
      });

      expect(delDueno.entries.map((e) => e.request)).toEqual([
        { kind: 'json', value: JSON.parse(RQ) as unknown },
      ]);
      expect(deLaAgencia.entries).toEqual([]);

      const { rows } = await pool.query<{
        actor_user_id: string;
        tenant_id: string;
        payload: { records: number };
      }>(
        `SELECT actor_user_id, tenant_id, payload FROM domain_events
          WHERE event_type = $1 AND aggregate_id = $2 ORDER BY occurred_at`,
        [PROVIDER_PAYLOAD_EVENTS.exported, rid('svc')],
      );
      expect(rows.map((r) => [r.actor_user_id, r.tenant_id, r.payload.records])).toEqual([
        [usuarios['consolidador'], consolidador, 1],
        [usuarios['agencia'], agencia, 0],
      ]);
    });

    it('si el evento no entra, la lectura no devuelve nada ni deja rastro a medias', async () => {
      // `actor_user_id` es UUID: el INSERT del evento falla dentro de la transacción de la lectura.
      await expect(
        service.exportByRequestId(rid('svc'), { userId: 'no-es-un-uuid' }),
      ).rejects.toMatchObject({ code: '22P02' });
    });

    it('la purga del servicio borra lo vencido', async () => {
      await insertar(
        pool,
        fila(rid('svc-vencida'), consolidador, {
          created_at: new Date(Date.now() - 10 * DIA_MS),
          expires_at: new Date(Date.now() - DIA_MS),
        }),
      );

      expect(await service.purgeExpired()).toBeGreaterThanOrEqual(1);
      const { rows } = await pool.query('SELECT 1 FROM provider_payloads WHERE request_id = $1', [
        rid('svc-vencida'),
      ]);
      expect(rows).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Sondas sin base de datos: sin Postgres todo lo de arriba se SALTA, y un salto silencioso no
// puede contar como verde. Estas vigilan lo que el bloque de arriba da por supuesto.
// ---------------------------------------------------------------------------

describe('bóveda de payloads 0043, sin base de datos', () => {
  const sqlText = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');

  it('el CHECK de entorno dice lo mismo que el vocabulario de la app', () => {
    const m = /CHECK \(environment IN \(([^)]*)\)\)/.exec(sqlText);
    expect(m, 'sin CHECK (environment IN (...))').not.toBeNull();
    expect((m?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''))).toEqual([
      ...PROVIDER_PAYLOAD_ENVIRONMENTS,
    ]);
  });

  it('quién lee en SQL es quién entra por HTTP: roles de plataforma y los del controlador', () => {
    const cuerpo =
      /CREATE FUNCTION can_read_provider_payloads[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(sqlText)?.[1] ??
      '';
    const listas = [...cuerpo.matchAll(/m\.role IN \(([^)]*)\)/g)].map((m) =>
      (m[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')),
    );
    expect(listas).toEqual([[...PLATFORM_ROLES], [...PROVIDER_PAYLOAD_READER_ROLES]]);
  });

  it('RLS forzada, sólo SELECT e INSERT para app_user, y funciones cerradas a PUBLIC', () => {
    expect(sqlText).toMatch(/ALTER TABLE provider_payloads ENABLE ROW LEVEL SECURITY/);
    expect(sqlText).toMatch(/ALTER TABLE provider_payloads FORCE\s+ROW LEVEL SECURITY/);
    expect(sqlText).toMatch(/REVOKE ALL ON provider_payloads FROM app_user;/);
    const grants = [...sqlText.matchAll(/GRANT ([A-Z, ]+) ON provider_payloads TO app_user/g)].map(
      (m) => m[1],
    );
    expect(grants).toEqual(['SELECT, INSERT']);
    expect(sqlText).toMatch(
      /CREATE POLICY provider_payloads_reader_select ON provider_payloads\s+FOR SELECT\s+USING \(expires_at > now\(\) AND can_read_provider_payloads\(owner_tenant_id\)\)/,
    );
    for (const fn of [
      'can_read_provider_payloads(uuid)',
      'purge_expired_provider_payloads(integer)',
    ]) {
      expect(sqlText).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
    }
  });

  it('la retención máxima de la base es la de la app', () => {
    const m = /expires_at <= created_at \+ interval '(\d+) days'/.exec(sqlText);
    expect(Number(m?.[1])).toBe(PROVIDER_PAYLOADS_MAX_RETENTION_DAYS);
  });
});
