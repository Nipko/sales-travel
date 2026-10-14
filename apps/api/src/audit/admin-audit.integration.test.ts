import { randomBytes, randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { requestContextStorage } from '../request-context/request-context.js';
import {
  AdminAuditExportQuerySchema,
  AdminAuditQuerySchema,
  type AdminAuditQuery,
} from './admin-audit.schemas.js';
import {
  AdminAuditService,
  PLATFORM_AUDIT_EXPORTED_EVENT,
  type AdminAuditEventView,
} from './admin-audit.service.js';
import { AuditService } from './audit.service.js';

/**
 * Plataforma → Actividad contra Postgres (0078):
 *
 *   - el superadmin ve toda la plataforma, de todas las redes, con los eventos sin nodo;
 *   - "Todo" nunca trae los latidos del barrido (system.*): sólo "Sistema" o pedir justo ese tipo;
 *   - cada filtro (categoría, nodo con su subárbol, persona, entidad, tipo) y la paginación por
 *     (occurred_at, id), sin saltar los eventos de una misma transacción;
 *   - el payload sale sin claves sensibles y de `meta` nunca el id de la sesión;
 *   - quien no es superadmin recibe 403 por el servicio y 42501 si llama a la función directo;
 *   - exportar escribe platform.audit.exported con los filtros y las filas, y nada si se rechaza.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira. Los
 * eventos de la prueba van en un día de 2001-2009 elegido al azar: ningún otro test escribe ahí, así
 * que los filtros por fecha dejan sólo los de esta prueba. Se SALTA sin PGHOST.
 *
 * Red de la prueba:
 *
 *   platform ─┬─ consA ── agA
 *             └─ consB ── agB
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

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

/** `código HTTP/motivo` del error con que falla `p`. Falla el test si `p` no falla. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    if (typeof http.getStatus !== 'function') throw err;
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
  throw new Error('esperaba un error HTTP');
}

const pad = (n: number) => String(n).padStart(2, '0');

d('Plataforma → Actividad (0078) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const service = new AdminAuditService(database, new AuditService(database));
  const sfx = randomBytes(4).toString('hex');

  /** El día de la prueba, en Bogotá. */
  const DAY = `${2001 + Math.floor(Math.random() * 9)}-${pad(1 + Math.floor(Math.random() * 12))}-${pad(1 + Math.floor(Math.random() * 28))}`;
  const ORDER = randomUUID();

  let platform: string;
  let consA: string;
  let agA: string;
  let consB: string;
  let agB: string;

  let superadmin: string;
  let adminConsA: string;
  let vendA: string;

  /** Los eventos sembrados, por nombre. */
  const ev: Record<string, string> = {};

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`aud-${slug}-${sfx}`, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`aud-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  /** Un evento a la hora `hhmm` (Bogotá) del día de la prueba, sembrado por el superusuario. */
  async function event(
    name: string,
    hhmm: string,
    e: {
      type: string;
      tenant: string | null;
      actor: string | null;
      aggregateType?: string;
      aggregateId?: string;
      payload?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    },
  ): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO domain_events (occurred_at, tenant_id, actor_user_id, event_type, aggregate_type,
                                  aggregate_id, payload, meta)
       VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) RETURNING id`,
      [
        `${DAY}T${hhmm}:00-05:00`,
        e.tenant,
        e.actor,
        e.type,
        e.aggregateType ?? null,
        e.aggregateId ?? null,
        JSON.stringify(e.payload ?? {}),
        JSON.stringify(e.meta ?? {}),
      ],
    );
    ev[name] = rows[0]!.id;
  }

  const query = (extra: Record<string, string> = {}): AdminAuditQuery =>
    AdminAuditQuerySchema.parse({ from: DAY, to: DAY, limit: '200', ...extra });

  const names = (events: readonly AdminAuditEventView[]) => {
    const byId = new Map(Object.entries(ev).map(([name, id]) => [id, name]));
    return events.map((e) => byId.get(e.id) ?? `ajeno:${e.eventType}`);
  };

  async function seen(extra: Record<string, string> = {}, as = superadmin): Promise<string[]> {
    return names((await service.list(as, query(extra))).events);
  }

  /** Qué pasa con una sentencia como `app_user`, sin dejar nada: `ok:<filas>` o el SQLSTATE. */
  async function ensayo(quien: string | null, text: string, values: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      if (quien !== null) {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [quien]);
      }
      const res = await c.query(text, values);
      return `ok:${res.rows.length}`;
    } catch (e) {
      return (e as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  async function exportsBy(actor: string): Promise<Array<{ tenant_id: string; payload: unknown }>> {
    const { rows } = await pool.query<{ tenant_id: string; payload: unknown }>(
      `SELECT tenant_id, payload FROM domain_events
        WHERE actor_user_id = $1 AND event_type = $2 ORDER BY occurred_at`,
      [actor, PLATFORM_AUDIT_EXPORTED_EVENT],
    );
    return rows;
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    consA = await tenant('ca', 'consolidator', platform);
    agA = await tenant('aa', 'agency', consA);
    consB = await tenant('cb', 'consolidator', platform);
    agB = await tenant('ab', 'agency', consB);

    superadmin = await user('root', platform, 'superadmin');
    adminConsA = await user('adm-ca', consA, 'consolidator_admin');
    vendA = await user('vend-aa', agA, 'vendedor');

    await event('LOGIN_FALLIDO', '09:00', {
      type: 'auth.login.failed',
      tenant: null,
      actor: null,
      payload: { reason: 'unknown_user' },
      meta: { ip: '190.0.0.1', userAgent: 'Mozilla/5.0', requestId: 'req-1', sessionId: 'ses-1' },
    });
    await event('RETENCION', '09:10', {
      type: 'wallet_hold.policy_changed',
      tenant: null,
      actor: superadmin,
      aggregateType: 'tenant',
      aggregateId: consA,
      payload: { mode: 'observe', previousMode: 'enforce' },
    });
    await event('ORDEN', '09:20', {
      type: 'OrderCreated',
      tenant: agA,
      actor: vendA,
      aggregateType: 'order',
      aggregateId: ORDER,
      payload: { outcome: 'confirmed' },
    });
    await event('DEPOSITO', '09:30', {
      type: 'portfolio.deposit.recorded',
      tenant: consA,
      actor: adminConsA,
    });
    await event('CREDENCIAL', '09:40', {
      type: 'ProviderCredentialsUpdated',
      tenant: agA,
      actor: adminConsA,
      payload: {
        providerCode: 'tbo-hotels',
        apiKey: 'sk_live_123',
        nested: { password: 'secreto', ok: 1 },
      },
    });
    await event('VISIBILIDAD', '09:50', {
      type: 'tenant.provider_disclosure.updated',
      tenant: consA,
      actor: adminConsA,
    });
    await event('SUSPENSION_B', '10:00', {
      type: 'tenant.updated',
      tenant: agB,
      actor: superadmin,
      aggregateType: 'tenant',
      aggregateId: agB,
      payload: { changed: ['status'], after: { status: 'suspended' } },
    });
    await event('BARRIDO', '10:10', {
      type: 'system.post_sale_sweep.completed',
      tenant: platform,
      actor: null,
      payload: { durationMs: 1200 },
    });
    await event('ANUNCIO', '10:20', {
      type: 'platform.announcement.published',
      tenant: platform,
      actor: superadmin,
    });
    // Tres en el mismo instante: el cursor no puede saltarlos ni repetirlos.
    for (const n of [1, 2, 3]) {
      await event(`ROL_${n}`, '10:30', {
        type: 'MembershipRoleChanged',
        tenant: agA,
        actor: adminConsA,
        payload: { targetUserId: vendA, previousRole: 'vendedor', newRole: 'admin' },
      });
    }
  });

  afterAll(async () => {
    const users = [superadmin, adminConsA, vendA].filter(Boolean);
    await pool.query(
      `DELETE FROM domain_events
        WHERE id = ANY($1::uuid[]) OR actor_user_id = ANY($2::uuid[])`,
      [Object.values(ev), users],
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`aud-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  const ROLES = ['ROL_1', 'ROL_2', 'ROL_3'];

  it('el superadmin ve todas las redes y los eventos sin nodo; "Todo" sin los system.*', async () => {
    const all = await seen();
    expect(new Set(all)).toEqual(
      new Set([
        'LOGIN_FALLIDO',
        'RETENCION',
        'ORDEN',
        'DEPOSITO',
        'CREDENCIAL',
        'VISIBILIDAD',
        'SUSPENSION_B',
        'ANUNCIO',
        ...ROLES,
      ]),
    );
    expect(all).not.toContain('BARRIDO');
    // Del más nuevo al más viejo.
    expect(all.slice(0, 3).sort()).toEqual(ROLES);
    expect(all.at(-1)).toBe('LOGIN_FALLIDO');
  });

  it('includePlatform=false deja fuera los eventos sin nodo', async () => {
    const all = await seen({ includePlatform: 'false' });
    expect(all).not.toContain('LOGIN_FALLIDO');
    expect(all).not.toContain('RETENCION');
    expect(all).toContain('ANUNCIO');
  });

  it('"Sistema" trae el barrido y los anuncios; pedir justo el tipo del barrido también', async () => {
    expect(new Set(await seen({ category: 'system' }))).toEqual(new Set(['BARRIDO', 'ANUNCIO']));
    expect(await seen({ eventType: 'system.post_sale_sweep.completed' })).toEqual(['BARRIDO']);
  });

  it('cada categoría trae lo suyo', async () => {
    expect(await seen({ category: 'access' })).toEqual(['LOGIN_FALLIDO']);
    expect(new Set(await seen({ category: 'team' }))).toEqual(new Set(ROLES));
    // Qué proveedores ve un nodo es de Proveedores, no de Red.
    expect(await seen({ category: 'network' })).toEqual(['SUSPENSION_B']);
    expect(await seen({ category: 'wallets' })).toEqual(['DEPOSITO', 'RETENCION']);
    expect(await seen({ category: 'providers' })).toEqual(['VISIBILIDAD', 'CREDENCIAL']);
    expect(await seen({ category: 'orders' })).toEqual(['ORDEN']);
  });

  it('un nodo trae su subárbol y nunca otra red; con includePlatform, además lo sin nodo', async () => {
    const red = await seen({ tenantId: consA });
    expect(new Set(red)).toEqual(
      new Set(['ORDEN', 'DEPOSITO', 'CREDENCIAL', 'VISIBILIDAD', ...ROLES]),
    );
    expect(new Set(await seen({ tenantId: agA }))).toEqual(
      new Set(['ORDEN', 'CREDENCIAL', ...ROLES]),
    );
    expect(await seen({ tenantId: consB })).toEqual(['SUSPENSION_B']);
    const conPlataforma = await seen({ tenantId: consA, includePlatform: 'true' });
    expect(conPlataforma).toEqual(expect.arrayContaining(['LOGIN_FALLIDO', 'RETENCION']));
    expect(conPlataforma).not.toContain('SUSPENSION_B');
  });

  it('un nodo que no existe: 404', async () => {
    expect(await rejection(service.list(superadmin, query({ tenantId: randomUUID() })))).toBe(
      '404/PLATFORM_CONSOLE_SCOPE_NOT_FOUND',
    );
  });

  it('por quién actuó (sin distinguir mayúsculas); un correo que no es de nadie no trae nada', async () => {
    const email = `AUD-ADM-CA-${sfx}@TEST.LOCAL`;
    expect(new Set(await seen({ actorEmail: email }))).toEqual(
      new Set(['DEPOSITO', 'CREDENCIAL', 'VISIBILIDAD', ...ROLES]),
    );
    expect(await seen({ actorEmail: `nadie-${sfx}@test.local` })).toEqual([]);
  });

  it('por entidad y por tipo exacto', async () => {
    expect(await seen({ aggregateType: 'order', aggregateId: ORDER })).toEqual(['ORDEN']);
    expect(await seen({ aggregateType: 'tenant', aggregateId: consA })).toEqual(['RETENCION']);
    expect(await seen({ eventType: 'OrderCreated' })).toEqual(['ORDEN']);
  });

  it('la paginación no salta ni repite, tampoco los eventos del mismo instante', async () => {
    const full = await seen();
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page = await service.list(
        superadmin,
        query({ limit: '2', ...(cursor === null ? {} : { cursor }) }),
      );
      paged.push(...names(page.events));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(paged).toEqual(full);
  });

  it('el payload sin claves sensibles, el "a quién" y de meta nunca el id de la sesión', async () => {
    const { events } = await service.list(superadmin, query());
    const byName = new Map(names(events).map((n, i) => [n, events[i]!]));
    expect(byName.get('CREDENCIAL')?.payload).toEqual({
      providerCode: 'tbo-hotels',
      nested: { ok: 1 },
    });
    expect(byName.get('LOGIN_FALLIDO')).toMatchObject({
      tenantId: null,
      tenantName: null,
      actorEmail: null,
      meta: { ip: '190.0.0.1', userAgent: 'Mozilla/5.0', requestId: 'req-1' },
    });
    expect(byName.get('ROL_1')).toMatchObject({
      tenantName: `aud-aa-${sfx}`,
      actorEmail: `aud-adm-ca-${sfx}@test.local`,
      targetEmail: `aud-vend-aa-${sfx}@test.local`,
    });
    expect(JSON.stringify(events)).not.toMatch(/sessionId|ses-1|sk_live|secreto/);

    // La función tampoco lo devuelve: no sale de la base.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [superadmin]);
      const { rows } = await c.query<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM admin_audit_events($1::timestamptz, $2::timestamptz, NULL, NULL,
           'auth.login.failed', NULL, NULL, true, NULL, NULL, NULL, NULL, 10)`,
        [`${DAY}T00:00:00-05:00`, `${DAY}T23:59:59-05:00`],
      );
      expect(rows.map((r) => Object.keys(r.meta).sort())).toEqual([
        ['ip', 'requestId', 'userAgent'],
      ]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('quien no es superadmin: 403 por el servicio, 42501 directo, y PUBLIC no la ejecuta', async () => {
    expect(await rejection(service.list(adminConsA, query()))).toBe('403/SUPERADMIN_REQUIRED');
    expect(await rejection(service.list(vendA, query()))).toBe('403/SUPERADMIN_REQUIRED');

    const call = `SELECT * FROM admin_audit_events(now() - interval '1 day', now(), NULL, NULL, NULL,
                    NULL, NULL, true, NULL, NULL, NULL, NULL, 10)`;
    expect(await ensayo(adminConsA, call)).toBe('42501');
    expect(await ensayo(null, call)).toBe('42501');
    expect(await ensayo(superadmin, call)).toMatch(/^ok:/);

    const { rows } = await pool.query<{ can: boolean }>(
      `SELECT has_function_privilege('public',
         'admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer)',
         'EXECUTE') AS can`,
    );
    expect(rows[0]?.can).toBe(false);
  });

  it('la base rechaza un período sin acotar o un cursor a medias: 22023', async () => {
    const call = (from: string, to: string, before = 'NULL', beforeId = 'NULL') =>
      ensayo(
        superadmin,
        `SELECT * FROM admin_audit_events(${from}, ${to}, NULL, NULL, NULL, NULL, NULL, true,
           NULL, NULL, ${before}, ${beforeId}, 10)`,
      );
    expect(await call(`now() - interval '94 days'`, 'now()')).toBe('22023');
    expect(await call('NULL', 'now()')).toBe('22023');
    expect(await call('now()', `now() - interval '1 day'`)).toBe('22023');
    expect(await call(`now() - interval '1 day'`, 'now()', 'now()')).toBe('22023');
    expect(await call(`now() - interval '93 days'`, 'now()')).toMatch(/^ok:/);
  });

  it('exportar: el CSV de la vista y platform.audit.exported en la raíz, con filtros y filas', async () => {
    const out = await requestContextStorage.run(
      { userId: superadmin, ip: '10.1.2.3', requestId: `req-${sfx}` },
      () =>
        service.exportCsv(
          superadmin,
          AdminAuditExportQuerySchema.parse({ from: DAY, to: DAY, tenantId: consA }),
        ),
    );
    const lines = out.csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('\uFEFFfecha,evento,nodo,actor,entidad,id_entidad,ip');
    expect(lines).toHaveLength(1 + 7);
    expect(out).toMatchObject({ rows: 7, truncated: false });
    expect(lines.some((l) => l.includes(`OrderCreated,aud-aa-${sfx},aud-vend-aa-${sfx}`))).toBe(
      true,
    );
    expect(out.csv).not.toMatch(/sk_live|tbo-hotels|SUSPENSION|tenant\.updated/);

    const trail = await exportsBy(superadmin);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toEqual({
      tenant_id: platform,
      payload: {
        filters: {
          from: DAY,
          to: DAY,
          category: null,
          eventType: null,
          actorUserId: null,
          tenantId: consA,
          includePlatform: false,
          aggregateType: null,
          aggregateId: null,
        },
        rows: 7,
        truncated: false,
      },
    });

    // La exportación aparece en la Actividad, en "Sistema".
    const { events } = await service.list(
      superadmin,
      AdminAuditQuerySchema.parse({ category: 'system', actorEmail: `aud-root-${sfx}@test.local` }),
    );
    expect(events.map((e) => e.eventType)).toContain(PLATFORM_AUDIT_EXPORTED_EVENT);
  });

  it('exportar sin ser superadmin: 403 y ningún rastro', async () => {
    expect(
      await rejection(
        service.exportCsv(adminConsA, AdminAuditExportQuerySchema.parse({ from: DAY, to: DAY })),
      ),
    ).toBe('403/SUPERADMIN_REQUIRED');
    expect(await exportsBy(adminConsA)).toEqual([]);
  });
});
