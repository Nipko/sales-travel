import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { HotelOrderReadsService } from '../orders/hotel-order-reads.service.js';
import { HotelOrderTrackingStore } from '../orders/hotel-order-tracking.store.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { HCN_READS } from './hcn-plan.js';
import { HcnTrackingService } from './hcn-tracking.service.js';
import { HcnTrackingStore } from './hcn-tracking.store.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * El seguimiento del HCN contra Postgres real (docs/tbo/09 PR-5.4; 08 RF-27; columnas `hcn_*` y
 * CHECK de 0042; pendiente c de la Fase 5).
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado: como
 * superusuario la RLS no aplica y el aislamiento no probaría nada. El superusuario sólo siembra y
 * mira. Lo que se prueba: que el SQL que el doble sólo compila corre de verdad, los CAS, los filtros
 * del barrido tenant por tenant y que la tarea de operaciones no copia PII. Los CHECK del plan
 * (0042) los prueba `orders/hotel-orders.integration.test.ts`.
 *
 * Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

/** `DatabaseService` que entra como `app_user`, el rol de la API. */
class ComoAppUser extends DatabaseService {
  override async withTenant<T>(
    tenantId: string,
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      await sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PII = ['Xiomara', 'Quintanilla', 'xiomara@example.com', '+57 300 555 0101'];

function fecha(desdeHoy: number): string {
  return new Date(Date.now() + desdeHoy * DAY).toISOString().slice(0, 10);
}

d('seguimiento del HCN contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new HcnTrackingStore(database);
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `hotel-hcn-${sfx}`;

  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let numero = 0;

  async function crearTenant(slug: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', $2) RETURNING id`,
      [slug, await platformRootId(pool)],
    );
    return rows[0]!.id;
  }

  interface Orden {
    tenantId?: string;
    status?: string;
    vertical?: string;
    provider?: string;
    locator?: string | null;
    checkin?: string;
    /** Hace cuánto se abrió la orden. */
    creadaHace?: number;
  }

  /** Una orden como la deja la saga del Book: con huéspedes y contacto, que el HCN nunca copia. */
  async function orden(opts: Orden = {}): Promise<string> {
    numero += 1;
    const tenantId = opts.tenantId ?? agenciaA;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                             contact_info, total_amount, order_number, status, provider_order_id,
                             provider_booking_ref, created_at)
         VALUES ($1, $2, $3,
                 jsonb_build_object('vertical', $4::text, 'hotelId', '1402689',
                                    'checkinDate', $5::text, 'checkoutDate', '2099-01-01'),
                 '{}'::jsonb,
                 '[{"room":0,"guests":[{"firstName":"Xiomara","lastName":"Quintanilla"}]}]'::jsonb,
                 '{"email":"xiomara@example.com","phone":"+57 300 555 0101"}'::jsonb,
                 34012, $6, $7, $8, $9, now() - make_interval(secs => $10))
         RETURNING id`,
        [
          tenantId,
          usuario,
          opts.provider ?? PROVEEDOR,
          opts.vertical ?? 'hotels',
          opts.checkin ?? fecha(2),
          numero,
          opts.status ?? 'confirmed',
          opts.locator === undefined ? `CONF${numero}` : opts.locator,
          `STT${sfx.toUpperCase()}${String(numero).padStart(9, '0')}`,
          (opts.creadaHace ?? 0) / 1000,
        ],
      );
      await c.query('COMMIT');
      return rows[0]!.id;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function seguimiento(id: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT hcn, hcn_state, hcn_priority, hcn_next_check_at, hcn_attempts, hcn_received_at,
              provider_status, provider_status_source, sub_status
         FROM hotel_order_tracking WHERE order_id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    database.onModuleInit();
    agenciaA = await crearTenant(`hcn-a-${sfx}`);
    agenciaB = await crearTenant(`hcn-b-${sfx}`);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`hcn-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of [agenciaA, agenciaB]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('abre el plan una sola vez, con o sin fila de seguimiento previa, y lo lee con la orden', async () => {
    const sinFila = await orden();
    const conFila = await orden();
    await pool.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, provider_status, provider_status_at, provider_status_source)
       VALUES ($1, $2, 'Confirmed', now(), 'retrieve')`,
      [conFila, agenciaA],
    );
    const hora = Date.now() + 6 * HOUR;

    const abre = await store.open(agenciaA, sinFila, {
      state: 'scheduled',
      priority: 'P2',
      nextAt: hora,
    });
    const reabre = await store.open(agenciaA, sinFila, {
      state: 'stopped',
      priority: null,
      nextAt: null,
    });
    const sobreLectura = await store.open(agenciaA, conFila, {
      state: 'out-of-window',
      priority: null,
      nextAt: hora,
    });

    expect({ abre, reabre, sobreLectura }).toEqual({
      abre: true,
      reabre: false,
      sobreLectura: true,
    });
    expect(await store.findTarget(agenciaA, sinFila)).toMatchObject({
      orderId: sinFila,
      provider: PROVEEDOR,
      status: 'confirmed',
      checkinDate: fecha(2),
      hotelId: '1402689',
      tracking: { state: 'scheduled', priority: 'P2', nextAt: hora, attempts: 0 },
    });
    expect(await seguimiento(conFila)).toMatchObject({
      hcn_state: 'out-of-window',
      provider_status: 'Confirmed',
    });
  });

  it('otro tenant no ve la orden ni le puede abrir un plan', async () => {
    const id = await orden();

    expect(await store.findTarget(agenciaB, id)).toBeUndefined();
    await expect(
      store.open(agenciaB, id, { state: 'scheduled', priority: 'P0', nextAt: Date.now() }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|42501)$/) as unknown });
    expect(await seguimiento(id)).toBeUndefined();
  });

  it('listUnplanned: sólo confirmadas de hotel del tenant, con localizador, del proveedor y en fecha', async () => {
    const buena = await orden();
    await orden({ status: 'pending' });
    await orden({ vertical: 'flights' });
    await orden({ locator: null });
    await orden({ provider: `otro-${sfx}` });
    await orden({ checkin: fecha(-5) });
    await orden({ checkin: 'mañana' });
    const deB = await orden({ tenantId: agenciaB });
    const conPlan = await orden();
    await store.open(agenciaA, conPlan, { state: 'stopped', priority: null, nextAt: null });

    const deA = await store.listUnplanned(agenciaA, {
      providers: [PROVEEDOR],
      checkinFrom: fecha(-1),
      limit: 100,
    });
    const ids = deA.map((t) => t.orderId);

    expect(ids).toContain(buena);
    expect(ids).not.toContain(deB);
    expect(ids).not.toContain(conPlan);
    expect(deA.every((t) => t.status === 'confirmed' && t.providerOrderId !== null)).toBe(true);
    expect(deA.every((t) => t.checkinDate === fecha(2))).toBe(true);
    expect(
      (
        await store.listUnplanned(agenciaB, {
          providers: [PROVEEDOR],
          checkinFrom: fecha(-1),
          limit: 100,
        })
      ).map((t) => t.orderId),
    ).toEqual([deB]);
  });

  it('listDue: lecturas vencidas tras el margen y entradas en ventana, sólo del tenant', async () => {
    const ahora = Date.now();
    const vencida = await orden();
    const enMargen = await orden();
    const entrada = await orden();
    const deB = await orden({ tenantId: agenciaB });
    await store.open(agenciaA, vencida, {
      state: 'scheduled',
      priority: 'P1',
      nextAt: ahora - HOUR,
    });
    await store.open(agenciaA, enMargen, { state: 'scheduled', priority: 'P1', nextAt: ahora });
    await store.open(agenciaA, entrada, { state: 'out-of-window', priority: null, nextAt: ahora });
    await store.open(agenciaB, deB, { state: 'scheduled', priority: 'P1', nextAt: ahora - HOUR });

    const due = await store.listDue(agenciaA, {
      scheduledBefore: ahora - 15 * 60_000,
      windowBefore: ahora,
      limit: 100,
    });
    const ids = due.map((t) => t.orderId);

    expect(ids).toContain(vencida);
    expect(ids).toContain(entrada);
    expect(ids).not.toContain(enMargen);
    expect(ids).not.toContain(deB);
  });

  it('advance: CAS sobre el plan y la reserva; el HCN recibido cumple los CHECK', async () => {
    const id = await orden();
    const ahora = Date.now();
    await store.open(agenciaA, id, { state: 'scheduled', priority: 'P2', nextAt: ahora });

    const otraLectura = await store.advance(
      agenciaA,
      id,
      { state: 'scheduled', attempts: 1 },
      { state: 'scheduled', attempts: 2, nextAt: ahora + HOUR },
    );
    const primera = await store.advance(
      agenciaA,
      id,
      {
        state: 'scheduled',
        attempts: 0,
        snapshot: { subStatus: null, providerStatus: null, hcn: null },
      },
      {
        state: 'scheduled',
        attempts: 1,
        nextAt: ahora + HOUR,
        read: { at: ahora, record: { providerStatus: 'Confirmed', refundAwaited: false } },
      },
    );
    const fotoVieja = await store.advance(
      agenciaA,
      id,
      {
        state: 'scheduled',
        attempts: 1,
        snapshot: { subStatus: null, providerStatus: null, hcn: null },
      },
      { state: 'stopped', attempts: 2, nextAt: null },
    );
    const deOtroTenant = await store.advance(
      agenciaB,
      id,
      { state: 'scheduled', attempts: 1 },
      { state: 'stopped', attempts: 1, nextAt: null },
    );
    const recibido = await store.advance(
      agenciaA,
      id,
      {
        state: 'scheduled',
        attempts: 1,
        snapshot: { subStatus: null, providerStatus: 'Confirmed', hcn: null },
      },
      {
        state: 'received',
        attempts: 2,
        nextAt: null,
        read: { at: ahora + HOUR, subStatus: null, hcn: 'HCN-4711' },
      },
    );

    expect({ otraLectura, primera, fotoVieja, deOtroTenant, recibido }).toEqual({
      otraLectura: false,
      primera: true,
      fotoVieja: false,
      deOtroTenant: false,
      recibido: true,
    });
    expect(await seguimiento(id)).toMatchObject({
      hcn: 'HCN-4711',
      hcn_state: 'received',
      hcn_next_check_at: null,
      hcn_attempts: 2,
      provider_status: 'Confirmed',
      provider_status_source: 'hcn',
    });
  });

  it('la tarea hcn-ticket nace en la transacción del "perdido", con RLS del tenant de la orden', async () => {
    const id = await orden();
    await store.open(agenciaA, id, { state: 'scheduled', priority: 'P2', nextAt: Date.now() });
    const tarea = { vertical: 'hotels', reason: 'sla-exhausted', attempts: HCN_READS };

    const pierde = await store.advance(
      agenciaA,
      id,
      { state: 'scheduled', attempts: 2 },
      { state: 'missing', attempts: HCN_READS, nextAt: null, ticket: tarea },
    );
    const gana = await store.advance(
      agenciaA,
      id,
      { state: 'scheduled', attempts: 0 },
      { state: 'missing', attempts: HCN_READS, nextAt: null, ticket: tarea },
    );

    expect({ pierde, gana }).toEqual({ pierde: false, gana: true });
    const { rows } = await pool.query<{
      tenant_id: string;
      type: string;
      status: string;
      result: unknown;
      actor_user_id: string | null;
    }>(
      `SELECT tenant_id, type, status, result, actor_user_id FROM order_operations WHERE order_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        tenant_id: agenciaA,
        type: 'hcn-ticket',
        status: 'pending',
        result: tarea,
        actor_user_id: null,
      },
    ]);
  });

  it('de punta a punta con el servicio: plan, cuatro lecturas sin HCN y tarea sin PII', async () => {
    const id = await orden({ creadaHace: 10 * HOUR });
    const proveedor = new StubHotelProviderFactory({ code: PROVEEDOR });
    const audit = new RecordingAuditService();
    const queue = new RecordingQueueService();
    const service = new HcnTrackingService(
      hotelRegistry([proveedor], hotelFlags(true)),
      store,
      new CircuitBreakerService(),
      audit.asService(),
      queue.asService(),
    );

    // El barrido de la agencia B adopta lo suyo y no ve la orden de A (pendiente c: tenant por
    // tenant, con RLS).
    await service.sweepTenant(agenciaB);
    expect(await seguimiento(id)).toBeUndefined();
    // La confirmación abre el plan: la primera lectura ya venció (la orden tiene 10 h).
    expect(await service.schedule({ tenantId: agenciaA, orderId: id })).toEqual({
      opened: true,
      queued: true,
    });
    for (let attempt = 0; attempt < HCN_READS; attempt += 1) {
      await service.runJob({ tenantId: agenciaA, orderId: id, attempt }, { final: false });
      // El reloj de la prueba no espera una hora: la próxima lectura se adelanta como superusuario.
      await pool.query(
        `UPDATE hotel_order_tracking SET hcn_next_check_at = now() - interval '1 minute'
          WHERE order_id = $1 AND hcn_next_check_at IS NOT NULL`,
        [id],
      );
    }

    expect(await seguimiento(id)).toMatchObject({
      hcn_state: 'missing',
      hcn_attempts: HCN_READS,
      hcn_next_check_at: null,
      provider_status_source: 'hcn',
    });
    expect(queue.hcnChecks.filter((j) => j.orderId === id).map((j) => j.attempt)).toEqual([
      0, 1, 2, 3,
    ]);
    const { rows } = await pool.query<{ result: string }>(
      `SELECT result::text AS result FROM order_operations WHERE order_id = $1 AND type = 'hcn-ticket'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.result)).toMatchObject({
      reason: 'sla-exhausted',
      hotelId: '1402689',
      checkinDate: fecha(2),
      checkoutDate: '2099-01-01',
    });
    for (const dato of PII) {
      expect(rows[0]!.result).not.toContain(dato);
      expect(audit.dump()).not.toContain(dato);
    }
    expect(audit.types()).toContain('HotelConfirmationNumberMissing');
  });

  describe('HARD-3: el HCN que llega con la tarea abierta la cierra', () => {
    const tarea = { vertical: 'hotels', reason: 'sla-exhausted', priority: 'P2' };

    /** Un plan agotado con su tarea, como lo deja la cuarta lectura sin HCN. */
    async function agotada(): Promise<string> {
      const id = await orden();
      await store.open(agenciaA, id, { state: 'scheduled', priority: 'P2', nextAt: Date.now() });
      await store.advance(
        agenciaA,
        id,
        { state: 'scheduled', attempts: 0 },
        { state: 'missing', attempts: HCN_READS, nextAt: null, ticket: tarea },
      );
      return id;
    }

    async function tareas(ids: readonly string[]) {
      const { rows } = await pool.query<{ order_id: string; status: string; result: unknown }>(
        `SELECT order_id, status, result FROM order_operations
          WHERE order_id = ANY($1::uuid[]) AND type = 'hcn-ticket'`,
        [ids],
      );
      return new Map(rows.map((r) => [r.order_id, r]));
    }

    it('por la consulta manual: la tarea pasa a success con motivo y fuente; la de otra orden, no', async () => {
      const id = await agotada();
      const otra = await agotada();
      const proveedor = new StubHotelProviderFactory({ code: PROVEEDOR });
      proveedor.adapterFor(agenciaA).getBooking.mockImplementation((locator: string) =>
        Promise.resolve({
          found: true,
          providerBookingId: locator,
          status: 'CONFIRMED',
          providerStatus: 'Confirmed',
          hotelConfirmationNumber: 'HCN-4711',
          warnings: [],
        }),
      );
      const reads = new HotelOrderReadsService(
        hotelRegistry([proveedor], hotelFlags(true)),
        new HotelOrderTrackingStore(database),
        new CircuitBreakerService(),
        new RecordingAuditService().asService(),
      );

      const leida = await reads.retrieve(agenciaA, id);

      expect(leida.tracking).toMatchObject({
        hotelConfirmationNumber: 'HCN-4711',
        hcnState: 'received',
      });
      const porOrden = await tareas([id, otra]);
      expect(porOrden.get(id)).toMatchObject({
        status: 'success',
        result: {
          ...tarea,
          resolution: { by: 'system', reason: 'hcn-received', source: 'retrieve' },
        },
      });
      const { resolution } = porOrden.get(id)!.result as { resolution: { at: string } };
      expect(Number.isNaN(Date.parse(resolution.at))).toBe(false);
      expect(JSON.stringify(porOrden.get(id)!.result)).not.toContain('HCN-4711');
      expect(porOrden.get(otra)).toMatchObject({ status: 'pending', result: tarea });
    });

    it('por una lectura del plan: se cierra en la misma escritura que guarda el HCN, con RLS', async () => {
      const id = await orden();
      await store.open(agenciaA, id, { state: 'scheduled', priority: 'P2', nextAt: Date.now() });
      // Una tarea que quedó abierta de antes: la siembra el superusuario.
      await pool.query(
        `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
         VALUES ($1, $2, 'hcn-ticket', 'pending', $3::jsonb)`,
        [agenciaA, id, JSON.stringify(tarea)],
      );

      const deOtroTenant = await store.advance(
        agenciaB,
        id,
        { state: 'scheduled', attempts: 0 },
        { state: 'received', attempts: 1, nextAt: null, read: { at: Date.now(), hcn: 'HCN-1' } },
      );
      expect(deOtroTenant).toBe(false);
      expect((await tareas([id])).get(id)?.status).toBe('pending');

      const recibido = await store.advance(
        agenciaA,
        id,
        { state: 'scheduled', attempts: 0 },
        { state: 'received', attempts: 1, nextAt: null, read: { at: Date.now(), hcn: 'HCN-1' } },
      );

      expect(recibido).toBe(true);
      expect((await tareas([id])).get(id)).toMatchObject({
        status: 'success',
        result: { resolution: { reason: 'hcn-received', source: 'hcn' } },
      });
      expect(await seguimiento(id)).toMatchObject({ hcn: 'HCN-1', hcn_state: 'received' });
    });
  });
});
