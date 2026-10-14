import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { AnnouncementArchivedError } from './announcements.errors.js';
import { CreateAnnouncementSchema, type CreateAnnouncementDto } from './announcements.schemas.js';
import { ANNOUNCEMENT_EVENTS, AnnouncementsService } from './announcements.service.js';

/**
 * Los anuncios de la plataforma contra Postgres de verdad (0079).
 *
 * Lo que los tests sin base no pueden probar: que la red ve sólo lo dirigido a su nodo o a un
 * ancestro (nunca lo de otra red), que "sólo administradores" no le llega a un vendedor, que lo
 * vencido, archivado o programado no se muestra, el orden y el tope de 3, que nadie más que el
 * superadmin lee o escribe la tabla (42501), los CHECK y que cada cambio deja su rastro sin el
 * mensaje.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS): como superusuario la RLS no aplicaría
 * y no probaría nada. El superusuario sólo siembra y mira. Se SALTA sin PGHOST.
 *
 * Red de la prueba:
 *
 *   platform ─┬─ consA ── agA ── subA
 *             └─ consB ── agB
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const MIN = 60_000;
const DAY = 86_400_000;

/** `DatabaseService` que entra como `app_user`, el rol de la API. */
class ComoAppUser extends DatabaseService {
  override async withRequestContext<T>(
    ctx: { userId?: string; tenantId?: string },
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      if (ctx.userId) {
        await sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
      }
      if (ctx.tenantId) {
        await sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`.execute(trx);
      }
      return fn(trx);
    });
  }
}

d('system_announcements (0079) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const service = new AnnouncementsService(database, new AuditService(database));
  const sfx = randomBytes(4).toString('hex');

  const tenants: string[] = [];
  const users: string[] = [];
  const mine: string[] = [];

  let platform: string;
  let consA: string;
  let agA: string;
  let subA: string;
  let consB: string;
  let agB: string;

  let superadmin: string;
  let adminConsA: string;
  let adminAgA: string;
  let vendA: string;
  let vendSubA: string;
  let vendB: string;

  /** Los anuncios de la prueba, por nombre. */
  const ids: Record<string, string> = {};

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`ann-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`ann-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  function dto(input: {
    severity: 'info' | 'warning' | 'critical';
    title: string;
    root?: string | null;
    adminsOnly?: boolean;
    startsInMs?: number;
    endsInMs?: number;
  }): CreateAnnouncementDto {
    const now = Date.now();
    return CreateAnnouncementSchema.parse({
      severity: input.severity,
      title: `${input.title} ${sfx}`,
      body: 'Mensaje de prueba.\nSegunda línea.',
      audience: { rootTenantId: input.root ?? null, adminsOnly: input.adminsOnly ?? false },
      ...(input.startsInMs === undefined
        ? {}
        : { startsAt: new Date(now + input.startsInMs).toISOString() }),
      endsAt: new Date(now + (input.endsInMs ?? DAY)).toISOString(),
    });
  }

  async function publish(name: string, input: Parameters<typeof dto>[0]): Promise<string> {
    const view = await service.create(superadmin, dto(input));
    ids[name] = view.id;
    mine.push(view.id);
    return view.id;
  }

  /** Los anuncios de esta prueba que ve `userId` con `tenantId` activo, en el orden de la base. */
  async function seen(userId: string, tenantId: string): Promise<string[]> {
    const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    const rows = await service.active(userId, tenantId);
    return rows.map((r) => names.get(r.id) ?? `ajeno:${r.id}`);
  }

  /**
   * Qué pasa con una sentencia como `app_user`, sin dejar nada: `ok:<filas>` o el SQLSTATE. Con el
   * usuario dado o, con `null`, sin usuario.
   */
  async function ensayo(quien: string | null, text: string, values: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      if (quien !== null) {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [quien]);
      }
      const res = await c.query(text, values);
      return `ok:${res.command === 'SELECT' ? res.rows.length : (res.rowCount ?? 0)}`;
    } catch (e) {
      return (e as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** Lo mismo como el superusuario que siembra, para los CHECK. */
  async function comoSuperusuario(text: string, values: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const res = await c.query(text, values);
      return `ok:${res.rowCount ?? 0}`;
    } catch (e) {
      return (e as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    consA = await tenant('ca', 'consolidator', platform);
    agA = await tenant('aa', 'agency', consA);
    subA = await tenant('sa', 'subagency', agA);
    consB = await tenant('cb', 'consolidator', platform);
    agB = await tenant('ab', 'agency', consB);

    superadmin = await user('root', platform, 'superadmin');
    adminConsA = await user('adm-ca', consA, 'consolidator_admin');
    adminAgA = await user('adm-aa', agA, 'agency_admin');
    vendA = await user('vend-aa', agA, 'vendedor');
    vendSubA = await user('vend-sa', subA, 'vendedor');
    vendB = await user('vend-ab', agB, 'vendedor');

    // Comienzos escalonados en el pasado: el orden entre los de igual gravedad no depende de la
    // velocidad de la prueba.
    await publish('NET', { severity: 'info', title: 'Toda la red', startsInMs: -60 * MIN });
    await publish('A', { severity: 'warning', title: 'Red A', root: consA, startsInMs: -50 * MIN });
    await publish('A_ADM', {
      severity: 'info',
      title: 'Red A, sólo admins',
      root: consA,
      adminsOnly: true,
      startsInMs: -40 * MIN,
    });
    await publish('SUB', {
      severity: 'critical',
      title: 'Subagencia A',
      root: subA,
      startsInMs: -30 * MIN,
    });
    await publish('B', {
      severity: 'critical',
      title: 'Red B',
      root: consB,
      startsInMs: -20 * MIN,
    });
    await publish('NET2', { severity: 'info', title: 'Toda la red, 2', startsInMs: -10 * MIN });
    await publish('FUT', {
      severity: 'critical',
      title: 'Programado',
      startsInMs: DAY,
      endsInMs: 2 * DAY,
    });
    await publish('ARCH', { severity: 'critical', title: 'Archivado', startsInMs: -5 * MIN });
    await service.archive(superadmin, ids['ARCH']!);

    // Uno vencido: la API no publica algo que ya terminó, así que lo siembra el superusuario.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO system_announcements (severity, title, starts_at, ends_at, created_by)
       VALUES ('critical', $1, now() - interval '2 days', now() - interval '1 day', $2)
       RETURNING id`,
      [`Vencido ${sfx}`, superadmin],
    );
    ids['EXP'] = rows[0]!.id;
    mine.push(rows[0]!.id);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM system_announcements WHERE id = ANY($1::uuid[])', [mine]);
    await pool.query(
      `DELETE FROM domain_events WHERE aggregate_type = 'system_announcement'
          AND aggregate_id = ANY($1::text[])`,
      [mine],
    );
    for (const id of [...tenants].reverse()) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM memberships WHERE user_id = ANY($1::uuid[])', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('quién ve qué en la red', () => {
    it('un vendedor de la red A ve lo de toda la red y lo de su red; nunca lo de la red B', async () => {
      expect(await seen(vendA, agA)).toEqual(['A', 'NET2', 'NET']);
    });

    it('un vendedor de la red B ve lo suyo y lo de toda la red; nunca lo de la red A', async () => {
      expect(await seen(vendB, agB)).toEqual(['B', 'NET2', 'NET']);
    });

    it('"sólo administradores" no le llega a un vendedor, sí al admin del nodo y al de un ancestro', async () => {
      expect(await seen(vendA, agA)).not.toContain('A_ADM');
      expect(await seen(adminAgA, agA)).toContain('A_ADM');
      expect(await seen(adminConsA, agA)).toContain('A_ADM');
      expect(await seen(adminConsA, consA)).toContain('A_ADM');
    });

    it('los más graves primero, a igual gravedad los más nuevos, y tres como mucho', async () => {
      expect(await seen(adminAgA, agA)).toEqual(['A', 'NET2', 'A_ADM']);
      expect(await seen(vendSubA, subA)).toEqual(['SUB', 'A', 'NET2']);
    });

    it('un anuncio de un nodo no sube: el consolidador no ve el de su subagencia', async () => {
      expect(await seen(adminConsA, consA)).not.toContain('SUB');
      expect(await seen(vendA, agA)).not.toContain('SUB');
    });

    it('lo vencido, lo archivado y lo programado no se muestran', async () => {
      for (const [u, t] of [
        [vendA, agA],
        [vendB, agB],
        [superadmin, platform],
      ] as const) {
        const names = await seen(u, t);
        expect(names).not.toContain('EXP');
        expect(names).not.toContain('ARCH');
        expect(names).not.toContain('FUT');
      }
    });

    it('nadie pregunta por otra red: con un nodo donde no opera, o sin usuario, no hay nada', async () => {
      expect(await seen(vendB, agA)).toEqual([]);
      expect(await seen(vendA, consB)).toEqual([]);
      expect(await ensayo(null, 'SELECT * FROM active_announcements()')).toBe('ok:0');
      const sinNodo = await database.withRequestContext({ userId: vendA }, (trx) =>
        sql`SELECT * FROM active_announcements()`.execute(trx),
      );
      expect(sinNodo.rows).toEqual([]);
    });

    it('la función no dice a quién iba ni quién lo escribió', async () => {
      const [row] = await service.active(vendA, agA);
      expect(Object.keys(row!).sort()).toEqual(
        ['body', 'endsAt', 'id', 'severity', 'startsAt', 'title'].sort(),
      );
      expect(row!.body).toBe('Mensaje de prueba.\nSegunda línea.');
    });
  });

  describe('la tabla es sólo del superadmin', () => {
    const INSERTAR = `INSERT INTO system_announcements (severity, title, ends_at, created_by)
                      VALUES ('info', 'Intruso', now() + interval '1 day', $1)`;

    it('quien no es superadmin no inserta: 42501', async () => {
      expect(await ensayo(adminConsA, INSERTAR, [adminConsA])).toBe('42501');
      expect(await ensayo(vendA, INSERTAR, [vendA])).toBe('42501');
      expect(await ensayo(null, INSERTAR, [superadmin])).toBe('42501');
    });

    it('el superadmin inserta, pero sólo a su nombre', async () => {
      expect(await ensayo(superadmin, INSERTAR, [superadmin])).toBe('ok:1');
      expect(await ensayo(superadmin, INSERTAR, [adminConsA])).toBe('42501');
    });

    it('nadie más la lee directo ni la cambia; borrar, nadie', async () => {
      expect(await ensayo(adminConsA, 'SELECT 1 FROM system_announcements')).toBe('ok:0');
      expect(await ensayo(vendA, 'SELECT 1 FROM system_announcements')).toBe('ok:0');
      expect(
        await ensayo(adminConsA, `UPDATE system_announcements SET title = 'x' WHERE id = $1`, [
          ids['A'],
        ]),
      ).toBe('ok:0');
      expect(
        await ensayo(superadmin, 'DELETE FROM system_announcements WHERE id = $1', [ids['A']]),
      ).toBe('42501');
    });

    it('el servicio le da 403 a quien no es superadmin, aunque pase la guarda de la app', async () => {
      await expect(
        service.create(adminConsA, dto({ severity: 'info', title: 'Colado' })),
      ).rejects.toBeInstanceOf(SuperadminRequiredError);
      await expect(service.list(adminConsA)).rejects.toBeInstanceOf(SuperadminRequiredError);
      await expect(service.archive(vendA, ids['A']!)).rejects.toBeInstanceOf(
        SuperadminRequiredError,
      );
    });

    it('un UPDATE no cambia quién lo publicó', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [superadmin]);
        await c.query('UPDATE system_announcements SET created_by = $1 WHERE id = $2', [
          adminConsA,
          ids['NET'],
        ]);
        const { rows } = await c.query<{ created_by: string }>(
          'SELECT created_by FROM system_announcements WHERE id = $1',
          [ids['NET']],
        );
        expect(rows[0]?.created_by).toBe(superadmin);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  describe('CHECK', () => {
    const insertar = (title: string, body: string, ends: string) =>
      comoSuperusuario(
        `INSERT INTO system_announcements (severity, title, body, starts_at, ends_at, created_by)
         VALUES ('info', $1, $2, now(), now() + $3::interval, $4)`,
        [title, body, ends, superadmin],
      );

    it('31 días como mucho y termina después de empezar', async () => {
      expect(await insertar('Título', '', '31 days')).toBe('ok:1');
      expect(await insertar('Título', '', '31 days 1 second')).toBe('23514');
      expect(await insertar('Título', '', '0 seconds')).toBe('23514');
    });

    it('texto plano: sin controles (el mensaje admite saltos de línea), título no vacío', async () => {
      expect(await insertar('Título', 'Uno\nDos', '1 day')).toBe('ok:1');
      expect(await insertar('Tí\ntulo', '', '1 day')).toBe('23514');
      expect(await insertar('Título', 'Uno\u0007', '1 day')).toBe('23514');
      expect(await insertar('   ', '', '1 day')).toBe('23514');
      expect(
        await comoSuperusuario(
          `INSERT INTO system_announcements (severity, title, ends_at, created_by)
           VALUES ('urgent', 'Título', now() + interval '1 day', $1)`,
          [superadmin],
        ),
      ).toBe('23514');
    });

    it('el anuncio de un nodo se va con el nodo', async () => {
      const temp = await tenant('tmp', 'agency', consB);
      const id = await publish('TMP', { severity: 'info', title: 'Nodo temporal', root: temp });
      await pool.query('DELETE FROM tenants WHERE id = $1', [temp]);
      tenants.splice(tenants.indexOf(temp), 1);
      const { rows } = await pool.query('SELECT 1 FROM system_announcements WHERE id = $1', [id]);
      expect(rows).toEqual([]);
    });
  });

  describe('el panel del superadmin', () => {
    it('lista cada uno con su estado', async () => {
      const list = await service.list(superadmin);
      const status = new Map(list.map((a) => [a.id, a.status]));
      expect(status.get(ids['NET']!)).toBe('active');
      expect(status.get(ids['FUT']!)).toBe('scheduled');
      expect(status.get(ids['EXP']!)).toBe('expired');
      expect(status.get(ids['ARCH']!)).toBe('archived');
      const a = list.find((x) => x.id === ids['A']);
      expect(a?.audience).toEqual({
        rootTenantId: consA,
        rootTenantName: `ann-ca-${sfx}`,
        adminsOnly: false,
      });
    });

    it('corregir: cambia lo que se ve; uno archivado ya no se toca', async () => {
      const updated = await service.update(superadmin, ids['NET2']!, {
        severity: 'warning',
        audience: { rootTenantId: consB, adminsOnly: false },
      });
      expect(updated).toMatchObject({ severity: 'warning', status: 'active' });
      expect(await seen(vendA, agA)).not.toContain('NET2');
      expect(await seen(vendB, agB)).toEqual(['B', 'NET2', 'NET']);

      await expect(
        service.update(superadmin, ids['ARCH']!, { title: 'Otra vez' }),
      ).rejects.toBeInstanceOf(AnnouncementArchivedError);
      await expect(service.archive(superadmin, ids['ARCH']!)).rejects.toBeInstanceOf(
        AnnouncementArchivedError,
      );
    });

    it('archivar lo saca de la franja en el acto', async () => {
      expect(await seen(vendB, agB)).toContain('B');
      const archived = await service.archive(superadmin, ids['B']!);
      expect(archived.status).toBe('archived');
      expect(await seen(vendB, agB)).not.toContain('B');
    });

    it('cada cambio deja su rastro en la raíz platform, con a quién iba y nunca el mensaje', async () => {
      const { rows } = await pool.query<{
        event_type: string;
        tenant_id: string | null;
        actor_user_id: string | null;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, tenant_id, actor_user_id, aggregate_id, payload FROM domain_events
          WHERE aggregate_type = 'system_announcement' AND aggregate_id = ANY($1::text[])
          ORDER BY occurred_at, id`,
        [[ids['B'], ids['NET2']]],
      );
      expect(rows.map((r) => [r.event_type, r.aggregate_id])).toEqual([
        [ANNOUNCEMENT_EVENTS.published, ids['B']],
        [ANNOUNCEMENT_EVENTS.published, ids['NET2']],
        [ANNOUNCEMENT_EVENTS.updated, ids['NET2']],
        [ANNOUNCEMENT_EVENTS.archived, ids['B']],
      ]);
      for (const r of rows) {
        expect(r.tenant_id).toBe(platform);
        expect(r.actor_user_id).toBe(superadmin);
        expect(JSON.stringify(r.payload)).not.toContain('Mensaje de prueba');
        expect(JSON.stringify(r.payload)).not.toContain(sfx);
      }
      expect(rows[2]?.payload).toMatchObject({
        severity: 'warning',
        audience: { rootTenantId: consB, adminsOnly: false },
        changed: ['severity', 'audience'],
      });
    });
  });
});
