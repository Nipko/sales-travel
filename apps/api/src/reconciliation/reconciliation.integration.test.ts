import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import type {
  HotelBookingDateRange,
  HotelBookingSummary,
  HotelBookingView,
  HotelBookingsByDatePort,
  HotelBookingsByDateResult,
  SearchContext,
} from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  RECONCILIATION_ITEM_ACTIONS,
  RECONCILIATION_RUN_STATUSES,
  RECONCILIATION_RUN_TRIGGERS,
  type DB,
} from '../database/database.types.js';
import type { HcnTrackingService } from '../hotels/hcn-tracking.service.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import { HotelOrderCancellationStore } from '../orders/hotel-order-cancellation.store.js';
import { HotelOrderTrackingStore } from '../orders/hotel-order-tracking.store.js';
import {
  DISCREPANCY_SEVERITIES,
  ORDER_EVENTS,
  RECONCILIATION_DISCREPANCY_KINDS,
} from '../orders/order-events.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { encryptCredentials } from '../provider-credentials/credentials-cipher.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import type { TenantAdapter } from '../providers/provider.types.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationStore } from './reconciliation.store.js';

/**
 * La conciliación contra Postgres real (docs/tbo/09 PR-5.5; migración 0047; 08 RF-28 CA; RNF-06
 * puntos 5 y 6; 06 §7.5, última fila; pendiente c de la Fase 5).
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado: como
 * superusuario la RLS no aplica y el aislamiento no probaría nada. El superusuario sólo siembra y
 * mira. La red es la de RF-29: un consolidador con una cuenta heredada por dos agencias, y otro
 * consolidador, fuera de esa red, con su agencia.
 *
 * Requiere las migraciones hasta la 0047. Se SALTA sin PGHOST; lo de abajo del todo corre siempre.
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
  '0047_provider_reconciliation.sql',
);

const DAY = 86_400_000;

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

function fecha(diasDesdeHoy: number): string {
  return new Date(Date.now() + diasDesdeHoy * DAY).toISOString().slice(0, 10);
}

d('conciliación contra Postgres (0047)', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new ReconciliationStore(database);
  const sfx = randomBytes(4).toString('hex');
  // Sintético: el índice de referencias es global y esto no puede chocar con una reserva real.
  const PROVEEDOR = `hotel-rc-${sfx}`;
  const REF = (n: number) => `STR${sfx.toUpperCase()}${String(n).padStart(9, '0')}`;

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let otroConsolidador: string;
  let agenciaAjena: string;
  let usuario: string;
  let cuenta: string;
  let cuentaAjena: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre],
    );
    return rows[0]!.id;
  }

  async function crearCuenta(tenantId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, '{"environment":"test"}'::jsonb, true, 'active') RETURNING id`,
      [tenantId, PROVEEDOR, encryptCredentials(JSON.stringify({ username: 'u', password: 'p' }))],
    );
    return rows[0]!.id;
  }

  interface Orden {
    tenantId: string;
    cuenta?: string;
    status?: string;
    locator?: string | null;
    /** `null` = un intent sin desenlace: sin `provider_raw`. */
    raw?: string | null;
    creadaHace?: number;
    checkout?: string;
    requestKey?: string | null;
  }

  /** Inserta la orden como `app_user` y su tenant, con huéspedes que nada puede copiar. */
  async function orden(o: Orden): Promise<{ id: string; ref: string; locator: string | null }> {
    numero += 1;
    const ref = REF(numero);
    const locator = o.locator === undefined ? `LC${sfx}${numero}`.toUpperCase() : o.locator;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [o.tenantId]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                             selected_offer, passengers, contact_info, total_amount, order_number,
                             status, provider_raw, provider_booking_ref, provider_account_id,
                             create_request_key, created_at)
         VALUES ($1, $2, $3, $4, jsonb_build_object('vertical', 'hotels', 'checkoutDate', $5::text),
                 '{"pricing":{"netMinor":50000,"currency":"USD"}}'::jsonb,
                 '[{"firstName":"Xiomara","lastName":"Quintanilla"}]'::jsonb,
                 '{"email":"xiomara@example.com"}'::jsonb,
                 34012, $6, $7, $8::jsonb, $9, $10, $11, now() - make_interval(secs => $12))
         RETURNING id`,
        [
          o.tenantId,
          usuario,
          PROVEEDOR,
          locator,
          o.checkout ?? fecha(60),
          numero,
          o.status ?? 'confirmed',
          o.raw === undefined ? '{"phase":"create"}' : o.raw,
          ref,
          o.cuenta ?? cuenta,
          o.requestKey ?? null,
          (o.creadaHace ?? DAY) / 1000,
        ],
      );
      await c.query('COMMIT');
      return { id: rows[0]!.id, ref, locator };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /** Adapter con reservas por fecha: el stub más el puerto opcional de la conciliación. */
  class Listado extends StubHotelAdapter implements HotelBookingsByDatePort {
    readonly maxBookingDateWindowDays = 60;
    filas: HotelBookingSummary[] = [];
    lecturas = new Map<string, HotelBookingView>();
    readonly listBookingsByDate = vi.fn(
      (range: HotelBookingDateRange, _ctx: SearchContext): Promise<HotelBookingsByDateResult> =>
        Promise.resolve({
          range,
          bookings: this.filas.filter(
            (f) => f.bookingDate >= range.from && f.bookingDate <= range.to,
          ),
        }),
    );

    constructor() {
      super(PROVEEDOR);
      this.getBooking.mockImplementation((locator: string) =>
        Promise.resolve(this.lecturas.get(locator) ?? { found: false, warnings: [] }),
      );
    }
  }

  /** La cuenta la resuelve la bóveda REAL: la del dueño por id, la de la orden por 0045. */
  class Proveedor extends StubHotelProviderFactory {
    readonly listado = new Listado();

    constructor(private readonly creds: ProviderCredentialsService) {
      super({ code: PROVEEDOR });
    }

    async resolveForAccount(
      owner: string,
      accountId: string,
    ): Promise<TenantAdapter<HotelProviderAdapter>> {
      await this.creds.resolveOwnAccount(owner, accountId, PROVEEDOR);
      return { adapter: this.listado, credentialSource: 'own', accountOwnerTenantId: owner };
    }

    async resolveForOrder(
      tenantId: string,
      orderId: string,
    ): Promise<TenantAdapter<HotelProviderAdapter>> {
      const resuelta = await this.creds.resolveForOrder(tenantId, orderId);
      if (resuelta.providerCode !== PROVEEDOR) throw new NotFoundException('otra cuenta');
      return { adapter: this.listado, credentialSource: 'inherited' };
    }
  }

  function servicio() {
    const creds = new ProviderCredentialsService(database);
    const proveedor = new Proveedor(creds);
    const hcn = { schedule: vi.fn(() => Promise.resolve({ opened: true, queued: true })) };
    const service = new ReconciliationService(
      hotelRegistry([proveedor], hotelFlags(false)),
      creds,
      store,
      new HotelOrderTrackingStore(database),
      new HotelOrderCancellationStore(database),
      new ExternalOrderIntentService(database),
      new BookingHoldLedger(database),
      hcn as unknown as HcnTrackingService,
      new CircuitBreakerService(),
      new AuditService(database),
      new RecordingQueueService().asService(),
      new InflightWorkRegistry(),
    );
    return { service, listado: proveedor.listado, hcn };
  }

  function correr(service: ReconciliationService) {
    return service.reconcileAccount({
      ownerTenantId: consolidador,
      accountId: cuenta,
      providerCode: PROVEEDOR,
      trigger: 'forced',
      requestedBy: usuario,
    });
  }

  async function itemsComo(tenantId: string) {
    return database.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('provider_reconciliation_items')
        .select(['kind', 'order_id', 'provider_booking_id', 'tenant_id', 'details'])
        .where('account_id', '=', cuenta)
        .execute(),
    );
  }

  beforeAll(async () => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    database.onModuleInit();

    consolidador = await crearTenant(`rc-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`rc-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`rc-b-${sfx}`, 'agency', consolidador);
    otroConsolidador = await crearTenant(`rc-x-${sfx}`, 'consolidator', null);
    agenciaAjena = await crearTenant(`rc-y-${sfx}`, 'agency', otroConsolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`rc-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
    cuenta = await crearCuenta(consolidador);
    cuentaAjena = await crearCuenta(otroConsolidador);
  });

  afterAll(async () => {
    for (const id of [agenciaAjena, agenciaA, agenciaB, consolidador, otroConsolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('app_user no es superusuario ni salta la RLS', async () => {
    const rol = await database.withTenant(agenciaA, async (trx) => {
      const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `.execute(trx);
      return r.rows[0];
    });
    expect(rol).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('la red de una cuenta es su dueño y su subárbol, y las órdenes se leen tenant por tenant', async () => {
    const a = await orden({ tenantId: agenciaA });
    const b = await orden({ tenantId: agenciaB });
    // La FK se verifica sin RLS: una agencia de otra red puede guardar la cuenta de esta red.
    const ajena = await orden({ tenantId: agenciaAjena });

    const red = await store.networkOf(consolidador);
    expect(new Set(red)).toEqual(new Set([consolidador, agenciaA, agenciaB]));

    const q = { provider: PROVEEDOR, accountId: cuenta, checkoutFrom: fecha(-1) };
    const deA = await store.listAnchors(agenciaA, q);
    expect(deA.map((o) => o.orderId)).toContain(a.id);
    expect(deA.map((o) => o.orderId)).not.toContain(b.id);
    // Con el tenant de A, la RLS no deja ver la de B aunque se pida por su localizador.
    const porClave = await store.listByKeys(agenciaA, {
      provider: PROVEEDOR,
      accountId: cuenta,
      locators: [b.locator!.toLowerCase(), a.locator!.toLowerCase()],
      references: [ajena.ref],
    });
    expect(porClave.map((o) => o.orderId)).toEqual([a.id]);
    expect(porClave[0]).toMatchObject({
      tenantId: agenciaA,
      net: { amountMinor: 50_000, currency: 'USD' },
      openIntent: false,
    });
  });

  it('una sola corrida en curso por cuenta; la abandonada se cierra antes de abrir otra', async () => {
    const t0 = Date.now();
    const primera = await store.startRun(consolidador, {
      accountId: cuenta,
      providerCode: PROVEEDOR,
      trigger: 'scheduled',
      staleBefore: t0 - 60 * 60_000,
    });
    expect(primera).toBeDefined();
    await expect(
      store.startRun(consolidador, {
        accountId: cuenta,
        providerCode: PROVEEDOR,
        trigger: 'forced',
        staleBefore: t0 - 60 * 60_000,
      }),
    ).resolves.toBeUndefined();

    // El proceso murió: pasada la hora, la siguiente la da por abandonada.
    const segunda = await store.startRun(consolidador, {
      accountId: cuenta,
      providerCode: PROVEEDOR,
      trigger: 'sweep',
      staleBefore: Date.now() + 60_000,
    });
    expect(segunda).toBeDefined();
    const { rows } = await pool.query<{ id: string; status: string; error_class: string | null }>(
      `SELECT id, status, error_class FROM provider_reconciliation_runs WHERE id = ANY($1::uuid[])`,
      [[primera, segunda]],
    );
    expect(rows.find((r) => r.id === primera)).toMatchObject({
      status: 'abandoned',
      error_class: 'StaleRun',
    });
    await store.finishRun(consolidador, segunda!, {
      status: 'failed',
      windows: [],
      rowsRead: 0,
      rowsMatched: 0,
      discrepancies: 0,
      summary: {},
      errorClass: 'Prueba',
    });
  });

  it('una corrida es del dueño: otro tenant no la ve ni puede abrirla sobre su cuenta', async () => {
    await expect(
      database.withTenant(agenciaA, (trx) =>
        trx
          .insertInto('provider_reconciliation_runs')
          .values({
            tenant_id: agenciaA,
            account_id: cuenta,
            provider_code: PROVEEDOR,
            trigger: 'forced',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const vistas = await database.withTenant(agenciaA, (trx) =>
      trx.selectFrom('provider_reconciliation_runs').select('id').execute(),
    );
    expect(vistas).toEqual([]);
  });

  it('el ítem de una orden vive en el tenant de la orden, se deduplica y no se edita ni se borra', async () => {
    const a = await orden({ tenantId: agenciaA });
    const run = await store.startRun(consolidador, {
      accountId: cuenta,
      providerCode: PROVEEDOR,
      trigger: 'forced',
      staleBefore: Date.now() + 60_000,
    });
    const item = {
      runId: run!,
      accountId: cuenta,
      providerCode: PROVEEDOR,
      kind: 'R4' as const,
      severity: 'critical' as const,
      action: 'review' as const,
      orderId: a.id,
      providerBookingId: a.locator!,
      dedupeKey: `R4|booking:${a.locator!}|Confirmed`,
      details: { providerStatus: 'Confirmed' },
    };

    // Colgado de otro tenant, la FK compuesta lo rechaza aunque la RLS lo dejara escribir.
    await expect(store.recordItem(agenciaB, item)).rejects.toMatchObject({ code: '23503' });
    await expect(store.recordItem(agenciaA, item)).resolves.toBe(true);
    await expect(store.recordItem(agenciaA, item)).resolves.toBe(false);

    expect(await itemsComo(agenciaB)).toEqual([]);
    expect((await itemsComo(agenciaA)).map((i) => i.order_id)).toEqual([a.id]);

    // R2 sin localizador, o R3 sin orden: el CHECK del sujeto.
    await expect(
      store.recordItem(consolidador, { ...item, kind: 'R3', orderId: undefined, dedupeKey: 'x1' }),
    ).rejects.toMatchObject({ code: '23514' });

    // Append-only para app_user.
    await expect(
      database.withTenant(agenciaA, (trx) =>
        trx
          .updateTable('provider_reconciliation_items')
          .set({ action: 'recorded' })
          .where('order_id', '=', a.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.withTenant(agenciaA, (trx) =>
        trx.deleteFrom('provider_reconciliation_items').where('order_id', '=', a.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await store.finishRun(consolidador, run!, {
      status: 'completed',
      windows: [],
      rowsRead: 0,
      rowsMatched: 0,
      discrepancies: 0,
      summary: {},
    });
  });

  it('una corrida completa: cada agencia ve lo de SUS órdenes, la reserva sin orden sólo el dueño, y el intent ausente pasa a fallido (RF-28 CA; D-TBO-24 A)', async () => {
    // Limpia lo que dejaron los casos anteriores de esta cuenta: la corrida los vería.
    await pool.query(`DELETE FROM orders WHERE provider = $1`, [PROVEEDOR]);
    const { service, listado, hcn } = servicio();

    const a = await orden({ tenantId: agenciaA, creadaHace: 2 * DAY });
    const b = await orden({ tenantId: agenciaB, status: 'cancelled', creadaHace: 2 * DAY });
    const prueba = await orden({ tenantId: agenciaB, creadaHace: 2 * DAY });
    const intent = await orden({
      tenantId: agenciaA,
      status: 'pending',
      locator: null,
      raw: null,
      creadaHace: 2 * DAY,
      requestKey: `rk-${sfx}`,
    });
    const recuperable = await orden({
      tenantId: agenciaB,
      status: 'pending',
      locator: null,
      raw: null,
      creadaHace: 3_600_000,
      requestKey: `rk2-${sfx}`,
    });
    // Otra red con la misma cuenta guardada (la FK lo permite): la corrida no la mira.
    await orden({ tenantId: agenciaAjena, creadaHace: 2 * DAY });
    await pool.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, sub_status) VALUES ($1, $2, 'create-not-found-yet')`,
      [intent.id, agenciaA],
    );

    const creada = fecha(-2);
    listado.filas = [
      {
        providerBookingId: a.locator!,
        bookingDate: creada,
        bookingReference: a.ref,
        status: 'CANCELLED',
        providerStatus: 'Cancelled',
      },
      {
        providerBookingId: b.locator!,
        bookingDate: creada,
        bookingReference: b.ref,
        status: 'CONFIRMED',
        providerStatus: 'Confirmed',
      },
      {
        providerBookingId: prueba.locator!,
        bookingDate: creada,
        bookingReference: prueba.ref,
        status: 'CONFIRMED',
        providerStatus: 'Confirmed',
      },
      {
        providerBookingId: `NW${sfx}`.toUpperCase(),
        bookingDate: fecha(0),
        bookingReference: recuperable.ref,
        status: 'CONFIRMED',
        providerStatus: 'Confirmed',
      },
      {
        providerBookingId: `EX${sfx}`.toUpperCase(),
        bookingDate: fecha(-1),
        bookingReference: 'PORTAL-1',
        status: 'CONFIRMED',
        providerStatus: 'Confirmed',
        agencyName: 'Agencia del portal',
      },
    ];
    listado.lecturas.set(a.locator!, {
      found: true,
      providerBookingId: a.locator!,
      status: 'CANCELLED',
      providerStatus: 'Cancelled',
      warnings: [],
    });
    listado.lecturas.set(b.locator!, {
      found: true,
      providerBookingId: b.locator!,
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      warnings: [],
    });
    listado.lecturas.set(`NW${sfx}`.toUpperCase(), {
      found: true,
      providerBookingId: `NW${sfx}`.toUpperCase(),
      bookingReference: recuperable.ref,
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      warnings: [],
    });

    const report = await correr(service);

    expect(report).toMatchObject({ status: 'completed', rowsRead: 5 });
    expect(report.outcomes).toMatchObject({
      cancelled: 1,
      review: 1,
      reported: 1,
      failed: 1,
      recovered: 1,
    });
    expect(listado.cancelBooking).not.toHaveBeenCalled();

    const estados = await pool.query<{
      id: string;
      status: string;
      create_request_key: string | null;
      provider_order_id: string | null;
    }>(
      `SELECT id, status, create_request_key, provider_order_id FROM orders WHERE id = ANY($1::uuid[])`,
      [[a.id, b.id, intent.id, recuperable.id]],
    );
    const de = (id: string) => estados.rows.find((r) => r.id === id);
    expect(de(a.id)?.status).toBe('cancelled');
    expect(de(b.id)?.status).toBe('cancelled');
    // R5: fallido y la clave liberada; el vendedor puede volver a reservar.
    expect(de(intent.id)).toMatchObject({ status: 'failed', create_request_key: null });
    // R1: consolidado con el localizador que devolvió la lectura.
    expect(de(recuperable.id)).toMatchObject({
      status: 'confirmed',
      provider_order_id: `NW${sfx}`.toUpperCase(),
    });
    expect(hcn.schedule).toHaveBeenCalledWith({ tenantId: agenciaB, orderId: recuperable.id });

    // Cada tenant ve sólo lo suyo (06 §7.5, última fila).
    const deA = await itemsComo(agenciaA);
    const deB = await itemsComo(agenciaB);
    const delDueno = await itemsComo(consolidador);
    expect(deA.map((i) => i.kind).sort()).toEqual(['R3', 'R5']);
    expect(deB.map((i) => i.kind).sort()).toEqual(['R1', 'R4']);
    expect(delDueno.map((i) => i.kind)).toEqual(['R2']);
    expect(await itemsComo(agenciaAjena)).toEqual([]);
    expect(JSON.stringify([...deA, ...deB])).not.toMatch(/PORTAL-1|Agencia del portal/);
    expect(JSON.stringify(delDueno)).toContain('Agencia del portal');

    // ProviderBookingUnmatched sólo al dueño de la cuenta.
    const eventos = await pool.query<{
      tenant_id: string;
      event_type: string;
      aggregate_type: string;
      payload: unknown;
    }>(
      `SELECT tenant_id, event_type, aggregate_type, payload FROM domain_events
        WHERE payload ->> 'runId' = $1`,
      [report.runId],
    );
    const sinOrden = eventos.rows.filter(
      (e) => e.event_type === ORDER_EVENTS.providerBookingUnmatched,
    );
    expect(sinOrden.map((e) => [e.tenant_id, e.aggregate_type])).toEqual([
      [consolidador, 'provider_account'],
    ]);
    for (const e of eventos.rows.filter((x) => x.tenant_id === agenciaA)) {
      expect(JSON.stringify(e.payload)).not.toMatch(new RegExp(`${b.locator!}|EX${sfx}`, 'i'));
    }
    expect(JSON.stringify(eventos.rows)).not.toMatch(/Xiomara|Quintanilla|xiomara@example\.com/);

    // La corrida quedó en el tenant del dueño, con sus ventanas.
    const [corrida] = await store.listRuns(consolidador, cuenta, { limit: 1 });
    expect(corrida).toMatchObject({ id: report.runId, status: 'completed', rowsRead: 5 });

    // Repetir la ventana no duplica nada.
    const otra = await correr(service);
    expect(otra.outcomes).not.toHaveProperty('reported');
    const repetidos = await pool.query(
      `SELECT count(*)::int AS n FROM domain_events WHERE payload ->> 'runId' = $1`,
      [otra.runId],
    );
    expect(repetidos.rows[0]).toEqual({ n: 0 });
  });

  it('una cancelación nuestra en curso que el proveedor ya terminó queda cancelled y su calendario cerrado', async () => {
    await pool.query(`DELETE FROM orders WHERE provider = $1`, [PROVEEDOR]);
    const { service, listado } = servicio();
    const enCurso = await orden({ tenantId: agenciaA, status: 'pending', creadaHace: 2 * DAY });
    await pool.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, provider_status, provider_status_at,
                                         provider_status_source, cancel_verify_anchor_at,
                                         cancel_verify_step, cancel_verify_next_at)
       VALUES ($1, $2, 'CancelPending', now() - interval '1 hour', 'cancel',
               now() - interval '1 hour', 1, now() + interval '5 hours')`,
      [enCurso.id, agenciaA],
    );
    listado.filas = [
      {
        providerBookingId: enCurso.locator!,
        bookingDate: fecha(-2),
        bookingReference: enCurso.ref,
        status: 'CANCELLED',
        providerStatus: 'Cancelled',
      },
    ];
    listado.lecturas.set(enCurso.locator!, {
      found: true,
      providerBookingId: enCurso.locator!,
      status: 'CANCELLED',
      providerStatus: 'Cancelled',
      warnings: [],
    });

    const report = await correr(service);

    expect(report.outcomes).toEqual({ settled: 1 });
    const { rows } = await pool.query<{ status: string; next: Date | null }>(
      `SELECT o.status, t.cancel_verify_next_at AS next
         FROM orders o JOIN hotel_order_tracking t ON t.order_id = o.id
        WHERE o.id = $1`,
      [enCurso.id],
    );
    expect(rows[0]).toEqual({ status: 'cancelled', next: null });
  });

  it('R6, R7 y R8 sobre datos sembrados: se registran sin tocar la orden, cada uno en su tenant', async () => {
    await pool.query(`DELETE FROM orders WHERE provider = $1`, [PROVEEDOR]);
    const { service, listado } = servicio();

    const precio = await orden({ tenantId: agenciaA, creadaHace: 2 * DAY });
    const rara = await orden({ tenantId: agenciaB, creadaHace: 2 * DAY });
    const atascada = await orden({ tenantId: agenciaA, status: 'pending', creadaHace: 5 * DAY });
    // El calendario de verify-cancellation se agotó hace rato y el proveedor sigue "en curso".
    await pool.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, provider_status, provider_status_at,
                                         provider_status_source, cancel_verify_anchor_at,
                                         cancel_verify_step, cancel_verify_next_at)
       VALUES ($1, $2, 'CxlRequestSentToHotel', now() - interval '80 hours', 'cancel',
               now() - interval '80 hours', 5, NULL)`,
      [atascada.id, agenciaA],
    );

    const creada = fecha(-2);
    listado.filas = [
      {
        providerBookingId: precio.locator!,
        bookingDate: creada,
        bookingReference: precio.ref,
        status: 'CONFIRMED',
        providerStatus: 'Confirmed',
        total: { amountMinor: 60_000, currency: 'USD' },
        agencyCommission: { amountMinor: 5_000, currency: 'USD' },
      },
      {
        providerBookingId: rara.locator!,
        bookingDate: creada,
        bookingReference: rara.ref,
        status: 'UNKNOWN',
        providerStatus: 'OnHold',
      },
      {
        providerBookingId: atascada.locator!,
        bookingDate: fecha(-5),
        bookingReference: atascada.ref,
        status: 'CANCELLATION_IN_PROGRESS',
        providerStatus: 'CxlRequestSentToHotel',
      },
    ];
    listado.lecturas.set(rara.locator!, {
      found: true,
      providerBookingId: rara.locator!,
      status: 'UNKNOWN',
      providerStatus: 'OnHold',
      warnings: [],
    });

    const report = await correr(service);

    expect(report).toMatchObject({ status: 'completed', rowsRead: 3 });
    expect(report.outcomes).toEqual({ recorded: 1, review: 2 });
    expect(listado.cancelBooking).not.toHaveBeenCalled();

    // Ninguno de los tres cambia la orden.
    const estados = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM orders WHERE id = ANY($1::uuid[])`,
      [[precio.id, rara.id, atascada.id]],
    );
    const de = (id: string) => estados.rows.find((r) => r.id === id)?.status;
    expect([de(precio.id), de(rara.id), de(atascada.id)]).toEqual([
      'confirmed',
      'confirmed',
      'pending',
    ]);
    // R7: el valor crudo queda en el seguimiento y la orden, a revisión.
    const seguimiento = await pool.query<{ provider_status: string; sub_status: string | null }>(
      `SELECT provider_status, sub_status FROM hotel_order_tracking WHERE order_id = $1`,
      [rara.id],
    );
    expect(seguimiento.rows[0]).toEqual({ provider_status: 'OnHold', sub_status: 'unknown' });

    // R6 con los montos sólo en el dueño de la cuenta; R7 y R8 en el tenant de su orden. Los ítems
    // son append-only y los casos anteriores dejaron los suyos en la cuenta: se miran los de ESTA corrida.
    const deLaCorrida = (tenantId: string) =>
      database.withTenant(tenantId, (trx) =>
        trx
          .selectFrom('provider_reconciliation_items')
          .select(['kind', 'order_id', 'provider_booking_id', 'details'])
          .where('run_id', '=', report.runId!)
          .execute(),
      );
    const delDueno = await deLaCorrida(consolidador);
    expect(delDueno.map((i) => [i.kind, i.order_id, i.provider_booking_id])).toEqual([
      ['R6', null, precio.locator!],
    ]);
    expect(delDueno[0]?.details).toMatchObject({
      providerNet: { amountMinor: 55_000, currency: 'USD' },
      storedNet: { amountMinor: 50_000, currency: 'USD' },
    });
    const deA = await deLaCorrida(agenciaA);
    expect(deA.map((i) => [i.kind, i.order_id])).toEqual([['R8', atascada.id]]);
    const deB = await deLaCorrida(agenciaB);
    expect(deB.map((i) => [i.kind, i.order_id])).toEqual([['R7', rara.id]]);
    expect(await deLaCorrida(agenciaAjena)).toEqual([]);

    const eventos = await pool.query<{
      tenant_id: string;
      event_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, event_type, aggregate_id, payload FROM domain_events
        WHERE payload ->> 'runId' = $1`,
      [report.runId],
    );
    const discrepancias = eventos.rows
      .filter((e) => e.event_type === ORDER_EVENTS.reconciliationDiscrepancy)
      .map((e) => [e.tenant_id, e.aggregate_id, e.payload['kind']]);
    expect(discrepancias).toEqual(
      expect.arrayContaining([
        [agenciaA, precio.id, 'R6'],
        [agenciaA, atascada.id, 'R8'],
      ]),
    );
    const escalada = eventos.rows.find((e) => e.event_type === ORDER_EVENTS.escalated);
    expect(escalada).toMatchObject({
      tenant_id: agenciaB,
      aggregate_id: rara.id,
      payload: expect.objectContaining({ reason: 'provider-status-unknown' }) as unknown,
    });
    // La agencia recibe el aviso de R6 sin los montos del dueño. Se buscan las claves y no los
    // números: la referencia sintética rellena con ceros y puede contener "60000".
    const deLaAgencia = eventos.rows.filter((e) => e.tenant_id === agenciaA);
    expect(JSON.stringify(deLaAgencia)).not.toMatch(
      /amountMinor|providerNet|storedNet|agencyCommission|"total"/,
    );

    // Repetir la corrida no duplica ítems ni avisos.
    const otra = await correr(service);
    expect(otra.outcomes).not.toHaveProperty('recorded');
    const repetidos = await pool.query(
      `SELECT count(*)::int AS n FROM domain_events WHERE payload ->> 'runId' = $1`,
      [otra.runId],
    );
    expect(repetidos.rows[0]).toEqual({ n: 0 });
  });

  it('una respuesta con una fila fuera de la ventana invalida la corrida y no cambia nada', async () => {
    const { service, listado } = servicio();
    const intent = await orden({
      tenantId: agenciaA,
      status: 'pending',
      locator: null,
      raw: null,
      creadaHace: 3 * DAY,
      requestKey: `rk3-${sfx}`,
    });
    listado.listBookingsByDate.mockImplementation((range) =>
      Promise.resolve({
        range,
        bookings: [{ providerBookingId: 'X1', bookingDate: '2000-01-01' }],
      }),
    );

    const report = await correr(service);

    expect(report.status).toBe('invalid');
    const { rows } = await pool.query<{ status: string; create_request_key: string | null }>(
      `SELECT status, create_request_key FROM orders WHERE id = $1`,
      [intent.id],
    );
    expect(rows[0]).toEqual({ status: 'pending', create_request_key: `rk3-${sfx}` });
    const [corrida] = await store.listRuns(consolidador, cuenta, { limit: 1 });
    expect(corrida).toMatchObject({
      status: 'invalid',
      errorClass: 'ReconciliationWindowMismatchError',
    });
    void cuentaAjena;
  });
});

