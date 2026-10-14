import { ConflictException } from '@nestjs/common';
import type { Money, Offer } from '@sales-travel/canonical';
import { OrderCreateNotSentError, type Passenger } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BookingHoldOutcome } from '../portfolios/booking-hold-policy.service.js';
import type { BookingHoldPolicyService } from '../portfolios/booking-hold-policy.service.js';
import type { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { BookingHoldRejectedError, type BookingHoldQuote } from '../portfolios/booking-hold.js';
import type { WalletHoldSettleOutcome } from '../portfolios/wallet-hold.store.js';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderSettlement } from '../providers/provider.types.js';
import type { ProviderEnvironment } from '../providers/provider-environment.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { memoryDb, type Row } from './__fixtures__/memory-orders-db.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';

/**
 * La retención de cartera de la reserva de un vuelo que liquida la red (SAB-10; SAB-FD-2 A), por la
 * puerta pública de `OrdersService.createOrder`.
 *
 * El proveedor es anónimo y declara `settlement` como lo haría Sabre; la retención es un doble de
 * `BookingHoldPolicyService` (la regla de verdad la prueba la base, en
 * `orders.wallet-hold.integration.test.ts`). Lo que se prueba acá es la saga: QUIÉN retiene, CON
 * QUÉ monto y EN QUÉ momento respecto del proveedor, y que una reserva que no salió no deja la
 * retención tomada.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const QUOTATION = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ACCOUNT_VERSION = '2026-10-01T00:00:00.000Z';
const AIR = 'red-air';
const NET = 100_000;

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

function oferta(extra: Partial<Offer> = {}): Offer {
  return {
    id: `${AIR}-offer`,
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: AIR, offerRef: `${AIR}-REF` },
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
    ...extra,
  };
}

function pedido(offer: Offer = oferta()): CreateOrderDto {
  return {
    offer,
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
    quotationId: QUOTATION,
  };
}

/** Un markup del 10 % del propio tenant: la venta de un neto de 1.000,00 es 1.100,00. */
const REGLAS: ApplicableRule[] = [
  { tenantId: TENANT, tenantName: 'Agencia', level: 2, ruleType: 'percentage', valueMinor: 1000 },
];
const VENTA = 110_000;

interface BancoOpts {
  readonly settlement?: ProviderSettlement;
  readonly environment?: ProviderEnvironment;
  readonly hold?: () => Promise<BookingHoldOutcome>;
  readonly preview?: (quote: BookingHoldQuote) => Promise<void>;
  /** Sin la cuenta de la bóveda: el factory no sabe volver a operar con ella. */
  readonly sinCuenta?: boolean;
}

/** El factory anónimo, que además sabe volver a operar con la cuenta de la orden, como Sabre. */
class AccountStubFactory extends StubProviderFactory {
  resolveForOrder(tenantId: string) {
    return this.resolveForTenant(tenantId);
  }
}

