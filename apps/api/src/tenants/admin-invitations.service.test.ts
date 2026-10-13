import type { HttpException } from '@nestjs/common';
import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import {
  AdminInvitationsService,
  invitationCountsQuery,
  invitationsPageSize,
  invitationsQuery,
  invitationState,
} from './admin-invitations.service.js';
import {
  decodePlatformUsersCursor,
  encodePlatformUsersCursor,
  ListPlatformInvitationsQuerySchema,
  PLATFORM_INVITATIONS_PAGE_SIZE,
  type ListPlatformInvitationsQuery,
} from './dto.js';
import { SuperadminOnlyError } from './member-detail.errors.js';

/**
 * Las invitaciones sin aceptar de toda la red con la base sustituida por lo que devolvería: el borde
 * (qué acepta la consulta), qué se consulta por cada estado y filtro, el cursor, cómo sale cada fila
 * y que quien no es superadmin no llega a leer nada. Que el SQL filtra, cuenta y pagina como dice, y
 * que la RLS lo deja leer al superadmin y a nadie más, lo prueba
 * admin-invitations.integration.test.ts contra Postgres.
 */

const ACTOR = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const OTRO_NODO = '22222222-2222-4222-8222-222222222222';
const INV_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INV_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function query(raw: Record<string, unknown> = {}): ListPlatformInvitationsQuery {
  return ListPlatformInvitationsQuerySchema.parse(raw);
}

