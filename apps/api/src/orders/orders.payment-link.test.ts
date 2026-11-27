import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PaymentLinkResult } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import type { BrandingService } from '../branding/branding.service.js';
import {
  PaymentMethodNotEnabledError,
  type GovernancePaymentsService,
} from '../governance/governance-payments.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { PaymentLinkSchema } from './dto.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { ordersController } from './__fixtures__/orders-controller.js';
import { OrdersService, type OrderRow } from './orders.service.js';

/**
 * POS-14: `POST /orders/:id/payment-link`. El proveedor (LATAM) le manda al pagador un enlace para
 * pagar en su sitio (PCI SAQ-A). Primero las compuertas del controlador; después lo que el servicio
 * deja escrito: la operación siempre, el evento sólo si salió, y nunca el correo del pagador.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const AIR = 'stub-air';
const EMAIL = 'pagador@example.test';

function fila(extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: AIR,
    provider_order_id: 'ABC123',
    status: 'confirmed',
    search_criteria: {},
    selected_offer: { provider: { name: AIR, offerRef: 'R-1' } },
    passengers: [{ givenName: 'Ana' }],
    contact_info: {},
    total_amount: 34012,
    currency: 'USD',
    order_number: 7,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-10-13T00:00:00Z'),
    updated_at: new Date('2026-10-13T00:00:00Z'),
    ...extra,
  };
}

function banco(
  o: {
    row?: OrderRow | undefined;
    capabilities?: Partial<ProviderCapabilities>;
    habilitada?: boolean;
    sinGobierno?: boolean;
  } = {},
) {
  const row = 'row' in o ? o.row : fila();
  const sendPaymentLink = vi.fn(() => Promise.resolve({ success: true, warnings: [] }));
  const assertEnabled = vi.fn((_t: string, provider: string, method: string) =>
    o.habilitada === false
      ? Promise.reject(new PaymentMethodNotEnabledError(provider, method))
      : Promise.resolve(),
  );
  const controller = ordersController({
    orders: {
      findById: vi.fn(() => Promise.resolve(row)),
      sendPaymentLink,
    } as unknown as OrdersService,
    mailer: {} as unknown as MailerService,
    branding: {} as unknown as BrandingService,
    activeTenant: { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    registry: new FlightProviderRegistry(
      [new StubProviderFactory({ code: AIR, capabilities: { pay: true, ...o.capabilities } })],
      { decisionFor: () => Promise.resolve(undefined) },
    ),
    hotelReads: {
      handles: () => false,
      capabilitiesOf: () => undefined,
    } as unknown as HotelOrderReadsService,
    ...(o.sinGobierno === true
      ? {}
      : { governance: { assertEnabled } as unknown as GovernancePaymentsService }),
  });
  return { controller, sendPaymentLink, assertEnabled };
}

describe('POST /orders/:id/payment-link — compuertas', () => {
  it('una reserva confirmada, con la forma habilitada, pide el enlace con el correo del pagador', async () => {
    const b = banco();
    await expect(b.controller.sendPaymentLink(USER, ORDER, { email: EMAIL })).resolves.toEqual({
      success: true,
      warnings: [],
    });
    expect(b.assertEnabled).toHaveBeenCalledWith(TENANT, AIR, 'payment_link');
    expect(b.sendPaymentLink).toHaveBeenCalledWith(TENANT, fila(), EMAIL, USER);
  });

  it('sin usuario, 403', async () => {
    await expect(
      banco().controller.sendPaymentLink(undefined, ORDER, { email: EMAIL }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['no existe (u otra agencia)', undefined],
    ['no tiene PNR', fila({ provider_order_id: null })],
  ])('si la orden %s, 404', async (_caso, row) => {
    const b = banco({ row });
    await expect(
      b.controller.sendPaymentLink(USER, ORDER, { email: EMAIL }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(b.sendPaymentLink).not.toHaveBeenCalled();
  });

  it.each(['pending', 'ticketed', 'cancelled', 'failed'] as const)(
    'una reserva %s no recibe enlace (409)',
    async (status) => {
      const b = banco({ row: fila({ status }) });
      await expect(
        b.controller.sendPaymentLink(USER, ORDER, { email: EMAIL }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(b.sendPaymentLink).not.toHaveBeenCalled();
    },
  );

  it('un proveedor que no cobra órdenes sin pagar: 400', async () => {
    const b = banco({ capabilities: { pay: false } });
    await expect(
      b.controller.sendPaymentLink(USER, ORDER, { email: EMAIL }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.sendPaymentLink).not.toHaveBeenCalled();
  });

  it('la forma de pago apagada por el gobierno (0089): 403 con el motivo', async () => {
    const b = banco({ habilitada: false });
    await expect(
      b.controller.sendPaymentLink(USER, ORDER, { email: EMAIL }),
    ).rejects.toBeInstanceOf(PaymentMethodNotEnabledError);
    expect(b.sendPaymentLink).not.toHaveBeenCalled();
  });

  it('sin el gobierno cableado no se envía: 403, nunca abierto por omisión', async () => {
    const b = banco({ sinGobierno: true });
    await expect(
      b.controller.sendPaymentLink(USER, ORDER, { email: EMAIL }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(b.sendPaymentLink).not.toHaveBeenCalled();
  });
});

describe('PaymentLinkSchema', () => {
  it('un correo, recortado; nada más', () => {
    expect(PaymentLinkSchema.parse({ email: `  ${EMAIL} ` })).toEqual({ email: EMAIL });
    expect(PaymentLinkSchema.safeParse({ email: 'no-es-correo' }).success).toBe(false);
    expect(PaymentLinkSchema.safeParse({ email: `${'a'.repeat(250)}@x.co` }).success).toBe(false);
    expect(PaymentLinkSchema.safeParse({ email: EMAIL, amount: 1 }).success).toBe(false);
    expect(PaymentLinkSchema.safeParse({}).success).toBe(false);
  });
});

describe('OrdersService.sendPaymentLink — lo que queda escrito', () => {
  function servicio(adapter: { sendPaymentLink?: () => Promise<PaymentLinkResult> }) {
    const logOperation = vi.fn(() => Promise.resolve());
    const emit = vi.fn(() => Promise.resolve());
    const self = {
      flightProviderForOrder: vi.fn(() => Promise.resolve({ adapter })),
      logOperation,
      audit: { emit },
    };
    const call = () =>
      OrdersService.prototype.sendPaymentLink.call(
        self as unknown as OrdersService,
        TENANT,
        fila(),
        EMAIL,
        USER,
      );
    return { call, logOperation, emit };
  }

  it('enviado: operación `success` y evento sin el correo del pagador', async () => {
    const send = vi.fn(() => Promise.resolve({ success: true, warnings: [] }));
    const s = servicio({ sendPaymentLink: send });
    await expect(s.call()).resolves.toEqual({ success: true, warnings: [] });
    expect(send).toHaveBeenCalledWith({ orderId: 'ABC123', email: EMAIL }, { tenantId: TENANT });
    expect(s.logOperation).toHaveBeenCalledWith(
      TENANT,
      ORDER,
      'payment-link',
      'success',
      null,
      USER,
    );
    expect(s.emit).toHaveBeenCalledOnce();
    expect(s.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'OrderPaymentLinkSent',
        aggregateId: ORDER,
        payload: { provider: AIR },
      }),
    );
    expect(JSON.stringify(s.emit.mock.calls)).not.toContain(EMAIL);
  });

  it('el proveedor dice que no: operación `failed` con su motivo y sin evento', async () => {
    const s = servicio({
      sendPaymentLink: () =>
        Promise.resolve({ success: false, warnings: [], error: 'LATAM error 911: x' }),
    });
    await expect(s.call()).resolves.toMatchObject({ success: false });
    expect(s.logOperation).toHaveBeenCalledWith(
      TENANT,
      ORDER,
      'payment-link',
      'failed',
      'LATAM error 911: x',
      USER,
    );
    expect(s.emit).not.toHaveBeenCalled();
  });

  it('el proveedor se cae: queda `failed` y el error sale tal cual', async () => {
    const s = servicio({ sendPaymentLink: () => Promise.reject(new Error('timeout')) });
    await expect(s.call()).rejects.toThrow('timeout');
    expect(s.logOperation).toHaveBeenCalledWith(
      TENANT,
      ORDER,
      'payment-link',
      'failed',
      'timeout',
      USER,
    );
    expect(s.emit).not.toHaveBeenCalled();
  });

  it('un proveedor sin enlace de pago: 400 sin llamar a nadie', async () => {
    const s = servicio({});
    await expect(s.call()).rejects.toBeInstanceOf(BadRequestException);
    expect(s.logOperation).not.toHaveBeenCalled();
  });
});
