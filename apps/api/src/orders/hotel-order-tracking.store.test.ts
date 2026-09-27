import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  HotelOrderTrackingStore,
  type HotelOrderTrackingExpectation,
} from './hotel-order-tracking.store.js';

/**
 * El registro de una lectura de la post-venta con el compilador REAL de Postgres de Kysely: lo que
 * recibiría Postgres cuando la consulta manual o la conciliación traen el HCN (HARD-3). Contra
 * Postgres de verdad, con RLS, corren `hotel-order-post-sale.integration.test.ts` y
 * `hotels/hcn-tracking.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const T = Date.parse('2026-10-02T09:30:00Z');

const FOTO: HotelOrderTrackingExpectation = {
  subStatus: null,
  providerStatus: 'Confirmed',
  hcn: null,
  hcnState: 'missing',
};

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => { rows?: unknown[] }) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: (this.responder(q).rows ?? []) as R[] }),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

/** `gana` = el upsert devuelve la fila (ganó el CAS). */
function banco(gana: boolean) {
  const consultas: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueGraba((q) => {
          consultas.push(q);
          return q.sql.startsWith('insert into "hotel_order_tracking"') && gana
            ? { rows: [{ order_id: ORDEN }] }
            : {};
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const database = new DatabaseService();
  database.db = db;
  const negocio = () =>
    consultas.filter(
      (q) => !q.sql.includes('set_config') && !/^(begin|commit|rollback)/i.test(q.sql),
    );
  return { store: new HotelOrderTrackingStore(database), consultas, negocio };
}

describe('HotelOrderTrackingStore.recordRead: el HCN cierra la tarea abierta (HARD-3)', () => {
  it('la consulta manual que trae el HCN cierra, en su transacción, la tarea hcn-ticket con motivo y fuente', async () => {
    const b = banco(true);

    const won = await b.store.recordRead(TENANT, ORDEN, {
      source: 'retrieve',
      at: T,
      record: { providerStatus: 'Confirmed', refundAwaited: false },
      hcn: { hcn: 'HCN-4711', markReceived: true },
      expected: FOTO,
    });

    expect(won).toBe(true);
    const [lectura, cierre] = b.negocio();
    expect(lectura?.sql).toContain('insert into "hotel_order_tracking"');
    expect(cierre?.sql).toBe(
      'update "order_operations" set "status" = $1, "result" = order_operations.result || $2::jsonb where "tenant_id" = $3 and "order_id" = $4 and "type" = $5 and "status" = $6',
    );
    expect(cierre?.parameters).toEqual([
      'success',
      JSON.stringify({
        resolution: {
          by: 'system',
          reason: 'hcn-received',
          source: 'retrieve',
          at: new Date(T).toISOString(),
        },
      }),
      TENANT,
      ORDEN,
      'hcn-ticket',
      'pending',
    ]);
    // Una sola transacción con el tenant fijado: el HCN no queda guardado con la tarea abierta.
    expect(b.consultas.filter((q) => q.sql.includes('set_config'))).toHaveLength(1);
  });

  it('la conciliación que trae el HCN la cierra con su fuente', async () => {
    const b = banco(true);

    await b.store.recordRead(TENANT, ORDEN, {
      source: 'reconciliation',
      at: T,
      hcn: { hcn: 'HCN-4711', markReceived: true },
      expected: FOTO,
    });

    const [, cierre] = b.negocio();
    expect(String(cierre?.parameters[1])).toContain('"source":"reconciliation"');
  });

  it('sin HCN en la lectura, o con la foto vieja (CAS perdido), no toca las tareas', async () => {
    const sinHcn = banco(true);
    await sinHcn.store.recordRead(TENANT, ORDEN, {
      source: 'retrieve',
      at: T,
      record: { providerStatus: 'Confirmed', refundAwaited: false },
      expected: FOTO,
    });
    const tarde = banco(false);
    const won = await tarde.store.recordRead(TENANT, ORDEN, {
      source: 'retrieve',
      at: T,
      hcn: { hcn: 'HCN-4711', markReceived: true },
      expected: FOTO,
    });

    expect(won).toBe(false);
    for (const b of [sinHcn, tarde]) {
      expect(b.negocio().filter((q) => q.sql.includes('order_operations'))).toEqual([]);
    }
  });
});
