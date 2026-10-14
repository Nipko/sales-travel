import { randomBytes } from 'node:crypto';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { MfaRecentRequiredError } from '../auth/auth-errors.js';
import { RecentMfaGuard } from '../auth/guards/recent-mfa.guard.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { ListPlatformUsersQuerySchema, PlatformUsersExportQuerySchema } from './dto.js';
import { PlatformUsersService } from './platform-users.service.js';
import { UserExportController } from './user-export.controller.js';
import { UserExportService, USERS_EXPORTED_EVENT } from './user-export.service.js';

/**
 * La exportación de usuarios a CSV (USR-16) contra Postgres:
 *
 *   - el CSV del directorio trae exactamente a las personas que la pantalla muestra con los mismos
 *     filtros (búsqueda, estado, rol, nodo con su subárbol, 2FA, bloqueo, nunca ingresaron), con los
 *     mismos nodos, y nunca un nodo del que se quitó a alguien;
 *   - el del equipo de un nodo es la lista de Equipo, para quien administra el nodo;
 *   - quien no es superadmin no exporta el directorio y un admin no exporta un nodo fuera de su
 *     subárbol: 403 sin rastro;
 *   - las dos rutas piden el 2FA de los últimos 10 minutos, medido con el reloj de la base;
 *   - el rastro `users.exported` va en la transacción de la lectura: si no se escribe, no hay
 *     archivo ni rastro a medias;
 *   - un nombre o un nodo que una planilla tomaría por fórmula sale neutralizado.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Cuelga de la raíz `platform` compartida y cada exportación del directorio busca el sufijo del test.
 * Se SALTA sin PGHOST.
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

/** Escribe el rastro y después falla: si va en la transacción de la lectura, se deshace con ella. */
class RastroQueFalla extends AuditService {
  override async emitWithin(trx: Transaction<DB>, event: AuditEvent): Promise<void> {
    await super.emitWithin(trx, event);
    throw new Error('el rastro no terminó de escribirse');
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

/** Un CSV (RFC 4180, con BOM y CRLF) en filas de celdas. */
function parseCsv(text: string): string[][] {
  expect(text.startsWith('﻿')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.slice(1);
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += c;
    }
  }
  expect(cell).toBe('');
  expect(row).toEqual([]);
  return rows;
}

d('exportar usuarios a CSV, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const platformUsers = new PlatformUsersService(database);
  const exports = new UserExportService(database, audit);
  const controller = new UserExportController(exports, network);
  const sessions = new SessionService(database, audit);

  let platform: string;
  let consNorte: string;
  let agenciaNorte: string;
  let subNorte: string;
  let consSur: string;
  let agenciaSur: string;

  let root: string;
  let adminNorte: string;
  let ana: string;

  const slug = (label: string) => `ux-${label}-${sfx}`;
  const email = (label: string) => `ux-${label}-${sfx}@test.local`;

  async function tenant(
    label: string,
    type: TenantType,
    parent: string,
    name = `Nodo ${label}`,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), name, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(
    label: string,
    patch: {
      name?: string;
      status?: string;
      mfa?: boolean;
      lastLogin?: boolean;
      lockedMinutes?: number;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status, mfa_enabled_at, last_login_at,
                          locked_until, email_verified_at)
       VALUES ($1, 'hash-que-no-sale', $2, $3,
               CASE WHEN $4 THEN now() END,
               CASE WHEN $5 THEN now() - interval '1 day' END,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(mins => $6::int) END,
               now())
       RETURNING id`,
      [
        email(label),
        patch.name ?? null,
        patch.status ?? 'active',
        patch.mfa ?? false,
        patch.lastLogin ?? false,
        patch.lockedMinutes ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: Role, status = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, removed_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'removed' THEN now() END)`,
      [tenantId, userId, role, status],
    );
  }

