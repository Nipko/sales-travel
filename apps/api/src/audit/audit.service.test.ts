import { Logger } from '@nestjs/common';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { requestContextStorage } from '../request-context/request-context.js';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  NETWORK_AUDIT_MAX_PAGE,
  NETWORK_AUDIT_PAGE_SIZE,
  USER_AUDIT_MAX_PAGE,
  USER_AUDIT_PAGE_SIZE,
} from './audit.schemas.js';
import { AuditService } from './audit.service.js';

/**
 * `emit` es best-effort y `emitWithin` no: el segundo existe para las lecturas que sólo pueden
 * devolver datos si su rastro quedó escrito (la bóveda de payloads, docs/tbo/09 PR-4.9).
 *
 * Las lecturas (Actividad de la red e historial de una persona) se prueban con el compilador REAL de
 * Postgres de Kysely: qué predicado y qué cursor recibiría la base, y cómo se arma la página. Contra
 * Postgres, con RLS, corre `user-audit.integration.test.ts`.
 */

function insertador(fallo?: Error) {
  const execute = vi.fn(() => (fallo === undefined ? Promise.resolve([]) : Promise.reject(fallo)));
  const values = vi.fn(() => ({ execute }));
  const insertInto = vi.fn(() => ({ values }));
  return { insertInto, values, execute };
}

const EVENTO = {
  eventType: 'ProviderPayloadsExported',
  tenantId: '33333333-3333-4333-8333-333333333333',
  aggregateType: 'provider_payload',
  aggregateId: 'req-1',
  payload: { records: 1 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditService', () => {
  it('emitWithin escribe en la transacción de quien llama, con actor y request del contexto', async () => {
    const trx = insertador();
    const base = insertador();
    const audit = new AuditService({ db: base } as unknown as DatabaseService);

    await requestContextStorage.run(
      { userId: 'u-1', requestId: 'http-1', ip: '10.0.0.1', userAgent: 'vitest', sessionId: 's-1' },
      () => audit.emitWithin(trx as unknown as Transaction<DB>, EVENTO),
    );

    expect(base.insertInto).not.toHaveBeenCalled();
    expect(trx.insertInto).toHaveBeenCalledWith('domain_events');
    expect(trx.values).toHaveBeenCalledWith({
      tenant_id: EVENTO.tenantId,
      actor_user_id: 'u-1',
      event_type: 'ProviderPayloadsExported',
      aggregate_type: 'provider_payload',
      aggregate_id: 'req-1',
      payload: JSON.stringify({ records: 1 }),
      meta: JSON.stringify({
        requestId: 'http-1',
        ip: '10.0.0.1',
        userAgent: 'vitest',
        sessionId: 's-1',
      }),
    });
  });

  it('emitWithin NO se traga el fallo: la transacción de quien llama se deshace con él', async () => {
    const trx = insertador(new Error('domain_events no disponible'));
    const audit = new AuditService({ db: insertador() } as unknown as DatabaseService);

    await expect(audit.emitWithin(trx as unknown as Transaction<DB>, EVENTO)).rejects.toThrow(
      'domain_events no disponible',
    );
  });

  it('emit sigue siendo best-effort: un fallo se avisa y no llega a quien llama', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const audit = new AuditService({
      db: insertador(new Error('sin base')),
    } as unknown as DatabaseService);

    await expect(audit.emit(EVENTO)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('no se pudo registrar ProviderPayloadsExported: sin base');
  });
});

// ---------------------------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------------------------

const VIEWER = '99999999-9999-4999-8999-999999999999';
const ROOT = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const BETO = '44444444-4444-4444-8444-444444444444';

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: this.responder(q) as R[] }),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

/**
 * Un AuditService sobre un Kysely que compila de verdad y responde con `responder`. `negocio` son
 * las consultas sin el control de la transacción ni los `set_config`; `contexto`, los GUC fijados.
 */
