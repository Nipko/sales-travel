import { ConflictException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  MemoryWalletHolds,
  type MemoryOrder,
  type MemoryWallet,
} from './__fixtures__/memory-wallet-holds.js';
import { held } from './__fixtures__/held-outcome.js';
import { BookingHoldRejectedError } from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';

/**
 * La retención de una reserva ya confirmada (vuelos y autos, `POST /portfolios/hold-booking`), con
 * un doble de las funciones de 0060: lo que decide el servicio antes de llamar a
 * `wallet_hold_retain` (la orden, sus expectativas) y cómo traduce lo que la base rechaza.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const USER = '33333333-3333-4333-8333-333333333333';

function order(extra: Partial<MemoryOrder> = {}): MemoryOrder {
  return {
    id: ORDER,
    tenant_id: TENANT,
    status: 'confirmed',
    total_amount: 125_000,
    currency: 'COP',
    provider: 'sabre',
    provider_order_id: 'PNR123',
    provider_raw: { phase: 'create' },
    create_request_key: null,
    ...extra,
  };
}

function harness(
  opts: { order?: Partial<MemoryOrder>; wallet?: Partial<MemoryWallet> | null } = {},
) {
  const bank = new MemoryWalletHolds({
    orders: [order(opts.order)],
    wallets:
      opts.wallet === null
        ? []
        : [
            MemoryWalletHolds.wallet(TENANT, {
              balance_minor: 500_000,
              currency: 'COP',
              ...opts.wallet,
            }),
          ],
  });
  const service = new PortfoliosService(
    bank.asDatabase(),
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );
  return { service, bank, balance: () => bank.wallet(TENANT, 'COP')?.balance_minor };
}

describe('PortfoliosService.holdBooking', () => {
  it('deriva monto y moneda de la orden; los valores del cliente son sólo expectativas', async () => {
    const h = harness();

    const result = held(
      await h.service.holdBooking(TENANT, ORDER, USER, {
        amountMinor: 125_000,
        currency: ' cop ',
      }),
    );

    expect(result.transaction.amount_minor).toBe(-125_000);
    expect(result.transaction.notes).toBe(
      'Retención preventiva de saldo por reserva pendiente de emisión',
    );
    expect(result.portfolio.balance_minor).toBe(375_000);
    expect(h.bank.state.entries).toHaveLength(1);
    // Nace cobrada: la reserva ya existe.
    expect(h.bank.groupOf(ORDER)?.status).toBe('captured');
    expect(h.bank.log).toEqual([
      "SET LOCAL lock_timeout = '2s'",
      'orders FOR UPDATE',
      'wallet_hold_retain',
      'agency_portfolios',
      'portfolio_transactions',
    ]);
  });

  it('retiene con el UUID canónico de la orden, no con el casing recibido', async () => {
    const h = harness();

    await h.service.holdBooking(TENANT, ORDER.toUpperCase(), USER);

    expect(h.bank.calls[0]?.params).toEqual([ORDER, USER]);
    expect(h.bank.state.entries[0]?.reference_id).toBe(ORDER);
  });

  it('rechaza un monto esperado manipulado sin crear el hold ni tocar el balance', async () => {
    const h = harness();

    await expect(h.service.holdBooking(TENANT, ORDER, USER, { amountMinor: 1 })).rejects.toThrow(
      /total de la reserva cambió/i,
    );
    await expect(h.service.holdBooking(TENANT, ORDER, USER, { currency: 'USD' })).rejects.toThrow(
      /moneda de la reserva cambió/i,
    );

    expect(h.balance()).toBe(500_000);
    expect(h.bank.state.entries).toHaveLength(0);
    expect(h.bank.log).not.toContain('wallet_hold_retain');
  });

  it('exige que la orden pertenezca al tenant y esté confirmada, no pendiente o emitida', async () => {
    const foreign = harness();
    await expect(foreign.service.holdBooking(OTHER_TENANT, ORDER, USER)).rejects.toThrow(
      /no se encontró la reserva/i,
    );

    for (const status of ['pending', 'ticketed', 'cancelled', 'failed']) {
      const h = harness({ order: { status } });
      await expect(h.service.holdBooking(TENANT, ORDER, USER)).rejects.toThrow(
        /sólo una reserva confirmada/i,
      );
      expect(h.bank.state.entries).toHaveLength(0);
    }
  });

  it('retiene en la cartera de la moneda de la orden: sin cartera en USD no usa la de COP', async () => {
    const h = harness({ order: { currency: 'USD' } });

    const err = await h.service.holdBooking(TENANT, ORDER, USER).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({ reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED' });
    expect((err as BookingHoldRejectedError).message).toBe(
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    );
    expect(h.balance()).toBe(500_000);
    expect(h.bank.state.entries).toHaveLength(0);
  });

  it('sin ninguna cartera no abre una implícita en COP: rechaza sin escribir', async () => {
    const h = harness({ wallet: null });

    await expect(h.service.holdBooking(TENANT, ORDER, USER)).rejects.toMatchObject({
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
    });
    expect(h.bank.state.wallets).toEqual([]);
    expect(h.bank.state.entries).toHaveLength(0);
  });

  it('sin saldo más cupo que cubra el total: 409 con motivo, sin asiento ni débito', async () => {
    const h = harness({ wallet: { credit_limit_minor: 10_000, balance_minor: 100_000 } });

    const err = await h.service.holdBooking(TENANT, ORDER, USER).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({ reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' });
    expect((err as BookingHoldRejectedError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as BookingHoldRejectedError).message).toMatch(/Informá un depósito en Cartera B2B/);
    expect(h.balance()).toBe(100_000);
    expect(h.bank.state.entries).toHaveLength(0);
  });

  it('el cupo que fija quien financia completa lo que falta de saldo', async () => {
    const h = harness({ wallet: { credit_limit_minor: 25_000, balance_minor: 100_000 } });

    const result = held(await h.service.holdBooking(TENANT, ORDER, USER));

    expect(result.portfolio.balance_minor).toBe(-25_000);
    expect(h.bank.state.entries).toHaveLength(1);
  });

  it('con la cartera de esa moneda suspendida: 409 PORTFOLIO_INACTIVE, sin asiento', async () => {
    const h = harness({ wallet: { status: 'suspended' } });

    const err = await h.service.holdBooking(TENANT, ORDER, USER).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({ reason: 'PORTFOLIO_INACTIVE' });
    expect(h.balance()).toBe(500_000);
    expect(h.bank.state.entries).toHaveLength(0);
  });

  it('un vuelo sin neto con red por encima: 409 PORTFOLIO_NETWORK_COST_UNAVAILABLE y aviso', async () => {
    const h = harness();
    h.bank.network.rejectWith = 'network_cost_unavailable';

    const err = await h.service.holdBooking(TENANT, ORDER, USER).catch((e: unknown) => e);

    expect(err).toMatchObject({ reason: 'PORTFOLIO_NETWORK_COST_UNAVAILABLE' });
    expect(h.balance()).toBe(500_000);
    expect(h.bank.reports).toEqual([{ tenantId: TENANT, orderId: ORDER }]);
  });

  it('un vuelo con la cuenta propia del nodo (O = T) no retiene nada, ni pide cartera en su moneda', async () => {
    const h = harness({ wallet: null });
    h.bank.network.ownAccount = true;

    await expect(h.service.holdBooking(TENANT, ORDER, USER)).resolves.toEqual({
      status: 'own-account',
    });
    expect(h.bank.state.entries).toHaveLength(0);
    expect(h.bank.groupOf(ORDER)).toMatchObject({ status: 'exempt' });

    // Pedirlo otra vez devuelve lo registrado, sin otro grupo ni un 409 de "ya retenida".
    await expect(h.service.holdBooking(TENANT, ORDER, USER)).resolves.toEqual({
      status: 'own-account',
    });
    expect(h.bank.state.groups).toHaveLength(1);
  });

  it('ante dos requests concurrentes crea un solo hold y debita exactamente una vez', async () => {
    const h = harness();

    const results = await Promise.allSettled([
      h.service.holdBooking(TENANT, ORDER, USER),
      h.service.holdBooking(TENANT, ORDER, USER),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected one rejected hold');
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(h.bank.state.entries).toHaveLength(1);
    expect(h.balance()).toBe(375_000);
  });
});