function banco(opts: BancoOpts = {}) {
  const factory = opts.sinCuenta
    ? new StubProviderFactory({
        code: AIR,
        ...(opts.settlement === undefined ? {} : { settlement: opts.settlement }),
        ...(opts.environment === undefined ? {} : { providerEnvironment: opts.environment }),
      })
    : new AccountStubFactory({
        code: AIR,
        accountId: ACCOUNT,
        accountUpdatedAt: new Date(ACCOUNT_VERSION),
        ...(opts.settlement === undefined ? {} : { settlement: opts.settlement }),
        ...(opts.environment === undefined ? {} : { providerEnvironment: opts.environment }),
      });
  const registry = new FlightProviderRegistry([factory], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const mem = memoryDb({
    quotations: [{ id: QUOTATION, tenant_id: TENANT }],
    providerAccounts: [{ id: ACCOUNT, updatedAt: ACCOUNT_VERSION }],
  });
  const audit = new RecordingAuditService();
  const adapter = factory.adapterFor(TENANT);
  /** El orden en que ocurren las cosas que importan: aviso, revalidación, retención, write. */
  const pasos: string[] = [];
  adapter.priceOffer.mockImplementation((offer: Offer) => {
    pasos.push('priceOffer');
    return Promise.resolve({ offer, priceChanged: false, warnings: [] });
  });
  const createImpl = adapter.createOrder.getMockImplementation();
  adapter.createOrder.mockImplementation((req, ctx) => {
    pasos.push('createOrder');
    if (createImpl === undefined) throw new Error('sin createOrder');
    return createImpl(req, ctx);
  });

  /** Lo que la orden decía cuando se pidió la retención: la base la lee de ahí. */
  let filaAlRetener: Row | undefined;
  const preview = vi.fn((_tenant: string, quote: BookingHoldQuote) => {
    pasos.push('preview');
    return opts.preview === undefined ? Promise.resolve() : opts.preview(quote);
  });
  const hold = vi.fn((_tenant: string, orderId: string, _user: string, _total: Money) => {
    pasos.push('hold');
    filaAlRetener = { ...mem.rows().find((r) => r['id'] === orderId) };
    return opts.hold === undefined
      ? Promise.resolve({ status: 'held' } as unknown as BookingHoldOutcome)
      : opts.hold();
  });
  const walletHolds = {
    assertBookingHoldAffordable: preview,
    holdBookingIntent: hold,
  } as unknown as BookingHoldPolicyService;
  const settle = vi.fn(
    (_tenant: string, _orderId: string, _actor: string): Promise<WalletHoldSettleOutcome> =>
      Promise.resolve('released'),
  );
  const ledger = { settle } as unknown as BookingHoldLedger;

  const orders = new OrdersService(
    mem.db,
    registry,
    new RecordingQueueService().asService(),
    {} as unknown as AgentCarsProviderFactory,
    audit.asService(),
    { getApplicableRules: () => Promise.resolve(REGLAS) } as unknown as PricingService,
    undefined,
    undefined,
    ledger,
    undefined,
    walletHolds,
  );
  return {
    orders,
    adapter,
    mem,
    audit,
    preview,
    hold,
    settle,
    pasos,
    filaAlRetener: () => filaAlRetener,
  };
}

function orden(b: ReturnType<typeof banco>): Row {
  const row = b.mem.rows()[0];
  if (row === undefined) throw new Error('sin orden');
  return row;
}

describe('quién retiene la cartera al reservar un vuelo (SAB-FD-2 A)', () => {
  it('network-wallet en una cuenta real: aviso antes de revalidar y retención antes del write', async () => {
    const b = banco({ settlement: 'network-wallet' });

    const { order, saga } = await b.orders.createOrder(TENANT, USER, pedido());

    expect(saga).toEqual({ kind: 'settled', status: 'confirmed' });
    expect(order.status).toBe('confirmed');
    expect(b.pasos).toEqual(['preview', 'priceOffer', 'hold', 'createOrder']);

    // El aviso: la venta con las reglas de la BD (nunca el pricing del navegador), el neto de la
    // oferta y la cuenta con que se va a reservar.
    expect(b.preview).toHaveBeenCalledWith(
      TENANT,
      {
        amount: { amountMinor: VENTA, currency: 'USD' },
        netMinor: NET,
        vertical: 'flights',
        providerCode: AIR,
        providerAccountId: ACCOUNT,
      },
      { reportOrderId: order.id },
    );
    // La retención: sobre el intent abierto, con lo revalidado, y la orden ya lo dice.
    expect(b.hold).toHaveBeenCalledWith(TENANT, order.id, USER, {
      amountMinor: VENTA,
      currency: 'USD',
    });
    expect(b.filaAlRetener()).toMatchObject({
      status: 'pending',
      provider_raw: null,
      total_amount: VENTA,
      currency: 'USD',
      provider_account_id: ACCOUNT,
    });
    expect(b.filaAlRetener()?.['create_request_key']).not.toBeNull();
    // Confirmada: la cobra el trigger de 0060, no la saga.
    expect(b.settle).not.toHaveBeenCalled();
  });

  it('un pricing manipulado en el navegador no baja lo que se avisa ni lo que se retiene', async () => {
    const b = banco({ settlement: 'network-wallet' });
    const trucada = oferta({
      pricing: { costMinor: 1, finalMinor: 1, ownMarkupMinor: 0, currency: 'USD' },
    });

    await b.orders.createOrder(TENANT, USER, pedido(trucada));

    expect(b.preview.mock.calls[0]?.[1].amount).toEqual({ amountMinor: VENTA, currency: 'USD' });
    expect(b.hold.mock.calls[0]?.[3]).toEqual({ amountMinor: VENTA, currency: 'USD' });
  });

  it('provider-direct no retiene', async () => {
    const b = banco({ settlement: 'provider-direct' });
    await b.orders.createOrder(TENANT, USER, pedido());
    expect(b.preview).not.toHaveBeenCalled();
    expect(b.hold).not.toHaveBeenCalled();
    expect(b.pasos).toEqual(['priceOffer', 'createOrder']);
  });

  it('un proveedor que no declara cómo liquida no retiene', async () => {
    const b = banco();
    await b.orders.createOrder(TENANT, USER, pedido());
    expect(b.preview).not.toHaveBeenCalled();
    expect(b.hold).not.toHaveBeenCalled();
  });

  it('una cuenta de pruebas (CERT) no retiene', async () => {
    const b = banco({ settlement: 'network-wallet', environment: 'test' });
    const { order } = await b.orders.createOrder(TENANT, USER, pedido());
    expect(order.status).toBe('confirmed');
    expect(b.preview).not.toHaveBeenCalled();
    expect(b.hold).not.toHaveBeenCalled();
  });

  it('sin cuenta en la orden, el aviso no inventa una: la base resuelve el dueño', async () => {
    const b = banco({ settlement: 'network-wallet', sinCuenta: true });
    await b.orders.createOrder(TENANT, USER, pedido());
    expect(b.preview.mock.calls[0]?.[1].providerAccountId).toBeNull();
    expect(b.hold).toHaveBeenCalledOnce();
  });

  it('con la cuenta propia del nodo la base no retiene, y no hay nada que liberar', async () => {
    const b = banco({
      settlement: 'network-wallet',
      hold: () => Promise.resolve({ status: 'own-account' }),
    });
    b.adapter.createOrder.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'FAILED', items: [], issues: [] }),
    );
    const { order } = await b.orders.createOrder(TENANT, USER, pedido());
    expect(order.status).toBe('failed');
    expect(b.settle).not.toHaveBeenCalled();
  });
});

