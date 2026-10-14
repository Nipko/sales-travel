import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { AncillaryCatalog, Offer } from '@sales-travel/canonical';
import type {
  AncillaryAddResult,
  AncillaryRemoveResult,
  Passenger,
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
import { listMovements } from '../portfolios/wallet-store.js';
import {
  cascadeProvider,
  cascadeVertical,
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
import type { ProviderEnvironment } from '../providers/provider-environment.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { FlightOrderTrackingStore } from './flight-order-tracking.store.js';
import { ORDER_EVENTS } from './order-events.js';
import { SERVICES_MESSAGES } from './order-services.plan.js';
import { FlightServicesService, SERVICES_STALE_AFTER_MS } from './order-services.service.js';
import { OrderServicesStore } from './order-services.store.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';
import { FlightTicketIssueService, ISSUE_CLAIM_MESSAGES } from './ticket-issue.service.js';
import { TicketIssueStore } from './ticket-issue.store.js';

/**
 * Maletas y servicios sobre una reserva confirmada (SAB-20) contra Postgres real, por las puertas
 * públicas de `FlightServicesService`, con la retención en cascada de 0060 y su ajuste de 0086
 * (`wallet_hold_adjust`).
 *
 * Lo que se prueba es el DINERO: el total de la orden, el monto de cada nivel de la retención, el
 * saldo de cada cartera y el libro (un asiento por nivel y operación, referido a la operación). Y que
 * cada cosa se mueve una sola vez: un pedido doble no cobra dos veces, quitar dos veces no devuelve
 * dos veces, y cancelar después libera exactamente lo que se retuvo, ajustes incluidos.
 *
 * La red es la de `network-hold-cases.ts` (P → C → A → S1); S1 vende con la cuenta de P, así que
 * retienen S1, A y C. El proveedor es un stub anónimo con el puerto de ancillares. Todo lo que la API
 * ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

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
const MALETA = 4_500;
const COMIDA = 1_500;
const NIVELES = ['S1', 'A', 'C'] as const;

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

/** El catálogo que publica la aerolínea para la reserva: una maleta y una comida. */
function catalogo(): AncillaryCatalog {
  return {
    segments: [
      {
        origin: 'BOG',
        destination: 'LIM',
        departureAt: '2099-09-10T09:00',
        carrier: 'AV',
        flightNumber: '123',
      },
    ],
    offers: [
      {
        serviceOfferItemId: 'BAG-1',
        category: 'BAGGAGE',
        name: 'Maleta 23 kg',
        serviceCode: '0C3',
        airlineCode: 'AV',
        segmentRefs: [0],
        passengers: [
          {
            passengerIndex: 0,
            charge: { type: 'PRICED', price: { amountMinor: MALETA, currency: 'USD' } },
          },
        ],
        quantity: 1,
        weights: [{ value: 23, unit: 'KG' }],
        sellable: true,
      },
      {
        serviceOfferItemId: 'MEAL-1',
        category: 'MEAL',
        name: 'Comida caliente',
        serviceCode: '0B5',
        airlineCode: 'AV',
        segmentRefs: [0],
        passengers: [
          {
            passengerIndex: 0,
            charge: { type: 'PRICED', price: { amountMinor: COMIDA, currency: 'USD' } },
          },
        ],
        quantity: 1,
        weights: [],
        sellable: true,
      },
    ],
    warnings: [],
  };
}

const agregada = (id: string, ids: string[] = [`X${id}`]): AncillaryAddResult['added'][number] => ({
  serviceOfferItemId: id,
  passengerIndex: 0,
  providerItemIds: ids,
  providerItemIdsShared: false,
});

class AccountStubFactory extends StubProviderFactory {
  resolveForOrder(tenantId: string) {
    return this.resolveForTenant(tenantId);
  }
}

d('servicios adicionales antes de emitir (SAB-20) contra Postgres', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  const database = new ComoAppUser();
  let net: SeededNetwork;
  const id = (k: NodeKey) => net.ids[k];

  function oferta(tenantId: string): Offer {
    return {
      id: `${net.provider}-offer`,
      tenantId,
      products: ['flight'],
      provider: { name: net.provider, offerRef: `${net.provider}-REF`, source: 'ATPCO' },
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

  async function montar(opts: { environment?: ProviderEnvironment } = {}) {
    const account = net.accounts.P;
    const factory = new AccountStubFactory({
      code: net.provider,
      capabilities: { issue: true, ticketCheck: true, void: true, addServices: true },
      accountId: account,
      accountUpdatedAt: await versionDe(account),
      settlement: 'network-wallet',
      ...(opts.environment === undefined ? {} : { providerEnvironment: opts.environment }),
    });
    const registry = new FlightProviderRegistry([factory], {
      decisionFor: () => Promise.resolve(undefined),
    });
    const adapter = factory.adapterFor(id('S1'));
    const listAncillaries = vi.fn(() => Promise.resolve(catalogo()));
    const addAncillaries = vi.fn(
      (): Promise<AncillaryAddResult> =>
        Promise.resolve({
          outcome: 'ADDED',
          added: [agregada('BAG-1')],
          failed: [],
          unverified: [],
          issues: [],
        }),
    );
    const removeAncillaries = vi.fn(
      (_ref: unknown, ids: readonly string[]): Promise<AncillaryRemoveResult> =>
        Promise.resolve({
          outcome: 'REMOVED',
          removed: [...ids],
          failed: [],
          unverified: [],
          issues: [],
        }),
    );
    const issueTickets = vi.fn(
      (): Promise<TicketIssueResult> =>
        Promise.resolve({
          outcome: 'ISSUED',
          documents: [],
          warnings: [],
          issues: [],
          idempotencyKey: 'clave',
          formOfPaymentType: 'CASH',
        }),
    );
    Object.assign(adapter, {
      listAncillaries,
      addAncillaries,
      removeAncillaries,
      issueTickets,
      checkTickets: vi.fn(),
    });

    const queue = new RecordingQueueService();
    const audit = new RecordingAuditService();
    const holds = new BookingHoldPolicyService(database);
    const services = new FlightServicesService(
      new OrderServicesStore(database),
      registry,
      holds,
      audit.asService(),
    );
    const orders = new OrdersService(
      database,
      registry,
      queue.asService(),
      {} as unknown as AgentCarsProviderFactory,
      audit.asService(),
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      undefined,
      undefined,
      new BookingHoldLedger(database),
      undefined,
      holds,
      services,
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
    const { order } = await orders.createOrder(
      id('S1'),
      net.sellers.S1,
      pedido('S1'),
      randomUUID(),
    );
    expect(order.status).toBe('confirmed');
    const fila = async () => (await orders.findById(id('S1'), order.id))!;
    return {
      services,
      orders,
      issues,
      audit,
      order,
      fila,
      listAncillaries,
      addAncillaries,
      removeAncillaries,
      issueTickets,
    };
  }

  /** `código/regla` del error de Postgres con que falla `p`, u `ok`. */
  async function regla(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      return `${e.code ?? '?'}/${e.constraint ?? '?'}`;
    }
    return 'ok';
  }

  /**
   * Lo que podría hacer quien tome la API (`app_user` con el tenant del que vende): abrir una
   * operación de servicios pendiente, reescribir el total de la orden y pedir el ajuste con una
   * diferencia declarada. Todo en una transacción: si la base rechaza, no queda nada.
   */
  function ajusteDirecto(
    orderId: string,
    tipo: 'add-services' | 'remove-services',
    delta: number,
    declarada: number,
  ): Promise<unknown> {
    return database.withTenant(id('S1'), async (trx) => {
      const op = await trx
        .insertInto('order_operations')
        .values({
          tenant_id: id('S1'),
          order_id: orderId,
          type: tipo,
          status: 'pending',
          last_error: null,
          result: JSON.stringify({}),
          actor_user_id: net.sellers.S1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('orders')
        .set({ total_amount: sql<number>`total_amount + ${delta}` })
        .where('id', '=', orderId)
        .execute();
      return sql`SELECT * FROM wallet_hold_adjust(${orderId}::uuid, ${net.sellers.S1}::uuid, ${op.id}::uuid, ${declarada}::bigint)`.execute(
        trx,
      );
    });
  }

  async function total(orderId: string): Promise<number> {
    const { rows } = await admin.query<{ t: string }>(
      'SELECT total_amount::text AS t FROM orders WHERE id = $1',
      [orderId],
    );
    return Number(rows[0]!.t);
  }

  async function niveles(orderId: string): Promise<number[]> {
    const { rows } = await admin.query<{ a: string }>(
      'SELECT amount_minor::text AS a FROM wallet_hold_levels WHERE order_id = $1 ORDER BY depth',
      [orderId],
    );
    return rows.map((r) => Number(r.a));
  }

  async function grupo(orderId: string): Promise<{ status: string; sale: number } | undefined> {
    const { rows } = await admin.query<{ status: string; s: string }>(
      'SELECT status, sale_amount_minor::text AS s FROM wallet_hold_groups WHERE order_id = $1',
      [orderId],
    );
    return rows[0] === undefined ? undefined : { status: rows[0].status, sale: Number(rows[0].s) };
  }

  async function saldos(): Promise<number[]> {
    const out: number[] = [];
    for (const k of NIVELES) {
      const { rows } = await admin.query<{ b: string }>(
        `SELECT balance_minor::text AS b FROM agency_portfolios
          WHERE tenant_id = $1 AND currency = 'USD'`,
        [id(k)],
      );
      out.push(Number(rows[0]!.b));
    }
    return out;
  }

  async function ajustes(orderId: string): Promise<[number, string, number, string][]> {
    const { rows } = await admin.query<{
      depth: number;
      direction: string;
      amount: string;
      type: string;
    }>(
      `SELECT a.depth, a.direction, a.amount_minor::text AS amount, t.transaction_type AS type
         FROM wallet_hold_adjustments a
         JOIN portfolio_transactions t ON t.id = a.transaction_id
        WHERE a.order_id = $1
        ORDER BY a.created_at, a.depth`,
      [orderId],
    );
    return rows.map((r) => [r.depth, r.direction, Number(r.amount), r.type]);
  }

  async function lineas(orderId: string): Promise<[string, string][]> {
    const { rows } = await admin.query<{ s: string; status: string }>(
      `SELECT service_offer_item_id AS s, status FROM order_ancillary_lines
        WHERE order_id = $1 ORDER BY created_at, service_offer_item_id`,
      [orderId],
    );
    return rows.map((r) => [r.s, r.status]);
  }

  async function operaciones(orderId: string): Promise<[string, string][]> {
    const { rows } = await admin.query<{ type: string; status: string }>(
      `SELECT type, status FROM order_operations
        WHERE order_id = $1 AND type IN ('add-services', 'remove-services') ORDER BY created_at`,
      [orderId],
    );
    return rows.map((r) => [r.type, r.status]);
  }

  const agregar = (ids: string[], expectedTotalMinor: number) => ({
    selections: ids.map((serviceOfferItemId) => ({ serviceOfferItemId, passengerIndexes: [0] })),
    expectedTotalMinor,
    currency: 'USD',
  });

  beforeAll(async () => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    database.onModuleInit();
    net = await seedNetwork(admin, {
      sfx,
      vertical: cascadeVertical(),
      provider: cascadeProvider(sfx),
    });
    for (const k of NIVELES) await seedWallet(admin, id(k), { creditLimitMinor: CREDIT });
  });

  afterAll(async () => {
    if (net !== undefined) await teardownNetwork(admin, net);
    await database.onModuleDestroy();
    await admin.end();
  });

  it('agregar retiene la diferencia en cada nivel; quitar la libera; cancelar libera todo, ajustes incluidos', async () => {
    const antesDeReservar = await saldos();
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);
    const nivelesBase = await niveles(s.order.id);
    expect(nivelesBase).toHaveLength(3);

    const alta = await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );

    expect(alta).toMatchObject({ outcome: 'ADDED', message: SERVICES_MESSAGES.added });
    expect(await total(s.order.id)).toBe(base + MALETA);
    expect(await niveles(s.order.id)).toEqual(nivelesBase.map((n) => n + MALETA));
    expect(await grupo(s.order.id)).toEqual({ status: 'captured', sale: base + MALETA });
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    expect(await ajustes(s.order.id)).toEqual([
      [0, 'hold', MALETA, 'BOOKING_HOLD'],
      [1, 'hold', MALETA, 'NETWORK_HOLD'],
      [2, 'hold', MALETA, 'NETWORK_HOLD'],
    ]);
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'active']]);
    expect(await operaciones(s.order.id)).toEqual([['add-services', 'success']]);
    expect(s.audit.first(ORDER_EVENTS.servicesAdded)?.payload).toMatchObject({
      count: 1,
      totalMinor: MALETA,
      currency: 'USD',
      hold: 'adjusted',
      testContent: false,
    });
    // El rastro de cada nivel lo deja la base, en el dueño de cada cartera.
    const { rows: eventos } = await admin.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM domain_events
        WHERE event_type = 'portfolio.hold.adjusted' AND aggregate_id = $1 ORDER BY tenant_id`,
      [s.order.id],
    );
    expect(eventos.map((e) => e.tenant_id).sort()).toEqual(NIVELES.map((k) => id(k)).sort());
    // Quien financia ve el asiento del ajuste con la agencia y la reserva de su red, como la
    // retención original; nunca el id de la orden de otro nodo.
    const movimientos = await database.withTenant(id('A'), (trx) =>
      listMovements(trx, id('A'), 'USD', { includeNetwork: true }),
    );
    const ajuste = movimientos.find(
      (m) => m.transactionType === 'NETWORK_HOLD' && m.amountMinor === -MALETA,
    );
    expect(ajuste).toMatchObject({
      referenceId: null,
      network: { originTenantId: id('S1'), orderNumber: s.order.order_number },
    });

    // Quitar: la aerolínea confirma y se libera la misma parte en cada nivel.
    const catalogo = await s.services.catalog(id('S1'), await s.fila());
    const linea = catalogo.added[0]!;
    expect(linea).toMatchObject({ status: 'active', removable: true, amountMinor: MALETA });
    const baja = await s.services.requestRemove(id('S1'), await s.fila(), net.sellers.S1, {
      lineIds: [linea.id],
      expectedTotalMinor: MALETA,
      currency: 'USD',
    });
    expect(baja).toMatchObject({ outcome: 'REMOVED', removedMinor: MALETA });
    expect(s.removeAncillaries).toHaveBeenCalledWith(
      expect.anything(),
      ['XBAG-1'],
      expect.objectContaining({ tenantId: id('S1') }),
    );
    expect(await total(s.order.id)).toBe(base);
    expect(await niveles(s.order.id)).toEqual(nivelesBase);
    expect(await saldos()).toEqual(reservada);
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'removed']]);

    // Quitar otra vez la misma línea: no se manda nada ni se devuelve dos veces.
    await expect(
      s.services.requestRemove(id('S1'), await s.fila(), net.sellers.S1, {
        lineIds: [linea.id],
        expectedTotalMinor: MALETA,
        currency: 'USD',
      }),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.lineNotRemovable));
    expect(s.removeAncillaries).toHaveBeenCalledTimes(1);
    expect(await saldos()).toEqual(reservada);

    // Agregar de nuevo y cancelar: la cancelación libera la venta y lo agregado, en cada nivel.
    await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    const run = await s.orders.cancelOrder(
      id('S1'),
      s.order.id,
      s.order.provider_order_id!,
      net.sellers.S1,
    );
    expect(run.result.success).toBe(true);
    expect((await grupo(s.order.id))?.status).toBe('released');
    expect(await saldos()).toEqual(antesDeReservar);
  });

  it('un alta parcial cobra sólo lo que quedó: lo rechazado sale del total y de la retención', async () => {
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);
    s.addAncillaries.mockResolvedValueOnce({
      outcome: 'PARTIAL',
      added: [agregada('BAG-1')],
      failed: [{ serviceOfferItemId: 'MEAL-1', passengerIndex: 0, reason: 'PRICE_CHANGED' }],
      unverified: [],
      issues: [],
    });

    const alta = await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1', 'MEAL-1'], MALETA + COMIDA),
    );

    expect(alta).toMatchObject({
      outcome: 'PARTIAL',
      message: SERVICES_MESSAGES.partial,
      addedMinor: MALETA,
      failed: 1,
    });
    expect(await total(s.order.id)).toBe(base + MALETA);
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    // Se retuvo todo lo pedido antes de llamar y se liberó lo que no quedó: una vez cada cosa.
    expect(await ajustes(s.order.id)).toEqual([
      [0, 'hold', MALETA + COMIDA, 'BOOKING_HOLD'],
      [1, 'hold', MALETA + COMIDA, 'NETWORK_HOLD'],
      [2, 'hold', MALETA + COMIDA, 'NETWORK_HOLD'],
      [0, 'release', COMIDA, 'BOOKING_RELEASED'],
      [1, 'release', COMIDA, 'NETWORK_RELEASED'],
      [2, 'release', COMIDA, 'NETWORK_RELEASED'],
    ]);
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'active']]);
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('un alta en duda queda retenida y escalada, y frena otro cambio y la emisión hasta conciliarla', async () => {
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);
    s.addAncillaries.mockResolvedValueOnce({
      outcome: 'UNVERIFIED',
      added: [],
      failed: [],
      unverified: [{ serviceOfferItemId: 'BAG-1', passengerIndex: 0 }],
      issues: [],
    });

    const alta = await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );

    expect(alta).toMatchObject({ outcome: 'UNVERIFIED', message: SERVICES_MESSAGES.unverified });
    // Del lado seguro: el total y la retención siguen con lo pedido, nunca se da por caído.
    expect(await total(s.order.id)).toBe(base + MALETA);
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'unverified']]);
    expect(await operaciones(s.order.id)).toEqual([['add-services', 'failed']]);
    expect(s.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'services-unverified',
      reconciliationRequired: true,
    });

    await expect(
      s.services.requestAdd(id('S1'), await s.fila(), net.sellers.S1, agregar(['MEAL-1'], COMIDA)),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.previousUnverified));
    await expect(s.issues.requestIssue(id('S1'), await s.fila(), net.sellers.S1)).rejects.toThrow(
      ConflictException,
    );
    expect(s.addAncillaries).toHaveBeenCalledTimes(1);
  });

  it('si el puerto lanza no se escribió nada: total y retención vuelven y se puede volver a pedir', async () => {
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);
    const caida = new Error('no salió');
    s.addAncillaries.mockRejectedValueOnce(caida);

    await expect(
      s.services.requestAdd(id('S1'), await s.fila(), net.sellers.S1, agregar(['BAG-1'], MALETA)),
    ).rejects.toBe(caida);

    expect(await total(s.order.id)).toBe(base);
    expect(await saldos()).toEqual(reservada);
    expect(await lineas(s.order.id)).toEqual([]);
    expect(await operaciones(s.order.id)).toEqual([['add-services', 'failed']]);
    expect(s.audit.first(ORDER_EVENTS.servicesChangeFailed)?.payload).toMatchObject({
      outcome: 'NOT_SENT',
      retryable: true,
    });

    const otra = await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );
    expect(otra.outcome).toBe('ADDED');
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('un doble clic no cobra dos veces: el segundo pedido choca con el claim mientras el primero vuela', async () => {
    const s = await montar();
    const reservada = await saldos();
    let soltar: () => void = () => undefined;
    const enVuelo = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    s.addAncillaries.mockImplementationOnce(async () => {
      await enVuelo;
      return {
        outcome: 'ADDED',
        added: [agregada('BAG-1')],
        failed: [],
        unverified: [],
        issues: [],
      };
    });

    const primero = s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );
    await vi.waitFor(() => expect(s.addAncillaries).toHaveBeenCalledTimes(1));
    await expect(
      s.services.requestAdd(id('S1'), await s.fila(), net.sellers.S1, agregar(['BAG-1'], MALETA)),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.alreadyPending));
    // Tampoco se emite ni se cancela con el cambio en vuelo.
    await expect(s.issues.requestIssue(id('S1'), await s.fila(), net.sellers.S1)).rejects.toThrow(
      ConflictException,
    );
    soltar();
    expect((await primero).outcome).toBe('ADDED');

    expect(s.addAncillaries).toHaveBeenCalledTimes(1);
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    expect(await operaciones(s.order.id)).toEqual([['add-services', 'success']]);
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('un nivel de la red que no cubre lo agregado: 409, sin llamar a la aerolínea y sin tocar nada', async () => {
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);
    // A queda sin cupo para lo nuevo (lo ya retenido sigue retenido).
    await admin.query(
      `UPDATE agency_portfolios SET credit_limit_minor = -balance_minor + 1
        WHERE tenant_id = $1 AND currency = 'USD'`,
      [id('A')],
    );
    try {
      const error = await s.services
        .requestAdd(id('S1'), await s.fila(), net.sellers.S1, agregar(['BAG-1'], MALETA))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BookingHoldRejectedError);
      expect((error as BookingHoldRejectedError).reason).toBe(
        'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
      );
    } finally {
      await seedWallet(admin, id('A'), {
        creditLimitMinor: CREDIT,
        balanceMinor: reservada[1],
      });
    }
    expect(s.addAncillaries).not.toHaveBeenCalled();
    expect(await total(s.order.id)).toBe(base);
    expect(await saldos()).toEqual(reservada);
    expect(await operaciones(s.order.id)).toEqual([]);
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('una reserva de la cuenta de pruebas no retiene: el total sube y ninguna cartera se mueve', async () => {
    const s = await montar({ environment: 'test' });
    const reservada = await saldos();
    expect(await grupo(s.order.id)).toBeUndefined();

    const alta = await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );

    expect(alta.outcome).toBe('ADDED');
    expect(await total(s.order.id)).toBe(NET + MALETA);
    expect(await saldos()).toEqual(reservada);
    expect(s.audit.first(ORDER_EVENTS.servicesAdded)?.payload).toMatchObject({
      hold: 'no-hold',
      testContent: true,
    });
  });

  it('el precio que vio el vendedor manda: si el catálogo dice otra cosa, 409 sin tocar nada', async () => {
    const s = await montar();
    const reservada = await saldos();
    await expect(
      s.services.requestAdd(id('S1'), await s.fila(), net.sellers.S1, agregar(['BAG-1'], 1)),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.priceChanged));
    expect(s.addAncillaries).not.toHaveBeenCalled();
    expect(await saldos()).toEqual(reservada);
    expect(await operaciones(s.order.id)).toEqual([]);
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('el barrido pasa a conciliación un alta que quedó pendiente, con lo pedido a la vista', async () => {
    const s = await montar();
    const base = await total(s.order.id);
    let soltar: () => void = () => undefined;
    const enVuelo = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    s.addAncillaries.mockImplementationOnce(async () => {
      await enVuelo;
      return {
        outcome: 'ADDED',
        added: [agregada('BAG-1')],
        failed: [],
        unverified: [],
        issues: [],
      };
    });
    const pedido = s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );
    await vi.waitFor(() => expect(s.addAncillaries).toHaveBeenCalledTimes(1));

    // El proceso «murió» con la llamada en vuelo: el barrido la encuentra vencida. El margen cubre
    // la diferencia de reloj entre este proceso y Postgres.
    const despues = Date.now() + SERVICES_STALE_AFTER_MS + 5 * 60_000;
    const report = await s.services.sweepTenant(id('S1'), despues);
    expect(report).toEqual({ examined: 1, reconciling: 1, skipped: 0 });
    expect(await operaciones(s.order.id)).toEqual([['add-services', 'failed']]);
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'unverified']]);
    expect(await total(s.order.id)).toBe(base + MALETA);
    expect(s.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload).toMatchObject({
      reason: 'services-stale',
    });

    // La respuesta tardía no pisa la conciliación: queda en duda para el vendedor.
    soltar();
    expect((await pedido).outcome).toBe('UNVERIFIED');
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'unverified']]);
  });

  it('un fallo tardío del puerto no devuelve lo que el barrido ya pasó a conciliación', async () => {
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);
    s.addAncillaries.mockImplementationOnce(async () => {
      // El proceso se colgó con la llamada en vuelo: el barrido la concilia y DESPUÉS el puerto lanza.
      await s.services.sweepTenant(id('S1'), Date.now() + SERVICES_STALE_AFTER_MS + 5 * 60_000);
      throw new Error('no salió');
    });

    await expect(
      s.services.requestAdd(id('S1'), await s.fila(), net.sellers.S1, agregar(['BAG-1'], MALETA)),
    ).rejects.toThrow('no salió');

    // Las líneas en duda cuentan, y el total y la retención las tienen: nada se devolvió.
    expect(await operaciones(s.order.id)).toEqual([['add-services', 'failed']]);
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'unverified']]);
    expect(await total(s.order.id)).toBe(base + MALETA);
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    expect(
      s.audit.ofType(ORDER_EVENTS.servicesChangeFailed).map((e) => e.payload?.['outcome']),
    ).toEqual(['UNVERIFIED']);
  });

  it('el ajuste nunca libera la retención de la reserva ni absorbe un total que no se declaró (0086)', async () => {
    const s = await montar();
    const reservada = await saldos();
    const base = await total(s.order.id);

    // Liberar por el ajuste lo que retuvo la reserva: ni declarándolo.
    expect(await regla(ajusteDirecto(s.order.id, 'remove-services', -50_000, -50_000))).toBe(
      'STW01/hold_amount_invalid',
    );
    // Una diferencia que no es la declarada no mueve nada, en ningún sentido.
    expect(await regla(ajusteDirecto(s.order.id, 'add-services', 7_000, 4_500))).toBe(
      'STW01/hold_amount_invalid',
    );
    // Una baja no retiene.
    expect(await regla(ajusteDirecto(s.order.id, 'remove-services', 1_000, 1_000))).toBe(
      'STW01/hold_order_not_holdable',
    );
    expect(await total(s.order.id)).toBe(base);
    expect(await saldos()).toEqual(reservada);

    // Con una maleta agregada, una baja libera hasta la maleta y ni un centavo más.
    await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );
    expect(
      await regla(ajusteDirecto(s.order.id, 'remove-services', -(MALETA + 1), -(MALETA + 1))),
    ).toBe('STW01/hold_amount_invalid');
    expect(await saldos()).toEqual(reservada.map((b) => b - MALETA));
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('las líneas de servicios son del nodo que vende: otro nodo no las ve, no las cuelga ni las borra', async () => {
    const s = await montar();
    await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );
    const linea = {
      service_offer_item_id: 'BAG-1',
      passenger_index: 0,
      category: 'BAGGAGE',
      service_code: '0C3',
      airline_code: 'AV',
      name: 'Maleta',
      amount_minor: 1,
      currency: 'USD',
      status: 'active',
      segments: '[]',
      provider_item_ids_shared: false,
    } as const;
    const estado = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code ?? '?';
      }
    };

    // Una hermana (S2) no ve las líneas de S1, aunque conozca el id de la orden.
    const ajenas = await database.withTenant(id('S2'), (trx) =>
      trx
        .selectFrom('order_ancillary_lines')
        .select('id')
        .where('order_id', '=', s.order.id)
        .execute(),
    );
    expect(ajenas).toEqual([]);
    // No puede colgarle una línea con su tenant (FK compuesta) ni con el de S1 (RLS).
    for (const tenant of [id('S2'), id('S1')]) {
      expect(
        await estado(
          database.withTenant(id('S2'), (trx) =>
            trx
              .insertInto('order_ancillary_lines')
              .values({
                ...linea,
                provider_item_ids: ['X1'],
                tenant_id: tenant,
                order_id: s.order.id,
                added_operation_id: randomUUID(),
              })
              .execute(),
          ),
        ),
      ).toMatch(/^(23503|42501)$/);
    }
    // Y ni el propio nodo borra: lo agregado y lo quitado quedan como historia.
    expect(
      await estado(
        database.withTenant(id('S1'), (trx) =>
          trx.deleteFrom('order_ancillary_lines').where('order_id', '=', s.order.id).execute(),
        ),
      ),
    ).toBe('42501');
    expect(await lineas(s.order.id)).toEqual([['BAG-1', 'active']]);
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('emitir con la reserva leída antes de agregar servicios: 409 en el claim, nada sale', async () => {
    const s = await montar();
    // El vendedor confirmó la emisión con este total; mientras, otro agregó una maleta.
    const vista = await s.fila();
    await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1'], MALETA),
    );

    await expect(s.issues.requestIssue(id('S1'), vista, net.sellers.S1)).rejects.toThrow(
      new ConflictException(ISSUE_CLAIM_MESSAGES['total-changed']),
    );
    expect(s.issueTickets).not.toHaveBeenCalled();
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM order_operations WHERE order_id = $1 AND type = 'issue'`,
      [s.order.id],
    );
    expect(rows[0]?.n).toBe('0');
    await s.orders.cancelOrder(id('S1'), s.order.id, s.order.provider_order_id!, net.sellers.S1);
  });

  it('la emisión le dice al proveedor cuánto se vendió en servicios: lo que la red retiene', async () => {
    const s = await montar();
    s.addAncillaries.mockResolvedValueOnce({
      outcome: 'PARTIAL',
      added: [agregada('BAG-1')],
      failed: [{ serviceOfferItemId: 'MEAL-1', passengerIndex: 0, reason: 'PRICE_CHANGED' }],
      unverified: [],
      issues: [],
    });
    await s.services.requestAdd(
      id('S1'),
      await s.fila(),
      net.sellers.S1,
      agregar(['BAG-1', 'MEAL-1'], MALETA + COMIDA),
    );

    const fila = await s.fila();
    const { operationId } = await s.issues.requestIssue(id('S1'), fila, net.sellers.S1);
    await s.issues.runIssueById(id('S1'), s.order.id, operationId, net.sellers.S1);

    // Sólo lo que quedó (la comida se rechazó): lo que el proveedor tiene que cobrar como EMD.
    expect(s.issueTickets).toHaveBeenCalledWith(
      fila.provider_order_id,
      expect.objectContaining({ tenantId: id('S1') }),
      { travelerCount: 1, ancillaryCharge: { amountMinor: MALETA, currency: 'USD' } },
    );
  });
});
