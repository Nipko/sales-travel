import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { PortfoliosController } from './portfolios.controller.js';
import type { PortfoliosService } from './portfolios.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const USER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-28T12:00:00.000Z');

function harness() {
  const portfolio = {
    id: '44444444-4444-4444-8444-444444444444',
    tenant_id: TENANT,
    credit_limit_minor: 0,
    balance_minor: 375_000,
    currency: 'COP',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  };
  const transaction = {
    id: '55555555-5555-4555-8555-555555555555',
    portfolio_id: portfolio.id,
    amount_minor: -125_000,
    transaction_type: 'BOOKING_HOLD',
    reference_id: ORDER,
    idempotency_key: null,
    notes: 'hold',
    created_by: USER,
    created_at: NOW,
  };
  const result = { portfolio, transaction };
  const holdBooking = vi.fn(() => Promise.resolve(result));
  const deposit = vi.fn(() => Promise.resolve(result));
  const withdraw = vi.fn(() => Promise.resolve(result));
  const approveBooking = vi.fn(() => Promise.resolve({ success: false, message: 'blocked' }));
  const rejectBooking = vi.fn(() => Promise.resolve({ success: true, message: 'released' }));
  const portfolios = {
    holdBooking,
    deposit,
    withdraw,
    approveBooking,
    rejectBooking,
  } as unknown as PortfoliosService;
  const activeTenant = {
    resolve: vi.fn(() => Promise.resolve(TENANT)),
  } as unknown as ActiveTenantService;
  const membershipQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  membershipQuery.select = vi.fn(() => membershipQuery);
  membershipQuery.where = vi.fn(() => membershipQuery);
  membershipQuery.executeTakeFirst = vi.fn(() => Promise.resolve({ role: 'agency_admin' }));
  const db = {
    withRequestContext: <T>(
      _context: unknown,
      callback: (trx: { selectFrom: () => typeof membershipQuery }) => Promise<T>,
    ) => callback({ selectFrom: () => membershipQuery }),
  } as unknown as DatabaseService;
  const controller = new PortfoliosController(portfolios, db, activeTenant);
  return { controller, holdBooking, deposit, withdraw, approveBooking, rejectBooking };
}

describe('PortfoliosController.hold', () => {
  it('permite omitir monto y moneda: la fuente autoritativa es la orden en el servicio', async () => {
    const h = harness();

    const response = await h.controller.hold(USER, { orderId: ORDER });

    expect(h.holdBooking).toHaveBeenCalledWith(TENANT, ORDER, USER, {});
    expect(response.transaction).toMatchObject({
      amountMinor: -125_000,
      transactionType: 'BOOKING_HOLD',
    });
  });

  it('canonicaliza el casing del UUID antes de llamar al servicio', async () => {
    const h = harness();

    await h.controller.hold(USER, { orderId: ORDER.toUpperCase() });

    expect(h.holdBooking).toHaveBeenCalledWith(TENANT, ORDER, USER, {});
  });

  it('trata amountMinor y currency enviados como expectativas normalizadas', async () => {
    const h = harness();

    await h.controller.hold(USER, {
      orderId: ORDER,
      amountMinor: 125_000,
      currency: ' cop ',
    });

    expect(h.holdBooking).toHaveBeenCalledWith(TENANT, ORDER, USER, {
      amountMinor: 125_000,
      currency: 'COP',
    });
  });

  it.each([
    [{ orderId: 'not-a-uuid' }, /orderId/i],
    [{ orderId: ORDER, amountMinor: 0 }, /amountMinor/i],
    [{ orderId: ORDER, amountMinor: 1.5 }, /amountMinor/i],
    [{ orderId: ORDER, currency: 'US' }, /currency/i],
  ])('rechaza un borde inválido antes de llamar al servicio: %o', async (body, message) => {
    const h = harness();

    await expect(
      h.controller.hold(USER, body as { orderId: string; amountMinor?: number; currency?: string }),
    ).rejects.toThrow(message);
    expect(h.holdBooking).not.toHaveBeenCalled();
  });
});

describe('PortfoliosController — idempotencia y params financieros', () => {
  it.each(['deposit', 'withdraw'] as const)(
    'exige y canonicaliza Idempotency-Key en %s',
    async (operation) => {
      const h = harness();
      const key = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

      await h.controller[operation](USER, { amountMinor: 125_000, notes: 'acción' }, key);

      expect(h[operation]).toHaveBeenCalledWith(TENANT, 125_000, USER, key.toLowerCase(), 'acción');
    },
  );

  it.each(['deposit', 'withdraw'] as const)(
    'rechaza %s sin Idempotency-Key UUID antes del write',
    async (operation) => {
      const h = harness();

      await expect(
        h.controller[operation](USER, { amountMinor: 125_000 }, undefined),
      ).rejects.toThrow(/Idempotency-Key/i);
      expect(h[operation]).not.toHaveBeenCalled();
    },
  );

  it.each(['approve', 'reject'] as const)(
    'valida UUID en %s antes de invocar la operación',
    async (operation) => {
      const h = harness();

      await expect(h.controller[operation](USER, 'not-a-uuid')).rejects.toThrow(/orderId/i);
      expect(operation === 'approve' ? h.approveBooking : h.rejectBooking).not.toHaveBeenCalled();
    },
  );
});
