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
import { HcnTrackingStore } from './hcn-tracking.store.js';

/**
 * El SQL del seguimiento del HCN con el compilador REAL de Postgres de Kysely: se afirma sobre lo
 * que recibiría Postgres —tenant fijado, filtros del barrido, CAS del plan, la tarea en la misma
 * transacción— y sobre cómo se leen las filas. Contra Postgres de verdad, con RLS, corre
 * `hcn-tracking.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const T = Date.parse('2026-10-01T10:00:00Z');

type Respuesta = { rows?: unknown[]; numAffectedRows?: bigint };

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => Respuesta) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        new Promise((resolve) => {
          const r = this.responder(q);
          resolve({
            rows: (r.rows ?? []) as R[],
            ...(r.numAffectedRows === undefined ? {} : { numAffectedRows: r.numAffectedRows }),
          });
        }),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

function banco(responder: (q: CompiledQuery) => Respuesta = () => ({})) {
  const consultas: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueGraba((q) => {
          consultas.push(q);
          return q.sql.includes('set_config') ? {} : responder(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const database = new DatabaseService();
  database.db = db;
  const store = new HcnTrackingStore(database);
  /** Las consultas de negocio: sin el `set_config` del tenant ni el control de la transacción. */
  const negocio = () =>
    consultas.filter(
      (q) => !q.sql.includes('set_config') && !/^(begin|commit|rollback)/i.test(q.sql),
    );
  return { store, consultas, negocio };
}

function fila(parcial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: ORDEN,
    provider: 'tbo-hotels',
    user_id: 'u-1',
    status: 'confirmed',
    provider_order_id: 'FL1IMA',
    provider_account_id: 'cuenta-1',
    provider_booking_ref: 'STT7K2M9QX4D8R1VZ6AB',
    created_at: new Date(T),
    checkin_date: '2026-10-04',
    checkout_date: '2026-10-06',
    hotel_id: '1402689',
    provider_status: 'Confirmed',
    provider_voucher_status: 'true',
    sub_status: null,
    refund_awaited: false,
    hcn: null,
    hcn_state: 'scheduled',
    hcn_priority: 'P2',
    hcn_next_check_at: new Date(T + 6 * 3_600_000),
    hcn_attempts: 1,
    ...parcial,
  };
}

