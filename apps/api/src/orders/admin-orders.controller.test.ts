import { BadRequestException, ParseUUIDPipe, type ExecutionContext } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { SALES_OPERATION_KEY } from '../auth/decorators/sales-operation.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { AgentCarsExceptionFilter } from '../cars/agent-cars-exception.filter.js';
import { LatamNdcExceptionFilter } from '../providers-latam/latam-ndc-exception.filter.js';
import { SabreExceptionFilter } from '../providers-sabre/sabre-exception.filter.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import type { AdminOrderActionsService } from './admin-order-actions.service.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import {
  AdminOrderNotFoundError,
  AdminOrderNumberMismatchError,
  AdminOrderWithoutLocatorError,
} from './admin-orders.errors.js';
import {
  AdminOrderActionSchema,
  AdminOrderCancelSchema,
  AdminOrdersQuerySchema,
} from './admin-orders.schemas.js';
import type { AdminOrdersService } from './admin-orders.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const ORDEN = '7f1d2c3b-4a5f-4e60-8b0e-4b7c9a3d4c1e';
const OPERACION = '1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';
const MOTIVO = { reason: 'La agencia no puede entrar' };

function banco() {
  const service = {
    search: vi.fn(() => Promise.resolve({ orders: [], nextCursor: null })),
    detail: vi.fn(() => Promise.resolve({ order: { id: ORDEN } })),
  };
  const actions = {
    sendConfirmation: vi.fn(() => Promise.resolve({ sent: true, to: 'ana@x.test' })),
    retrieve: vi.fn(() => Promise.resolve({ reading: { found: true }, detail: null })),
    retryCancellation: vi.fn(() => Promise.resolve({ success: true, warnings: [] })),
    cancellationEstimate: vi.fn(() =>
      Promise.resolve({ orderId: ORDEN, estimate: { kind: 'unavailable', reason: 'no-snapshot' } }),
    ),
    cancel: vi.fn(() => Promise.resolve({ success: true, warnings: [] })),
  };
  const controller = new AdminOrdersController(
    service as unknown as AdminOrdersService,
    actions as unknown as AdminOrderActionsService,
  );
  return { controller, service, actions };
}

type RouteName =
  | 'list'
  | 'detail'
  | 'sendConfirmation'
  | 'retrieve'
  | 'retry'
  | 'cancellationEstimate'
  | 'cancel';

/** Los métodos de las rutas, como los ve Nest: la función que lleva la metadata. */
const ROUTES: Record<RouteName, object> = AdminOrdersController.prototype;
const ALL_ROUTES: readonly RouteName[] = [
  'list',
  'detail',
  'sendConfirmation',
  'retrieve',
  'retry',
  'cancellationEstimate',
  'cancel',
];

function contextFor(handler: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => AdminOrdersController,
  } as unknown as ExecutionContext;
}

describe('AdminOrdersController: sólo el superadmin', () => {
  it('la clase entera pasa por SuperadminGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminOrdersController)).toEqual([SuperadminGuard]);
  });

  it('declara los roles de plataforma', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController)).toEqual([...PLATFORM_ROLES]);
  });

  it('un tenant_admin (o cualquier rol de nodo) recibe 403 de RolesGuard', () => {
    const guard = new RolesGuard(new Reflector());
    const allowed = (role: Role | undefined) =>
      requestContextStorage.run({ userId: USUARIO, role }, () => {
        try {
          return guard.canActivate(contextFor(ROUTES.list));
        } catch {
          return false;
        }
      });

    expect(allowed('superadmin')).toBe(true);
    for (const role of [
      'tenant_admin',
      'consolidator_admin',
      'agency_admin',
      'admin',
      'vendedor',
    ] as const) {
      expect(allowed(role), role).toBe(false);
    }
    expect(allowed(undefined)).toBe(false);
  });

  it('las acciones de post-venta también: un tenant_admin recibe 403 en cada una', () => {
    const guard = new RolesGuard(new Reflector());
    for (const name of ALL_ROUTES) {
      const rejected = requestContextStorage.run({ userId: USUARIO, role: 'tenant_admin' }, () => {
        try {
          guard.canActivate(contextFor(ROUTES[name]));
          return undefined;
        } catch (err) {
          return err;
        }
      });
      expect(rejected, name).toMatchObject({ status: 403 });
      expect(
        requestContextStorage.run({ userId: USUARIO, role: 'superadmin' }, () =>
          guard.canActivate(contextFor(ROUTES[name])),
        ),
        name,
      ).toBe(true);
    }
  });

  it('platform_admin pasa RolesGuard pero SuperadminGuard lo frena: 403', async () => {
    const roles = new RolesGuard(new Reflector());
    const network = { isSuperadmin: vi.fn(() => Promise.resolve(false)) };
    const superadmin = new SuperadminGuard(network as unknown as NetworkService);
    const ctx = contextFor(ROUTES.detail);
    await requestContextStorage.run({ userId: USUARIO, role: 'platform_admin' }, async () => {
      expect(roles.canActivate(ctx)).toBe(true);
      await expect(superadmin.canActivate(ctx)).rejects.toBeInstanceOf(SuperadminRequiredError);
    });
  });

  it('ninguna ruta es una operación de venta, tampoco las acciones', () => {
    for (const name of ALL_ROUTES) {
      expect(Reflect.getMetadata(SALES_OPERATION_KEY, ROUTES[name]), name).toBeUndefined();
    }
    expect(Reflect.getMetadata(SALES_OPERATION_KEY, AdminOrdersController)).toBeUndefined();
  });

  it('los errores de cada proveedor se traducen como en Reservas de la agencia', () => {
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, AdminOrdersController)).toEqual([
      LatamNdcExceptionFilter,
      SabreExceptionFilter,
      AgentCarsExceptionFilter,
      TboHotelsExceptionFilter,
    ]);
  });

  it('las acciones responden 200, no el 201 de un POST que crea algo', () => {
    for (const name of ['sendConfirmation', 'retrieve', 'retry', 'cancel'] as const) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, ROUTES[name]), name).toBe(200);
    }
  });
});

