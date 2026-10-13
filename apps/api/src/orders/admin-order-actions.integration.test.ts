import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { BrandingService } from '../branding/branding.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import {
  clearWalletHolds,
  retainAsSuperuser,
  seedWallet,
} from '../portfolios/__fixtures__/wallet-hold-seed.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { currentTenantId, requestContextStorage } from '../request-context/request-context.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  ADMIN_ORDER_ACTION_EVENT,
  AdminOrderActionsService,
} from './admin-order-actions.service.js';
import { AdminOrderNumberMismatchError } from './admin-orders.errors.js';
import { AdminOrdersService } from './admin-orders.service.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { OrderCapabilitiesService } from './order-capabilities.service.js';
import { OrderConfirmationService } from './order-confirmation.service.js';
import { ORDER_EVENTS } from './order-events.js';
import { OrdersService } from './orders.service.js';

/**
 * La post-venta del superadmin desde Reservas de la red, contra Postgres y como `app_user` (el rol de
 * producción, sujeto a la RLS), con un proveedor de vuelos de prueba.
 *
 * Lo que se prueba es que el superadmin actúa DENTRO del nodo de la reserva sin ser miembro: los
 * servicios de la agencia corren con el tenant de la reserva, los eventos caen en ese tenant con el
 * superadmin como actor, el reintento usa el mismo claim durable y la retención de cartera se libera
 * cuando la cancelación sale bien. Y que nadie más puede.
 *
 * La red: Planetour → consolidador C (dueño de la cuenta del proveedor) → agencia A. Sólo A retiene.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const RETENIDO = 95_000;
const MOTIVO = 'La agencia no puede entrar al panel';

d('Reservas de la red: acciones de post-venta del superadmin (como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  const SFX = sfx.toUpperCase();
  const PROVEEDOR = `stub-air-${sfx}`;
  const MARCA = `Agencia Sur ${SFX}`;

  /** SUPERUSUARIO: sólo para montar la red, sembrar y mirar. */
  const admin = new pg.Pool();
  const appPool = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });
  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appPool }) });

  const audit = new AuditService(database);
  const hotelReads = new HotelOrderReadsService(
    { capabilitiesOf: () => undefined } as unknown as HotelProviderRegistry,
    new HotelOrderTrackingStore(database),
    new CircuitBreakerService(),
    audit,
  );
  const factory = new StubProviderFactory({ code: PROVEEDOR });
  const registry = new FlightProviderRegistry([factory], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const orders = new OrdersService(
    database,
    registry,
    new RecordingQueueService().asService(),
    {} as unknown as AgentCarsProviderFactory,
    audit,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    hotelReads,
    undefined,
    new BookingHoldLedger(database),
  );
  const capabilities = new OrderCapabilitiesService(registry, hotelReads);
  const adminOrders = new AdminOrdersService(database, orders, hotelReads, audit, capabilities);
  const mails: { tenantId: string | null; to: string; subject: string; html: string }[] = [];
  const mailer = {
    sendToTenant: (
      tenantId: string | null,
      mail: { to: string; subject: string; html: string },
    ) => {
      mails.push({ tenantId, to: mail.to, subject: mail.subject, html: mail.html });
      return Promise.resolve(true);
    },
  } as unknown as MailerService;
  const confirmation = new OrderConfirmationService(
    mailer,
    new BrandingService(database),
    hotelReads,
  );
  const actions = new AdminOrderActionsService(
    adminOrders,
    orders,
    confirmation,
    capabilities,
    audit,
  );

  const tenants: string[] = [];
  const users: string[] = [];
  const orderIds: string[] = [];
  let numero = 0;

  let platform: string;
  let consolidator: string;
  let agency: string;
  let superadmin: string;
  let agencyAdmin: string;
  let seller: string;
  let portfolio: string;

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'USD', $2, $3) RETURNING id`,
      [`pa-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`pa-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  /** Una reserva de vuelos confirmada de la agencia, con su retención de cartera cobrada. */
  async function order(): Promise<{ id: string; number: number; pnr: string }> {
    numero += 1;
    const pnr = `PNR${SFX}${numero}`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                           selected_offer, passengers, contact_info, total_amount, currency,
                           order_number, status)
       VALUES ($1, $2, $3, $4, '{"origin":"BOG","destination":"LIM"}'::jsonb, '{}'::jsonb,
               '[{"givenName":"Ana","surname":"Ríos"}]'::jsonb, $5::jsonb, $6, 'USD', $7,
               'confirmed')
       RETURNING id`,
      [
        agency,
        seller,
        PROVEEDOR,
        pnr,
        JSON.stringify({ email: `cliente.${sfx}@test.local` }),
        RETENIDO,
        numero,
      ],
    );
    const id = rows[0]!.id;
    orderIds.push(id);
    const held = await retainAsSuperuser(admin, agency, id, seller);
    // Confirmada: la retención queda cobrada, como la deja una venta que el proveedor confirmó.
    expect(held.hold_status).toBe('captured');
    return { id, number: numero, pnr };
  }

  async function balance(): Promise<number> {
    const { rows } = await admin.query<{ balance_minor: string }>(
      'SELECT balance_minor FROM agency_portfolios WHERE id = $1',
      [portfolio],
    );
    return Number(rows[0]!.balance_minor);
  }

  async function holdStatus(orderId: string): Promise<string | undefined> {
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM wallet_hold_groups WHERE order_id = $1',
      [orderId],
    );
    return rows[0]?.status;
  }

  async function orderStatus(orderId: string): Promise<string> {
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0]!.status;
  }

  async function cancelOps(orderId: string) {
    const { rows } = await admin.query<{
      id: string;
      status: string;
      actor_user_id: string | null;
    }>(
      `SELECT id, status, actor_user_id FROM order_operations
        WHERE order_id = $1 AND type = 'cancel' ORDER BY created_at`,
      [orderId],
    );
    return rows;
  }

  async function events(orderId: string, eventType: string) {
    const { rows } = await admin.query<{
      tenant_id: string | null;
      actor_user_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, actor_user_id, payload FROM domain_events
        WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = $2
        ORDER BY occurred_at, id`,
      [orderId, eventType],
    );
    return rows;
  }

  /** Como en un request: el superadmin con la plataforma como tenant activo. */
  function comoSuperadmin<T>(fn: () => Promise<T>): Promise<T> {
    return requestContextStorage.run({ userId: superadmin, tenantId: platform }, fn);
  }

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    await admin.query(
      `UPDATE tenants SET commercial_name = $2, primary_color = '#0a7f5a' WHERE id = $1`,
      [agency, MARCA],
    );

    superadmin = await user('sa', platform, 'superadmin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    seller = await user('ve', agency, 'vendedor');

    // La cuenta del proveedor es del consolidador y la hereda la agencia: retiene sólo la agencia.
    await admin.query(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config,
                                      is_inheritable, status)
       VALUES ($1, $2, 'default', '\\x00'::bytea, '{"environment":"test"}'::jsonb, true, 'active')`,
      [consolidator, PROVEEDOR],
    );
    portfolio = await seedWallet(admin, agency, {
      currency: 'USD',
      balanceMinor: 500_000,
      creditLimitMinor: 0,
    });
  });

  beforeEach(() => {
    factory.adapterFor(agency).cancelOrder.mockClear();
    factory.adapterFor(agency).retrieveForDisplay.mockClear();
    mails.length = 0;
  });

  afterAll(async () => {
    await clearWalletHolds(admin, orderIds);
    await admin.query('DELETE FROM domain_events WHERE aggregate_id = ANY($1::text[])', [orderIds]);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('reintentar una cancelación fallida: el mismo claim, eventos en la agencia con el superadmin y la cartera liberada', async () => {
    const o = await order();
    const { rows: op } = await admin.query<{ id: string }>(
      `INSERT INTO order_operations (tenant_id, order_id, type, status, last_error, result, actor_user_id)
       VALUES ($1, $2, 'cancel', 'failed', 'Falló antes de enviar la cancelación.', $3::jsonb, $4)
       RETURNING id`,
      [
        agency,
        o.id,
        JSON.stringify({
          status: 'failed',
          outcome: 'FAILED',
          retryable: true,
          reconciliationRequired: false,
          reason: 'pre-write-transient',
          priorOrderStatus: 'confirmed',
        }),
        seller,
      ],
    );
    const opId = op[0]!.id;
    const before = await balance();
    const adapter = factory.adapterFor(agency);
    let tenantDuringCancel: string | undefined;
    adapter.cancelOrder.mockImplementationOnce(() => {
      tenantDuringCancel = currentTenantId();
      return Promise.resolve({ success: true, warnings: [] });
    });

    const result = await comoSuperadmin(() =>
      actions.retryCancellation(superadmin, o.id, opId.toUpperCase(), { reason: MOTIVO }),
    );

    expect(result).toMatchObject({ success: true });
    expect(adapter.cancelOrder).toHaveBeenCalledOnce();
    expect(adapter.cancelOrder.mock.calls[0]?.[0]).toBe(o.pnr);
    // Lo que cae al tenant del contexto (la bóveda de payloads) cae en la agencia.
    expect(tenantDuringCancel).toBe(agency);

    // El mismo claim: ninguna operación nueva, la fallida pasó a success con el superadmin.
    expect(await cancelOps(o.id)).toEqual([
      { id: opId, status: 'success', actor_user_id: superadmin },
    ]);
    expect(await orderStatus(o.id)).toBe('cancelled');

    // La retención se liberó: el saldo vuelve a la agencia una sola vez.
    expect(await holdStatus(o.id)).toBe('released');
    expect(await balance()).toBe(before + RETENIDO);

    // Los eventos del servicio, en la agencia y con el superadmin como actor.
    const attempted = await events(o.id, ORDER_EVENTS.cancelled);
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toMatchObject({
      tenant_id: agency,
      actor_user_id: superadmin,
      payload: { success: true, provider: PROVEEDOR },
    });
    expect(await events(o.id, ADMIN_ORDER_ACTION_EVENT)).toEqual([
      {
        tenant_id: agency,
        actor_user_id: superadmin,
        payload: {
          action: 'retry-cancel',
          orderId: o.id,
          operationId: opId,
          reason: MOTIVO,
          outcome: 'ok',
          result: { success: true },
        },
      },
    ]);

    // El administrador de la agencia lo ve en su auditoría (RLS por subárbol administrado).
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [agencyAdmin]);
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND aggregate_id = $2`,
        [ADMIN_ORDER_ACTION_EVENT, o.id],
      );
      expect(rows[0]?.n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('cancelar en nombre de la agencia: con otro número no pasa nada; con el suyo cancela y libera', async () => {
    const o = await order();
    const before = await balance();
    const adapter = factory.adapterFor(agency);

    await expect(
      comoSuperadmin(() =>
        actions.cancel(superadmin, o.id, { reason: MOTIVO, orderNumber: o.number + 1 }),
      ),
    ).rejects.toBeInstanceOf(AdminOrderNumberMismatchError);
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(await orderStatus(o.id)).toBe('confirmed');
    expect(await cancelOps(o.id)).toEqual([]);

    const result = await comoSuperadmin(() =>
      actions.cancel(superadmin, o.id, { reason: MOTIVO, orderNumber: o.number }),
    );

    expect(result).toMatchObject({ success: true });
    expect(adapter.cancelOrder).toHaveBeenCalledOnce();
    expect(await orderStatus(o.id)).toBe('cancelled');
    expect(await cancelOps(o.id)).toEqual([
      expect.objectContaining({ status: 'success', actor_user_id: superadmin }),
    ]);
    expect(await holdStatus(o.id)).toBe('released');
    expect(await balance()).toBe(before + RETENIDO);
    expect((await events(o.id, ADMIN_ORDER_ACTION_EVENT)).map((e) => e.payload)).toEqual([
      {
        action: 'cancel',
        orderId: o.id,
        reason: MOTIVO,
        outcome: 'error',
        errorReason: 'ORDER_NUMBER_MISMATCH',
      },
      { action: 'cancel', orderId: o.id, reason: MOTIVO, outcome: 'ok', result: { success: true } },
    ]);

    // Ya cancelada: una segunda cancelación es el 409 de la agencia, sin llamar al proveedor.
    await expect(
      comoSuperadmin(() =>
        actions.cancel(superadmin, o.id, { reason: MOTIVO, orderNumber: o.number }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(adapter.cancelOrder).toHaveBeenCalledOnce();
  });

  it('cancelar y que el proveedor la rechace: la reserva y la retención quedan como estaban', async () => {
    const o = await order();
    const before = await balance();
    const adapter = factory.adapterFor(agency);
    adapter.cancelOrder.mockResolvedValueOnce({
      success: false,
      warnings: [],
      error: 'Fuera de política',
    });

    const result = await comoSuperadmin(() =>
      actions.cancel(superadmin, o.id, { reason: MOTIVO, orderNumber: o.number }),
    );

    expect(result).toMatchObject({ success: false });
    expect(await orderStatus(o.id)).toBe('confirmed');
    expect(await holdStatus(o.id)).toBe('captured');
    expect(await balance()).toBe(before);
    expect(await cancelOps(o.id)).toEqual([
      expect.objectContaining({ status: 'failed', actor_user_id: superadmin }),
    ]);
    expect((await events(o.id, ADMIN_ORDER_ACTION_EVENT)).map((e) => e.payload)).toEqual([
      {
        action: 'cancel',
        orderId: o.id,
        reason: MOTIVO,
        outcome: 'error',
        errorReason: 'PROVIDER_REJECTED',
        result: { success: false },
      },
    ]);
  });

  it('reenviar la confirmación: la marca y el correo del nodo de la reserva, no los de la plataforma', async () => {
    const o = await order();

    const res = await comoSuperadmin(() =>
      actions.sendConfirmation(superadmin, o.id, { reason: MOTIVO }),
    );

    expect(res).toEqual({ sent: true, to: `cliente.${sfx}@test.local` });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ tenantId: agency, to: `cliente.${sfx}@test.local` });
    expect(mails[0]?.subject).toContain(`#${o.number}`);
    expect(mails[0]?.html).toContain(MARCA);
    const [event] = await events(o.id, ADMIN_ORDER_ACTION_EVENT);
    expect(event).toEqual({
      tenant_id: agency,
      actor_user_id: superadmin,
      payload: {
        action: 'send-confirmation',
        orderId: o.id,
        reason: MOTIVO,
        outcome: 'ok',
        result: { sent: true },
      },
    });
  });

  it('consultar al proveedor: lee con la cuenta de la agencia y devuelve la ficha con sus capacidades', async () => {
    const o = await order();
    const adapter = factory.adapterFor(agency);
    let tenantDuringRead: string | undefined;
    adapter.retrieveForDisplay.mockImplementationOnce((orderId: string) => {
      tenantDuringRead = currentTenantId();
      return Promise.resolve({
        found: true,
        orderId,
        status: 'TICKETED',
        ticketNumbers: ['0451234567890'],
        airlineLocators: [{ carrierCode: 'LA', locator: 'XYZ987' }],
        warnings: [],
      });
    });

    const res = await comoSuperadmin(() => actions.retrieve(superadmin, o.id, { reason: MOTIVO }));

    expect(adapter.retrieveForDisplay.mock.calls[0]?.[0]).toBe(o.pnr);
    expect(tenantDuringRead).toBe(agency);
    expect(res.reading).toMatchObject({
      found: true,
      status: 'TICKETED',
      ticketNumbers: ['0451234567890'],
      airlineLocators: [{ carrierCode: 'LA', locator: 'XYZ987' }],
    });
    expect(res.detail?.order.id).toBe(o.id);
    expect(res.detail?.capabilities).toEqual({ retrieve: true, cancel: true });
    expect((await events(o.id, ADMIN_ORDER_ACTION_EVENT)).map((e) => e.payload)).toEqual([
      {
        action: 'retrieve',
        orderId: o.id,
        reason: MOTIVO,
        outcome: 'ok',
        result: { found: true, providerStatus: 'TICKETED' },
      },
    ]);
  });

  it('un tenant_admin no puede ninguna: 403 de la base, nada corre y nada queda', async () => {
    const o = await order();
    const adapter = factory.adapterFor(agency);
    const asAdmin = <T>(fn: () => Promise<T>) =>
      requestContextStorage.run({ userId: agencyAdmin, tenantId: agency }, fn);

    const attempts: (() => Promise<unknown>)[] = [
      () => actions.sendConfirmation(agencyAdmin, o.id, { reason: MOTIVO }),
      () => actions.retrieve(agencyAdmin, o.id, { reason: MOTIVO }),
      () => actions.cancel(agencyAdmin, o.id, { reason: MOTIVO, orderNumber: o.number }),
      () => actions.cancellationEstimate(agencyAdmin, o.id),
    ];
    for (const attempt of attempts) {
      await expect(asAdmin(attempt)).rejects.toBeInstanceOf(SuperadminRequiredError);
    }
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.retrieveForDisplay).not.toHaveBeenCalled();
    expect(mails).toEqual([]);
    expect(await orderStatus(o.id)).toBe('confirmed');
    expect(await events(o.id, ADMIN_ORDER_ACTION_EVENT)).toEqual([]);
  });
});
