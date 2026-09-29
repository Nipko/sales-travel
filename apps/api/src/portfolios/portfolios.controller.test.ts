import { BadRequestException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { PortfolioForbiddenError } from './portfolio-errors.js';
import { PortfoliosController } from './portfolios.controller.js';
import type { PortfoliosService } from './portfolios.service.js';
import { WalletFinancingController } from './wallet-financing.controller.js';
import type { WalletFinancingService } from './wallet-financing.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const USER = '33333333-3333-4333-8333-333333333333';
const WALLET = '44444444-4444-4444-8444-444444444444';
const KEY = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const NOW = new Date('2026-09-29T12:00:00.000Z');

function harness(role = 'tenant_admin') {
  const portfolio = {
    id: WALLET,
    tenant_id: TENANT,
    credit_limit_minor: '0',
    balance_minor: '375000',
    currency: 'COP',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  };
  const transaction = {
    id: '55555555-5555-4555-8555-555555555555',
    portfolio_id: portfolio.id,
    amount_minor: '-125000',
    transaction_type: 'BOOKING_HOLD',
    reference_id: ORDER,
    idempotency_key: null,
    notes: 'hold',
    created_by: USER,
    created_at: NOW,
  };
  const service = {
    holdBooking: vi.fn(() => Promise.resolve({ portfolio, transaction })),
    submitDepositReport: vi.fn(() => Promise.resolve({ id: 'r-1' })),
    overview: vi.fn(() => Promise.resolve({ portfolios: [], financier: null })),
    approveBooking: vi.fn(() => Promise.resolve({ success: false, message: 'blocked' })),
    rejectBooking: vi.fn(() => Promise.resolve({ success: true, message: 'released' })),
  };
  const activeTenant = {
    resolve: vi.fn(() => Promise.resolve(TENANT)),
  } as unknown as ActiveTenantService;
  const membershipQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  membershipQuery.select = vi.fn(() => membershipQuery);
  membershipQuery.where = vi.fn(() => membershipQuery);
  membershipQuery.executeTakeFirst = vi.fn(() => Promise.resolve({ role }));
  const db = {
    withRequestContext: <T>(
      _context: unknown,
      callback: (trx: { selectFrom: () => typeof membershipQuery }) => Promise<T>,
    ) => callback({ selectFrom: () => membershipQuery }),
  } as unknown as DatabaseService;
  const controller = new PortfoliosController(
    service as unknown as PortfoliosService,
    db,
    activeTenant,
  );
  return { controller, service };
}

async function rechazo(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

describe('PortfoliosController: la agencia ya no mueve su propia cartera', () => {
  it.each([
    ['deposit', 'informalo en Cartera B2B'],
    ['withdraw', 'los registra quien te financia'],
    ['updateLimit', 'lo fija quien financia a tu agencia'],
  ] as const)('%s responde 403 con motivo y sin tocar el servicio', async (route, texto) => {
    const h = harness();

    const err = await rechazo(() => h.controller[route]());

    expect(err).toBeInstanceOf(PortfolioForbiddenError);
    expect((err as PortfolioForbiddenError).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect((err as PortfolioForbiddenError).reason).toBe('PORTFOLIO_FINANCIER_REQUIRED');
    expect((err as PortfolioForbiddenError).message).toContain(texto);
    expect(Object.values(h.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('PortfoliosController.submitDepositReport', () => {
  const body = {
    currency: 'COP',
    amountMinor: 5_000_000,
    reference: 'TRX-991',
    depositedOn: null,
    notes: null,
  };

  it('exige y canonicaliza la Idempotency-Key, y lo informa a nombre de quien llama', async () => {
    const h = harness();

    await h.controller.submitDepositReport(USER, body, KEY);

    expect(h.service.submitDepositReport).toHaveBeenCalledWith(
      USER,
      TENANT,
      body,
      KEY.toLowerCase(),
    );
  });

  it.each([undefined, 'no-es-uuid'])(
    'sin una clave UUID (%s) no llega al servicio',
    async (key) => {
      const h = harness();

      const err = await rechazo(h.controller.submitDepositReport(USER, body, key));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((err as BadRequestException).getResponse())).toContain(
        'Idempotency-Key',
      );
      expect(h.service.submitDepositReport).not.toHaveBeenCalled();
    },
  );

  it('un vendedor no informa depósitos: lo hace un admin de la agencia', async () => {
    const h = harness('vendedor');

    await expect(h.controller.submitDepositReport(USER, body, KEY)).rejects.toThrow(/admin/);
    expect(h.service.submitDepositReport).not.toHaveBeenCalled();
  });
});

describe('PortfoliosController.hold', () => {
  it('pasa la orden y las expectativas al servicio y devuelve la cartera con su exponente', async () => {
    const h = harness();

    const response = await h.controller.hold(USER, {
      orderId: ORDER,
      amountMinor: 125_000,
      currency: 'COP',
    });

    expect(h.service.holdBooking).toHaveBeenCalledWith(TENANT, ORDER, USER, {
      amountMinor: 125_000,
      currency: 'COP',
    });
    expect(response.portfolio).toMatchObject({
      balanceMinor: 375_000,
      currency: 'COP',
      exponent: 2,
      availableMinor: 375_000,
    });
    expect(response.transaction).toMatchObject({
      amountMinor: -125_000,
      transactionType: 'BOOKING_HOLD',
      currency: 'COP',
    });
  });

  it('sin monto ni moneda, el servicio decide con la orden', async () => {
    const h = harness();

    await h.controller.hold(USER, { orderId: ORDER });

    expect(h.service.holdBooking).toHaveBeenCalledWith(TENANT, ORDER, USER, {});
  });
});

describe('WalletFinancingController', () => {
  function financing() {
    const service = {
      recordDeposit: vi.fn(() => Promise.resolve({})),
      recordAdjustment: vi.fn(() => Promise.resolve({})),
      overview: vi.fn(() => Promise.resolve({})),
    };
    const controller = new WalletFinancingController(service as unknown as WalletFinancingService);
    return { controller, service };
  }

  it('sin sesión es 401 antes de llegar al servicio', async () => {
    const f = financing();

    await expect(f.controller.overview(undefined, TENANT)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(f.service.overview).not.toHaveBeenCalled();
  });

  it.each(['recordDeposit', 'recordAdjustment'] as const)(
    '%s exige una Idempotency-Key UUID y la pasa en minúsculas',
    async (route) => {
      const f = financing();
      const body = { amountMinor: 1_000, reason: 'Transferencia 1' };

      await expect(f.controller[route](USER, TENANT, WALLET, body, undefined)).rejects.toThrow(
        BadRequestException,
      );
      expect(f.service[route]).not.toHaveBeenCalled();

      await f.controller[route](USER, TENANT, WALLET, body, KEY);
      expect(f.service[route]).toHaveBeenCalledWith(USER, TENANT, WALLET, body, KEY.toLowerCase());
    },
  );
});
