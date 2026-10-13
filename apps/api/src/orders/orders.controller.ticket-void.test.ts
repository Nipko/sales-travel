import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { TicketCheckResult } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { BrandingService } from '../branding/branding.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { OrdersController } from './orders.controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';
import { TICKET_VOID_MESSAGES } from './ticket-void.plan.js';

/**
 * `GET /orders/:id/ticket-check` y `POST /orders/:id/void` (SAB-09): las compuertas antes de
 * consultar o anular. Lo que pasa después —la consulta en vivo, el claim, el desenlace— lo prueba
 * `orders.service.ticket-void.test.ts`; aquí sólo se decide si se llega.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const AIR = 'stub-air';

function fila(extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: AIR,
    provider_order_id: 'ABC123',
    status: 'ticketed',
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

const CONDICIONES: TicketCheckResult = {
  checkedAt: '2026-10-13T15:00:00.000Z',
  tickets: [
    {
      number: '0016802004060',
      voidable: 'yes',
      refundable: 'yes',
      refund: { totalMinor: 80_200, penaltyMinor: 22_200, currency: 'USD' },
    },
  ],
  cancelOffers: [],
};

function banco(
  o: { row?: OrderRow | undefined; capabilities?: Partial<ProviderCapabilities> } = {},
) {
  const row = 'row' in o ? o.row : fila();
  const checkTickets = vi.fn(() => Promise.resolve(CONDICIONES));
  const voidTickets = vi.fn(() =>
    Promise.resolve({
      outcome: 'VOIDED' as const,
      message: TICKET_VOID_MESSAGES.voided,
      orderStatus: 'cancelled',
    }),
  );
  const cancelOrder = vi.fn();
  const controller = new OrdersController(
    {
      findById: vi.fn(() => Promise.resolve(row)),
      checkTickets,
      voidTickets,
      cancelOrder,
    } as unknown as OrdersService,
    {} as unknown as DatabaseService,
    {} as unknown as MailerService,
    {} as unknown as BrandingService,
    { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    new FlightProviderRegistry(
      [
        new StubProviderFactory({
          code: AIR,
          capabilities: { ticketCheck: true, void: true, ...o.capabilities },
        }),
      ],
      { decisionFor: () => Promise.resolve(undefined) },
    ),
    {
      handles: () => false,
      capabilitiesOf: () => undefined,
    } as unknown as HotelOrderReadsService,
  );
  return { controller, checkTickets, voidTickets, cancelOrder };
}

describe('GET /orders/:id/ticket-check — compuertas', () => {
  it('una reserva emitida: la vista pública de la consulta, sin importes de reembolso', async () => {
    const b = banco();

    const res = await b.controller.ticketCheck(USER, ORDER);

    expect(res).toEqual({
      checkedAt: '2026-10-13T15:00:00.000Z',
      tickets: [{ number: '0016802004060', voidable: 'yes', refundable: 'yes' }],
      voidAvailable: true,
      voidStatus: 'available',
    });
    expect(b.checkTickets).toHaveBeenCalledWith(TENANT, fila());
  });

  it('sin usuario, 403', async () => {
    await expect(banco().controller.ticketCheck(undefined, ORDER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each([
    ['no existe', undefined],
    ['no tiene PNR', fila({ provider_order_id: null })],
  ])('si la orden %s, 404', async (_caso, row) => {
    const b = banco({ row });
    await expect(b.controller.ticketCheck(USER, ORDER)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.checkTickets).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'pending', 'cancelled'] as const)(
    'una reserva %s no tiene condiciones de tiquetes (409)',
    async (status) => {
      const b = banco({ row: fila({ status }) });
      await expect(b.controller.ticketCheck(USER, ORDER)).rejects.toThrow(
        new ConflictException(TICKET_VOID_MESSAGES.notTicketedCheck),
      );
      expect(b.checkTickets).not.toHaveBeenCalled();
    },
  );

  it('un proveedor sin la capacidad `ticketCheck` responde 400', async () => {
    for (const capabilities of [{ ticketCheck: false }, { ticketCheck: undefined }]) {
      const b = banco({ capabilities });
      await expect(b.controller.ticketCheck(USER, ORDER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(b.checkTickets).not.toHaveBeenCalled();
    }
  });

  it('no se cachea: la ventana de anulación cambia con el reloj', () => {
    const handler = Object.getOwnPropertyDescriptor(OrdersController.prototype, 'ticketCheck')
      ?.value as object;
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  });
});

describe('POST /orders/:id/void — compuertas', () => {
  it('una reserva emitida con la capacidad `void` se anula y responde el desenlace', async () => {
    const b = banco();

    await expect(b.controller.voidTickets(USER, ORDER)).resolves.toEqual({
      outcome: 'VOIDED',
      message: TICKET_VOID_MESSAGES.voided,
      orderStatus: 'cancelled',
    });
    expect(b.voidTickets).toHaveBeenCalledWith(TENANT, fila(), USER);
  });

  it('sin usuario, 403', async () => {
    await expect(banco().controller.voidTickets(undefined, ORDER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('sin PNR, 404', async () => {
    const b = banco({ row: fila({ provider_order_id: null }) });
    await expect(b.controller.voidTickets(USER, ORDER)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.voidTickets).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'pending', 'cancelled', 'failed'] as const)(
    'una reserva %s no se anula (409)',
    async (status) => {
      const b = banco({ row: fila({ status }) });
      await expect(b.controller.voidTickets(USER, ORDER)).rejects.toThrow(
        new ConflictException(TICKET_VOID_MESSAGES.notTicketed),
      );
      expect(b.voidTickets).not.toHaveBeenCalled();
    },
  );

  it('sin la capacidad `void` (apagada o no declarada), 400', async () => {
    for (const capabilities of [{ void: false }, { void: undefined }]) {
      const b = banco({ capabilities });
      await expect(b.controller.voidTickets(USER, ORDER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(b.voidTickets).not.toHaveBeenCalled();
    }
  });

  it('cancelar una emitida por la vía genérica se rechaza en tú y no llega al servicio', async () => {
    const b = banco();
    await expect(b.controller.cancel(USER, ORDER)).rejects.toThrow(
      new BadRequestException(TICKET_VOID_MESSAGES.ticketedCancel),
    );
    expect(b.cancelOrder).not.toHaveBeenCalled();
  });

  it('responde 200: corre en el request', () => {
    const handler = Object.getOwnPropertyDescriptor(OrdersController.prototype, 'voidTickets')
      ?.value as object;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.OK);
  });
});

describe('quién consulta y quién anula (SAB-FD-3 A)', () => {
  const guard = new RolesGuard(new Reflector());

  function pasa(method: 'ticketCheck' | 'voidTickets', role: Role, platformUser = false): unknown {
    const handler = Object.getOwnPropertyDescriptor(OrdersController.prototype, method)?.value as (
      ...args: unknown[]
    ) => unknown;
    const contexto = {
      getHandler: () => handler,
      getClass: () => OrdersController,
    } as unknown as ExecutionContext;
    try {
      return requestContextStorage.run({ userId: USER, tenantId: TENANT, role, platformUser }, () =>
        guard.canActivate(contexto),
      );
    } catch (err) {
      return err;
    }
  }

  it.each(['vendedor', 'agency_admin', 'tenant_admin', 'consolidator_admin', 'admin'] as const)(
    'anula y consulta quien vende: %s',
    (role) => {
      expect(pasa('voidTickets', role)).toBe(true);
      expect(pasa('ticketCheck', role)).toBe(true);
    },
  );

  it.each(['superadmin', 'platform_admin'] as const)(
    '%s también: deshacer lo vendido es post-venta, no venta',
    (role) => {
      expect(pasa('voidTickets', role)).toBe(true);
      expect(pasa('ticketCheck', role)).toBe(true);
    },
  );

  it('el cliente final no llega', () => {
    expect(pasa('voidTickets', 'cliente_final')).toBeInstanceOf(ForbiddenException);
    expect(pasa('ticketCheck', 'cliente_final')).toBeInstanceOf(ForbiddenException);
  });
});
