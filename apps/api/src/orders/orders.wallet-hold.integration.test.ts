import { randomBytes, randomUUID } from 'node:crypto';
import type { Offer } from '@sales-travel/canonical';
import type {
  OrderView,
  Passenger,
  TicketCheckResult,
  TicketIssueResult,
} from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { BookingHoldPolicyService } from '../portfolios/booking-hold-policy.service.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { BookingHoldRejectedError } from '../portfolios/booking-hold.js';
import {
  cascadeProvider,
  cascadeVertical,
  type AccountOwner,
  type NodeKey,
} from '../portfolios/__fixtures__/network-hold-cases.js';
import {
  seedNetwork,
  seedWallet,
  teardownNetwork,
  type SeededNetwork,
} from '../portfolios/__fixtures__/wallet-hold-seed.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { OrderCancelAudit, ProviderSettlement } from '../providers/provider.types.js';
import type { ProviderEnvironment } from '../providers/provider-environment.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { FlightOrderTrackingStore } from './flight-order-tracking.store.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';
import { FlightTicketIssueService } from './ticket-issue.service.js';
import { TicketIssueStore } from './ticket-issue.store.js';

/**
 * La retención de cartera de una reserva de vuelo que liquida la red (SAB-10; SAB-FD-2 A) contra
 * Postgres real, por las puertas públicas de `OrdersService` y `FlightTicketIssueService`, con las
 * funciones de 0060 (`wallet_hold_retain`, `wallet_hold_settle` y sus triggers).
 *
 * El ciclo de vida completo: se retiene en cascada ANTES de llamar al proveedor, se cobra al
 * confirmarse, sigue cobrada al emitir, y se libera al 100 % al cancelar, al anular los tiquetes o
 * si el proveedor no hizo la reserva. No retienen una cuenta de pruebas (CERT), la cuenta propia del
 * nodo que vende ni un proveedor que cobra por su cuenta.
 *
 * La red es la de `network-hold-cases.ts` (P → C → A → S1/S2), con su proveedor propio de la
 * corrida; el proveedor es un stub anónimo que declara `settlement`, como Sabre. Todo lo que la API
 * ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado; el superusuario sólo siembra y
 * mira. Se SALTA sin PGHOST.
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

const NET = 100_000;
const CREDIT = 50_000_000;
const TIQUETE = '0451234567890';

const PASAJERO: Passenger = {
  paxId: 'P1',
  paxType: 'ADT',
  title: 'Mr',
  givenName: 'Juan',
  surname: 'Pérez',
  birthdate: '1990-01-01',
  gender: 'M',
  citizenshipCountryCode: 'CO',
  identityDoc: { type: 'CC', number: '123456789', issuingCountryCode: 'CO' },
};

/** El factory anónimo que, como Sabre, sabe volver a operar con la cuenta de la orden. */
class AccountStubFactory extends StubProviderFactory {
  resolveForOrder(tenantId: string) {
    return this.resolveForTenant(tenantId);
  }
}

interface Grupo {
  status: string;
  credential_source: string;
  levels: { tenant_id: string; depth: number; amount_minor: number; status: string }[];
}

