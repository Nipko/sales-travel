import { randomBytes, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  NET_MINOR,
  NETWORK_HOLD_CASES,
  cascadeProvider,
  cascadeVertical,
  expectedHolds,
  saleOf,
  type AccountOwner,
  type NodeKey,
} from './__fixtures__/network-hold-cases.js';
import {
  seedNetwork,
  seedOrder,
  seedWallet,
  teardownNetwork,
  type SeededNetwork,
} from './__fixtures__/wallet-hold-seed.js';
import { held } from './__fixtures__/held-outcome.js';
import {
  BookingHoldRejectedError,
  PortfolioHoldAccountChangedError,
  type BookingHoldQuote,
  type BookingHoldVertical,
} from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';
import { WalletFinancingService } from './wallet-financing.service.js';

/**
 * La retención en cascada de 0060 por la puerta de la API, como `app_user` (el rol de producción):
 * `PortfoliosService` retiene y libera por las funciones de la base, traduce un rechazo de la red a
 * su motivo y le avisa al nivel que bloqueó; quien financia ve las reservas de su red en sus
 * carteras, sin el vendedor ni el precio de venta; el vendedor no ve nada de sus ancestros.
 *
 * La red es la de `network-hold-cases.ts` (P → C → A → S1/S2), con una vertical y un proveedor
 * propios de la corrida. Las órdenes las siembra el superusuario con la vertical de la corrida
 * (`ExternalOrderIntentService` sólo acepta las verticales reales, que otras suites comparten).
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD), como wallets-rls.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HUGE_CREDIT = 50_000_000;
const S1_WITH_P = NETWORK_HOLD_CASES.find((c) => c.name === 'S1 con la cuenta de P')!;

d('retención en cascada por la API (0060, como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar la red, mirar y desmontar. */
  const admin = new pg.Pool();
  const database = new DatabaseService();
  database.db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        user: 'app_user',
        password: process.env['APP_USER_PASSWORD'],
        host: process.env['PGHOST'],
        port: Number(process.env['PGPORT'] ?? 5432),
        database: process.env['PGDATABASE'],
      }),
    }),
  });
  const portfolios = new PortfoliosService(
    database,
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );
  const financing = new WalletFinancingService(database, new AuditService(database));

  let net: SeededNetwork;
  const id = (k: NodeKey) => net.ids[k];

  function quote(
    seller: NodeKey,
    owner: AccountOwner | null,
    extra: { currency?: string; netMinor?: number | null; account?: string | null } = {},
  ): BookingHoldQuote {
    return {
      amount: { amountMinor: saleOf(seller), currency: extra.currency ?? 'USD' },
      netMinor: extra.netMinor === undefined ? NET_MINOR : extra.netMinor,
      vertical: net.vertical as BookingHoldVertical,
      providerCode: net.provider,
      providerAccountId:
        extra.account !== undefined ? extra.account : owner === null ? null : net.accounts[owner],
    };
  }

  function openOrder(seller: NodeKey, owner: AccountOwner | null, currency = 'USD') {
    return seedOrder(admin, {
      tenantId: id(seller),
      userId: net.sellers[seller],
      provider: net.provider,
      totalMinor: saleOf(seller),
      currency,
      accountId: owner === null ? null : net.accounts[owner],
      vertical: net.vertical,
      pricing: { netMinor: NET_MINOR, currency },
    });
  }

  async function balance(k: NodeKey, currency = 'USD'): Promise<number | undefined> {
    const { rows } = await admin.query<{ b: string }>(
      'SELECT balance_minor::text AS b FROM agency_portfolios WHERE tenant_id = $1 AND currency = $2',
      [id(k), currency],
    );
    return rows[0] === undefined ? undefined : Number(rows[0].b);
  }

  async function fail(orderId: string): Promise<void> {
    await admin.query(
      `UPDATE orders SET status = 'failed', create_request_key = NULL,
                         provider_raw = '{"reason":"rate-unavailable"}'::jsonb
        WHERE id = $1`,
      [orderId],
    );
  }

  async function blockedEvents(orderId: string) {
    const { rows } = await admin.query<{
      tenant_id: string;
      actor: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, actor_user_id AS actor, payload FROM domain_events
        WHERE aggregate_type = 'order' AND aggregate_id = $1
          AND event_type = 'portfolio.network_hold.blocked'`,
      [orderId],
    );
    return rows;
  }

  beforeAll(async () => {
    net = await seedNetwork(admin, {
      sfx,
      vertical: cascadeVertical(),
      provider: cascadeProvider(sfx),
    });
    for (const k of ['S1', 'S2', 'A', 'C'] as const) {
      await seedWallet(admin, id(k), { creditLimitMinor: HUGE_CREDIT });
    }
  });

  afterAll(async () => {
    await teardownNetwork(admin, net);
    await database.db.destroy();
    await admin.end();
  });

  it('S1 con la cuenta de P: retiene en S1, A y C y la respuesta sólo trae lo de S1', async () => {
    const orderId = await openOrder('S1', 'P');
    const expected = expectedHolds(S1_WITH_P);
    const before = { S1: await balance('S1'), A: await balance('A'), C: await balance('C') };

    await portfolios.assertBookingHoldAffordable(id('S1'), quote('S1', 'P'));
    const { portfolio, transaction } = held(
      await portfolios.holdBookingIntent(id('S1'), orderId, net.sellers.S1, {
        amountMinor: saleOf('S1'),
        currency: 'USD',
      }),
    );

    expect(portfolio.tenant_id).toBe(id('S1'));
    expect(transaction).toMatchObject({
      transaction_type: 'BOOKING_HOLD',
      reference_id: orderId,
      created_by: net.sellers.S1,
    });
    expect(Number(transaction.amount_minor)).toBe(-saleOf('S1'));
    // Los montos de la spec: 1.397,09 (venta), 1.134,00 y 1.050,00 (costos).
    expect(expected.get('S1')).toBe(139_709);
    expect(await balance('S1')).toBe(before.S1! - 139_709);
    expect(await balance('A')).toBe(before.A! - 113_400);
    expect(await balance('C')).toBe(before.C! - 105_000);

    // Lo libera la API, en todos los niveles, cuando el proveedor no la hizo.
    await fail(orderId);
    await expect(
      portfolios.releaseFailedBookingHold(id('S1'), orderId, net.sellers.S1),
    ).resolves.toBe('released');
    expect(await balance('S1')).toBe(before.S1);
    expect(await balance('A')).toBe(before.A);
    expect(await balance('C')).toBe(before.C);
    await expect(
      portfolios.releaseFailedBookingHold(id('S1'), orderId, net.sellers.S1),
    ).resolves.toBe('already-released');
  });

  it('vuelos y autos (hold-booking) sin cuenta en la orden: retiene hasta el dueño de la que la bóveda resuelve', async () => {
    // Como una orden de vuelos: sin provider_account_id y confirmada. A S1 la bóveda le resuelve la
    // cuenta de A (la heredable más cercana), así que ni A ni C tienen nada en juego.
    const orderId = await seedOrder(admin, {
      tenantId: id('S1'),
      userId: net.sellers.S1,
      provider: net.provider,
      totalMinor: saleOf('S1'),
      accountId: null,
      vertical: net.vertical,
      pricing: { netMinor: NET_MINOR, currency: 'USD' },
      status: 'confirmed',
    });
    const before = { S1: await balance('S1'), A: await balance('A'), C: await balance('C') };

    await portfolios.holdBooking(id('S1'), orderId, net.sellers.S1);

    expect(await balance('S1')).toBe(before.S1! - saleOf('S1'));
    expect(await balance('A')).toBe(before.A);
    expect(await balance('C')).toBe(before.C);
    const { rows } = await admin.query<{ source: string; owner: string }>(
      `SELECT credential_source AS source, credential_owner_tenant_id AS owner
         FROM wallet_hold_groups WHERE order_id = $1`,
      [orderId],
    );
    expect(rows[0]).toEqual({ source: 'resolved', owner: id('A') });
  });

  it('C con su cuenta propia (O = T): no retiene nada ni necesita cartera en esa moneda; S1 con esa cuenta sigue reteniendo su cadena', async () => {
    // PEN: nadie de la red tiene cartera en esa moneda, tampoco C.
    const orderId = await openOrder('C', 'C', 'PEN');
    await expect(
      portfolios.previewBookingHold(id('C'), quote('C', 'C', { currency: 'PEN' }), {
        reportNetworkBlock: true,
      }),
    ).resolves.toEqual({ status: 'own-account', currency: 'PEN' });
    await portfolios.assertBookingHoldAffordable(id('C'), quote('C', 'C', { currency: 'PEN' }), {
      reportOrderId: orderId,
    });
    await expect(
      portfolios.holdBookingIntent(id('C'), orderId, net.sellers.C, {
        amountMinor: saleOf('C'),
        currency: 'PEN',
      }),
    ).resolves.toEqual({ status: 'own-account' });
    expect(await balance('C', 'PEN')).toBeUndefined();
    const { rows: entries } = await admin.query(
      'SELECT 1 FROM portfolio_transactions WHERE lower(reference_id) = lower($1)',
      [orderId],
    );
    expect(entries).toHaveLength(0);
    await fail(orderId);
    await expect(
      portfolios.releaseFailedBookingHold(id('C'), orderId, net.sellers.C),
    ).resolves.toBe('no-hold');

    // Un vuelo confirmado sin cuenta en la orden: que la bóveda le resuelva hoy a C la suya no prueba
    // con qué cuenta se reservó, así que no lo exime. Retiene en su cartera, y no tiene en PEN.
    const flight = await seedOrder(admin, {
      tenantId: id('C'),
      userId: net.sellers.C,
      provider: net.provider,
      totalMinor: saleOf('C'),
      currency: 'PEN',
      accountId: null,
      vertical: net.vertical,
      pricing: { netMinor: NET_MINOR, currency: 'PEN' },
      status: 'confirmed',
    });
    await expect(portfolios.holdBooking(id('C'), flight, net.sellers.C)).rejects.toMatchObject({
      name: 'BookingHoldRejectedError',
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
    });
    const { rows: flightGroup } = await admin.query(
      'SELECT 1 FROM wallet_hold_groups WHERE order_id = $1',
      [flight],
    );
    expect(flightGroup).toHaveLength(0);

    // Cartera B2B y la búsqueda lo saben: C reserva con su cuenta; S1 la hereda, no es suya.
    expect((await portfolios.overview(id('C'))).ownProviderAccounts).toEqual([net.provider]);
    expect((await portfolios.overview(id('S1'))).ownProviderAccounts).toEqual([]);

    // S1 vende con la cuenta de C: retiene S1 y A por debajo de C; C no.
    const before = { S1: await balance('S1'), A: await balance('A'), C: await balance('C') };
    const byChild = await openOrder('S1', 'C');
    held(
      await portfolios.holdBookingIntent(id('S1'), byChild, net.sellers.S1, {
        amountMinor: saleOf('S1'),
        currency: 'USD',
      }),
    );
    expect(await balance('S1')).toBe(before.S1! - saleOf('S1'));
    expect(await balance('A')).toBe(before.A! - 113_400);
    expect(await balance('C')).toBe(before.C);
    await fail(byChild);
    await portfolios.releaseFailedBookingHold(id('S1'), byChild, net.sellers.S1);
  });

  it('quien financia ve la reserva de su red al costo de su nivel; el vendedor no ve nada de arriba', async () => {
    const orderId = await openOrder('S1', 'P');
    await portfolios.holdBookingIntent(id('S1'), orderId, net.sellers.S1, {
      amountMinor: saleOf('S1'),
      currency: 'USD',
    });
    const { rows } = await admin.query<{ order_number: string; name: string }>(
      `SELECT o.order_number::text AS order_number, t.name
         FROM orders o JOIN tenants t ON t.id = o.tenant_id WHERE o.id = $1`,
      [orderId],
    );
    const orderNumber = Number(rows[0]!.order_number);

    // A, desde su Cartera B2B.
    const ofA = await portfolios.listNetworkHolds(id('A'), { currency: 'USD' });
    const item = ofA.items.find((i) => i.orderNumber === orderNumber);
    expect(item).toMatchObject({
      currency: 'USD',
      amountMinor: 113_400,
      status: 'held',
      originTenantId: id('S1'),
      originTenantName: rows[0]!.name,
      orderNumber,
    });
    expect(Object.keys(item!).sort()).toEqual(
      [
        'levelId',
        'currency',
        'exponent',
        'amountMinor',
        'status',
        'originTenantId',
        'originTenantName',
        'orderNumber',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(ofA.totals.find((t) => t.currency === 'USD')?.heldMinor).toBeGreaterThanOrEqual(113_400);
    // Nada del vendedor, del precio de venta ni de los pasajeros.
    expect(JSON.stringify(ofA)).not.toContain(net.sellers.S1);
    expect(ofA.items.some((i) => i.amountMinor === saleOf('S1'))).toBe(false);

    // Sus movimientos, como los ve un admin de A: el NETWORK_HOLD con la agencia de origen y el
    // número, sin quién lo firmó ni el id de una orden que A no puede abrir.
    const movements = await portfolios.listTransactions(id('A'), 'USD', { includeNetwork: true });
    const hold = movements.find(
      (m) => m.transactionType === 'NETWORK_HOLD' && m.network?.orderNumber === orderNumber,
    );
    expect(hold).toMatchObject({
      amountMinor: -113_400,
      referenceId: null,
      createdBy: null,
      createdByName: null,
      network: {
        originTenantId: id('S1'),
        originTenantName: rows[0]!.name,
        orderNumber,
        status: 'held',
      },
    });
    // Y como los ve el resto del personal de A: el monto y el tipo, sin de quién es la venta.
    const staffView = await portfolios.listTransactions(id('A'), 'USD');
    const networkRows = staffView.filter((m) => m.transactionType.startsWith('NETWORK_'));
    expect(networkRows.length).toBeGreaterThan(0);
    for (const m of networkRows) {
      expect(m).toMatchObject({ referenceId: null, createdBy: null, network: null });
    }
    expect(JSON.stringify(staffView)).not.toContain(orderId);
    expect(JSON.stringify(staffView)).not.toContain(id('S1'));

    // C, que financia a A, lo ve en las carteras de A; y en las suyas, su propio costo.
    const cSeesA = await financing.listNetworkHolds(net.admins.C, id('A'), { status: 'held' });
    expect(cSeesA.items.some((i) => i.orderNumber === orderNumber)).toBe(true);
    const ofC = await portfolios.listNetworkHolds(id('C'), {});
    expect(ofC.items.find((i) => i.orderNumber === orderNumber)?.amountMinor).toBe(105_000);

    // S1 vende: no tiene red por debajo ni ve lo de arriba.
    const ofS1 = await portfolios.listNetworkHolds(id('S1'), {});
    expect(ofS1).toEqual({ items: [], totals: [] });
    const ownMovements = await portfolios.listTransactions(id('S1'), 'USD');
    expect(ownMovements.some((m) => m.transactionType.startsWith('NETWORK_'))).toBe(false);
    expect(ownMovements.find((m) => m.referenceId === orderId)).toMatchObject({
      transactionType: 'BOOKING_HOLD',
      createdBy: net.sellers.S1,
      network: null,
    });

    // Quien no financia a A no entra.
    await expect(financing.listNetworkHolds(net.admins.S2, id('A'), {})).rejects.toMatchObject({
      reason: 'PORTFOLIO_FINANCIER_REQUIRED',
    });
  });

  it('la liberación que firma alguien de arriba no muestra su nombre en la cartera de quien vende', async () => {
    const orderId = await openOrder('S1', 'P');
    await admin.query(`UPDATE users SET name = $2 WHERE id = $1`, [
      net.admins.C,
      `Admin interno de C ${sfx}`,
    ]);
    await admin.query(`UPDATE users SET name = $2 WHERE id = $1`, [
      net.sellers.S1,
      `Vendedora de S1 ${sfx}`,
    ]);
    await portfolios.holdBookingIntent(id('S1'), orderId, net.sellers.S1, {
      amountMinor: saleOf('S1'),
      currency: 'USD',
    });
    await fail(orderId);
    // Como la conciliación de la red: firma un admin del dueño de la cuenta, sin membership en S1.
    await expect(
      portfolios.releaseFailedBookingHold(id('S1'), orderId, net.admins.C),
    ).resolves.toBe('released');

    const own = await portfolios.listTransactions(id('S1'), 'USD');
    expect(
      own.find((m) => m.transactionType === 'BOOKING_HOLD' && m.referenceId === orderId),
    ).toMatchObject({ createdBy: net.sellers.S1, createdByName: `Vendedora de S1 ${sfx}` });
    expect(
      own.find((m) => m.transactionType === 'BOOKING_RELEASED' && m.referenceId === orderId),
    ).toMatchObject({ createdBy: null, createdByName: null });
    expect(JSON.stringify(own)).not.toContain('Admin interno de C');
    expect(JSON.stringify(own)).not.toContain(net.admins.C);
  });

  it('un PreBook que la red bloquea le avisa al nivel que bloquea, una vez por día, sin orden', async () => {
    const before = await balance('C');
    await seedWallet(admin, id('C'), { creditLimitMinor: 0, balanceMinor: 0 });
    const events = async () =>
      (
        await admin.query<{
          tenant_id: string;
          actor: string | null;
          aggregate_type: string;
          aggregate_id: string;
          payload: Record<string, unknown>;
        }>(
          `SELECT tenant_id, actor_user_id AS actor, aggregate_type, aggregate_id, payload
             FROM domain_events
            WHERE event_type = 'portfolio.network_hold.blocked' AND aggregate_type = 'tenant'
              AND aggregate_id = $1`,
          [id('S1')],
        )
      ).rows;
    try {
      // Sólo leer no avisa: el control del Book con la orden abierta tiene su propio aviso.
      await portfolios.previewBookingHold(id('S1'), quote('S1', 'P'));
      expect(await events()).toEqual([]);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          portfolios.previewBookingHold(id('S1'), quote('S1', 'P'), { reportNetworkBlock: true }),
        ).resolves.toMatchObject({ reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' });
      }
      const seen = await events();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        tenant_id: id('C'),
        actor: null,
        payload: {
          originTenantId: id('S1'),
          depth: 2,
          currency: 'USD',
          reason: 'network_funds_unavailable',
          amountMinor: 105_000,
          stage: 'prebook',
        },
      });
      expect(JSON.stringify(seen)).not.toContain(net.sellers.S1);

      // Con la cuenta de C, C es el dueño y no bloquea: no hay a quién avisar.
      await portfolios.previewBookingHold(id('S1'), quote('S1', 'C'), { reportNetworkBlock: true });
      expect(await events()).toHaveLength(1);
    } finally {
      await seedWallet(admin, id('C'), { creditLimitMinor: HUGE_CREDIT, balanceMinor: before! });
    }
  });

  it('un nivel sin cartera en la moneda: 409 de la red, nada escrito y aviso a ese nivel', async () => {
    await seedWallet(admin, id('S1'), { currency: 'COP', creditLimitMinor: HUGE_CREDIT });
    const orderId = await openOrder('S1', 'P', 'COP');
    const before = await balance('S1', 'COP');

    const preview = await portfolios.previewBookingHold(
      id('S1'),
      quote('S1', 'P', { currency: 'COP' }),
    );
    expect(preview).toEqual({
      status: 'blocked',
      currency: 'COP',
      reason: 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED',
      message:
        'Tu red todavía no opera en COP, así que no se puede retener saldo para esta reserva. Pedile a quien te financia que lo habilite.',
    });

    const err = await portfolios
      .holdBookingIntent(id('S1'), orderId, net.sellers.S1, {
        amountMinor: saleOf('S1'),
        currency: 'COP',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED');
    expect((err as BookingHoldRejectedError).message).not.toMatch(UUID_RE);
    expect(await balance('S1', 'COP')).toBe(before);
    const { rows } = await admin.query('SELECT 1 FROM wallet_hold_groups WHERE order_id = $1', [
      orderId,
    ]);
    expect(rows).toHaveLength(0);
    // El aviso va al primer nivel que bloquea (A), sin actor ni nombres, una sola vez.
    await portfolios
      .assertBookingHoldAffordable(id('S1'), quote('S1', 'P', { currency: 'COP' }), {
        reportOrderId: orderId,
      })
      .catch(() => undefined);
    const blocked = await blockedEvents(orderId);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      tenant_id: id('A'),
      actor: null,
      payload: { originTenantId: id('S1'), depth: 1, reason: 'network_currency_not_enabled' },
    });
  });

  it('el aviso previo es la misma decisión que la retención, y "no se sabe" si la cuenta no se resuelve', async () => {
    const before = await balance('C');
    await seedWallet(admin, id('C'), { creditLimitMinor: 0, balanceMinor: 0 });
    try {
      await expect(
        portfolios.previewBookingHold(id('S1'), quote('S1', 'P')),
      ).resolves.toMatchObject({
        status: 'blocked',
        reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
      });
      // Con la cuenta de C, C es el dueño y no retiene: alcanza con S1 y A.
      await expect(portfolios.previewBookingHold(id('S1'), quote('S1', 'C'))).resolves.toEqual({
        status: 'ok',
        currency: 'USD',
      });
      // Sin neto con red por encima: no se puede calcular el costo.
      await expect(
        portfolios.previewBookingHold(id('S1'), quote('S1', 'C', { netMinor: null })),
      ).resolves.toMatchObject({ reason: 'PORTFOLIO_NETWORK_COST_UNAVAILABLE' });
      // Una cuenta que no es de su red: no se sabe; la reserva decide.
      await expect(
        portfolios.previewBookingHold(id('S1'), quote('S1', 'P', { account: randomUUID() })),
      ).resolves.toBeUndefined();
      await expect(
        portfolios.assertBookingHoldAffordable(
          id('S1'),
          quote('S1', 'P', { account: randomUUID() }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await seedWallet(admin, id('C'), { creditLimitMinor: HUGE_CREDIT, balanceMinor: before! });
    }
  });

  it('la cuenta de la orden que se desactivó antes de retener: 409 PORTFOLIO_HOLD_ACCOUNT_CHANGED', async () => {
    const orderId = await openOrder('S1', 'C');
    await admin.query(`UPDATE provider_accounts SET status = 'disabled' WHERE id = $1`, [
      net.accounts.C,
    ]);
    try {
      await expect(
        portfolios.holdBookingIntent(id('S1'), orderId, net.sellers.S1, {
          amountMinor: saleOf('S1'),
          currency: 'USD',
        }),
      ).rejects.toBeInstanceOf(PortfolioHoldAccountChangedError);
    } finally {
      await admin.query(`UPDATE provider_accounts SET status = 'active' WHERE id = $1`, [
        net.accounts.C,
      ]);
    }
  });
});
