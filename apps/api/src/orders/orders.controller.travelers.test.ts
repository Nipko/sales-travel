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
import type { BrandingService } from '../branding/branding.service.js';
import type { Role } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { ModifyTravelersSchema } from './dto.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { ordersController } from './__fixtures__/orders-controller.js';
import { TRAVELERS_MESSAGES } from './order-travelers.plan.js';
import type { FlightTravelersService } from './order-travelers.service.js';
import { OrdersController } from './orders.controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * `GET` y `PATCH /orders/:id/travelers` (SAB-25): las compuertas del controlador antes de tocar al
 * proveedor y quién puede. El cambio en sí lo prueban `order-travelers.service.test.ts` y
 * `order-travelers.integration.test.ts`.
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
    selected_offer: { provider: { name: AIR, offerRef: 'R-1', source: 'ATPCO' } },
    passengers: [{ paxType: 'ADT', givenName: 'Ana', surname: 'Pérez' }],
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

const CAMBIO = new ZodValidationPipe(ModifyTravelersSchema).transform({
  travelers: [{ index: 0, specialServices: ['WCHR'] }],
});

function banco(
  o: {
    row?: OrderRow | undefined;
    capabilities?: Partial<ProviderCapabilities>;
    sinServicio?: boolean;
  } = {},
) {
  const row = 'row' in o ? o.row : fila();
  const view = vi.fn(() => Promise.resolve({ kind: 'travelers' }));
  const requestModify = vi.fn(() => Promise.resolve({ outcome: 'MODIFIED' }));
  const controller = ordersController({
    orders: { findById: vi.fn(() => Promise.resolve(row)) } as unknown as OrdersService,
    mailer: {} as unknown as MailerService,
    branding: {} as unknown as BrandingService,
    activeTenant: { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    registry: new FlightProviderRegistry(
      [new StubProviderFactory({ code: AIR, capabilities: { modify: true, ...o.capabilities } })],
      { decisionFor: () => Promise.resolve(undefined) },
    ),
    hotelReads: {
      handles: () => false,
      capabilitiesOf: () => undefined,
    } as unknown as HotelOrderReadsService,
    ...(o.sinServicio === true
      ? {}
      : { travelers: { view, requestModify } as unknown as FlightTravelersService }),
  });
  return { controller, view, requestModify };
}

describe('GET y PATCH /orders/:id/travelers — compuertas', () => {
  it('una reserva confirmada con la capacidad pasa al servicio, con el tenant y quien la pide', async () => {
    const b = banco();
    await expect(b.controller.travelersOf(USER, ORDER)).resolves.toEqual({ kind: 'travelers' });
    expect(b.view).toHaveBeenCalledWith(TENANT, fila());
    await expect(b.controller.modifyTravelers(USER, ORDER, CAMBIO)).resolves.toEqual({
      outcome: 'MODIFIED',
    });
    expect(b.requestModify).toHaveBeenCalledWith(TENANT, fila(), USER, CAMBIO);
  });

  it('una emitida también: los datos del pasajero no son la tarifa', async () => {
    const b = banco({ row: fila({ status: 'ticketed' }) });
    await expect(b.controller.modifyTravelers(USER, ORDER, CAMBIO)).resolves.toBeDefined();
  });

  it('sin usuario, 403; sin orden o sin localizador, 404', async () => {
    await expect(
      banco().controller.modifyTravelers(undefined, ORDER, CAMBIO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    for (const row of [undefined, fila({ provider_order_id: null })]) {
      const b = banco({ row });
      await expect(b.controller.travelersOf(USER, ORDER)).rejects.toThrow(
        new NotFoundException(TRAVELERS_MESSAGES.notFound),
      );
      await expect(b.controller.modifyTravelers(USER, ORDER, CAMBIO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(b.requestModify).not.toHaveBeenCalled();
    }
  });

  it.each(['pending', 'cancelled', 'failed'] as const)(
    'una reserva %s no cambia sus pasajeros (409)',
    async (status) => {
      const b = banco({ row: fila({ status }) });
      await expect(b.controller.modifyTravelers(USER, ORDER, CAMBIO)).rejects.toThrow(
        new ConflictException(TRAVELERS_MESSAGES.notModifiable),
      );
      expect(b.requestModify).not.toHaveBeenCalled();
    },
  );

  it('sin la capacidad `modify` (apagada o ausente), 400 sin llamar a nadie', async () => {
    for (const capabilities of [{ modify: false }, { modify: undefined }]) {
      const b = banco({ capabilities });
      await expect(b.controller.travelersOf(USER, ORDER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(b.controller.modifyTravelers(USER, ORDER, CAMBIO)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(b.view).not.toHaveBeenCalled();
      expect(b.requestModify).not.toHaveBeenCalled();
    }
  });

  it('sin el servicio cableado, 503 en vez de un 500', async () => {
    const b = banco({ sinServicio: true });
    await expect(b.controller.modifyTravelers(USER, ORDER, CAMBIO)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('la capacidad sale en la orden serializada para que Reservas ofrezca el botón', async () => {
    const res = await banco().controller.findOne(USER, ORDER);
    expect(res.order?.capabilities).toMatchObject({ modify: true });
  });
});

describe('quién puede: corregir datos no es vender', () => {
  const guard = new RolesGuard(new Reflector());

  function contexto(method: 'modifyTravelers' | 'travelersOf'): ExecutionContext {
    const handler = Object.getOwnPropertyDescriptor(OrdersController.prototype, method)?.value as (
      ...args: unknown[]
    ) => unknown;
    return {
      getHandler: () => handler,
      getClass: () => OrdersController,
    } as unknown as ExecutionContext;
  }

  function pasa(method: 'modifyTravelers' | 'travelersOf', role: Role): unknown {
    try {
      return requestContextStorage.run(
        { userId: USER, tenantId: TENANT, role, platformUser: false },
        () => guard.canActivate(contexto(method)),
      );
    } catch (err) {
      return err;
    }
  }

  it('el cambio responde 200 con el desenlace', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, contexto('modifyTravelers').getHandler())).toBe(
      HttpStatus.OK,
    );
  });

  it.each([
    'vendedor',
    'agency_admin',
    'tenant_admin',
    'consolidator_admin',
    'superadmin',
  ] as const)('lo pueden ver y corregir los roles de la post-venta: %s', (role) => {
    expect(pasa('travelersOf', role)).toBe(true);
    expect(pasa('modifyTravelers', role)).toBe(true);
  });

  it('un cliente final, no', () => {
    expect(pasa('modifyTravelers', 'cliente_final')).not.toBe(true);
  });
});
