import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PlatformRoleCannotSellError } from '../auth/sales-operation-errors.js';
import type { BrandingService } from '../branding/branding.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { IssueOrderSchema } from './dto.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { OrdersController } from './orders.controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';
import type { FlightTicketIssueService } from './ticket-issue.service.js';

/**
 * `POST /orders/:id/issue` (SAB-08): las compuertas antes de pedir la emisión y el 202. La emisión
 * en sí corre en la cola (`ticket-issue.service.test.ts`); aquí sólo se decide si se pide.
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

const CUERPO = { expectedTotalMinor: 34012, currency: 'USD' };

function banco(
  o: {
    row?: OrderRow | undefined;
    capabilities?: Partial<ProviderCapabilities>;
    sinEmision?: boolean;
  } = {},
) {
  const row = 'row' in o ? o.row : fila();
  const requestIssue = vi.fn(() =>
    Promise.resolve({ operationId: 'op-1', status: 'pending' as const }),
  );
  const controller = new OrdersController(
    { findById: vi.fn(() => Promise.resolve(row)) } as unknown as OrdersService,
    {} as unknown as DatabaseService,
    {} as unknown as MailerService,
    {} as unknown as BrandingService,
    { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    new FlightProviderRegistry(
      [new StubProviderFactory({ code: AIR, capabilities: { issue: true, ...o.capabilities } })],
      { decisionFor: () => Promise.resolve(undefined) },
    ),
    {
      handles: () => false,
      capabilitiesOf: () => undefined,
    } as unknown as HotelOrderReadsService,
    undefined,
    o.sinEmision === true ? undefined : ({ requestIssue } as unknown as FlightTicketIssueService),
  );
  return { controller, requestIssue };
}

describe('POST /orders/:id/issue — compuertas', () => {
  it('una reserva confirmada con el total que vio el vendedor se pide y responde la operación', async () => {
    const b = banco();

    await expect(b.controller.issue(USER, ORDER, CUERPO)).resolves.toEqual({
      operationId: 'op-1',
      status: 'pending',
    });
    expect(b.requestIssue).toHaveBeenCalledWith(TENANT, fila(), USER);
  });

  it('sin usuario, 403', async () => {
    await expect(banco().controller.issue(undefined, ORDER, CUERPO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each([
    ['no existe', undefined],
    ['no tiene PNR', fila({ provider_order_id: null })],
  ])('si la orden %s, 404', async (_caso, row) => {
    const b = banco({ row });
    await expect(b.controller.issue(USER, ORDER, CUERPO)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.requestIssue).not.toHaveBeenCalled();
  });

  it.each(['pending', 'ticketed', 'cancelled', 'failed'] as const)(
    'una reserva %s no se emite (409)',
    async (status) => {
      const b = banco({ row: fila({ status }) });
      await expect(b.controller.issue(USER, ORDER, CUERPO)).rejects.toThrow(
        new ConflictException('Sólo se puede emitir una reserva confirmada.'),
      );
      expect(b.requestIssue).not.toHaveBeenCalled();
    },
  );

  it('un proveedor sin la capacidad `issue` (o con ella apagada) responde 400', async () => {
    for (const capabilities of [{ issue: false }, { issue: undefined }]) {
      const b = banco({ capabilities });
      await expect(b.controller.issue(USER, ORDER, CUERPO)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(b.requestIssue).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['otro total', { expectedTotalMinor: 34000, currency: 'USD' }],
    ['otra moneda', { expectedTotalMinor: 34012, currency: 'COP' }],
  ])('con %s que el de la orden, 409 y a volver a consultarla', async (_caso, cuerpo) => {
    const b = banco();
    await expect(b.controller.issue(USER, ORDER, cuerpo)).rejects.toThrow(
      new ConflictException(
        'El total cambió desde que abriste la reserva. Vuelve a consultarla antes de emitir.',
      ),
    );
    expect(b.requestIssue).not.toHaveBeenCalled();
  });

  it('sin el servicio de emisión cableado, 503 en vez de un 500', async () => {
    await expect(
      banco({ sinEmision: true }).controller.issue(USER, ORDER, CUERPO),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('la capacidad `issue` sale en la orden serializada para que la pantalla ofrezca el botón', async () => {
    const b = banco();
    const res = await b.controller.findOne(USER, ORDER);
    expect(res.order?.capabilities).toMatchObject({ issue: true });
  });
});

describe('POST /orders/:id/issue — el cuerpo (Zod estricto)', () => {
  const pipe = new ZodValidationPipe(IssueOrderSchema);

  it('acepta el total en unidades menores y la moneda ISO', () => {
    expect(pipe.transform(CUERPO)).toEqual(CUERPO);
  });

  it.each([
    ['una tarjeta colada', { ...CUERPO, payment: { cardNumber: '4111111111111111' } }],
    ['un total con decimales', { ...CUERPO, expectedTotalMinor: 340.12 }],
    ['un total negativo', { ...CUERPO, expectedTotalMinor: -1 }],
    ['una moneda en minúsculas', { ...CUERPO, currency: 'usd' }],
    ['sin moneda', { expectedTotalMinor: 34012 }],
  ])('rechaza %s', (_caso, cuerpo) => {
    expect(() => pipe.transform(cuerpo)).toThrow();
  });
});

describe('POST /orders/:id/issue — es venta: el superadmin no emite', () => {
  // El método se lee de su descriptor: es la referencia que registra Nest y que mira el guard.
  const handler = Object.getOwnPropertyDescriptor(OrdersController.prototype, 'issue')?.value as (
    ...args: unknown[]
  ) => unknown;
  const contexto = {
    getHandler: () => handler,
    getClass: () => OrdersController,
  } as unknown as ExecutionContext;
  const guard = new RolesGuard(new Reflector());

  function pasa(role: Role, platformUser = false): unknown {
    try {
      return requestContextStorage.run({ userId: USER, tenantId: TENANT, role, platformUser }, () =>
        guard.canActivate(contexto),
      );
    } catch (err) {
      return err;
    }
  }

  it('responde 202', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.ACCEPTED);
  });

  it.each(['vendedor', 'agency_admin', 'tenant_admin', 'consolidator_admin'] as const)(
    'emite quien vende: %s (SAB-FD-3 A)',
    (role) => {
      expect(pasa(role)).toBe(true);
    },
  );

  it.each(['superadmin', 'platform_admin'] as const)('%s recibe 403 de venta', (role) => {
    expect(pasa(role)).toBeInstanceOf(PlatformRoleCannotSellError);
  });

  it('tampoco el superadmin que entra como vendedor de una sucursal', () => {
    expect(pasa('vendedor', true)).toBeInstanceOf(PlatformRoleCannotSellError);
  });
});
