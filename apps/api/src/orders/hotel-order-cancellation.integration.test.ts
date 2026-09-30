import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelBookingView, HotelCancelResult } from '@sales-travel/domain';
import { TboApiError } from '@sales-travel/tbo-hotels';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import {
  clearWalletHoldsOfTenants,
  retainAsSuperuser,
} from '../portfolios/__fixtures__/wallet-hold-seed.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { encryptCredentials } from '../provider-credentials/credentials-cipher.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import type { TenantAdapter } from '../providers/provider.types.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import { HotelOrderCancellationStore } from './hotel-order-cancellation.store.js';
import { OrdersService } from './orders.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * La cancelación de una orden de hotel contra Postgres real (docs/tbo/09 PR-5.3; 08 RF-25, RF-38;
 * migración 0046): el claim, la respuesta y el seguimiento en UNA transacción, el calendario de
 * `verify-cancellation` con sus CAS, el cierre en la dirección segura y la retención de la cartera.
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado; el
 * superusuario sólo siembra y mira. Requiere las migraciones hasta la 0046. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const MIGRACION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'db',
  'migrations',
  '0046_hotel_cancellation_verification.sql',
);

const MIN = 60_000;

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

d('cancelación de hoteles contra Postgres (0046)', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const creds = new ProviderCredentialsService(database);
  const sfx = randomBytes(4).toString('hex');
  // Sintético: el índice de referencias es global y esto no puede chocar con una reserva real.
  const PROVEEDOR = `hotel-cx-${sfx}`;
  const RETENIDO = 95_000;

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let cuenta: string;
  let cartera: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'USD', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  /** Una orden confirmada de la agencia A, con la cuenta de la red y su retención de cartera. */
  async function orden(): Promise<string> {
    numero += 1;
    const oferta = {
      vertical: 'hotels',
      checkinDate: '2099-10-10',
      roompack: {
        price: { total: { amountMinor: 80_000, currency: 'USD' } },
        rooms: [{ name: 'Doble' }],
        cancellation: {
          refundable: true,
          status: 'partially_refundable',
          policySource: 'prebook-final',
          rules: [
            { type: 'Percentage', fromLocalDateTime: '2000-01-01T00:00:00', penaltyPercentage: 25 },
          ],
        },
      },
    };
    const c = await pool.connect();
    let id: string;
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [agenciaA]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                             selected_offer, passengers, contact_info, total_amount, currency,
                             order_number, status, provider_raw, provider_booking_ref,
                             provider_account_id)
         VALUES ($1, $2, $3, $4, '{"vertical":"hotels","checkoutDate":"2099-10-12"}'::jsonb,
                 $5::jsonb, '[{"firstName":"Ana"}]'::jsonb, '{"email":"ana@x.test"}'::jsonb,
                 $6, 'USD', $7, 'confirmed', '{"phase":"create"}'::jsonb, $8, $9)
         RETURNING id`,
        [
          agenciaA,
          usuario,
          PROVEEDOR,
          `LOC${sfx}${numero}`.toUpperCase(),
          JSON.stringify(oferta),
          RETENIDO,
          numero,
          `STT${sfx.toUpperCase()}${String(numero).padStart(9, '0')}`,
          cuenta,
        ],
      );
      id = rows[0]!.id;
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    // La retención de la reserva, como la deja 0060 (desde ahí `app_user` no escribe asientos de
    // retención ni mueve el saldo): la cuenta es del consolidador, así que retiene sólo la agencia.
    await retainAsSuperuser(pool, agenciaA, id, usuario);
    return id;
  }

  class ProveedorDeLaRed extends StubHotelProviderFactory {
    readonly adapter = new StubHotelAdapter(PROVEEDOR);

    constructor() {
      super({ code: PROVEEDOR, capabilities: { retrieve: true, cancel: true } });
    }

    async resolveForOrder(
      tenantId: string,
      orderId: string,
    ): Promise<TenantAdapter<HotelProviderAdapter>> {
      // La cuenta de la orden con la bóveda REAL (0045): sólo si sigue en la red del tenant.
      await creds.resolveForOrder(tenantId, orderId);
      return { adapter: this.adapter, credentialSource: 'inherited' };
    }
  }

  function servicios() {
    const proveedor = new ProveedorDeLaRed();
    const audit = new RecordingAuditService();
    const queue = new RecordingQueueService();
    const store = new HotelOrderCancellationStore(database);
    const cancellations = new HotelOrderCancellationService(
      hotelRegistry([proveedor], hotelFlags(false)),
      store,
      new CircuitBreakerService(),
      audit.asService(),
      queue.asService(),
      new BookingHoldLedger(database),
    );
    const orders = new OrdersService(
      database,
      {} as unknown as FlightProviderRegistry,
      queue.asService(),
      {} as unknown as AgentCarsProviderFactory,
      audit.asService(),
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      undefined,
      cancellations,
    );
    return { proveedor, audit, queue, store, cancellations, orders };
  }

  async function fila(id: string) {
    const { rows } = await pool.query<{
      status: string;
      sub_status: string | null;
      provider_status: string | null;
      provider_status_source: string | null;
      cancel_verify_step: number | null;
      anchor: string | null;
      next: string | null;
    }>(
      `SELECT o.status, t.sub_status, t.provider_status, t.provider_status_source,
              t.cancel_verify_step,
              (extract(epoch FROM t.cancel_verify_anchor_at) * 1000)::bigint::text AS anchor,
              (extract(epoch FROM t.cancel_verify_next_at) * 1000)::bigint::text AS next
       FROM orders o LEFT JOIN hotel_order_tracking t ON t.order_id = o.id WHERE o.id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function operaciones(id: string) {
    const { rows } = await pool.query<{ status: string; result: Record<string, unknown> }>(
      `SELECT status, result FROM order_operations WHERE order_id = $1 AND type = 'cancel' ORDER BY created_at`,
      [id],
    );
    return rows;
  }

  async function saldo(): Promise<number> {
    const { rows } = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor FROM agency_portfolios WHERE id = $1',
      [cartera],
    );
    return Number(rows[0]!.balance_minor);
  }

  function cancelada(): HotelBookingView {
    return {
      found: true,
      status: 'CANCELLED',
      providerStatus: 'Cancelled',
      warnings: [],
    };
  }

  beforeAll(async () => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    database.onModuleInit();

    consolidador = await crearTenant(`cx-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`cx-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`cx-b-${sfx}`, 'agency', consolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`cx-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
    // Quien firma la retención tiene que ser de la red de la reserva (0060).
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', 'active')`,
      [agenciaA, usuario],
    );
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, '{"environment":"test"}'::jsonb, true, 'active') RETURNING id`,
      [
        consolidador,
        PROVEEDOR,
        encryptCredentials(JSON.stringify({ username: 'u', password: 'no-es-real' })),
      ],
    );
    cuenta = acc.rows[0]!.id;
    const p = await pool.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, credit_limit_minor, balance_minor, currency, status)
       VALUES ($1, 1000000, 500000, 'USD', 'active') RETURNING id`,
      [agenciaA],
    );
    cartera = p.rows[0]!.id;
  });

  afterAll(async () => {
    // Las retenciones son ON DELETE RESTRICT: se borran antes que las órdenes y los tenants.
    await clearWalletHoldsOfTenants(
      pool,
      [agenciaA, agenciaB, consolidador].filter((id) => id !== undefined),
    );
    for (const id of [agenciaA, agenciaB, consolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('en curso: pending con el seguimiento escrito en la misma transacción; la lectura la cierra y libera la cartera', async () => {
    const s = servicios();
    const id = await orden();
    const saldoRetenido = await saldo();
    const enCurso: HotelCancelResult = {
      success: true,
      bookingStatus: 'CANCELLATION_IN_PROGRESS',
      providerStatus: 'CxlRequestSentToHotel',
      warnings: [],
    };
    s.proveedor.adapter.cancelBooking.mockResolvedValue(enCurso);

    const { result } = await s.orders.cancelOrder(agenciaA, id, 'X', usuario);

    expect(result).toMatchObject({ success: true, settlement: 'in-progress' });
    const antes = await fila(id);
    expect(antes).toMatchObject({
      status: 'pending',
      sub_status: null,
      provider_status: 'CxlRequestSentToHotel',
      provider_status_source: 'cancel',
      cancel_verify_step: 0,
    });
    expect(Number(antes.next) - Number(antes.anchor)).toBe(2 * MIN);
    expect(await operaciones(id)).toMatchObject([
      { status: 'success', result: { outcome: 'SUCCEEDED', settlement: 'in-progress' } },
    ]);
    expect(await saldo()).toBe(saldoRetenido);

    s.proveedor.adapter.getBooking.mockResolvedValue(cancelada());
    const [job] = s.queue.cancelVerifications;
    await s.cancellations.runJob(job, { final: false });

    expect(await fila(id)).toMatchObject({
      status: 'cancelled',
      provider_status: 'Cancelled',
      provider_status_source: 'verify',
      cancel_verify_step: 1,
      next: null,
    });
    expect(await saldo()).toBe(saldoRetenido + RETENIDO);
    // Un segundo cierre (el barrido con el mismo paso) no vuelve a acreditar.
    await s.cancellations.runJob(job, { final: false });
    expect(await saldo()).toBe(saldoRetenido + RETENIDO);
    expect(s.proveedor.adapter.cancelBooking).toHaveBeenCalledOnce();
  });

  it('UNVERIFIED: la operación queda a conciliar, y el barrido la resuelve con la lectura', async () => {
    const s = servicios();
    const id = await orden();
    s.proveedor.adapter.cancelBooking.mockRejectedValue(
      new TboApiError({
        status: 0,
        path: '/Cancel',
        kind: 'TRANSPORT',
        requestId: 'r',
        timedOut: true,
      }),
    );

    await expect(s.orders.cancelOrder(agenciaA, id, 'X', usuario)).rejects.toThrow(
      /no confirmó si la cancelación se aplicó/,
    );
    const antes = await fila(id);
    expect(antes).toMatchObject({
      status: 'pending',
      sub_status: 'cancel-unverified',
      cancel_verify_step: 0,
    });
    expect(await operaciones(id)).toMatchObject([
      { status: 'failed', result: { outcome: 'UNVERIFIED' } },
    ]);

    // El barrido de OTRA agencia de la red no ve esta orden (RLS por tenant).
    expect(
      (await s.cancellations.sweepTenant(agenciaB, Number(antes.anchor) + 20 * MIN)).examined,
    ).toBe(0);

    s.proveedor.adapter.getBooking.mockResolvedValue(cancelada());
    const report = await s.cancellations.sweepTenant(agenciaA, Number(antes.anchor) + 20 * MIN);

    expect(report).toMatchObject({ examined: 1, closed: 1 });
    expect(await fila(id)).toMatchObject({ status: 'cancelled', sub_status: null, next: null });
    expect(await operaciones(id)).toMatchObject([
      {
        status: 'success',
        result: {
          outcome: 'SUCCEEDED',
          resolvedBy: 'verify-cancellation',
          priorOrderStatus: 'confirmed',
        },
      },
    ]);
    expect(s.proveedor.adapter.cancelBooking).toHaveBeenCalledOnce();
  });

  it('HARD-2: una lectura del barrido que falla reprograma el paso con backoff, sin avanzarlo', async () => {
    const s = servicios();
    const id = await orden();
    s.proveedor.adapter.cancelBooking.mockRejectedValue(
      new TboApiError({
        status: 0,
        path: '/Cancel',
        kind: 'TRANSPORT',
        requestId: 'r',
        timedOut: true,
      }),
    );
    await expect(s.orders.cancelOrder(agenciaA, id, 'X', usuario)).rejects.toThrow();
    const anchor = Number((await fila(id)).anchor);

    s.proveedor.adapter.getBooking.mockRejectedValue(
      new TboApiError({ status: 503, path: '/BookingDetail', kind: 'UPSTREAM', requestId: 'r' }),
    );
    const report = await s.cancellations.sweepTenant(agenciaA, anchor + 20 * MIN);

    expect(report).toMatchObject({ examined: 1, unavailable: 1, failed: 0 });
    // Leyó como el paso 1 (+15 min), vencido hace 5: la próxima, una corrida del barrido después.
    expect(await fila(id)).toMatchObject({
      status: 'pending',
      sub_status: 'cancel-unverified',
      cancel_verify_step: 0,
      anchor: String(anchor),
      next: String(anchor + 35 * MIN),
    });
    // El CAS sobre el ancla: un calendario de otra cancelación no se toca.
    await expect(
      s.store.postpone(agenciaA, id, { anchorAt: anchor - 1, step: 0 }, anchor + 60 * MIN),
    ).resolves.toBe(false);
    await expect(
      s.store.postpone(agenciaB, id, { anchorAt: anchor, step: 0 }, anchor + 60 * MIN),
    ).resolves.toBe(false);
    expect((await fila(id)).next).toBe(String(anchor + 35 * MIN));
  });

  it('el cierre es atómico: si la orden ya no está pendiente, tampoco avanza el paso', async () => {
    const s = servicios();
    const id = await orden();
    s.proveedor.adapter.cancelBooking.mockResolvedValue({
      success: true,
      bookingStatus: 'CANCELLATION_IN_PROGRESS',
      providerStatus: 'CancelPending',
      warnings: [],
    });
    await s.orders.cancelOrder(agenciaA, id, 'X', usuario);
    // Otro camino (una persona) movió la orden.
    await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [id]);

    await expect(
      s.store.close(agenciaA, id, 0, { at: Date.now(), source: 'verify', subStatus: null }),
    ).resolves.toBe(false);

    expect(await fila(id)).toMatchObject({ status: 'confirmed', cancel_verify_step: 0 });
    expect((await fila(id)).next).not.toBeNull();
  });

  it('un claim nuevo apaga el calendario anterior dentro de su transacción', async () => {
    const s = servicios();
    const id = await orden();
    s.proveedor.adapter.cancelBooking.mockResolvedValueOnce({
      success: false,
      error: 'TBO_CANCEL_FAIL',
      warnings: ['POST_CANCEL_READ_FAILED'],
    });
    await s.orders.cancelOrder(agenciaA, id, 'X', usuario);
    expect(await fila(id)).toMatchObject({ status: 'confirmed', cancel_verify_step: 0 });

    await database.withTenant(agenciaA, (trx) => s.store.markRequested(trx, agenciaA, id));

    expect(await fila(id)).toMatchObject({ sub_status: 'cancel-requested', next: null });
  });

  describe('la orden que queda cancelled cierra su tarea hcn-ticket y corta el plan (04 §8.6)', () => {
    const TAREA = { vertical: 'hotels', reason: 'sla-exhausted', priority: 'P0', attempts: 4 };

    /**
     * El seguimiento como lo deja el HCN: `missing` con su tarea abierta, o `scheduled` con una
     * lectura por delante. Lo siembra el superusuario, como lo habría escrito el seguimiento.
     */
    async function conSeguimiento(id: string, estado: 'missing' | 'scheduled'): Promise<void> {
      await pool.query(
        `INSERT INTO hotel_order_tracking (order_id, tenant_id, hcn_state, hcn_priority, hcn_attempts, hcn_next_check_at)
         VALUES ($1, $2, $3, 'P0', $4, $5)`,
        [
          id,
          agenciaA,
          estado,
          estado === 'missing' ? 4 : 1,
          estado === 'scheduled' ? new Date(Date.now() + 60 * MIN) : null,
        ],
      );
      if (estado === 'missing') {
        await pool.query(
          `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
           VALUES ($1, $2, 'hcn-ticket', 'pending', $3::jsonb)`,
          [agenciaA, id, JSON.stringify(TAREA)],
        );
      }
    }

    async function tareas(id: string) {
      const { rows } = await pool.query<{ status: string; result: Record<string, unknown> }>(
        `SELECT status, result FROM order_operations WHERE order_id = $1 AND type = 'hcn-ticket'`,
        [id],
      );
      return rows;
    }

    async function plan(id: string) {
      const { rows } = await pool.query<{ hcn_state: string | null; next: Date | null }>(
        `SELECT hcn_state, hcn_next_check_at AS next FROM hotel_order_tracking WHERE order_id = $1`,
        [id],
      );
      return rows[0]!;
    }

    function cerrada(source: string) {
      return {
        status: 'success',
        result: {
          ...TAREA,
          resolution: {
            by: 'system',
            reason: 'order-cancelled',
            source,
            at: expect.any(String) as string,
          },
        },
      };
    }

    it('la cancelación que la deja cancelled cierra la tarea en su transacción; otra orden no se toca', async () => {
      const s = servicios();
      const id = await orden();
      const vecina = await orden();
      await conSeguimiento(id, 'missing');
      await conSeguimiento(vecina, 'missing');
      s.proveedor.adapter.cancelBooking.mockResolvedValue({
        success: true,
        bookingStatus: 'CANCELLED',
        providerStatus: 'Cancelled',
        warnings: [],
      });

      const antes = Date.now();
      const { result } = await s.orders.cancelOrder(agenciaA, id, 'X', usuario);

      expect(result).toMatchObject({ success: true, settlement: 'final' });
      expect(await fila(id)).toMatchObject({ status: 'cancelled' });
      const [tarea] = await tareas(id);
      expect(tarea).toMatchObject(cerrada('cancel'));
      const at = Date.parse(String((tarea!.result['resolution'] as { at: string }).at));
      expect(at).toBeGreaterThanOrEqual(antes - 1_000);
      // Un HCN dado por perdido queda como estaba: no tenía nada programado.
      expect(await plan(id)).toEqual({ hcn_state: 'missing', next: null });
      expect(await tareas(vecina)).toMatchObject([{ status: 'pending', result: TAREA }]);
    });

    it('con el plan en curso, la cancelación lo corta y apaga su próxima lectura', async () => {
      const s = servicios();
      const id = await orden();
      await conSeguimiento(id, 'scheduled');
      s.proveedor.adapter.cancelBooking.mockResolvedValue({
        success: true,
        bookingStatus: 'CANCELLED',
        providerStatus: 'Cancelled',
        warnings: [],
      });

      await s.orders.cancelOrder(agenciaA, id, 'X', usuario);

      expect(await plan(id)).toEqual({ hcn_state: 'stopped', next: null });
    });

    it('en curso la tarea sigue abierta; la verificación que cierra la orden, la cierra', async () => {
      const s = servicios();
      const id = await orden();
      await conSeguimiento(id, 'missing');
      s.proveedor.adapter.cancelBooking.mockResolvedValue({
        success: true,
        bookingStatus: 'CANCELLATION_IN_PROGRESS',
        providerStatus: 'CancelPending',
        warnings: [],
      });
      await s.orders.cancelOrder(agenciaA, id, 'X', usuario);
      expect(await tareas(id)).toMatchObject([{ status: 'pending', result: TAREA }]);

      s.proveedor.adapter.getBooking.mockResolvedValue(cancelada());
      const [job] = s.queue.cancelVerifications;
      await s.cancellations.runJob(job, { final: false });

      expect(await fila(id)).toMatchObject({ status: 'cancelled' });
      expect(await tareas(id)).toMatchObject([cerrada('verify')]);
    });

    it('la conciliación que la ve cancelada fuera de la plataforma la cierra, aunque el plan no lo pida', async () => {
      const s = servicios();
      const id = await orden();
      await conSeguimiento(id, 'missing');
      const cambio = {
        from: 'confirmed',
        to: 'cancelled',
        expected: { subStatus: null, providerStatus: null, hcn: null, hcnState: 'missing' },
        write: {
          at: Date.now(),
          source: 'reconciliation',
          subStatus: null,
          record: { providerStatus: 'Cancelled', refundAwaited: false },
        },
      } as const;

      // Con la tarea todavía abierta: la conciliación de OTRA agencia de la red no cancela esta
      // orden ni cierra su tarea.
      await expect(s.store.transitionByReading(agenciaB, id, cambio)).resolves.toBe(false);
      expect(await fila(id)).toMatchObject({ status: 'confirmed' });
      expect(await tareas(id)).toMatchObject([{ status: 'pending', result: TAREA }]);

      await expect(s.store.transitionByReading(agenciaA, id, cambio)).resolves.toBe(true);

      expect(await fila(id)).toMatchObject({ status: 'cancelled' });
      expect(await tareas(id)).toMatchObject([cerrada('reconciliation')]);
    });

    it('si el cierre de la orden se deshace, la tarea queda abierta', async () => {
      const s = servicios();
      const id = await orden();
      s.proveedor.adapter.cancelBooking.mockResolvedValue({
        success: true,
        bookingStatus: 'CANCELLATION_IN_PROGRESS',
        providerStatus: 'CancelPending',
        warnings: [],
      });
      await s.orders.cancelOrder(agenciaA, id, 'X', usuario);
      await pool.query(
        `UPDATE hotel_order_tracking SET hcn_state = 'missing', hcn_priority = 'P0', hcn_attempts = 4 WHERE order_id = $1`,
        [id],
      );
      await pool.query(
        `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
         VALUES ($1, $2, 'hcn-ticket', 'pending', $3::jsonb)`,
        [agenciaA, id, JSON.stringify(TAREA)],
      );
      // Otro camino (una persona) movió la orden antes de que la verificación la cerrara.
      await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [id]);

      const cierre = { at: Date.now(), source: 'verify', subStatus: null } as const;

      await expect(s.store.close(agenciaA, id, 0, cierre)).resolves.toBe(false);

      expect(await tareas(id)).toMatchObject([{ status: 'pending', result: TAREA }]);
      expect(await plan(id)).toMatchObject({ hcn_state: 'missing' });
      expect(await fila(id)).toMatchObject({ status: 'confirmed', cancel_verify_step: 0 });

      // Con la orden de nuevo `pending`, el MISMO cierre gana: el CAS del paso coincidía, así que
      // el primero sí cerró la tarea dentro de su transacción y la deshizo con el resto.
      await pool.query(`UPDATE orders SET status = 'pending' WHERE id = $1`, [id]);
      await expect(s.store.close(agenciaA, id, 0, cierre)).resolves.toBe(true);
      expect(await tareas(id)).toMatchObject([cerrada('verify')]);
    });
  });
});