describe('HcnTrackingStore: lecturas', () => {
  it('cada operación corre con el tenant fijado, dentro de su transacción', async () => {
    const b = banco();
    await b.store.findTarget(TENANT, ORDEN);

    const tenant = b.consultas.find((q) => q.sql.includes('set_config'));
    expect(tenant?.parameters).toEqual([TENANT]);
  });

  it('findTarget: la orden con su plan y las fechas de la búsqueda, sin columnas de PII', async () => {
    const b = banco(() => ({ rows: [fila()] }));

    expect(await b.store.findTarget(TENANT, ORDEN)).toEqual({
      orderId: ORDEN,
      provider: 'tbo-hotels',
      userId: 'u-1',
      status: 'confirmed',
      providerOrderId: 'FL1IMA',
      providerAccountId: 'cuenta-1',
      bookingReference: 'STT7K2M9QX4D8R1VZ6AB',
      createdAt: T,
      checkinDate: '2026-10-04',
      checkoutDate: '2026-10-06',
      hotelId: '1402689',
      snapshot: {
        status: 'confirmed',
        subStatus: null,
        providerStatus: 'Confirmed',
        voucherStatus: 'true',
        refundAwaited: false,
        hcn: null,
        hcnState: 'scheduled',
      },
      tracking: { state: 'scheduled', priority: 'P2', nextAt: T + 6 * 3_600_000, attempts: 1 },
    });
    const [q] = b.negocio();
    expect(q?.sql).toContain('left join "hotel_order_tracking" as "t"');
    expect(q?.sql).toContain('"t"."tenant_id" = "o"."tenant_id"');
    expect(q?.sql).toContain(`o.search_criteria ->> 'checkinDate'`);
    expect(q?.sql).not.toMatch(/passengers|contact_info/);
    expect(q?.parameters).toEqual([ORDEN, TENANT]);
  });

  it('sin fila de seguimiento no hay plan ni lecturas; fechas como texto también se leen', async () => {
    const b = banco(() => ({
      rows: [
        fila({
          created_at: '2026-10-01T10:00:00.000Z',
          provider_status: null,
          provider_voucher_status: null,
          refund_awaited: null,
          hcn_state: null,
          hcn_priority: null,
          hcn_next_check_at: null,
          hcn_attempts: null,
        }),
      ],
    }));

    const target = await b.store.findTarget(TENANT, ORDEN);

    expect(target?.createdAt).toBe(T);
    expect(target?.snapshot.refundAwaited).toBe(false);
    expect(target?.tracking).toEqual({ state: null, priority: null, nextAt: null, attempts: 0 });
  });

  it('una hora y un conteo que el driver trae como texto se normalizan', async () => {
    const b = banco(() => ({
      rows: [fila({ hcn_next_check_at: '2026-10-01T16:00:00.000Z', hcn_attempts: '2' })],
    }));

    expect((await b.store.findTarget(TENANT, ORDEN))?.tracking).toMatchObject({
      nextAt: T + 6 * 3_600_000,
      attempts: 2,
    });
  });

  it('una orden que el tenant no ve no existe', async () => {
    const b = banco(() => ({ rows: [] }));
    expect(await b.store.findTarget(TENANT, ORDEN)).toBeUndefined();
  });

  it('listDue: lecturas vencidas tras el margen y entradas en ventana, la más atrasada primero', async () => {
    const b = banco(() => ({ rows: [fila(), fila({ hcn_state: 'out-of-window' })] }));

    const due = await b.store.listDue(TENANT, {
      scheduledBefore: T - 900_000,
      windowBefore: T,
      limit: 25,
    });

    expect(due.map((t) => t.tracking.state)).toEqual(['scheduled', 'out-of-window']);
    const [q] = b.negocio();
    expect(q?.sql).toContain(
      '(("t"."hcn_state" = $2 and "t"."hcn_next_check_at" <= $3) or ("t"."hcn_state" = $4 and "t"."hcn_next_check_at" <= $5))',
    );
    expect(q?.sql).toContain('order by "t"."hcn_next_check_at"');
    expect(q?.parameters).toEqual([
      TENANT,
      'scheduled',
      new Date(T - 900_000),
      'out-of-window',
      new Date(T),
      25,
    ]);
  });

  it('listUnplanned: confirmadas de hotel, con localizador, proveedor legible, sin plan y en fecha', async () => {
    const b = banco(() => ({ rows: [fila({ hcn_state: null })] }));

    const found = await b.store.listUnplanned(TENANT, {
      providers: ['tbo-hotels'],
      checkinFrom: '2026-09-30',
      limit: 25,
    });

    expect(found).toHaveLength(1);
    const [q] = b.negocio();
    expect(q?.sql).toContain('"o"."status" = $2');
    expect(q?.sql).toContain('"o"."provider_order_id" is not null');
    expect(q?.sql).toContain('"o"."provider" in ($3)');
    expect(q?.sql).toContain(`o.search_criteria ->> 'vertical' = $4`);
    expect(q?.sql).toContain('"t"."hcn_state" is null');
    expect(q?.sql).toContain(`o.search_criteria ->> 'checkinDate' ~ $5`);
    expect(q?.sql).toContain(`o.search_criteria ->> 'checkinDate' >= $6`);
    expect(q?.sql).toContain('order by "o"."created_at"');
    expect(q?.parameters).toEqual([
      TENANT,
      'confirmed',
      'tbo-hotels',
      'hotels',
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
      '2026-09-30',
      25,
    ]);
  });

  it('listUnplanned sin proveedores legibles no consulta nada', async () => {
    const b = banco();
    expect(
      await b.store.listUnplanned(TENANT, { providers: [], checkinFrom: '2026-09-30', limit: 25 }),
    ).toEqual([]);
    expect(b.consultas).toEqual([]);
  });
});

