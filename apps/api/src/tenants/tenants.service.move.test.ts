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
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import type { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import type { InvitationsService } from './invitations.service.js';
import { TENANT_MOVED_REASON, TenantsService } from './tenants.service.js';

/**
 * Mover un nodo con sesiones abiertas, con la base sustituida por lo que devolvería: el orden de
 * las consultas y qué se revoca y audita. Que el SQL elige las sesiones correctas lo prueba
 * seats.integration.test.ts contra Postgres.
 */
const ACTOR = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const PADRE_NUEVO = '22222222-2222-4222-8222-222222222222';
const CUPO_VIEJO = '33333333-3333-4333-8333-333333333333';

interface Varada {
  session_id: string;
  user_id: string;
  tenant_id: string;
  pool_tenant_id: string;
}

const S1: Varada = {
  session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tenant_id: NODO,
  pool_tenant_id: CUPO_VIEJO,
};
const S2: Varada = {
  session_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  tenant_id: NODO,
  pool_tenant_id: CUPO_VIEJO,
};

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        new Promise((resolve) => resolve({ rows: this.responder(q) as R[] })),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

function banco({
  varadas = [] as Varada[],
  yaCerradas = [] as string[],
  moved = 1,
  moverFalla = undefined as Error | undefined,
} = {}) {
  const consultas: CompiledQuery[] = [];
  const responder = (q: CompiledQuery): unknown[] => {
    consultas.push(q);
    if (q.sql.includes('pool_active_sessions')) return varadas;
    if (q.sql.includes('revoke_session')) {
      const ids = q.parameters[1] as string[];
      return ids.map((id) => ({ session_id: id, revoked: !yaCerradas.includes(id) }));
    }
    if (q.sql.includes('move_tenant_subtree')) {
      if (moverFalla) throw moverFalla;
      return [{ moved }];
    }
    if (q.sql.includes('from "tenants"')) {
      return [
        {
          id: NODO,
          slug: 'nodo',
          name: 'Nodo',
          tenant_type: 'agency',
          is_branch: false,
          parent_tenant_id: PADRE_NUEVO,
          status: 'active',
          depth: 3,
        },
      ];
    }
    throw new Error(`consulta no prevista: ${q.sql}`);
  };

  const kysely = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DriverQueGraba(responder),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const db = {
    withRequestContext: vi.fn(<T>(_ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>) =>
      kysely.transaction().execute(fn),
    ),
  };
  const audit = { emitWithin: vi.fn(() => Promise.resolve()) };
  const enablement = { invalidate: vi.fn() };
  const service = new TenantsService(
    db as unknown as DatabaseService,
    {} as NetworkService,
    {} as PasswordService,
    {} as InvitationsService,
    audit as unknown as AuditService,
    enablement as unknown as ProviderEnablementStore,
  );
  const indice = (fragmento: string) => consultas.findIndex((q) => q.sql.includes(fragmento));
  return { service, consultas, audit, enablement, db, indice };
}

describe('TenantsService.move: sesiones que quedarían en el cupo de la red vieja', () => {
  it('se buscan y se revocan con `tenant_moved` ANTES de mover, en la misma transacción, y queda el evento', async () => {
    const { service, consultas, audit, db, indice } = banco({ varadas: [S1, S2] });

    const res = await service.move(ACTOR, NODO, PADRE_NUEVO);

    expect(res.moved).toBe(1);
    expect(db.withRequestContext).toHaveBeenCalledTimes(1);
    expect(db.withRequestContext).toHaveBeenCalledWith({ userId: ACTOR }, expect.any(Function));

    const buscar = indice('pool_active_sessions');
    const revocar = indice('revoke_session');
    const mover = indice('move_tenant_subtree');
    expect(buscar).toBeGreaterThanOrEqual(0);
    expect(buscar).toBeLessThan(revocar);
    expect(revocar).toBeLessThan(mover);
    expect(consultas[buscar]!.parameters).toEqual([NODO, PADRE_NUEVO]);
    expect(consultas[revocar]!.parameters).toEqual([
      TENANT_MOVED_REASON,
      [S1.session_id, S2.session_id],
    ]);
    expect(TENANT_MOVED_REASON).toBe('tenant_moved');

    expect(audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(audit.emitWithin).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'auth.sessions.revoked_by_tenant_move',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'tenant',
      aggregateId: NODO,
      payload: {
        toParentId: PADRE_NUEVO,
        sessions: [
          {
            sessionId: S1.session_id,
            userId: S1.user_id,
            tenantId: NODO,
            poolTenantId: CUPO_VIEJO,
          },
          {
            sessionId: S2.session_id,
            userId: S2.user_id,
            tenantId: NODO,
            poolTenantId: CUPO_VIEJO,
          },
        ],
      },
    });
  });

  it('una que se cerró entre la lectura y la revocación no entra en el evento', async () => {
    const { service, audit } = banco({ varadas: [S1, S2], yaCerradas: [S1.session_id] });

    await service.move(ACTOR, NODO, PADRE_NUEVO);

    expect(audit.emitWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: {
          toParentId: PADRE_NUEVO,
          sessions: [
            {
              sessionId: S2.session_id,
              userId: S2.user_id,
              tenantId: NODO,
              poolTenantId: CUPO_VIEJO,
            },
          ],
        },
      }),
    );
  });

  it('sin sesiones varadas no revoca ni audita nada; el movimiento sigue igual', async () => {
    const { service, audit, indice, enablement } = banco();

    expect((await service.move(ACTOR, NODO, PADRE_NUEVO)).moved).toBe(1);

    expect(indice('pool_active_sessions')).toBeGreaterThanOrEqual(0);
    expect(indice('revoke_session')).toBe(-1);
    expect(audit.emitWithin).not.toHaveBeenCalled();
    expect(enablement.invalidate).toHaveBeenCalledTimes(1);
  });

  it('si la base rechaza el movimiento, el error sale y la caché no se olvida', async () => {
    const rechazo = new Error('tenant_move_cycle');
    const { service, enablement } = banco({ varadas: [S1], moverFalla: rechazo });

    await expect(service.move(ACTOR, NODO, PADRE_NUEVO)).rejects.toBe(rechazo);
    expect(enablement.invalidate).not.toHaveBeenCalled();
  });
});
