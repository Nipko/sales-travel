import { BadRequestException, ParseUUIDPipe, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
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
import { AdminOrdersController } from './admin-orders.controller.js';
import { AdminOrderNotFoundError } from './admin-orders.errors.js';
import { AdminOrdersQuerySchema } from './admin-orders.schemas.js';
import type { AdminOrdersService } from './admin-orders.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const ORDEN = '7f1d2c3b-4a5f-4e60-8b0e-4b7c9a3d4c1e';

function banco() {
  const service = {
    search: vi.fn(() => Promise.resolve({ orders: [], nextCursor: null })),
    detail: vi.fn(() => Promise.resolve({ order: { id: ORDEN } })),
  };
  const controller = new AdminOrdersController(service as unknown as AdminOrdersService);
  return { controller, service };
}

/** Los métodos de las rutas, como los ve Nest: la función que lleva la metadata. */
const ROUTES: Record<'list' | 'detail', object> = AdminOrdersController.prototype;

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

  it('ninguna ruta es una operación de venta', () => {
    for (const handler of [ROUTES.list, ROUTES.detail]) {
      expect(Reflect.getMetadata(SALES_OPERATION_KEY, handler)).toBeUndefined();
    }
    expect(Reflect.getMetadata(SALES_OPERATION_KEY, AdminOrdersController)).toBeUndefined();
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

describe('errores de Reservas de la red', () => {
  it('la reserva que no existe es un 404 con motivo y texto en tú', () => {
    const error = new AdminOrderNotFoundError();
    expect(error.getStatus()).toBe(404);
    expect(error.reason).toBe('ORDER_NOT_FOUND');
    expect(error.message).toBe('No encontramos esa reserva.');
  });
});