describe('HcnTrackingStore: escrituras', () => {
  it('open: sólo si la orden todavía no tiene plan (nunca lo reabre)', async () => {
    const b = banco(() => ({ rows: [{ order_id: ORDEN }] }));

    expect(
      await b.store.open(TENANT, ORDEN, { state: 'scheduled', priority: 'P2', nextAt: T }),
    ).toBe(true);

    const [q] = b.negocio();
    expect(q?.sql).toMatch(/^insert into "hotel_order_tracking"/);
    expect(q?.sql).toContain(
      'on conflict ("order_id") do update set "hcn_state" = $7, "hcn_priority" = $8, "hcn_next_check_at" = $9, "hcn_attempts" = $10 where "hotel_order_tracking"."hcn_state" is null',
    );
    expect(q?.parameters.slice(0, 6)).toEqual([ORDEN, TENANT, 'scheduled', 'P2', new Date(T), 0]);
  });

  it('open: un plan terminado antes de empezar no lleva hora; ya abierto devuelve false', async () => {
    const b = banco(() => ({ rows: [] }));

    expect(
      await b.store.open(TENANT, ORDEN, { state: 'stopped', priority: null, nextAt: null }),
    ).toBe(false);
    expect(b.negocio()[0]?.parameters.slice(2, 6)).toEqual(['stopped', null, null, 0]);
  });

  it('advance: CAS sobre el estado y las lecturas hechas; sin lectura no toca la reserva', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));

    const won = await b.store.advance(
      TENANT,
      ORDEN,
      { state: 'scheduled', attempts: 1 },
      { state: 'scheduled', attempts: 1, nextAt: T + 3_600_000 },
    );

    expect(won).toBe(true);
    const [q] = b.negocio();
    expect(q?.sql).toBe(
      'update "hotel_order_tracking" set "hcn_state" = $1, "hcn_attempts" = $2, "hcn_next_check_at" = $3 where "order_id" = $4 and "tenant_id" = $5 and "hcn_state" = $6 and "hcn_attempts" = $7',
    );
    expect(q?.parameters).toEqual([
      'scheduled',
      1,
      new Date(T + 3_600_000),
      ORDEN,
      TENANT,
      'scheduled',
      1,
    ]);
    expect(b.negocio()).toHaveLength(1);
  });

  it('advance con lectura: registra lo leído con fuente hcn y exige que la fila no haya cambiado', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));

    await b.store.advance(
      TENANT,
      ORDEN,
      {
        state: 'scheduled',
        attempts: 2,
        snapshot: { subStatus: null, providerStatus: 'Confirmed', hcn: null },
      },
      {
        state: 'received',
        attempts: 3,
        nextAt: null,
        read: {
          at: T,
          record: { providerStatus: 'Vouchered', voucherStatus: 'true', refundAwaited: false },
          subStatus: null,
          hcn: 'HCN-4711',
        },
      },
    );

    const [q] = b.negocio();
    expect(q?.sql).toBe(
      'update "hotel_order_tracking" set "provider_status" = $1, "provider_status_at" = $2, "provider_status_source" = $3, "refund_awaited" = $4, "provider_voucher_status" = $5, "sub_status" = $6, "hcn" = $7, "hcn_received_at" = $8, "hcn_state" = $9, "hcn_attempts" = $10, "hcn_next_check_at" = $11 where "order_id" = $12 and "tenant_id" = $13 and "hcn_state" = $14 and "hcn_attempts" = $15 and "sub_status" is not distinct from $16 and "provider_status" is not distinct from $17 and "hcn" is not distinct from $18',
    );
    expect(q?.parameters).toEqual([
      'Vouchered',
      new Date(T),
      'hcn',
      false,
      'true',
      null,
      'HCN-4711',
      new Date(T),
      'received',
      3,
      null,
      ORDEN,
      TENANT,
      'scheduled',
      2,
      null,
      'Confirmed',
      null,
    ]);
  });

  it('advance: una lectura sin voucher no lo pisa; una entrada en ventana fija la prioridad', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));

    await b.store.advance(
      TENANT,
      ORDEN,
      { state: 'scheduled', attempts: 0 },
      {
        state: 'scheduled',
        attempts: 1,
        nextAt: T,
        read: { at: T, record: { providerStatus: 'Confirmed', refundAwaited: false } },
      },
    );
    await b.store.advance(
      TENANT,
      ORDEN,
      { state: 'out-of-window', attempts: 0 },
      { state: 'scheduled', priority: 'P5', attempts: 0, nextAt: T },
    );
    await b.store.advance(
      TENANT,
      ORDEN,
      { state: 'scheduled', attempts: 1 },
      { state: 'scheduled', attempts: 2, nextAt: T, read: { at: T } },
    );

    const [conLectura, entrada, sinNada] = b.negocio();
    expect(conLectura?.sql).not.toContain('provider_voucher_status');
    expect(conLectura?.sql).not.toContain('"sub_status" =');
    expect(conLectura?.sql).not.toContain('"hcn" =');
    expect(entrada?.sql).toContain('"hcn_priority" = $4');
    expect(sinNada?.sql).toMatch(/^update "hotel_order_tracking" set "hcn_state" = \$1,/);
  });

  it('advance que pierde el CAS no escribe la tarea', async () => {
    const b = banco(() => ({ numAffectedRows: 0n }));

    const won = await b.store.advance(
      TENANT,
      ORDEN,
      { state: 'scheduled', attempts: 3 },
      { state: 'missing', attempts: 4, nextAt: null, ticket: { reason: 'sla-exhausted' } },
    );

    expect(won).toBe(false);
    expect(b.negocio().filter((q) => q.sql.includes('order_operations'))).toEqual([]);
  });

  it('advance que gana el CAS crea la tarea hcn-ticket en la misma transacción, sin actor', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));
    const ticket = { vertical: 'hotels', reason: 'sla-exhausted', confirmationNumber: 'FL1IMA' };

    await b.store.advance(
      TENANT,
      ORDEN,
      { state: 'scheduled', attempts: 3 },
      { state: 'missing', attempts: 4, nextAt: null, ticket },
    );

    const [, alta] = b.negocio();
    expect(alta?.sql).toBe(
      'insert into "order_operations" ("tenant_id", "order_id", "type", "status", "result", "actor_user_id") values ($1, $2, $3, $4, $5, $6)',
    );
    expect(alta?.parameters).toEqual([
      TENANT,
      ORDEN,
      'hcn-ticket',
      'pending',
      JSON.stringify(ticket),
      null,
    ]);
    // Una sola transacción con el tenant fijado: la tarea no sale sin el plan, ni al revés.
    expect(b.consultas.filter((q) => q.sql.includes('set_config'))).toHaveLength(1);
  });
});