function banco(responder: (q: CompiledQuery) => unknown[] = () => []) {
  const consultas: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueGraba((q) => {
          consultas.push(q);
          return q.sql.includes('set_config') ? [] : responder(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const database = new DatabaseService();
  database.db = db;
  const audit = new AuditService(database);
  const negocio = () =>
    consultas.filter(
      (q) => !q.sql.includes('set_config') && !/^(begin|commit|rollback)/i.test(q.sql),
    );
  const contexto = () =>
    consultas
      .filter((q) => q.sql.includes('set_config'))
      .map((q) => [/set_config\('([^']+)'/.exec(q.sql)?.[1], q.parameters[0]]);
  return { audit, negocio, contexto };
}

/** El SQL en una línea, para buscar fragmentos sin depender de la indentación. */
function plano(q: CompiledQuery | undefined): string {
  return (q?.sql ?? '').replace(/\s+/g, ' ');
}

function fila(n: number, extra: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    occurred_at: new Date(Date.UTC(2026, 9, 13, 12, 0, 60 - n)),
    cursor_at: `2026-10-13T12:00:${String(60 - n).padStart(2, '0')}.123456Z`,
    event_type: 'MembershipRoleChanged',
    tenant_id: ROOT,
    tenant_name: 'Norte',
    actor_email: 'admin@norte.test',
    target_email: 'ana@norte.test',
    aggregate_type: 'membership',
    payload: { targetUserId: ANA, previousRole: 'vendedor', newRole: 'agency_admin' },
    ...extra,
  };
}

const filas = (n: number) => Array.from({ length: n }, (_, i) => fila(i + 1));

describe('AuditService.networkAudit', () => {
  it('lee el subárbol con el que mira en el contexto (la RLS de domain_events lo exige)', async () => {
    const { audit, negocio, contexto } = banco();

    await audit.networkAudit(VIEWER, ROOT);

    expect(contexto()).toEqual([
      ['app.current_user_id', VIEWER],
      ['app.current_tenant_id', ROOT],
    ]);
    const sql = plano(negocio()[0]);
    expect(sql).toContain('JOIN tenants t ON t.id = e.tenant_id');
    expect(sql).toContain(
      '"t"."path" OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = $1::uuid)',
    );
    expect(sql).toContain('ORDER BY e.occurred_at DESC, e.id DESC');
    expect(sql).toContain('audit_event_target_user(');
    // El "a quién" sólo se nombra si tiene una membership bajo el nodo raíz.
    expect(sql).toContain(
      'WHERE tm.user_id = tu.id AND "tt"."path" OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = $3::uuid)',
    );
    expect(negocio()[0]?.parameters).toEqual([ROOT, NETWORK_AUDIT_PAGE_SIZE + 1, ROOT]);
  });

  it('cada categoría filtra por el prefijo de event_type', async () => {
    const esperado = {
      users: [`'auth.%'`, `'users.%'`, `'User%'`, `'Membership%'`],
      credentials: [`'ProviderCredentials%'`],
      pricing: [`'Markup%'`],
      network: [`'Tenant%'`, `'tenant.%'`],
    } as const;
    for (const [category, prefijos] of Object.entries(esperado)) {
      const { audit, negocio } = banco();
      await audit.networkAudit(VIEWER, ROOT, { category: category as keyof typeof esperado });
      const sql = plano(negocio()[0]);
      for (const p of prefijos) expect(sql, category).toContain(`e.event_type LIKE ${p}`);
      for (const otro of Object.values(esperado).flat()) {
        if (!(prefijos as readonly string[]).includes(otro)) {
          expect(sql, category).not.toContain(`LIKE ${otro}`);
        }
      }
    }
  });

  it('sin categoría ni actor no filtra por tipo ni por quién', async () => {
    const { audit, negocio } = banco();
    await audit.networkAudit(VIEWER, ROOT);
    const sql = plano(negocio()[0]);
    expect(sql.replace(`e.event_type NOT LIKE 'system.%'`, '')).not.toContain('LIKE');
    expect(sql).not.toContain('e.actor_user_id =');
  });

  it('deja fuera los system.* siempre, con o sin filtro (el barrido escribe uno cada 15 min)', async () => {
    for (const opts of [{}, { category: 'network' as const }, { actorUserId: ANA }]) {
      const { audit, negocio } = banco();
      await audit.networkAudit(VIEWER, ROOT, opts);
      expect(plano(negocio()[0]), JSON.stringify(opts)).toContain(
        `AND e.event_type NOT LIKE 'system.%'`,
      );
    }
  });

  it('el filtro por persona y el cursor llegan como parámetros, con desempate por id', async () => {
    const { audit, negocio } = banco();
    await audit.networkAudit(VIEWER, ROOT, {
      actorUserId: ANA,
      before: { occurredAt: '2026-10-13T12:00:00.123456Z', id: BETO },
      limit: 10,
    });
    const q = negocio()[0];
    expect(plano(q)).toContain('e.actor_user_id = $2::uuid');
    expect(plano(q)).toContain('(e.occurred_at, e.id) < ($3::timestamptz, $4::uuid)');
    expect(q?.parameters).toEqual([ROOT, ANA, '2026-10-13T12:00:00.123456Z', BETO, 11, ROOT]);
  });

  it('el tamaño de página se acota: 1 a 200, 50 si no viene', async () => {
    for (const [pedido, sql] of [
      [0, 2],
      [-5, 2],
      [7.9, 8],
      [10_000, NETWORK_AUDIT_MAX_PAGE + 1],
      [Number.NaN, NETWORK_AUDIT_PAGE_SIZE + 1],
    ] as const) {
      const { audit, negocio } = banco();
      await audit.networkAudit(VIEWER, ROOT, { limit: pedido });
      expect(negocio()[0]?.parameters.at(-2), String(pedido)).toBe(sql);
    }
  });

  it('con una fila de más hay página siguiente: el cursor es el de la última que se muestra', async () => {
    const { audit } = banco(() => filas(4));

    const page = await audit.networkAudit(VIEWER, ROOT, { limit: 3 });

    expect(page.events.map((e) => e.id)).toEqual(filas(3).map((f) => f.id));
    const last = filas(3)[2]!;
    expect(page.nextBefore).toBe(encodeAuditCursor({ occurredAt: last.cursor_at, id: last.id }));
    expect(decodeAuditCursor(page.nextBefore!)).toEqual({
      occurredAt: last.cursor_at,
      id: last.id,
    });
    expect(page.events[0]).toEqual({
      id: filas(1)[0]!.id,
      occurredAt: filas(1)[0]!.occurred_at,
      eventType: 'MembershipRoleChanged',
      tenantId: ROOT,
      tenantName: 'Norte',
      actorEmail: 'admin@norte.test',
      targetEmail: 'ana@norte.test',
      aggregateType: 'membership',
      payload: { targetUserId: ANA, previousRole: 'vendedor', newRole: 'agency_admin' },
    });
  });

  it('sin la fila de más no hay página siguiente; un payload nulo sale como objeto vacío', async () => {
    const { audit } = banco(() => [fila(1, { payload: null, target_email: null })]);

    const page = await audit.networkAudit(VIEWER, ROOT, { limit: 3 });

    expect(page.nextBefore).toBeNull();
    expect(page.events[0]?.payload).toEqual({});
    expect(page.events[0]?.targetEmail).toBeNull();
  });
});

describe('AuditService.userAuditTrail', () => {
  it('sin membership en el subárbol no lee el historial: undefined', async () => {
    const { audit, negocio, contexto } = banco(() => []);

    expect(await audit.userAuditTrail(VIEWER, ROOT, ANA)).toBeUndefined();

    expect(contexto()).toEqual([
      ['app.current_user_id', VIEWER],
      ['app.current_tenant_id', ROOT],
    ]);
    expect(negocio()).toHaveLength(1);
    const sql = plano(negocio()[0]);
    expect(sql).toContain('from "memberships" as "m" inner join "tenants" as "t"');
    expect(sql).toContain('"t"."path" OPERATOR(public.<@)');
    expect(negocio()[0]?.parameters).toEqual([ANA, ROOT, 1]);
  });

  it('con membership: lo que hizo, lo que se hizo sobre su cuenta y lo que la nombra, en el subárbol', async () => {
    const { audit, negocio } = banco((q) =>
      q.sql.includes('"memberships"') ? [{ id: 'm-1' }] : filas(2),
    );

    const page = await audit.userAuditTrail(VIEWER, ROOT, ANA, {
      before: { occurredAt: '2026-10-13T12:00:00.000001Z', id: BETO },
      limit: 5,
    });

    expect(page?.events).toHaveLength(2);
    expect(page?.nextBefore).toBeNull();
    const q = negocio()[1];
    const sql = plano(q);
    expect(sql).toContain('JOIN tenants t ON t.id = e.tenant_id');
    expect(sql).toContain(
      '"t"."path" OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = $1::uuid)',
    );
    expect(sql).toContain('e.actor_user_id = $2::uuid');
    expect(sql).toContain(`(e.aggregate_type = 'user' AND e.aggregate_id = $3)`);
    expect(sql).toContain(
      `(e.payload ? 'targetUserId' AND lower(e.payload ->> 'targetUserId') = $4)`,
    );
    expect(sql).toContain('(e.occurred_at, e.id) < ($5::timestamptz, $6::uuid)');
    expect(q?.parameters).toEqual([
      ROOT,
      ANA,
      ANA,
      ANA,
      '2026-10-13T12:00:00.000001Z',
      BETO,
      6,
      ROOT,
    ]);
    expect(sql).toContain('WHERE tm.user_id = tu.id AND "tt"."path" OPERATOR(public.<@)');
  });

  it('el tamaño de página del historial va de 1 a 100, 30 si no viene', async () => {
    for (const [pedido, sql] of [
      [undefined, USER_AUDIT_PAGE_SIZE + 1],
      [500, USER_AUDIT_MAX_PAGE + 1],
      [0, 2],
    ] as const) {
      const { audit, negocio } = banco((q) =>
        q.sql.includes('"memberships"') ? [{ id: 'm-1' }] : [],
      );
      await audit.userAuditTrail(VIEWER, ROOT, ANA, { limit: pedido });
      expect(negocio()[1]?.parameters.at(-2), String(pedido)).toBe(sql);
    }
  });
});

describe('AuditService.platformUserAuditTrail', () => {
  it('una cuenta que no existe: undefined, sin llamar a la función', async () => {
    const { audit, negocio, contexto } = banco(() => []);

    expect(await audit.platformUserAuditTrail(VIEWER, ANA)).toBeUndefined();

    expect(contexto()).toEqual([['app.current_user_id', VIEWER]]);
    expect(negocio()).toHaveLength(1);
    expect(plano(negocio()[0])).toContain('from "users"');
  });

  it('va por la función de 0065, con el cursor y una fila de más', async () => {
    const { audit, negocio } = banco((q) =>
      q.sql.includes('from "users"') ? [{ id: ANA }] : filas(3),
    );

    const page = await audit.platformUserAuditTrail(VIEWER, ANA, {
      before: { occurredAt: '2026-10-13T12:00:00.5Z', id: BETO },
      limit: 2,
    });

    const q = negocio()[1];
    expect(plano(q)).toContain(
      'FROM platform_user_audit_trail( $1::uuid, $2::timestamptz, $3::uuid, $4::int ) p',
    );
    expect(q?.parameters).toEqual([ANA, '2026-10-13T12:00:00.5Z', BETO, 3]);
    expect(page?.events).toHaveLength(2);
    expect(page?.nextBefore).not.toBeNull();
  });

  it('sin cursor, la función recibe nulos', async () => {
    const { audit, negocio } = banco((q) => (q.sql.includes('from "users"') ? [{ id: ANA }] : []));

    const page = await audit.platformUserAuditTrail(VIEWER, ANA);

    expect(negocio()[1]?.parameters).toEqual([ANA, null, null, USER_AUDIT_PAGE_SIZE + 1]);
    expect(page).toEqual({ events: [], nextBefore: null });
  });
});

describe('cursor del historial', () => {
  it('ida y vuelta, con el id en minúsculas', () => {
    const raw = encodeAuditCursor({
      occurredAt: '2026-10-13T12:00:00.123456Z',
      id: BETO.toUpperCase(),
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAuditCursor(raw)).toEqual({ occurredAt: '2026-10-13T12:00:00.123456Z', id: BETO });
  });

  it('rechaza lo que no emitió: basura, JSON raro, instantes imposibles o ids que no son UUID', () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const raw of [
      '',
      'no es base64!',
      'x'.repeat(201),
      Buffer.from('{').toString('base64url'),
      b64(null),
      b64('texto'),
      b64({ occurredAt: '2026-02-30T00:00:00Z', id: BETO }),
      b64({ occurredAt: '2026-10-13T24:00:00Z', id: BETO }),
      b64({ occurredAt: '2026-10-13 12:00:00', id: BETO }),
      b64({ occurredAt: '2026-10-13T12:00:00Z', id: 'no-uuid' }),
      b64({ occurredAt: 12, id: BETO }),
    ]) {
      expect(decodeAuditCursor(raw), raw).toBeUndefined();
    }
  });
});