d('retención de cartera de un vuelo que liquida la red (SAB-10) contra Postgres', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar la red, mirar y desmontar. */
  const admin = new pg.Pool();
  const database = new ComoAppUser();
  /** La lectura con que Reservas sabe qué órdenes tienen saldo retenido que liberar. */
  const ledger = new BookingHoldLedger(database);
  let net: SeededNetwork;
  const id = (k: NodeKey) => net.ids[k];

  function oferta(tenantId: string): Offer {
    return {
      id: `${net.provider}-offer`,
      tenantId,
      products: ['flight'],
      provider: { name: net.provider, offerRef: `${net.provider}-REF` },
      total: { amountMinor: NET, currency: 'USD' },
      baseFare: { amountMinor: 80_000, currency: 'USD' },
      taxes: { amountMinor: 20_000, currency: 'USD' },
      itineraries: [
        {
          segments: [
            {
              carrier: 'AV',
              flightNumber: '123',
              origin: 'BOG',
              destination: 'LIM',
              departureAt: '2099-09-10T09:00:00-05:00',
              arrivalAt: '2099-09-10T12:00:00-05:00',
              durationMinutes: 180,
              cabin: 'economy',
              bookingClass: 'Y',
            },
          ],
          totalDurationMinutes: 180,
          stops: 0,
        },
      ],
      fetchedAt: '2099-08-26T12:00:00.000Z',
      expiresAt: '2099-08-26T12:30:00.000Z',
    };
  }

  function pedido(seller: NodeKey): CreateOrderDto {
    return {
      offer: oferta(id(seller)),
      searchCriteria: {
        origin: 'BOG',
        destination: 'LIM',
        departureDate: '2099-09-10',
        paxCount: { adults: 1, children: 0, infants: 0 },
        cabin: 'economy',
        currency: 'USD',
      },
      passengers: [PASAJERO],
      contactInfo: { email: 'a@b.test', phone: '+573000000000' },
    };
  }

  async function versionDe(account: string): Promise<Date> {
    const { rows } = await admin.query<{ updated_at: Date }>(
      'SELECT updated_at FROM provider_accounts WHERE id = $1',
      [account],
    );
    return rows[0]!.updated_at;
  }

  /**
   * La saga con el proveedor anónimo reservando con la cuenta de `owner`. `pasos` dice qué vio la
   * base de la retención en el momento del write al proveedor.
   */
  async function servicio(
    seller: NodeKey,
    opts: {
      owner?: AccountOwner;
      settlement?: ProviderSettlement;
      environment?: ProviderEnvironment;
    } = {},
  ) {
    const owner = opts.owner ?? 'P';
    const account = net.accounts[owner];
    const factory = new AccountStubFactory({
      code: net.provider,
      capabilities: { issue: true, ticketCheck: true, void: true },
      accountId: account,
      accountUpdatedAt: await versionDe(account),
      settlement: opts.settlement ?? 'network-wallet',
      ...(opts.environment === undefined ? {} : { providerEnvironment: opts.environment }),
    });
    const registry = new FlightProviderRegistry([factory], {
      decisionFor: () => Promise.resolve(undefined),
    });
    const adapter = factory.adapterFor(id(seller));
    /** El estado de la retención cuando la reserva salió hacia el proveedor. */
    const alReservar: (string | undefined)[] = [];
    const createImpl = adapter.createOrder.getMockImplementation()!;
    adapter.createOrder.mockImplementation(async (req, ctx) => {
      alReservar.push((await grupo(ctx.requestId ?? ''))?.status);
      return createImpl(req, ctx);
    });
    const issueTickets = vi.fn(
      (): Promise<TicketIssueResult> =>
        Promise.resolve({
          outcome: 'ISSUED',
          documents: [{ number: TIQUETE, kind: 'TICKET', travelerIndex: 0, status: 'ISSUED' }],
          warnings: [],
          issues: [],
          idempotencyKey: 'clave',
          formOfPaymentType: 'CASH',
        }),
    );
    const checkTickets = vi.fn(
      (): Promise<TicketCheckResult> =>
        Promise.resolve({
          checkedAt: new Date().toISOString(),
          tickets: [{ number: TIQUETE, voidable: 'yes', refundable: 'yes' }],
          cancelOffers: [],
        }),
    );
    const cancelOrderAudited = vi.fn(
      (): Promise<OrderCancelAudit> =>
        Promise.resolve({
          result: { success: true, warnings: [] },
          audit: { audited: true, called: true, ticketOperation: 'VOID', voidedTickets: 1 },
          verified: true,
        }),
    );
    Object.assign(adapter, { issueTickets, checkTickets, cancelOrderAudited });

    const queue = new RecordingQueueService();
    const orders = new OrdersService(
      database,
      registry,
      queue.asService(),
      {} as unknown as AgentCarsProviderFactory,
      new RecordingAuditService().asService(),
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      undefined,
      undefined,
      new BookingHoldLedger(database),
      undefined,
      new BookingHoldPolicyService(database),
    );
    const issues = new FlightTicketIssueService(
      new TicketIssueStore(database),
      registry,
      queue.asService(),
      new AuditService(database),
      { sendToTenant: vi.fn(() => Promise.resolve(true)) } as unknown as MailerService,
      { resolve: () => Promise.resolve(null) } as unknown as BrandingService,
      new FlightOrderTrackingStore(database),
    );
    return { orders, issues, adapter, alReservar };
  }

  async function grupo(orderId: string): Promise<Grupo | undefined> {
    const { rows } = await admin.query<{ id: string; status: string; credential_source: string }>(
      'SELECT id, status, credential_source FROM wallet_hold_groups WHERE order_id = $1',
      [orderId],
    );
    const g = rows[0];
    if (g === undefined) return undefined;
    const levels = await admin.query<{
      tenant_id: string;
      depth: number;
      amount_minor: string;
      status: string;
    }>(
      `SELECT p.tenant_id, l.depth, l.amount_minor::text, l.status
         FROM wallet_hold_levels l JOIN agency_portfolios p ON p.id = l.portfolio_id
        WHERE l.group_id = $1 ORDER BY l.depth`,
      [g.id],
    );
    return {
      status: g.status,
      credential_source: g.credential_source,
      levels: levels.rows.map((l) => ({ ...l, amount_minor: Number(l.amount_minor) })),
    };
  }

  async function saldos(keys: readonly NodeKey[]): Promise<Record<string, number | undefined>> {
    const out: Record<string, number | undefined> = {};
    for (const k of keys) {
      const { rows } = await admin.query<{ b: string }>(
        `SELECT balance_minor::text AS b FROM agency_portfolios
          WHERE tenant_id = $1 AND currency = 'USD'`,
        [id(k)],
      );
      out[k] = rows[0] === undefined ? undefined : Number(rows[0].b);
    }
    return out;
  }

  async function estado(orderId: string): Promise<string | undefined> {
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0]?.status;
  }

  /** La Idempotency-Key de cada reserva: un UUID nuevo, como el que manda el panel. */
  function nuevaClave(): string {
    return randomUUID();
  }

  beforeAll(async () => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    database.onModuleInit();
    net = await seedNetwork(admin, {
      sfx,
      vertical: cascadeVertical(),
      provider: cascadeProvider(sfx),
    });
    for (const k of ['S1', 'A', 'C'] as const) {
      await seedWallet(admin, id(k), { creditLimitMinor: CREDIT });
    }
  });

  afterAll(async () => {
    if (net !== undefined) await teardownNetwork(admin, net);
    await database.onModuleDestroy();
    await admin.end();
  });

  it('S1 con la cuenta de P: retiene en S1, A y C antes de reservar, cobra al confirmar, sigue cobrada al emitir y se libera al anular', async () => {
    const s = await servicio('S1');
    const antes = await saldos(['S1', 'A', 'C']);

    const { order, saga } = await s.orders.createOrder(
      id('S1'),
      net.sellers.S1,
      pedido('S1'),
      nuevaClave(),
    );

    expect(saga).toEqual({ kind: 'settled', status: 'confirmed' });
    // Cuando la reserva salió hacia el proveedor, la cascada ya estaba retenida.
    expect(s.alReservar).toEqual(['held']);
    const retenida = await grupo(order.id);
    expect(retenida).toMatchObject({ status: 'captured', credential_source: 'account' });
    expect(retenida?.levels.map((l) => [l.tenant_id, l.depth, l.status])).toEqual([
      [id('S1'), 0, 'captured'],
      [id('A'), 1, 'captured'],
      [id('C'), 2, 'captured'],
    ]);
    // El que vende retiene el precio de venta; cada nivel de la red, lo que retuvo la base.
    expect(retenida?.levels[0]?.amount_minor).toBe(Number(order.total_amount));
    // Reservas la ve abierta, sólo el que vende: su red no lee la orden de otro.
    expect(await ledger.openHoldsOf(id('S1'), [order.id])).toEqual(
      new Map([[order.id, 'captured']]),
    );
    expect(await ledger.openHoldsOf(id('A'), [order.id])).toEqual(new Map());
    const despues = await saldos(['S1', 'A', 'C']);
    for (const [i, k] of (['S1', 'A', 'C'] as const).entries()) {
      expect(despues[k]).toBe(antes[k]! - retenida!.levels[i]!.amount_minor);
    }

    // Emitir (SAB-08) no mueve la retención: ya es un cargo.
    const confirmada = await s.orders.findById(id('S1'), order.id);
    const { operationId } = await s.issues.requestIssue(id('S1'), confirmada!, net.sellers.S1);
    await s.issues.runIssueById(id('S1'), order.id, operationId, net.sellers.S1);
    expect(await estado(order.id)).toBe('ticketed');
    expect((await grupo(order.id))?.status).toBe('captured');
    expect(await saldos(['S1', 'A', 'C'])).toEqual(despues);

    // Anular los tiquetes (SAB-09) cancela la reserva y libera el 100 % en todos los niveles.
    s.adapter.retrieveForDisplay.mockImplementation(
      (pnr: string): Promise<OrderView> =>
        Promise.resolve({
          found: true,
          orderId: pnr,
          pnr,
          airlineLocators: [],
          documents: [{ number: TIQUETE, kind: 'TICKET', status: 'VOIDED', travelerIndex: 0 }],
          warnings: [],
        }),
    );
    const emitida = await s.orders.findById(id('S1'), order.id);
    const anulada = await s.orders.voidTickets(id('S1'), emitida!, net.sellers.S1);
    expect(anulada.outcome).toBe('VOIDED');
    expect(await estado(order.id)).toBe('cancelled');
    const liberada = await grupo(order.id);
    expect(liberada?.status).toBe('released');
    expect(liberada?.levels.every((l) => l.status === 'released')).toBe(true);
    expect(await ledger.openHoldsOf(id('S1'), [order.id])).toEqual(new Map());
    expect(await saldos(['S1', 'A', 'C'])).toEqual(antes);
  });

  it('cancelar una reserva confirmada sin emitir libera la cascada', async () => {
    const s = await servicio('S1');
    const antes = await saldos(['S1', 'A', 'C']);
    const { order } = await s.orders.createOrder(
      id('S1'),
      net.sellers.S1,
      pedido('S1'),
      nuevaClave(),
    );
    expect((await grupo(order.id))?.status).toBe('captured');

    const run = await s.orders.cancelOrder(
      id('S1'),
      order.id,
      order.provider_order_id!,
      net.sellers.S1,
    );

    expect(run.result.success).toBe(true);
    expect((await grupo(order.id))?.status).toBe('released');
    expect(await saldos(['S1', 'A', 'C'])).toEqual(antes);
  });

  it('el proveedor no la hizo (FAILED): la orden queda fallida y la cascada se libera', async () => {
    const s = await servicio('S1');
    const antes = await saldos(['S1', 'A', 'C']);
    s.adapter.createOrder.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'FAILED', items: [], issues: [] }),
    );

    const { order } = await s.orders.createOrder(
      id('S1'),
      net.sellers.S1,
      pedido('S1'),
      nuevaClave(),
    );

    expect(order.status).toBe('failed');
    expect((await grupo(order.id))?.status).toBe('released');
    expect(await saldos(['S1', 'A', 'C'])).toEqual(antes);
  });

  it('una cuenta de pruebas (CERT) no retiene', async () => {
    const s = await servicio('S1', { environment: 'test' });
    const antes = await saldos(['S1', 'A', 'C']);
    const { order } = await s.orders.createOrder(
      id('S1'),
      net.sellers.S1,
      pedido('S1'),
      nuevaClave(),
    );
    expect(order.status).toBe('confirmed');
    expect(await grupo(order.id)).toBeUndefined();
    expect(await saldos(['S1', 'A', 'C'])).toEqual(antes);
  });

  it('un proveedor que cobra por su cuenta (provider-direct) no retiene', async () => {
    const s = await servicio('S1', { settlement: 'provider-direct' });
    const { order } = await s.orders.createOrder(
      id('S1'),
      net.sellers.S1,
      pedido('S1'),
      nuevaClave(),
    );
    expect(order.status).toBe('confirmed');
    expect(await grupo(order.id)).toBeUndefined();
  });

  it('A con su cuenta propia (O = T): no retiene nadie, queda exento y no hace falta cartera', async () => {
    // A no tiene cartera en EUR: con la cuenta propia no la necesita.
    const s = await servicio('A', { owner: 'A' });
    const antes = await saldos(['A', 'C']);
    const dto = pedido('A');
    const eur: CreateOrderDto = {
      ...dto,
      offer: { ...dto.offer, total: { amountMinor: NET, currency: 'EUR' } },
      searchCriteria: { ...dto.searchCriteria, currency: 'EUR' },
    };

    const { order } = await s.orders.createOrder(id('A'), net.sellers.A, eur, nuevaClave());

    expect(order.status).toBe('confirmed');
    expect(await grupo(order.id)).toEqual({
      status: 'exempt',
      credential_source: 'account',
      levels: [],
    });
    // Exenta: no hay saldo retenido que liberar al cancelarla.
    expect(await ledger.openHoldsOf(id('A'), [order.id])).toEqual(new Map());
    expect(await saldos(['A', 'C'])).toEqual(antes);

    // Cancelar una exenta no tiene nada que liberar.
    await s.orders.cancelOrder(id('A'), order.id, order.provider_order_id!, net.sellers.A);
    expect((await grupo(order.id))?.status).toBe('exempt');
  });

  it('S2 sin cartera en la moneda: 409 con el motivo, sin llamar al proveedor ni retener nada', async () => {
    const s = await servicio('S2');
    const antes = await saldos(['A', 'C']);

    const err = await s.orders
      .createOrder(id('S2'), net.sellers.S2, pedido('S2'), nuevaClave())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect(s.adapter.priceOffer).not.toHaveBeenCalled();
    expect(s.adapter.createOrder).not.toHaveBeenCalled();
    const { rows } = await admin.query<{ id: string; status: string; key: string | null }>(
      'SELECT id, status, create_request_key AS key FROM orders WHERE tenant_id = $1',
      [id('S2')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', key: null });
    expect(await grupo(rows[0]!.id)).toBeUndefined();
    expect(await saldos(['A', 'C'])).toEqual(antes);
  });

  it('S1 cuando C suspende su cartera: la red no cubre, 409 de red y nada retenido', async () => {
    const s = await servicio('S1');
    await seedWallet(admin, id('C'), { creditLimitMinor: CREDIT, status: 'suspended' });
    try {
      const antes = await saldos(['S1', 'A', 'C']);
      const err = await s.orders
        .createOrder(id('S1'), net.sellers.S1, pedido('S1'), nuevaClave())
        .catch((e: unknown) => e);

      expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE');
      expect(s.adapter.createOrder).not.toHaveBeenCalled();
      expect(await saldos(['S1', 'A', 'C'])).toEqual(antes);
    } finally {
      await seedWallet(admin, id('C'), { creditLimitMinor: CREDIT });
    }
  });
});
