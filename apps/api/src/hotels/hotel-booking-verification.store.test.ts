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
import { HotelBookingVerificationStore } from './hotel-booking-verification.store.js';

/**
 * El SQL de la verificación con el compilador REAL de Postgres de Kysely (como
 * `__fixtures__/fake-hotels-db.ts`): se afirma sobre lo que recibiría Postgres —tenant fijado,
 * filtros del barrido, CAS del paso— y sobre cómo se leen las filas. Contra Postgres de verdad, con
 * RLS, corre `hotel-booking-verification.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const T = Date.parse('2026-09-25T15:00:00Z');

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
  const store = new HotelBookingVerificationStore(database);
  /** Las consultas de negocio: sin el `set_config` del tenant. */
  const negocio = () => consultas.filter((q) => !q.sql.includes('set_config'));
  return { store, consultas, negocio };
}

function fila(parcial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: ORDEN,
    provider: 'tbo-hotels',
    user_id: 'u-1',
    provider_booking_ref: 'STT7K2M9QX4D8R1VZ6AB',
    provider_account_id: 'cuenta-1',
    open: true,
    updated_at: new Date(T),
    verify_anchor_at: new Date(T + 1_000),
    verify_step: 1,
    verify_next_at: new Date(T + 301_000),
    ...parcial,
  };
}

