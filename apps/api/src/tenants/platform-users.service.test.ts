import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  decodePlatformUsersCursor,
  encodePlatformUsersCursor,
  ListPlatformUsersQuerySchema,
  type ListPlatformUsersQuery,
} from './dto.js';
import { LastSuperadminError, UserNotFoundError } from './platform-users.errors.js';
import {
  directoryQuery,
  likePattern,
  pageSize,
  PlatformUsersService,
} from './platform-users.service.js';

/**
 * El directorio de usuarios de la plataforma con la base sustituida por lo que devolvería: qué se
 * consulta, cómo se arma una fila por persona con sus nodos y sesiones, y el cursor. Que el SQL
 * filtra y ordena como dice lo prueba platform-users.integration.test.ts contra Postgres.
 */

const ACTOR = '99999999-9999-4999-8999-999999999999';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAMI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NODO = '11111111-1111-4111-8111-111111111111';
const OTRO_NODO = '22222222-2222-4222-8222-222222222222';

function query(raw: Record<string, unknown> = {}): ListPlatformUsersQuery {
  return ListPlatformUsersQuerySchema.parse(raw);
}

function userRow(id: string, email: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    email,
    name: null,
    status: 'active',
    email_verified_at: new Date('2026-01-01T00:00:00Z'),
    mfa_enabled_at: null,
    last_login_at: null,
    created_at: new Date('2026-10-01T10:00:00.123Z'),
    locked_until: null,
    cursor_at: '2026-10-01T10:00:00.123456Z',
    ...patch,
  };
}

interface Script {
  users?: unknown[];
  memberships?: unknown[];
  stats?: unknown[];
  exists?: boolean;
  count?: string;
  superadmins?: { id: string }[];
}

function banco(script: Script = {}) {
  const k = scriptedKysely((q: CompiledQuery) => {
    if (q.sql.includes('platform_user_session_stats')) return script.stats ?? [];
    if (q.sql.includes('to_char(u.created_at')) return script.users ?? [];
    if (q.sql.includes('for update')) return script.superadmins ?? [];
    if (q.sql.includes('count(*)')) return [{ n: script.count ?? '0' }];
    if (q.sql.includes('from "memberships" as "m"')) return script.memberships ?? [];
    if (q.sql.includes('from "users"')) return script.exists === false ? [] : [{ id: ANA }];
    if (q.sql.includes('from "memberships"')) return script.superadmins ? [{ id: 'm-1' }] : [];
    return [];
  });
  const contexts: unknown[] = [];
  const db = {
    withRequestContext: <T>(ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>) => {
      contexts.push(ctx);
      return k.db.transaction().execute(fn);
    },
  };
  const service = new PlatformUsersService(db as unknown as DatabaseService);
  return { service, k, contexts };
}

