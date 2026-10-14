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
import type { Role } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AddServicesSchema, RemoveServicesSchema } from './dto.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { ordersController } from './__fixtures__/orders-controller.js';
import { SERVICES_MESSAGES } from './order-services.plan.js';
import type { FlightServicesService } from './order-services.service.js';
import { OrdersController } from './orders.controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * `POST /orders/:id/services/add` y `/remove` (SAB-20): las compuertas del controlador antes de
 * tocar al proveedor. El cambio en sí (claim, retención, desenlace) lo prueban
 * `order-services.service.test.ts` y `order-services.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const LINE = '44444444-4444-4444-8444-444444444444';
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
    selected_offer: { provider: { name: AIR, offerRef: 'R-1', source: 'ATPCO' } },
    passengers: [{ paxType: 'ADT', givenName: 'Ana' }],
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

const ALTA = {
  selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0] }],
  expectedTotalMinor: 4500,
  currency: 'USD',
};
const BAJA = { lineIds: [LINE], expectedTotalMinor: 4500, currency: 'USD' };

function banco(
  o: {
    row?: OrderRow | undefined;
    capabilities?: Partial<ProviderCapabilities>;
    sinServicios?: boolean;
  } = {},
) {
  const row = 'row' in o ? o.row : fila();
  const requestAdd = vi.fn(() => Promise.resolve({ outcome: 'ADDED' }));
  const requestRemove = vi.fn(() => Promise.resolve({ outcome: 'REMOVED' }));
  const controller = ordersController({
    orders: { findById: vi.fn(() => Promise.resolve(row)) } as unknown as OrdersService,
    mailer: {} as unknown as MailerService,
    branding: {} as unknown as BrandingService,
    activeTenant: { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    registry: new FlightProviderRegistry(
      [
        new StubProviderFactory({
          code: AIR,
          capabilities: { addServices: true, ...o.capabilities },
        }),
      ],
      { decisionFor: () => Promise.resolve(undefined) },
    ),
    hotelReads: {
      handles: () => false,
      capabilitiesOf: () => undefined,
    } as unknown as HotelOrderReadsService,
    ...(o.sinServicios === true
      ? {}
      : { services: { requestAdd, requestRemove } as unknown as FlightServicesService }),
  });
  return { controller, requestAdd, requestRemove };
}

describe('POST /orders/:id/services/add y /remove — compuertas', () => {
  it('una reserva confirmada con la capacidad pasa al servicio, con el tenant y quien la pide', async () => {
    const b = banco();
    await expect(b.controller.addServices(USER, ORDER, ALTA)).resolves.toEqual({
      outcome: 'ADDED',
    });
    expect(b.requestAdd).toHaveBeenCalledWith(TENANT, fila(), USER, ALTA);
    await expect(b.controller.removeServices(USER, ORDER, BAJA)).resolves.toEqual({
      outcome: 'REMOVED',
    });
    expect(b.requestRemove).toHaveBeenCalledWith(TENANT, fila(), USER, BAJA);
  });

  it('sin usuario, 403', async () => {
    const b = banco();
    await expect(b.controller.addServices(undefined, ORDER, ALTA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(b.controller.removeServices(undefined, ORDER, BAJA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each([
    ['no existe', undefined],
    ['no tiene PNR', fila({ provider_order_id: null })],
  ])('si la orden %s, 404', async (_caso, row) => {
    const b = banco({ row });
    await expect(b.controller.addServices(USER, ORDER, ALTA)).rejects.toThrow(
      new NotFoundException(SERVICES_MESSAGES.notFound),
    );
    await expect(b.controller.removeServices(USER, ORDER, BAJA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(b.requestAdd).not.toHaveBeenCalled();
  });

  it.each(['ticketed', 'pending', 'cancelled', 'failed'] as const)(
    'una reserva %s no cambia sus servicios (409): sólo antes de emitir',
    async (status) => {
      const b = banco({ row: fila({ status }) });
      await expect(b.controller.addServices(USER, ORDER, ALTA)).rejects.toThrow(
        new ConflictException(SERVICES_MESSAGES.notConfirmed),
      );
      await expect(b.controller.removeServices(USER, ORDER, BAJA)).rejects.toThrow(
        new ConflictException(SERVICES_MESSAGES.notConfirmed),
      );
      expect(b.requestAdd).not.toHaveBeenCalled();
      expect(b.requestRemove).not.toHaveBeenCalled();
    },
  );

  it('sin la capacidad `addServices` (apagada o ausente), 400 sin llamar a nadie', async () => {
    for (const capabilities of [{ addServices: false }, { addServices: undefined }]) {
      const b = banco({ capabilities });
      await expect(b.controller.addServices(USER, ORDER, ALTA)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(b.controller.removeServices(USER, ORDER, BAJA)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(b.requestAdd).not.toHaveBeenCalled();
      expect(b.requestRemove).not.toHaveBeenCalled();
    }
  });

  it('sin el servicio cableado, 503 en vez de un 500', async () => {
    const b = banco({ sinServicios: true });
    await expect(b.controller.addServices(USER, ORDER, ALTA)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('la capacidad sale en la orden serializada para que Reservas ofrezca el botón', async () => {
    const res = await banco().controller.findOne(USER, ORDER);
    expect(res.order?.capabilities).toMatchObject({ addServices: true });
  });
});

describe('los cuerpos (Zod estricto)', () => {
  const alta = new ZodValidationPipe(AddServicesSchema);
  const baja = new ZodValidationPipe(RemoveServicesSchema);

  it('aceptan qué, para quién y lo que el vendedor vio', () => {
    expect(alta.transform(ALTA)).toEqual(ALTA);
    expect(baja.transform(BAJA)).toEqual(BAJA);
  });

  it.each([
    ['una tarjeta colada', { ...ALTA, payment: { cardNumber: '4111111111111111' } }],
    ['un precio por línea', { ...ALTA, selections: [{ ...ALTA.selections[0], price: 1 }] }],
    ['sin selecciones', { ...ALTA, selections: [] }],
    ['un servicio repetido', { ...ALTA, selections: [ALTA.selections[0], ALTA.selections[0]] }],
    [
      'un pasajero repetido',
      { ...ALTA, selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0, 0] }] },
    ],
    [
      'un pasajero fuera de rango',
      { ...ALTA, selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [9] }] },
    ],
    ['un total con decimales', { ...ALTA, expectedTotalMinor: 45.5 }],
    ['una moneda en minúsculas', { ...ALTA, currency: 'usd' }],
  ])('el alta rechaza %s', (_caso, cuerpo) => {
    expect(() => alta.transform(cuerpo)).toThrow();
  });

  it.each([
    ['ids del proveedor en vez de líneas', { ...BAJA, lineIds: ['XBAG1'] }],
    ['una línea repetida', { ...BAJA, lineIds: [LINE, LINE] }],
    ['ids del proveedor colados', { ...BAJA, providerItemIds: ['1'] }],
  ])('la baja rechaza %s', (_caso, cuerpo) => {
    expect(() => baja.transform(cuerpo)).toThrow();
  });
});

describe('quién puede: agregar es venta, quitar es deshacer lo vendido', () => {
  const guard = new RolesGuard(new Reflector());

  function contexto(method: 'addServices' | 'removeServices'): ExecutionContext {
    const handler = Object.getOwnPropertyDescriptor(OrdersController.prototype, method)?.value as (
      ...args: unknown[]
    ) => unknown;
    return {
      getHandler: () => handler,
      getClass: () => OrdersController,
    } as unknown as ExecutionContext;
  }

  function pasa(method: 'addServices' | 'removeServices', role: Role): unknown {
    try {
      return requestContextStorage.run(
        { userId: USER, tenantId: TENANT, role, platformUser: false },
        () => guard.canActivate(contexto(method)),
      );
    } catch (err) {
      return err;
    }
  }

  it('responden 200 con el desenlace', () => {
    for (const method of ['addServices', 'removeServices'] as const) {
      const handler = contexto(method).getHandler();
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.OK);
    }
  });

  it.each(['vendedor', 'agency_admin', 'tenant_admin', 'consolidator_admin'] as const)(
    'quien vende agrega y quita: %s',
    (role) => {
      expect(pasa('addServices', role)).toBe(true);
      expect(pasa('removeServices', role)).toBe(true);
    },
  );

  it('el superadmin no agrega (403 de venta)', () => {
    expect(pasa('addServices', 'superadmin')).toBeInstanceOf(PlatformRoleCannotSellError);
  });
});