// ---------------------------------------------------------------------------
// Sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no cuenta como verde.
// ---------------------------------------------------------------------------

describe('0046, sin base de datos', () => {
  const texto = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');

  it('el paso y el ancla van juntos, y sólo se despierta una fila con calendario', () => {
    expect(texto).toMatch(
      /CHECK \(\(cancel_verify_anchor_at IS NULL\) = \(cancel_verify_step IS NULL\)\)/,
    );
    expect(texto).toMatch(
      /CHECK \(cancel_verify_next_at IS NULL OR cancel_verify_anchor_at IS NOT NULL\)/,
    );
    expect(texto).toMatch(/cancel_verify_step\s+SMALLINT CHECK \(cancel_verify_step >= 0\)/);
  });

  it('el barrido encuentra lo vencido por índice parcial', () => {
    expect(texto).toMatch(
      /CREATE INDEX idx_hotel_order_tracking_cancel_verify_due\s+ON hotel_order_tracking \(cancel_verify_next_at\)\s+WHERE cancel_verify_next_at IS NOT NULL/,
    );
  });

  it('es aditiva: no toca la RLS ni las columnas de 0042 y 0044', () => {
    expect(texto).not.toMatch(/POLICY|DISABLE ROW LEVEL SECURITY|DROP /);
    expect(texto).not.toMatch(/\bverify_(anchor_at|step|next_at)\b(?<!cancel_verify_\w+)/);
  });
});