describe('likePattern: la búsqueda se busca tal cual', () => {
  it('rodea el texto de comodines y escapa los de LIKE y la barra', () => {
    expect(likePattern('ana')).toBe('%ana%');
    expect(likePattern('50%_off')).toBe('%50\\%\\_off%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('directoryQuery: filtros, orden y una fila de más', () => {
  const { k } = banco();

  function compiled(raw: Record<string, unknown>) {
    return directoryQuery(k.db, query(raw)).compile();
  }

  it('sin filtros: altas más recientes primero, desempate por id, y pide una fila de más', () => {
    const c = compiled({});
    expect(c.sql).toContain('order by "u"."created_at" desc, "u"."id" desc');
    expect(c.sql).not.toContain(' where ');
    expect(c.parameters.at(-1)).toBe(pageSize({}) + 1);
  });

  it('la búsqueda va por correo y nombre, con el patrón escapado como parámetro', () => {
    const c = compiled({ q: '  50%_  ' });
    expect(c.sql).toContain('("u"."email" ilike $1 or "u"."name" ilike $2)');
    expect(c.parameters.slice(0, 2)).toEqual(['%50\\%\\_%', '%50\\%\\_%']);
  });

  it('rol y nodo en una sola membership del subárbol del nodo, sin las quitadas', () => {
    const c = compiled({ role: 'vendedor', tenantId: NODO });
    expect(c.sql).toContain('exists (select 1 as "one" from "memberships" as "m"');
    expect(c.sql).toContain('"m"."status" != $1 and "m"."role" = $2');
    expect(c.sql).toContain('t.path OPERATOR(public.<@) (SELECT root.path FROM tenants root');
    expect(c.parameters.slice(0, 3)).toEqual(['removed', 'vendedor', NODO]);
  });

  it('estado, 2FA, bloqueo, nunca ingresaron y el cursor', () => {
    const cursor = encodePlatformUsersCursor({ createdAt: '2026-10-01T10:00:00.123456Z', id: ANA });
    const c = compiled({
      status: 'suspended',
      mfa: 'off',
      locked: 'true',
      neverLoggedIn: 'true',
      cursor,
      limit: '10',
    });
    expect(c.sql).toContain('"u"."status" = $1');
    expect(c.sql).toContain('"u"."mfa_enabled_at" is null');
    expect(c.sql).toContain('u.locked_until > now()');
    expect(c.sql).toContain('"u"."last_login_at" is null');
    expect(c.sql).toContain('(u.created_at, u.id) < ($2::timestamptz, $3::uuid)');
    expect(c.parameters).toEqual(['suspended', '2026-10-01T10:00:00.123456Z', ANA, 11]);
  });

  it('con 2FA: el que lo tiene activo', () => {
    expect(compiled({ mfa: 'on' }).sql).toContain('"u"."mfa_enabled_at" is not null');
  });
});

describe('PlatformUsersService.list', () => {
  it('una fila por persona con todos sus nodos y sus sesiones; quien no tiene nodos también', async () => {
    const { service, contexts, k } = banco({
      users: [
        userRow(ANA, 'ana@agencia.co', {
          name: 'Ana Pérez',
          mfa_enabled_at: new Date('2026-02-01T00:00:00Z'),
          last_login_at: new Date('2026-10-10T08:00:00Z'),
          locked_until: new Date('2026-10-11T15:00:00Z'),
        }),
        userRow(BETO, 'beto@agencia.co', { email_verified_at: null, status: 'suspended' }),
      ],
      memberships: [
        {
          user_id: ANA,
          tenant_id: NODO,
          tenant_name: 'Agencia Norte',
          tenant_type: 'agency',
          is_branch: false,
          role: 'vendedor',
          status: 'active',
        },
        {
          user_id: ANA,
          tenant_id: OTRO_NODO,
          tenant_name: 'Sucursal Centro',
          tenant_type: 'agency',
          is_branch: true,
          role: 'admin',
          status: 'suspended',
        },
      ],
      stats: [
        { user_id: ANA, last_seen_at: new Date('2026-10-11T09:30:00Z'), active_sessions: '2' },
      ],
    });

    const page = await service.list(ACTOR, query());

    expect(contexts).toEqual([{ userId: ACTOR }]);
    expect(page.nextCursor).toBeNull();
    expect(page.users).toEqual([
      {
        id: ANA,
        email: 'ana@agencia.co',
        name: 'Ana Pérez',
        status: 'active',
        emailVerified: true,
        mfaEnabled: true,
        lockedUntil: '2026-10-11T15:00:00.000Z',
        lastLoginAt: '2026-10-10T08:00:00.000Z',
        lastSeenAt: '2026-10-11T09:30:00.000Z',
        activeSessions: 2,
        createdAt: '2026-10-01T10:00:00.123Z',
        memberships: [
          {
            tenantId: NODO,
            tenantName: 'Agencia Norte',
            tenantType: 'agency',
            isBranch: false,
            role: 'vendedor',
            status: 'active',
          },
          {
            tenantId: OTRO_NODO,
            tenantName: 'Sucursal Centro',
            tenantType: 'agency',
            isBranch: true,
            role: 'admin',
            status: 'suspended',
          },
        ],
      },
      {
        id: BETO,
        email: 'beto@agencia.co',
        name: null,
        status: 'suspended',
        emailVerified: false,
        mfaEnabled: false,
        lockedUntil: null,
        lastLoginAt: null,
        lastSeenAt: null,
        activeSessions: 0,
        createdAt: '2026-10-01T10:00:00.123Z',
        memberships: [],
      },
    ]);

    // Los nodos y las sesiones se piden sólo para los de la página.
    const nodos = k.queries[k.indexOf('from "memberships" as "m"')]!;
    // Sin los nodos de los que la quitaron (USR-11). Los ids van en un solo arreglo.
    expect(nodos.sql).toContain('m.user_id = ANY($1::uuid[])');
    expect(nodos.sql).toContain('"m"."status" != $2');
    expect(nodos.parameters).toEqual([[ANA, BETO], 'removed']);
    const sesiones = k.queries[k.indexOf('platform_user_session_stats')]!;
    expect(sesiones.parameters).toEqual([[ANA, BETO]]);
  });

  it('la fila de más da el cursor de la última de la página, que la siguiente consulta usa tal cual', async () => {
    const first = banco({
      users: [
        userRow(ANA, 'ana@agencia.co', { cursor_at: '2026-10-03T00:00:00.000003Z' }),
        userRow(BETO, 'beto@agencia.co', { cursor_at: '2026-10-02T00:00:00.000002Z' }),
        userRow(CAMI, 'cami@agencia.co', { cursor_at: '2026-10-01T00:00:00.000001Z' }),
      ],
    });

    const page = await first.service.list(ACTOR, query({ limit: '2' }));

    expect(page.users.map((u) => u.id)).toEqual([ANA, BETO]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodePlatformUsersCursor(page.nextCursor!)).toEqual({
      createdAt: '2026-10-02T00:00:00.000002Z',
      id: BETO,
    });

    const next = directoryQuery(
      first.k.db,
      query({ limit: '2', cursor: page.nextCursor }),
    ).compile();
    expect(next.parameters).toEqual(['2026-10-02T00:00:00.000002Z', BETO, 3]);
  });

  it('una página vacía no pregunta por nodos ni sesiones', async () => {
    const { service, k } = banco({ users: [] });

    await expect(service.list(ACTOR, query({ q: 'nadie' }))).resolves.toEqual({
      users: [],
      nextCursor: null,
    });
    expect(k.indexOf('platform_user_session_stats')).toBe(-1);
    expect(k.indexOf('from "memberships"')).toBe(-1);
  });
});

describe('PlatformUsersService.footprint', () => {
  it('accesos activos y sesiones vivas de la cuenta', async () => {
    const { service, k, contexts } = banco({
      count: '3',
      stats: [{ user_id: ANA, last_seen_at: null, active_sessions: 2 }],
    });

    await expect(service.footprint(ACTOR, ANA)).resolves.toEqual({
      activeMemberships: 3,
      liveSessions: 2,
    });
    expect(contexts).toEqual([{ userId: ACTOR }]);
    expect(k.queries[k.indexOf('platform_user_session_stats')]!.parameters).toEqual([[ANA]]);
  });

  it('sin sesiones, cero', async () => {
    const { service } = banco({ count: '1' });
    await expect(service.footprint(ACTOR, ANA)).resolves.toEqual({
      activeMemberships: 1,
      liveSessions: 0,
    });
  });

  it('una cuenta que no existe: 404 sin contar nada', async () => {
    const { service, k } = banco({ exists: false });
    await expect(service.footprint(ACTOR, ANA)).rejects.toBeInstanceOf(UserNotFoundError);
    expect(k.indexOf('count(*)')).toBe(-1);
  });
});

describe('PlatformUsersService.assertNotLastSuperadmin', () => {
  async function check(script: Script, target = ANA) {
    const { service, k } = banco(script);
    await k.db.transaction().execute((trx) => service.assertNotLastSuperadmin(trx, target));
    return k;
  }

  it('quien no es superadmin no bloquea ni cuenta nada', async () => {
    const k = await check({});
    expect(k.indexOf('for update')).toBe(-1);
  });

  it('con otro superadmin activo, pasa; bloquea las filas en orden de id', async () => {
    const k = await check({ superadmins: [{ id: ANA }, { id: BETO }] });
    const lock = k.queries[k.indexOf('for update')]!;
    expect(lock.sql).toContain('order by "u"."id" for update');
    expect(lock.sql).toContain('"m"."role" = $');
  });

  it('si es el único superadmin activo: 409', async () => {
    await expect(check({ superadmins: [{ id: ANA }] })).rejects.toBeInstanceOf(LastSuperadminError);
  });

  it('si ya no queda ninguno activo (el otro lo suspendió primero): 409', async () => {
    await expect(check({ superadmins: [] })).rejects.toBeInstanceOf(LastSuperadminError);
  });
});
