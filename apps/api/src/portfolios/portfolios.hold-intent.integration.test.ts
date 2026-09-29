import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import type { OrderRow, OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { BookingHoldRejectedError } from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Retención antes del Book contra Postgres real (docs/tbo/09 PR-4.8; 08 RF-23 CA 1 y 2).
 *
 * El test unitario usa un banco de mentira; éste prueba lo que sólo la base puede decir: que
 * `tenants.credit_limit` (NUMERIC de 0007) se lee y convierte bien, que los `FOR UPDATE` y el
 * predicado del débito corren como SQL válida bajo el tenant, que la retención cae sobre el intent
 * abierto que deja `ExternalOrderIntentService` y que el índice de 0039 frena la segunda.
 *
 * La red es la del caso: un consolidador y una sub-agencia que reserva con su cuenta heredada,
 * con la cartera en USD y un cupo que la propia agencia se puso.
 *
 * Requiere las migraciones hasta la 0042. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const HEREDADA = { inheritedAccount: true } as const;
const USD = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

d('retención de cartera sobre el intent contra Postgres (0007 + 0039 + 0042)', () => {
  const pool = new pg.Pool();
  const database = new DatabaseService();
  const intents = new ExternalOrderIntentService(database);
  const portfolios = new PortfoliosService(
    database,
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `it-hold-${sfx}`;
  let n = 0;

  let consolidador: string;
  let subagencia: string;
  let usuario: string;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'USD', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  async function abrirIntent(totalMinor: number): Promise<OrderRow> {
    n += 1;
    return intents.openExternalCreateIntent(subagencia, usuario, {
      provider: PROVEEDOR,
      vertical: 'hotels',
      idempotencyKey: randomUUID(),
      searchCriteria: { hotelId: `H-${sfx}` },
      selectedOffer: { offerRef: `offer-${sfx}-${n}` },
      passengers: [{ room: 0 }],
      contactInfo: { email: `huesped-${sfx}@example.test` },
      totalAmountMinor: totalMinor,
      currency: 'USD',
      providerBookingRef: `STH${sfx.toUpperCase()}${String(n).padStart(9, '0')}`,
      providerAccountId: null,
    });
  }

  async function cartera(): Promise<{ balance: number; movimientos: string[] }> {
    const p = await pool.query<{ balance_minor: string }>(
      `SELECT balance_minor FROM agency_portfolios WHERE tenant_id = $1`,
      [subagencia],
    );
    const t = await pool.query<{ transaction_type: string }>(
      `SELECT t.transaction_type FROM portfolio_transactions t
         JOIN agency_portfolios p ON p.id = t.portfolio_id
        WHERE p.tenant_id = $1 ORDER BY t.created_at, t.transaction_type`,
      [subagencia],
    );
    return {
      balance: Number(p.rows[0]?.balance_minor),
      movimientos: t.rows.map((r) => r.transaction_type),
    };
  }

  async function creditoInterno(valor: string): Promise<void> {
    await pool.query(`UPDATE tenants SET credit_limit = $2::numeric WHERE id = $1`, [
      subagencia,
      valor,
    ]);
  }

  beforeAll(async () => {
    database.onModuleInit();
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`hold-intent-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
    consolidador = await crearTenant(`hold-c-${sfx}`, 'consolidator', null);
    subagencia = await crearTenant(`hold-s-${sfx}`, 'agency', consolidador);
    // El cupo de la cartera lo edita la propia agencia: no puede ampliar el crédito de su red.
    await pool.query(
      `INSERT INTO agency_portfolios (tenant_id, credit_limit_minor, balance_minor, currency, status)
       VALUES ($1, 10000000, 0, 'USD', 'active')`,
      [subagencia],
    );
  });

  afterAll(async () => {
    for (const id of [subagencia, consolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('CA-1: sin crédito interno (0007 por defecto) la sub-agencia no retiene, aunque su cartera declare cupo', async () => {
    const intent = await abrirIntent(34_012);

    const previo = await portfolios
      .assertBookingHoldAffordable(subagencia, USD(34_012), HEREDADA)
      .catch((e: unknown) => e);
    const retencion = await portfolios
      .holdBookingIntent(subagencia, intent.id, usuario, USD(34_012), HEREDADA)
      .catch((e: unknown) => e);

    for (const err of [previo, retencion]) {
      expect(err).toBeInstanceOf(BookingHoldRejectedError);
      expect((err as BookingHoldRejectedError).reason).toBe('INTERNAL_CREDIT_INSUFFICIENT');
    }
    expect(await cartera()).toEqual({ balance: 0, movimientos: [] });
  });

  it('con crédito interno la retención cae sobre el intent abierto, con el monto que la orden dice', async () => {
    await creditoInterno('340.11');
    const intent = await abrirIntent(34_012);
    await expect(
      portfolios.holdBookingIntent(subagencia, intent.id, usuario, USD(34_012), HEREDADA),
    ).rejects.toBeInstanceOf(BookingHoldRejectedError);

    await creditoInterno('340.12');
    await portfolios.assertBookingHoldAffordable(subagencia, USD(34_012), HEREDADA);
    const { transaction } = await portfolios.holdBookingIntent(
      subagencia,
      intent.id,
      usuario,
      USD(34_012),
      HEREDADA,
    );

    expect(transaction).toMatchObject({
      transaction_type: 'BOOKING_HOLD',
      reference_id: intent.id,
      created_by: usuario,
    });
    expect(Number(transaction.amount_minor)).toBe(-34_012);
    expect(await cartera()).toEqual({ balance: -34_012, movimientos: ['BOOKING_HOLD'] });

    // Índice de 0039: una segunda retención de la misma orden no debita otra vez.
    await creditoInterno('100000.00');
    await expect(
      portfolios.holdBookingIntent(subagencia, intent.id, usuario, USD(34_012), HEREDADA),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await cartera()).balance).toBe(-34_012);

    // CA-2, incierto: la orden sigue `pending` y la retención no se toca.
    await expect(
      portfolios.releaseFailedBookingHold(subagencia, intent.id, usuario),
    ).rejects.toBeInstanceOf(ConflictException);

    // CA-2, fallo definitivo: `failed` libera, una sola vez.
    const failed = await intents.settleExternalCreateIntent(subagencia, intent, {
      status: 'failed',
      providerRaw: { reason: 'insufficient-balance', providerStatus: '300' },
    });
    expect(failed?.status).toBe('failed');
    await expect(portfolios.releaseFailedBookingHold(subagencia, intent.id, usuario)).resolves.toBe(
      'released',
    );
    await expect(portfolios.releaseFailedBookingHold(subagencia, intent.id, usuario)).resolves.toBe(
      'already-released',
    );
    expect(await cartera()).toEqual({
      balance: 0,
      movimientos: ['BOOKING_HOLD', 'BOOKING_RELEASED'],
    });
  });

  it('una orden ya consolidada no retiene: sólo el intent abierto', async () => {
    await creditoInterno('100000.00');
    const intent = await abrirIntent(1_000);
    await intents.settleExternalCreateIntent(subagencia, intent, {
      status: 'confirmed',
      providerOrderId: `CONF-${sfx}`,
      providerRaw: { reason: 'confirmed' },
    });

    await expect(
      portfolios.holdBookingIntent(subagencia, intent.id, usuario, USD(1_000), HEREDADA),
    ).rejects.toThrow(/Sólo una reserva abierta/);
  });
});