// ---------------------------------------------------------------------------
// Sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no cuenta como verde.
// ---------------------------------------------------------------------------

describe('0047, sin base de datos', () => {
  const texto = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');

  function lista(valores: readonly string[]): string {
    return valores.map((v) => `'${v}'`).join(',\\s*');
  }

  it('los vocabularios del SQL son los de la app', () => {
    expect(texto).toMatch(
      new RegExp(
        `trigger\\s+TEXT\\s+NOT NULL CHECK \\(trigger IN \\(${lista(RECONCILIATION_RUN_TRIGGERS)}\\)\\)`,
      ),
    );
    expect(texto).toMatch(
      new RegExp(`CHECK \\(status IN \\(${lista(RECONCILIATION_RUN_STATUSES)}\\)\\)`),
    );
    expect(texto).toMatch(
      new RegExp(`CHECK \\(kind IN \\(${lista(RECONCILIATION_DISCREPANCY_KINDS)}\\)\\)`),
    );
    expect(texto).toMatch(
      new RegExp(`CHECK \\(severity IN \\(${lista(DISCREPANCY_SEVERITIES)}\\)\\)`),
    );
    expect(texto).toMatch(
      new RegExp(`CHECK \\(action IN \\(${lista(RECONCILIATION_ITEM_ACTIONS)}\\)\\)`),
    );
  });

  it('RLS forzada por tenant en las dos tablas, sin funciones que la salten', () => {
    for (const tabla of ['provider_reconciliation_runs', 'provider_reconciliation_items']) {
      expect(texto).toMatch(new RegExp(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY;`));
      expect(texto).toMatch(new RegExp(`ALTER TABLE ${tabla} FORCE\\s+ROW LEVEL SECURITY;`));
      expect(texto).toMatch(
        new RegExp(
          `CREATE POLICY ${tabla}_tenant_isolation ON ${tabla}\\s+USING\\s+\\(tenant_id::text = current_setting\\('app\\.current_tenant_id', true\\)\\)\\s+WITH CHECK\\s+\\(tenant_id::text = current_setting\\('app\\.current_tenant_id', true\\)\\)`,
        ),
      );
    }
    expect(texto).not.toMatch(/SECURITY DEFINER|BYPASSRLS|DISABLE ROW LEVEL SECURITY/);
  });

  it('la corrida cuelga de la cuenta DEL tenant, y el ítem de una orden, de la orden DEL tenant', () => {
    expect(texto).toMatch(/ADD CONSTRAINT uq_provider_accounts_id_tenant UNIQUE \(id, tenant_id\)/);
    expect(texto).toMatch(
      /FOREIGN KEY \(account_id, tenant_id\) REFERENCES provider_accounts \(id, tenant_id\)/,
    );
    expect(texto).toMatch(
      /FOREIGN KEY \(order_id, tenant_id\) REFERENCES orders \(id, tenant_id\)/,
    );
    expect(texto).toMatch(
      /WHEN kind IN \('R2', 'R6'\) THEN order_id IS NULL AND provider_booking_id IS NOT NULL/,
    );
  });

  it('una sola corrida en curso por cuenta, y la deduplicación por cuenta', () => {
    expect(texto).toMatch(
      /CREATE UNIQUE INDEX uq_provider_reconciliation_runs_running\s+ON provider_reconciliation_runs \(account_id\)\s+WHERE status = 'running'/,
    );
    expect(texto).toMatch(
      /CONSTRAINT uq_provider_reconciliation_items_dedupe UNIQUE \(account_id, dedupe_key\)/,
    );
  });

  it('los ítems son append-only para app_user y las corridas no se borran', () => {
    expect(texto).toMatch(/REVOKE UPDATE, DELETE ON provider_reconciliation_items FROM app_user;/);
    expect(texto).toMatch(/REVOKE DELETE ON provider_reconciliation_runs FROM app_user;/);
  });
});