describe('HotelBookingVerificationStore', () => {
  it('cada operación corre con el tenant fijado, dentro de su transacción', async () => {
    const b = banco();
    await b.store.findTarget(TENANT, ORDEN);

    const [tenant] = b.consultas;
    expect(tenant?.sql).toContain('set_config');
    expect(tenant?.parameters).toEqual([TENANT]);
  });

  it('findTarget: la orden con referencia y su calendario, sin columnas de PII', async () => {
    const b = banco(() => ({ rows: [fila()] }));

    const target = await b.store.findTarget(TENANT, ORDEN);

    expect(target).toEqual({
      orderId: ORDEN,
      provider: 'tbo-hotels',
      userId: 'u-1',
      bookingReference: 'STT7K2M9QX4D8R1VZ6AB',
      providerAccountId: 'cuenta-1',
      open: true,
      updatedAt: T,
      anchorAt: T + 1_000,
      step: 1,
      nextAt: T + 301_000,
    });
    const [q] = b.negocio();
    expect(q?.sql).toContain('left join "hotel_order_tracking" as "t"');
    expect(q?.sql).toContain('"t"."tenant_id" = "o"."tenant_id"');
    expect(q?.sql).toContain(`o.status = 'pending' AND o.provider_raw IS NULL`);
    expect(q?.sql).toContain('"o"."provider_booking_ref" is not null');
    expect(q?.parameters).toEqual([ORDEN, TENANT]);
    expect(q?.sql).not.toMatch(/passengers|contact_info/);
  });

  it('findTarget: sin fila no hay objetivo; lee fechas en texto y un paso como texto', async () => {
    expect(await banco(() => ({ rows: [] })).store.findTarget(TENANT, ORDEN)).toBeUndefined();

    const target = await banco(() => ({
      rows: [
        fila({
          open: null,
          updated_at: '2026-09-25T15:00:00.000Z',
          verify_anchor_at: null,
          verify_step: null,
          verify_next_at: null,
          provider_account_id: null,
        }),
      ],
    })).store.findTarget(TENANT, ORDEN);
    expect(target).toMatchObject({
      open: false,
      updatedAt: T,
      anchorAt: null,
      step: null,
      nextAt: null,
      providerAccountId: null,
    });

    const conPasoEnTexto = await banco(() => ({
      rows: [fila({ verify_step: '2' })],
    })).store.findTarget(TENANT, ORDEN);
    expect(conPasoEnTexto?.step).toBe(2);
  });

  it('findTarget: una fila sin referencia no se verifica', async () => {
    const b = banco(() => ({ rows: [fila({ provider_booking_ref: null })] }));
    expect(await b.store.findTarget(TENANT, ORDEN)).toBeUndefined();
  });

  it('listDue: abiertas de hotel con referencia, vencidas o huérfanas, con tope', async () => {
    const b = banco(() => ({ rows: [fila(), fila({ provider_booking_ref: null })] }));

    const due = await b.store.listDue(TENANT, {
      dueBefore: T + 10 * 60_000,
      orphanBefore: T - 60_000,
      limit: 25,
    });

    expect(due.map((t) => t.orderId)).toEqual([ORDEN]);
    const [q] = b.negocio();
    expect(q?.sql).toContain(`"o"."status" = $2`);
    expect(q?.sql).toContain('"o"."provider_raw" is null');
    expect(q?.sql).toContain(`o.search_criteria ->> 'vertical'`);
    expect(q?.sql).toContain('"t"."verify_next_at" is not null and "t"."verify_next_at" <= $');
    expect(q?.sql).toContain('"t"."verify_anchor_at" is null and o.updated_at <= $');
    // Por su hora programada: una orden reprogramada tras un fallo deja pasar al resto (HARD-2).
    expect(q?.sql).toContain('order by coalesce(t.verify_next_at, o.updated_at) limit $');
    expect(q?.parameters).toEqual([
      TENANT,
      'pending',
      'hotels',
      new Date(T + 10 * 60_000),
      new Date(T - 60_000),
      25,
    ]);
  });

  it('startCalendar: sólo si la fila no tiene calendario; `false` si ya lo tenía', async () => {
    const b = banco(() => ({ rows: [{ order_id: ORDEN }] }));
    const abierto = await b.store.startCalendar(TENANT, ORDEN, {
      anchorAt: T,
      step: 0,
      nextAt: T + 120_000,
    });

    expect(abierto).toBe(true);
    const [q] = b.negocio();
    expect(q?.sql).toContain('insert into "hotel_order_tracking"');
    expect(q?.sql).toContain('on conflict ("order_id") do update set');
    expect(q?.sql).toContain('where "hotel_order_tracking"."verify_anchor_at" is null');
    expect(q?.sql).toContain('returning "order_id"');
    expect(q?.parameters).toEqual([
      ORDEN,
      TENANT,
      'create-uncertain',
      new Date(T),
      0,
      new Date(T + 120_000),
      'create-uncertain',
      new Date(T),
      0,
      new Date(T + 120_000),
    ]);

    const yaTenia = banco(() => ({ rows: [] }));
    expect(
      await yaTenia.store.startCalendar(TENANT, ORDEN, { anchorAt: T, step: 0, nextAt: T }),
    ).toBe(false);
  });

  it('advance: CAS sobre el paso guardado; `false` si otro ya lo avanzó', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));
    const gano = await b.store.advance(TENANT, ORDEN, 1, { step: 2, nextAt: T + 15 * 60_000 });

    expect(gano).toBe(true);
    const [q] = b.negocio();
    expect(q?.sql).toBe(
      'update "hotel_order_tracking" set "verify_step" = $1, "verify_next_at" = $2 where "order_id" = $3 and "tenant_id" = $4 and "verify_step" = $5',
    );
    expect(q?.parameters).toEqual([2, new Date(T + 15 * 60_000), ORDEN, TENANT, 1]);

    const perdio = banco(() => ({ numAffectedRows: 0n }));
    expect(await perdio.store.advance(TENANT, ORDEN, 1, { step: 2, nextAt: null })).toBe(false);
  });

  it('postpone: corre la próxima lectura sin avanzar el paso, con CAS sobre ancla y paso', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));
    const movida = await b.store.postpone(TENANT, ORDEN, { anchorAt: T, step: 1 }, T + 15 * 60_000);

    expect(movida).toBe(true);
    const [q] = b.negocio();
    expect(q?.sql).toBe(
      'update "hotel_order_tracking" set "verify_next_at" = $1 where "order_id" = $2 and "tenant_id" = $3 and "verify_anchor_at" = $4 and "verify_step" = $5 and "verify_next_at" is not null',
    );
    expect(q?.parameters).toEqual([new Date(T + 15 * 60_000), ORDEN, TENANT, new Date(T), 1]);

    const otro = banco(() => ({ numAffectedRows: 0n }));
    expect(await otro.store.postpone(TENANT, ORDEN, { anchorAt: T, step: 1 }, T)).toBe(false);
  });

  it('advance: detiene el calendario con subestado y el estado crudo leído, fuente `verify`', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));

    await b.store.advance(TENANT, ORDEN, 3, {
      step: 4,
      nextAt: null,
      subStatus: null,
      providerStatus: { value: 'Confirmed', at: T },
    });

    const [q] = b.negocio();
    expect(q?.sql).toBe(
      'update "hotel_order_tracking" set "verify_step" = $1, "verify_next_at" = $2, "sub_status" = $3, "provider_status" = $4, "provider_status_at" = $5, "provider_status_source" = $6 where "order_id" = $7 and "tenant_id" = $8 and "verify_step" = $9',
    );
    expect(q?.parameters).toEqual([
      4,
      null,
      null,
      'Confirmed',
      new Date(T),
      'verify',
      ORDEN,
      TENANT,
      3,
    ]);
  });
});