  /** Lo que devuelve la ruta: el CSV, y las cabeceras que vio el panel. */
  async function exportDirectory(raw: Record<string, unknown> = {}, actor = root) {
    const headers = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => headers.set(k, v) };
    const csv = await controller.exportPlatform(
      actor,
      PlatformUsersExportQuerySchema.parse({ q: sfx, ...raw }),
      res as never,
    );
    return { rows: parseCsv(csv), headers };
  }

  async function exportNode(tenantId: string, actor: string) {
    const res = { setHeader: () => undefined };
    return parseCsv(await controller.exportTeam(actor, tenantId, res as never));
  }

  /** Correo → sus nodos, en el orden del archivo. "Sin nodos" es ninguno. */
  function nodesByEmail(rows: string[][]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of rows.slice(1)) {
      const list = out.get(r[0]!) ?? [];
      if (r[2] !== 'Sin nodos') list.push(r[2]!);
      out.set(r[0]!, list);
    }
    return out;
  }

  /** Lo mismo, de la pantalla: el directorio con esos filtros, todo en una página. */
  async function screen(raw: Record<string, unknown> = {}): Promise<Map<string, string[]>> {
    const page = await platformUsers.list(
      root,
      ListPlatformUsersQuerySchema.parse({ q: sfx, limit: '100', ...raw }),
    );
    expect(page.nextCursor).toBeNull();
    return new Map(page.users.map((u) => [u.email, u.memberships.map((m) => m.tenantName)]));
  }

  async function exportsOf(
    actor: string,
  ): Promise<{ tenant_id: string | null; payload: unknown }[]> {
    const { rows } = await pool.query<{ tenant_id: string | null; payload: unknown }>(
      `SELECT tenant_id, payload FROM domain_events
        WHERE event_type = $1 AND actor_user_id = $2
        ORDER BY occurred_at, id`,
      [USERS_EXPORTED_EVENT, actor],
    );
    return rows;
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    consNorte = await tenant('cons-norte', 'consolidator', platform);
    agenciaNorte = await tenant('agencia-norte', 'agency', consNorte);
    subNorte = await tenant('sub-norte', 'subagency', agenciaNorte);
    consSur = await tenant('cons-sur', 'consolidator', platform);
    // Un nombre de nodo que una planilla tomaría por fórmula.
    agenciaSur = await tenant('agencia-sur', 'agency', consSur, '=cmd|"/C calc"!A0');

    root = await user('root', { name: 'Root', mfa: true, lastLogin: true });
    await member(platform, root, 'superadmin');
    adminNorte = await user('admin-norte', { mfa: true, lastLogin: true });
    await member(consNorte, adminNorte, 'consolidator_admin');

    ana = await user('ana', { name: 'Ana Pérez', mfa: true, lastLogin: true, lockedMinutes: 30 });
    await member(agenciaNorte, ana, 'vendedor');
    await member(agenciaSur, ana, 'admin', 'suspended');
    const beto = await user('beto', { name: '=HYPERLINK("http://evil.test","clic")' });
    await member(agenciaSur, beto, 'vendedor');
    const cami = await user('cami', { name: '+cami', lastLogin: true });
    await member(subNorte, cami, 'vendedor');
    // Quitada del norte (USR-11): sigue en el sur.
    const quitada = await user('quitada', { name: '-quitada', lastLogin: true });
    await member(agenciaNorte, quitada, 'vendedor', 'removed');
    await member(agenciaSur, quitada, 'vendedor');
    // Quitada de su único nodo: el directorio la muestra sin nodos.
    const soloQuitada = await user('solo-quitada', { name: '@solo' });
    await member(agenciaNorte, soloQuitada, 'admin', 'removed');
    await user('sin-nodos');
    const suspendido = await user('suspendido', { status: 'suspended', lastLogin: true });
    await member(agenciaNorte, suspendido, 'admin');
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`ux-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('el directorio: lo mismo que la pantalla con los mismos filtros', () => {
    it.each([
      ['sin filtros', {}],
      ['suspendidos', { status: 'suspended' }],
      ['activos', { status: 'active' }],
      ['vendedores', { role: 'vendedor' }],
      ['admins', { role: 'admin' }],
      ['el subárbol del norte', { tenantId: 'consNorte' }],
      ['vendedores del sur', { role: 'vendedor', tenantId: 'consSur' }],
      ['admins de la agencia del norte', { role: 'admin', tenantId: 'agenciaNorte' }],
      ['sin 2FA', { mfa: 'off' }],
      ['con 2FA', { mfa: 'on' }],
      ['bloqueados', { locked: 'true' }],
      ['nunca ingresaron', { neverLoggedIn: 'true' }],
    ])('%s', async (_label, raw: Record<string, string>) => {
      const ids: Record<string, string> = { consNorte, consSur, agenciaNorte };
      const filters = {
        ...raw,
        ...(raw['tenantId'] === undefined ? {} : { tenantId: ids[raw['tenantId']] }),
      };
      const shown = await screen(filters);
      const { rows } = await exportDirectory(filters);
      const exported = nodesByEmail(rows);
      // Las mismas personas, en el mismo orden, con los mismos nodos.
      expect([...exported.keys()]).toEqual([...shown.keys()]);
      for (const [mail, nodes] of shown) {
        expect(exported.get(mail)?.map((n) => n.replace(/^'/, ''))).toEqual(nodes);
      }
    });

    it('sin filtros trae a todos, también a quien no tiene nodos; nunca el nodo del que se quitó a alguien', async () => {
      const { rows, headers } = await exportDirectory();
      const exported = nodesByEmail(rows);
      expect(exported.size).toBe(9);
      expect(exported.get(email('sin-nodos'))).toEqual([]);
      expect(exported.get(email('solo-quitada'))).toEqual([]);
      expect(exported.get(email('quitada'))).toEqual(['\'=cmd|"/C calc"!A0']);
      // Ana: primero el acceso activo, después el suspendido.
      expect(rows.filter((r) => r[0] === email('ana')).map((r) => [r[2], r[3], r[4]])).toEqual([
        ['Nodo agencia-norte', 'Vendedor', 'Activo'],
        ['\'=cmd|"/C calc"!A0', 'Manager', 'Suspendido'],
      ]);
      expect(headers.get('X-Export-Users')).toBe('9');
      expect(headers.get('X-Export-Rows')).toBe(String(rows.length - 1));
      expect(headers.get('X-Export-Truncated')).toBe('false');
    });

    it('filtrar por el nodo del que se quitó a alguien no la trae', async () => {
      const exported = nodesByEmail((await exportDirectory({ tenantId: agenciaNorte })).rows);
      expect(exported.has(email('quitada'))).toBe(false);
      expect(exported.has(email('solo-quitada'))).toBe(false);
      expect([...exported.keys()].sort()).toEqual(
        [email('ana'), email('cami'), email('suspendido')].sort(),
      );
    });

    it('columnas mínimas: sin hashes, IPs ni sesiones; fechas de Bogotá', async () => {
      const { rows } = await exportDirectory();
      expect(rows[0]).toEqual([
        'Correo',
        'Nombre',
        'Nodo',
        'Rol',
        'Estado en el nodo',
        'Estado de la cuenta',
        '2FA',
        'Último ingreso (hora de Bogotá UTC-5)',
        'Alta de la cuenta (hora de Bogotá UTC-5)',
      ]);
      const all = JSON.stringify(rows);
      expect(all).not.toContain('hash-que-no-sale');
      const filaAna = rows.find((r) => r[0] === email('ana'))!;
      expect(filaAna[5]).toBe('Activa');
      expect(filaAna[6]).toBe('Sí');
      expect(filaAna[7]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      const { rows: when } = await pool.query<{ local: string }>(
        `SELECT to_char(last_login_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS local
           FROM users WHERE id = $1`,
        [ana],
      );
      expect(filaAna[7]).toBe(when[0]!.local);
      expect(rows.find((r) => r[0] === email('suspendido'))![5]).toBe('Suspendida');
      expect(rows.find((r) => r[0] === email('beto'))![7]).toBe('');
    });

    it('lo que una planilla tomaría por fórmula sale con el apóstrofo', async () => {
      const { rows } = await exportDirectory();
      expect(rows.find((r) => r[0] === email('beto'))![1]).toBe(
        `'=HYPERLINK("http://evil.test","clic")`,
      );
      expect(rows.find((r) => r[0] === email('cami'))![1]).toBe("'+cami");
      expect(rows.find((r) => r[0] === email('quitada'))![1]).toBe("'-quitada");
      expect(rows.find((r) => r[0] === email('solo-quitada'))![1]).toBe("'@solo");
      for (const r of rows.slice(1)) {
        for (const c of r) expect(c).not.toMatch(/^[=+\-@\t\r]/);
      }
    });

    it('quien no es superadmin recibe 403 y no queda rastro; el superadmin sí deja el suyo', async () => {
      expect(await rejection(exportDirectory({}, adminNorte))).toBe('403/SUPERADMIN_REQUIRED');
      expect(await rejection(exportDirectory({}, ana))).toBe('403/SUPERADMIN_REQUIRED');
      expect(await exportsOf(adminNorte)).toEqual([]);
      expect(await exportsOf(ana)).toEqual([]);

      const before = (await exportsOf(root)).length;
      await exportDirectory({ role: 'vendedor', mfa: 'off' });
      const trail = await exportsOf(root);
      expect(trail).toHaveLength(before + 1);
      expect(trail.at(-1)).toEqual({
        tenant_id: platform,
        payload: {
          scope: 'platform',
          filters: {
            search: true,
            status: null,
            role: 'vendedor',
            tenantId: null,
            mfa: 'off',
            locked: false,
            neverLoggedIn: false,
          },
          users: 3,
          rows: 3,
          truncated: false,
        },
      });
      expect(JSON.stringify(trail)).not.toContain('@');
    });
  });

  describe('el equipo de un nodo: lo mismo que Equipo, para quien lo administra', () => {
    it('el admin del consolidador exporta una agencia de su red: la lista de Equipo, sin quitados', async () => {
      const team = await network.listTenantUsers(adminNorte, agenciaNorte);
      const rows = await exportNode(agenciaNorte, adminNorte);
      expect(rows[0]!.at(-1)).toBe('Alta en el nodo (hora de Bogotá UTC-5)');
      expect(rows.slice(1).map((r) => r[0])).toEqual(team.map((m) => m.email));
      expect(rows.slice(1).map((r) => r[0])).toEqual([email('ana'), email('suspendido')]);
      expect(rows.slice(1).every((r) => r[2] === 'Nodo agencia-norte')).toBe(true);

      const trail = await exportsOf(adminNorte);
      expect(trail.at(-1)).toEqual({
        tenant_id: agenciaNorte,
        payload: {
          scope: 'node',
          filters: { tenantId: agenciaNorte },
          users: 2,
          rows: 2,
          truncated: false,
        },
      });
    });

    it('un nodo fuera de su subárbol, o sin ser admin: 403 sin rastro', async () => {
      const before = (await exportsOf(adminNorte)).length;
      expect(await rejection(exportNode(agenciaSur, adminNorte))).toBe('403/TENANT_NOT_MANAGED');
      expect(await rejection(exportNode(consSur, adminNorte))).toBe('403/TENANT_NOT_MANAGED');
      expect(await rejection(exportNode(agenciaNorte, ana))).toBe('403/TENANT_NOT_MANAGED');
      expect(await exportsOf(adminNorte)).toHaveLength(before);
      expect(await exportsOf(ana)).toEqual([]);
    });

    it('el superadmin exporta cualquier nodo; el nombre hostil del nodo sale neutralizado', async () => {
      const rows = await exportNode(agenciaSur, root);
      expect(rows.slice(1).map((r) => r[0])).toEqual([
        email('ana'),
        email('beto'),
        email('quitada'),
      ]);
      expect(rows.slice(1).every((r) => r[2] === `'=cmd|"/C calc"!A0`)).toBe(true);
      expect(rows.find((r) => r[0] === email('ana'))!.slice(3, 5)).toEqual([
        'Manager',
        'Suspendido',
      ]);
    });
  });

  describe('el rastro va en la transacción de la lectura', () => {
    it('si el rastro falla, no hay archivo ni rastro a medias', async () => {
      const broken = new UserExportController(
        new UserExportService(database, new RastroQueFalla(database)),
        network,
      );
      const res = { setHeader: () => undefined } as never;
      const before = (await exportsOf(root)).length;
      await expect(
        broken.exportPlatform(root, PlatformUsersExportQuerySchema.parse({ q: sfx }), res),
      ).rejects.toThrow('el rastro no terminó de escribirse');
      await expect(broken.exportTeam(root, agenciaNorte, res)).rejects.toThrow(
        'el rastro no terminó de escribirse',
      );
      // El INSERT del rastro corrió y se deshizo con la lectura.
      expect(await exportsOf(root)).toHaveLength(before);
    });
  });

  describe('el 2FA de los últimos 10 minutos, con el reloj de la base', () => {
    const guard = new RecentMfaGuard(new Reflector());
    const proto = UserExportController.prototype as unknown as Record<
      'exportPlatform' | 'exportTeam',
      (...args: never[]) => unknown
    >;

    async function contextOf(minutesAgo: number): Promise<RequestContext> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, tenant_id, expires_at, last_seen_at, mfa_verified_at)
         VALUES ($1, $2, now() + interval '8 hours', now(), now() - make_interval(mins => $3))
         RETURNING id`,
        [root, platform, minutesAgo],
      );
      const v = await sessions.validate({
        sessionId: rows[0]!.id,
        userId: root,
        tenantId: platform,
      });
      if (!v.ok) throw new Error(`sesión inválida: ${v.reason}`);
      return {
        userId: root,
        role: v.role,
        mfaRequired: v.mfaRequired,
        mfaEnabled: v.mfaEnabled,
        mfaVerified: v.mfaVerified,
        ...(v.mfaVerifiedAt ? { mfaVerifiedAt: v.mfaVerifiedAt } : {}),
      };
    }

    function check(ctx: RequestContext, handler: (...args: never[]) => unknown): unknown {
      return requestContextStorage.run(ctx, () => {
        try {
          return guard.canActivate({
            getHandler: () => handler,
            getClass: () => UserExportController,
          } as unknown as ExecutionContext);
        } catch (err) {
          return err;
        }
      });
    }

    it('con el código de hace 30 minutos se pide de nuevo; con el de hace 2, pasa', async () => {
      const stale = await contextOf(30);
      const fresh = await contextOf(2);
      for (const handler of [proto.exportPlatform, proto.exportTeam]) {
        expect(check(stale, handler)).toBeInstanceOf(MfaRecentRequiredError);
        expect(check(fresh, handler)).toBe(true);
      }
    });
  });
});
