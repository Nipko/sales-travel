import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import type { OrderRow, OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { BookingHoldRejectedError, type BookingHoldQuote } from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';
import { WalletFinancingService } from './wallet-financing.service.js';
import { clearWalletHoldsOfTenants, seedWallet } from './__fixtures__/wallet-hold-seed.js';
import { held } from './__fixtures__/held-outcome.js';

/**
 * La retención usa la cartera de la MONEDA de la tarifa (decisión del founder del 2026-09-29,
 * opción A), por los servicios de la API y como `app_user`: el rol de producción, bajo la RLS y las
 * guardas de 0052. Una agencia con dos carteras (COP, como la abría la API, y USD, habilitada por
 * su consolidador) retiene cada reserva en la suya, sin tocar la otra ni convertir; sin cartera en
 * la moneda de la tarifa, rechaza con motivo sin abrir una. Vale igual para la retención previa al
 * Book de un hotel (sobre el intent abierto) y para la de una reserva confirmada de autos o vuelos.
 *
 * Los cupos, depósitos y estados los pone quien financia por `WalletFinancingService`, como en
 * producción; el superusuario sólo monta la red, mira y desmonta. Desde 0060 la agencia reserva con
 * credenciales de entorno (el dueño es la raíz), así que el consolidador que la financia retiene
 * también, en la misma moneda: sus carteras las abre el superusuario con cupo de sobra, y lo que
 * este test mira es la cartera de la agencia.
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD), como wallets-rls.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** El neto de cada reserva de este test: el que la base usa para el costo del consolidador. */
const netOf = (totalMinor: number) => Math.floor(totalMinor * 0.9);

d('la retención elige la cartera por la moneda de la tarifa (API como app_user)', () => {
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
  const financing = new WalletFinancingService(database, new AuditService(database));
  const portfolios = new PortfoliosService(
    database,
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );
  const intents = new ExternalOrderIntentService(database);

  const tenants: string[] = [];
  const users: string[] = [];
  let n = 0;

  let consolidator: string;
  let agency: string;
  let financier: string;
  let seller: string;
  let copWallet: string;
  let usdWallet: string;

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`hpc-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`hpc-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  /** Saldo por moneda y los asientos de cada cartera de la agencia. */
  async function wallets(): Promise<Record<string, { balance: number; entries: string[] }>> {
    const { rows } = await admin.query<{
      currency: string;
      balance_minor: string;
      entries: string[];
    }>(
      `SELECT p.currency, p.balance_minor,
              COALESCE(array_agg(t.transaction_type ORDER BY t.created_at, t.id)
                         FILTER (WHERE t.id IS NOT NULL), '{}') AS entries
         FROM agency_portfolios p
         LEFT JOIN portfolio_transactions t ON t.portfolio_id = p.id
        WHERE p.tenant_id = $1
        GROUP BY p.currency, p.balance_minor
        ORDER BY p.currency`,
      [agency],
    );
    return Object.fromEntries(
      rows.map((r) => [r.currency, { balance: Number(r.balance_minor), entries: r.entries }]),
    );
  }

  /** Lo que el aviso previo recibe de una tarifa de hotel de este test. */
  function quote(amount: { amountMinor: number; currency: string }): BookingHoldQuote {
    return {
      amount,
      netMinor: netOf(amount.amountMinor),
      vertical: 'hotels',
      providerCode: `it-hpc-hotels-${sfx}`,
      providerAccountId: null,
    };
  }

  /** Las retenciones de la red en las carteras del consolidador, por moneda. */
  async function networkEntries(): Promise<Record<string, string[]>> {
    const { rows } = await admin.query<{ currency: string; entries: string[] }>(
      `SELECT p.currency,
              COALESCE(array_agg(t.transaction_type ORDER BY t.created_at, t.id)
                         FILTER (WHERE t.id IS NOT NULL), '{}') AS entries
         FROM agency_portfolios p
         LEFT JOIN portfolio_transactions t ON t.portfolio_id = p.id
        WHERE p.tenant_id = $1
        GROUP BY p.currency
        ORDER BY p.currency`,
      [consolidator],
    );
    return Object.fromEntries(rows.map((r) => [r.currency, r.entries]));
  }

  async function openIntent(
    vertical: 'hotels' | 'cars',
    totalMinor: number,
    currency: string,
  ): Promise<OrderRow> {
    n += 1;
    return intents.openExternalCreateIntent(agency, seller, {
      provider: `it-hpc-${vertical}-${sfx}`,
      vertical,
      idempotencyKey: randomUUID(),
      searchCriteria: { ref: `R-${sfx}-${n}` },
      selectedOffer: {
        offerRef: `offer-${sfx}-${n}`,
        pricing: { netMinor: netOf(totalMinor), currency },
      },
      passengers: [{ room: 0 }],
      contactInfo: { email: `pasajero-${sfx}@example.test` },
      totalAmountMinor: totalMinor,
      currency,
      providerBookingRef: `STH${sfx.toUpperCase()}${String(n).padStart(9, '0')}`,
      providerAccountId: null,
    });
  }

  /** Una reserva de autos que el proveedor ya confirmó, como la retiene `hold-booking`. */
  async function confirmedCar(totalMinor: number, currency: string): Promise<OrderRow> {
    const intent = await openIntent('cars', totalMinor, currency);
    const confirmed = await intents.settleExternalCreateIntent(agency, intent, {
      status: 'confirmed',
      providerOrderId: `CAR-${sfx}-${n}`,
      providerRaw: { reason: 'confirmed' },
    });
    if (!confirmed) throw new Error('la reserva de autos no quedó confirmada');
    return confirmed;
  }

  async function reasonOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      if (err instanceof BookingHoldRejectedError) return err.reason;
      throw err;
    }
    throw new Error('esperaba un rechazo de la retención');
  }

  beforeAll(async () => {
    const platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    financier = await user('ca', consolidator, 'consolidator_admin');
    seller = await user('vend', agency, 'vendedor');
    // El nivel de la red que financia a la agencia, con cupo de sobra en las monedas del test.
    for (const currency of ['COP', 'USD', 'EUR']) {
      await seedWallet(admin, consolidator, { currency, creditLimitMinor: 1_000_000_000_00 });
    }

    // Como producción: la cartera COP 0/0 que abría la API sola.
    const cop = await admin.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
       VALUES ($1, 'COP', 0, 0) RETURNING id`,
      [agency],
    );
    copWallet = cop.rows[0]!.id;

    // Quien financia deposita en COP y habilita USD sólo con cupo.
    await financing.recordDeposit(
      financier,
      agency,
      copWallet,
      { amountMinor: 200_000_00, reason: 'Transferencia verificada' },
      randomUUID(),
    );
    const usd = await financing.enableCurrency(financier, agency, {
      currency: 'USD',
      creditLimitMinor: 500_00,
      reason: 'Opera hoteles en dólares',
    });
    usdWallet = usd.id;
  });

  afterAll(async () => {
    // Las retenciones son ON DELETE RESTRICT: se borran antes que las órdenes y los tenants.
    await clearWalletHoldsOfTenants(admin, tenants);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('el aviso del PreBook mira la cartera de la moneda de la tarifa, sin escribir', async () => {
    const before = await wallets();

    await expect(
      portfolios.previewBookingHold(agency, quote(money(340_12, 'USD'))),
    ).resolves.toEqual({
      status: 'ok',
      currency: 'USD',
    });
    // Sobra plata en COP, pero la tarifa en USD pasa el cupo en USD: no se mezclan.
    await expect(
      portfolios.previewBookingHold(agency, quote(money(500_01, 'USD'))),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'PORTFOLIO_FUNDS_INSUFFICIENT',
      currency: 'USD',
    });
    await expect(
      portfolios.previewBookingHold(agency, quote(money(100_00, 'EUR'))),
    ).resolves.toEqual({
      status: 'blocked',
      currency: 'EUR',
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
      message: 'La agencia no tiene cartera en EUR: pedile a quien te financia que la habilite.',
    });
    expect(await wallets()).toEqual(before);
  });

  it('un hotel en USD retiene en la cartera USD, con el cupo, y la de COP no se toca', async () => {
    const intent = await openIntent('hotels', 340_12, 'USD');

    await portfolios.assertBookingHoldAffordable(agency, quote(money(340_12, 'USD')));
    const { portfolio, transaction } = held(
      await portfolios.holdBookingIntent(agency, intent.id, seller, money(340_12, 'USD')),
    );

    expect(portfolio).toMatchObject({ id: usdWallet, currency: 'USD' });
    expect(transaction).toMatchObject({
      portfolio_id: usdWallet,
      transaction_type: 'BOOKING_HOLD',
      reference_id: intent.id,
      created_by: seller,
    });
    expect(await wallets()).toEqual({
      COP: { balance: 200_000_00, entries: ['DEPOSIT_PAYMENT'] },
      USD: { balance: -340_12, entries: ['BOOKING_HOLD'] },
    });
    // 0060: quien financia a la agencia retiene su costo en la misma moneda, no en otra.
    expect(await networkEntries()).toEqual({ COP: [], EUR: [], USD: ['NETWORK_HOLD'] });

    // CA-2: el proveedor no la hizo → se libera en la MISMA cartera.
    await intents.settleExternalCreateIntent(agency, intent, {
      status: 'failed',
      providerRaw: { reason: 'rate-unavailable' },
    });
    await expect(portfolios.releaseFailedBookingHold(agency, intent.id, seller)).resolves.toBe(
      'released',
    );
    expect(await wallets()).toEqual({
      COP: { balance: 200_000_00, entries: ['DEPOSIT_PAYMENT'] },
      USD: { balance: 0, entries: ['BOOKING_HOLD', 'BOOKING_RELEASED'] },
    });
    expect((await networkEntries())['USD']).toEqual(['NETWORK_HOLD', 'NETWORK_RELEASED']);
  });

  it('una reserva de autos confirmada en COP retiene en la cartera COP, y la de USD no se toca', async () => {
    const order = await confirmedCar(150_000_00, 'COP');

    const { portfolio, transaction } = held(
      await portfolios.holdBooking(agency, order.id, seller, {
        amountMinor: 150_000_00,
        currency: 'COP',
      }),
    );

    expect(portfolio).toMatchObject({ id: copWallet, currency: 'COP' });
    expect(transaction).toMatchObject({ portfolio_id: copWallet, reference_id: order.id });
    const after = await wallets();
    expect(after['COP']).toEqual({
      balance: 50_000_00,
      entries: ['DEPOSIT_PAYMENT', 'BOOKING_HOLD'],
    });
    expect(after['USD']?.balance).toBe(0);

    // Índice de 0039: una segunda retención de la misma reserva no debita otra vez.
    await expect(portfolios.holdBooking(agency, order.id, seller)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await wallets())['COP']?.balance).toBe(50_000_00);
  });

  it('sin cartera en la moneda de la tarifa no retiene, ni abre una implícita', async () => {
    const hotel = await openIntent('hotels', 100_00, 'EUR');
    const car = await confirmedCar(100_00, 'EUR');
    const before = await wallets();

    expect(
      await reasonOf(portfolios.assertBookingHoldAffordable(agency, quote(money(100_00, 'EUR')))),
    ).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect(
      await reasonOf(portfolios.holdBookingIntent(agency, hotel.id, seller, money(100_00, 'EUR'))),
    ).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect(await reasonOf(portfolios.holdBooking(agency, car.id, seller))).toBe(
      'PORTFOLIO_CURRENCY_NOT_ENABLED',
    );
    expect(await wallets()).toEqual(before);
  });

  it('la cartera suspendida por quien financia no retiene; lo retenido antes se libera igual', async () => {
    const held = await openIntent('hotels', 100_00, 'USD');
    await portfolios.holdBookingIntent(agency, held.id, seller, money(100_00, 'USD'));
    await financing.updateWallet(financier, agency, usdWallet, {
      status: 'suspended',
      reason: 'Mora en el pago',
    });

    const next = await openIntent('hotels', 100_00, 'USD');
    await expect(
      portfolios.previewBookingHold(agency, quote(money(100_00, 'USD'))),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'PORTFOLIO_INACTIVE' });
    expect(
      await reasonOf(portfolios.holdBookingIntent(agency, next.id, seller, money(100_00, 'USD'))),
    ).toBe('PORTFOLIO_INACTIVE');

    // La plata de una reserva que no se hizo vuelve aunque la cartera esté suspendida.
    await intents.settleExternalCreateIntent(agency, held, {
      status: 'failed',
      providerRaw: { reason: 'rate-unavailable' },
    });
    await expect(portfolios.releaseFailedBookingHold(agency, held.id, seller)).resolves.toBe(
      'released',
    );
    expect((await wallets())['USD']?.balance).toBe(0);
  });
});