describe('sin cartera no sale nada hacia el proveedor', () => {
  it('el aviso rechaza: ni revalida ni reserva, y la cotización queda libre para reintentar', async () => {
    const b = banco({
      settlement: 'network-wallet',
      preview: () =>
        Promise.reject(
          new BookingHoldRejectedError('PORTFOLIO_FUNDS_INSUFFICIENT', { amountCurrency: 'USD' }),
        ),
    });

    const err = await b.orders.createOrder(TENANT, USER, pedido()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_FUNDS_INSUFFICIENT');
    expect((err as BookingHoldRejectedError).getStatus()).toBe(409);
    expect(b.pasos).toEqual(['preview']);
    expect(orden(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.hold).not.toHaveBeenCalled();
  });

  it('la retención rechaza después de revalidar: no reserva, cierra la orden y libera lo que quedara', async () => {
    const b = banco({
      settlement: 'network-wallet',
      hold: () =>
        Promise.reject(
          new BookingHoldRejectedError('PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE', {
            amountCurrency: 'USD',
          }),
        ),
    });

    await expect(b.orders.createOrder(TENANT, USER, pedido())).rejects.toBeInstanceOf(
      BookingHoldRejectedError,
    );

    expect(b.pasos).toEqual(['preview', 'priceOffer', 'hold']);
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
    expect(orden(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.settle).toHaveBeenCalledWith(TENANT, orden(b)['id'], USER);
  });

  it('una orden que otro camino ya cerró no se retiene ni se reserva', async () => {
    const b = banco({ settlement: 'network-wallet' });
    b.adapter.priceOffer.mockImplementationOnce((offer: Offer) => {
      const row = b.mem.rows()[0];
      if (row !== undefined) row['provider_raw'] = { closedBy: 'otro' };
      return Promise.resolve({ offer, priceChanged: false, warnings: [] });
    });

    await expect(b.orders.createOrder(TENANT, USER, pedido())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(b.hold).not.toHaveBeenCalled();
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
  });
});

describe('lo que el proveedor no hizo libera la retención', () => {
  it('FAILED: la orden queda fallida y se libera', async () => {
    const b = banco({ settlement: 'network-wallet' });
    b.adapter.createOrder.mockImplementationOnce(() => {
      b.pasos.push('createOrder');
      return Promise.resolve({ outcome: 'FAILED', items: [], issues: [] });
    });

    const { order } = await b.orders.createOrder(TENANT, USER, pedido());

    expect(order.status).toBe('failed');
    expect(b.settle).toHaveBeenCalledOnce();
    expect(b.settle).toHaveBeenCalledWith(TENANT, order.id, USER);
  });

  it('no se envió: la orden se cierra como no enviada y se libera', async () => {
    const b = banco({ settlement: 'network-wallet' });
    b.adapter.createOrder.mockImplementationOnce(() =>
      Promise.reject(new OrderCreateNotSentError('travelers.0.givenName:invalid_string')),
    );

    await expect(b.orders.createOrder(TENANT, USER, pedido())).rejects.toThrow(
      /no se envió a la aerolínea/,
    );
    expect(orden(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.settle).toHaveBeenCalledWith(TENANT, orden(b)['id'], USER);
  });

  it('incierta: la orden sigue pendiente y la base conserva la retención', async () => {
    const b = banco({ settlement: 'network-wallet' });
    b.settle.mockImplementation(() => Promise.resolve('open'));
    b.adapter.createOrder.mockImplementationOnce(() => Promise.reject(new Error('timeout')));

    await expect(b.orders.createOrder(TENANT, USER, pedido())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(orden(b)['status']).toBe('pending');
    // `wallet_hold_settle` con la orden pendiente no toca nada (`open`): no se escala.
    expect(b.audit.ofType('OrderEscalated')).toHaveLength(0);
  });

  it('una liberación que falla no tumba la respuesta: se escala', async () => {
    const b = banco({ settlement: 'network-wallet' });
    b.settle.mockImplementation(() => Promise.reject(new Error('base caída')));
    b.adapter.createOrder.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'FAILED', items: [], issues: [] }),
    );

    const { order } = await b.orders.createOrder(TENANT, USER, pedido());

    expect(order.status).toBe('failed');
    const escaladas = b.audit.ofType('OrderEscalated');
    expect(escaladas).toHaveLength(1);
    expect(escaladas[0]).toMatchObject({
      aggregateId: order.id,
      payload: { reason: 'portfolio-hold-release-failed' },
    });
  });
});