function row(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id.slice(0, 4)}@agencia.co`,
    role: 'vendedor',
    tenant_id: NODO,
    tenant_name: 'Agencia Norte',
    invited_by_email: 'root@plataforma.co',
    created_at: new Date('2026-10-01T10:00:00.123Z'),
    expires_at: new Date('2026-10-08T10:00:00.123Z'),
    expired: false,
    cursor_at: '2026-10-01T10:00:00.123456Z',
    ...patch,
  };
}

interface Script {
  superadmin?: boolean;
  rows?: unknown[];
  counts?: { pending: string; expired: string } | null;
}

function banco(script: Script = {}) {
  const k = scriptedKysely((q: CompiledQuery) => {
    if (q.sql.includes('count(*) FILTER')) {
      return script.counts === null ? [] : [script.counts ?? { pending: '0', expired: '0' }];
    }
    if (q.sql.includes('from "user_invitations"')) return script.rows ?? [];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const contexts: unknown[] = [];
  const db = {
    withRequestContext: <T>(ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>) => {
      contexts.push(ctx);
      return k.db.transaction().execute(fn);
    },
  };
  const isSuperadmin = vi.fn(() => Promise.resolve(script.superadmin ?? true));
  const network = { isSuperadmin } as unknown as NetworkService;
  const service = new AdminInvitationsService(db as unknown as DatabaseService, network);
  return { service, k, contexts, isSuperadmin };
}

describe('ListPlatformInvitationsQuerySchema: el borde de GET /admin/invitations', () => {
  it('sin nada es válida: el estado lo completa el servicio', () => {
    expect(query()).toEqual({});
    expect(invitationState(query())).toBe('pending');
    expect(invitationsPageSize(query())).toBe(PLATFORM_INVITATIONS_PAGE_SIZE);
  });

  it('acepta los tres estados, la búsqueda recortada, el nodo en minúsculas y el límite en texto', () => {
    const parsed = query({
      state: 'expired',
      q: '  ana@  ',
      tenantId: NODO.toUpperCase(),
      limit: '20',
    });
    expect(parsed).toEqual({ state: 'expired', q: 'ana@', tenantId: NODO, limit: 20 });
    expect(query({ state: 'all' }).state).toBe('all');
    expect(query({ state: 'pending' }).state).toBe('pending');
  });

  it.each([
    ['un parámetro de más', { role: 'vendedor' }],
    ['un estado que no existe', { state: 'accepted' }],
    ['una búsqueda vacía', { q: '   ' }],
    ['una búsqueda con NUL', { q: 'a\u0000b' }],
    ['una búsqueda de más de 100', { q: 'x'.repeat(101) }],
    ['un nodo que no es UUID', { tenantId: 'norte' }],
    ['un cursor que no emitió la lista', { cursor: 'no-es-un-cursor' }],
    ['un límite fuera de rango', { limit: '0' }],
    ['un límite de más de 100', { limit: '101' }],
  ])('rechaza %s', (_label, raw) => {
    expect(ListPlatformInvitationsQuerySchema.safeParse(raw).success).toBe(false);
  });

  it('acepta el cursor que emite la lista', () => {
    const cursor = encodePlatformUsersCursor({
      createdAt: '2026-10-01T10:00:00.123456Z',
      id: INV_1,
    });
    expect(query({ cursor }).cursor).toBe(cursor);
  });
});

describe('invitationsQuery: estados, filtros, orden y una fila de más', () => {
  const { k } = banco();

  function compiled(raw: Record<string, unknown>) {
    return invitationsQuery(k.db, query(raw)).compile();
  }

  it('sólo las que no se aceptaron ni se revocaron, con su nodo y quién la mandó, sin el token', () => {
    const c = compiled({});
    expect(c.sql).toContain('"i"."accepted_at" is null');
    expect(c.sql).toContain('"i"."revoked_at" is null');
    expect(c.sql).toContain('inner join "tenants" as "t" on "t"."id" = "i"."tenant_id"');
    expect(c.sql).toContain('left join "users" as "u" on "u"."id" = "i"."invited_by"');
    expect(c.sql).not.toContain('token_hash');
  });

  it('sin estado son las pendientes: las que vencen después de ahora', () => {
    const c = compiled({});
    expect(c.sql).toContain('i.expires_at > now()');
    expect(c.sql).not.toContain('where i.expires_at <= now()');
    expect(c.sql).not.toContain('and i.expires_at <= now()');
  });

  it('vencidas: las que vencen ahora o antes, el mismo corte que el canje', () => {
    const c = compiled({ state: 'expired' });
    expect(c.sql).toContain('and i.expires_at <= now()');
    expect(c.sql).not.toContain('i.expires_at > now()');
  });

  it('todas: sin corte por vencimiento', () => {
    const c = compiled({ state: 'all' });
    expect(c.sql).not.toContain('i.expires_at > now()');
    expect(c.sql).not.toContain('and i.expires_at <= now()');
    // La marca de vencida sale en cada fila.
    expect(c.sql).toContain('i.expires_at <= now() as "expired"');
  });

  it('las más recientes primero, desempate por id, y pide una fila de más', () => {
    const c = compiled({});
    expect(c.sql).toContain('order by "i"."created_at" desc, "i"."id" desc');
    expect(c.parameters.at(-1)).toBe(PLATFORM_INVITATIONS_PAGE_SIZE + 1);
    expect(compiled({ limit: 10 }).parameters.at(-1)).toBe(11);
  });

  it('la búsqueda va por correo con el patrón escapado, y el nodo con su subárbol', () => {
    const c = compiled({ q: '50%_', tenantId: NODO });
    expect(c.sql).toContain('"i"."email" ilike $1');
    expect(c.sql).toContain('t.path OPERATOR(public.<@) (SELECT root.path FROM tenants root');
    expect(c.parameters.slice(0, 2)).toEqual(['%50\\%\\_%', NODO]);
  });

  it('el cursor sigue después de la última fila, con el instante en microsegundos', () => {
    const cursor = encodePlatformUsersCursor({
      createdAt: '2026-10-01T10:00:00.123456Z',
      id: INV_1,
    });
    const c = compiled({ cursor });
    expect(c.sql).toContain('(i.created_at, i.id) < ($1::timestamptz, $2::uuid)');
    expect(c.parameters.slice(0, 2)).toEqual(['2026-10-01T10:00:00.123456Z', INV_1]);
    expect(c.sql).toContain(`to_char(i.created_at AT TIME ZONE 'UTC'`);
  });
});

describe('invitationCountsQuery: pendientes y vencidas del mismo alcance', () => {
  const { k } = banco();

  it('cuenta las dos con la búsqueda y el nodo, sin el estado, el cursor ni el límite', () => {
    const cursor = encodePlatformUsersCursor({
      createdAt: '2026-10-01T10:00:00.123456Z',
      id: INV_1,
    });
    const c = invitationCountsQuery(
      k.db,
      query({ state: 'expired', q: 'ana', tenantId: OTRO_NODO, cursor, limit: 5 }),
    ).compile();
    expect(c.sql).toContain('count(*) FILTER (WHERE i.expires_at > now()) as "pending"');
    expect(c.sql).toContain('count(*) FILTER (WHERE i.expires_at <= now()) as "expired"');
    expect(c.sql).toContain('"i"."accepted_at" is null');
    expect(c.sql).toContain('"i"."revoked_at" is null');
    expect(c.sql).not.toContain('(i.created_at, i.id) <');
    expect(c.sql).not.toContain('limit');
    expect(c.sql).not.toContain('and i.expires_at');
    expect(c.parameters).toEqual(['%ana%', OTRO_NODO]);
  });
});

describe('AdminInvitationsService.list', () => {
  it('a quien no es superadmin, 403 SUPERADMIN_ONLY sin leer ninguna invitación', async () => {
    const { service, k, contexts, isSuperadmin } = banco({ superadmin: false });

    const err = await service.list(ACTOR, query()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SuperadminOnlyError);
    expect((err as HttpException).getStatus()).toBe(403);
    expect((err as SuperadminOnlyError).reason).toBe('SUPERADMIN_ONLY');
    expect(isSuperadmin).toHaveBeenCalledWith(ACTOR);
    expect(k.queries).toHaveLength(0);
    expect(contexts).toHaveLength(0);
  });

  it('lee con el contexto del actor, sin nodo activo, la página y los contadores en una transacción', async () => {
    const { service, k, contexts } = banco({
      rows: [row(INV_1)],
      counts: { pending: '1', expired: '0' },
    });

    await service.list(ACTOR, query());

    expect(contexts).toEqual([{ userId: ACTOR }]);
    expect(k.indexOf('from "user_invitations"')).toBe(0);
    expect(k.indexOf('count(*) FILTER')).toBe(1);
  });

  it('cada fila con su nodo, quién la mandó, fechas en ISO y si venció; y los contadores', async () => {
    const { service } = banco({
      rows: [
        row(INV_1),
        row(INV_2, {
          role: 'tenant_admin',
          tenant_id: OTRO_NODO,
          tenant_name: 'Consolidador Sur',
          invited_by_email: null,
          expires_at: '2026-09-30T00:00:00Z',
          expired: true,
        }),
      ],
      counts: { pending: '7', expired: '3' },
    });

    const page = await service.list(ACTOR, query({ state: 'all' }));

    expect(page).toEqual({
      invitations: [
        {
          id: INV_1,
          email: 'aaaa@agencia.co',
          role: 'vendedor',
          tenantId: NODO,
          tenantName: 'Agencia Norte',
          invitedByEmail: 'root@plataforma.co',
          createdAt: '2026-10-01T10:00:00.123Z',
          expiresAt: '2026-10-08T10:00:00.123Z',
          expired: false,
        },
        {
          id: INV_2,
          email: 'bbbb@agencia.co',
          role: 'tenant_admin',
          tenantId: OTRO_NODO,
          tenantName: 'Consolidador Sur',
          invitedByEmail: null,
          createdAt: '2026-10-01T10:00:00.123Z',
          expiresAt: '2026-09-30T00:00:00.000Z',
          expired: true,
        },
      ],
      nextCursor: null,
      counts: { pending: 7, expired: 3 },
    });
  });

  it('con una fila de más, la deja fuera y el cursor apunta a la última que sí salió', async () => {
    const { service } = banco({
      rows: [
        row(INV_1, { cursor_at: '2026-10-01T10:00:00.500001Z' }),
        row(INV_2, { cursor_at: '2026-10-01T10:00:00.500000Z' }),
        row(INV_3, { cursor_at: '2026-10-01T09:00:00.000000Z' }),
      ],
    });

    const page = await service.list(ACTOR, query({ limit: 2 }));

    expect(page.invitations.map((i) => i.id)).toEqual([INV_1, INV_2]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodePlatformUsersCursor(page.nextCursor ?? '')).toEqual({
      createdAt: '2026-10-01T10:00:00.500000Z',
      id: INV_2,
    });
  });

  it('sin invitaciones: lista vacía, sin cursor, y contadores en cero aunque no vuelva la fila', async () => {
    const { service } = banco({ rows: [], counts: null });

    const page = await service.list(ACTOR, query({ q: 'nadie' }));

    expect(page).toEqual({ invitations: [], nextCursor: null, counts: { pending: 0, expired: 0 } });
  });
});