describe('AdminOrdersController: rutas', () => {
  it('la lista pasa el actor y la query ya validada', async () => {
    const { controller, service } = banco();
    const query = AdminOrdersQuerySchema.parse({ status: 'pending', attention: 'true' });
    await expect(controller.list(USUARIO, query)).resolves.toEqual({
      orders: [],
      nextCursor: null,
    });
    expect(service.search).toHaveBeenCalledWith(USUARIO, query);
  });

  it('la ficha pasa el actor y el id', async () => {
    const { controller, service } = banco();
    await expect(controller.detail(USUARIO, ORDEN)).resolves.toEqual({ order: { id: ORDEN } });
    expect(service.detail).toHaveBeenCalledWith(USUARIO, ORDEN);
  });

  it('el id de la ficha pasa por ParseUUIDPipe: lo que no es un UUID es un 400', async () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AdminOrdersController,
      'detail',
    ) as Record<string, { data?: string; pipes?: unknown[] }>;
    const param = Object.values(args).find((a) => a.data === 'id');
    const pipe = param?.pipes?.[0];
    expect(pipe).toBeInstanceOf(ParseUUIDPipe);
    await expect(
      (pipe as ParseUUIDPipe).transform('no-es-un-uuid', { type: 'param', data: 'id' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/** Los pipes de un parámetro de la ruta, como los registró Nest (`undefined`: el cuerpo). */
function pipesOf(method: RouteName, data: string | undefined): unknown[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminOrdersController, method) as Record<
    string,
    { data?: string; pipes?: unknown[] }
  >;
  return (
    Object.values(args).find((a) => a.data === data && (a.pipes?.length ?? 0) > 0)?.pipes ?? []
  );
}

describe('AdminOrdersController: acciones de post-venta', () => {
  it('cada acción pasa el actor, la reserva y el cuerpo validado', async () => {
    const { controller, actions } = banco();

    await expect(controller.sendConfirmation(USUARIO, ORDEN, MOTIVO)).resolves.toEqual({
      sent: true,
      to: 'ana@x.test',
    });
    expect(actions.sendConfirmation).toHaveBeenCalledWith(USUARIO, ORDEN, MOTIVO);

    await controller.retrieve(USUARIO, ORDEN, MOTIVO);
    expect(actions.retrieve).toHaveBeenCalledWith(USUARIO, ORDEN, MOTIVO);

    await controller.retry(USUARIO, ORDEN, OPERACION, MOTIVO);
    expect(actions.retryCancellation).toHaveBeenCalledWith(USUARIO, ORDEN, OPERACION, MOTIVO);

    await expect(controller.cancellationEstimate(USUARIO, ORDEN)).resolves.toMatchObject({
      orderId: ORDEN,
    });
    expect(actions.cancellationEstimate).toHaveBeenCalledWith(USUARIO, ORDEN);

    const cancel = { ...MOTIVO, orderNumber: 1042 };
    await controller.cancel(USUARIO, ORDEN, cancel);
    expect(actions.cancel).toHaveBeenCalledWith(USUARIO, ORDEN, cancel);
  });

  it('el cuerpo pasa por su esquema: el motivo en todas, el número de orden en cancelar', () => {
    for (const name of ['sendConfirmation', 'retrieve', 'retry'] as const) {
      const [pipe] = pipesOf(name, undefined);
      expect(pipe, name).toBeInstanceOf(ZodValidationPipe);
      expect((pipe as { schema: unknown }).schema, name).toBe(AdminOrderActionSchema);
    }
    const [cancelPipe] = pipesOf('cancel', undefined);
    expect((cancelPipe as { schema: unknown }).schema).toBe(AdminOrderCancelSchema);
  });

  it('los ids de la reserva y de la operación son UUID: lo demás es un 400', () => {
    for (const name of ALL_ROUTES.filter((n) => n !== 'list')) {
      expect(pipesOf(name, 'id')[0], name).toBeInstanceOf(ParseUUIDPipe);
    }
    expect(pipesOf('retry', 'opId')[0]).toBeInstanceOf(ParseUUIDPipe);
  });
});

describe('errores de Reservas de la red', () => {
  it('la reserva que no existe es un 404 con motivo y texto en tú', () => {
    const error = new AdminOrderNotFoundError();
    expect(error.getStatus()).toBe(404);
    expect(error.reason).toBe('ORDER_NOT_FOUND');
    expect(error.message).toBe('No encontramos esa reserva.');
  });

  it('sin localizador, 409; el número de orden que no coincide, 400', () => {
    const sinLocalizador = new AdminOrderWithoutLocatorError();
    expect(sinLocalizador.getStatus()).toBe(409);
    expect(sinLocalizador.reason).toBe('ORDER_WITHOUT_LOCATOR');
    const otroNumero = new AdminOrderNumberMismatchError();
    expect(otroNumero.getStatus()).toBe(400);
    expect(otroNumero.reason).toBe('ORDER_NUMBER_MISMATCH');
    expect(otroNumero.message).toBe(
      'El número de orden no coincide: escríbelo tal como aparece en la reserva.',
    );
  });
});
