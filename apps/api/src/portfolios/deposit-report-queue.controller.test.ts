import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import {
  DepositReportQueueController,
  DepositReportQueueSuperadminOnlyError,
} from './deposit-report-queue.controller.js';
import { DepositReportQueueQuerySchema } from './deposit-report-queue.schemas.js';
import type { DepositReportQueueService } from './deposit-report-queue.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

function banco({ esSuperadmin = true } = {}) {
  const queue = {
    list: vi.fn(() =>
      Promise.resolve({ status: 'pending', reports: [], nextCursor: null, totals: [] }),
    ),
    pendingCount: vi.fn(() => Promise.resolve({ total: 3, platform: 2, network: 1 })),
  };
  const network = { isSuperadmin: vi.fn(() => Promise.resolve(esSuperadmin)) };
  const controller = new DepositReportQueueController(
    queue as unknown as DepositReportQueueService,
    network as unknown as NetworkService,
  );
  return { controller, queue, network };
}

const QUERY = DepositReportQueueQuerySchema.parse({});

describe('DepositReportQueueController: sólo el superadmin', () => {
  it('sin usuario, 401 y el servicio no se entera', async () => {
    const { controller, queue } = banco();
    await expect(controller.list(undefined, QUERY)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.pendingCount(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(queue.list).not.toHaveBeenCalled();
    expect(queue.pendingCount).not.toHaveBeenCalled();
  });

  it.each([
    ['la cola', (c: DepositReportQueueController) => c.list(USUARIO, QUERY)],
    ['el contador', (c: DepositReportQueueController) => c.pendingCount(USUARIO)],
  ])('%s: quien no es superadmin recibe 403 con motivo', async (_q, llamar) => {
    const { controller, queue, network } = banco({ esSuperadmin: false });
    const error = await llamar(controller).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DepositReportQueueSuperadminOnlyError);
    expect((error as DepositReportQueueSuperadminOnlyError).getStatus()).toBe(403);
    expect((error as DepositReportQueueSuperadminOnlyError).reason).toBe(
      'DEPOSIT_REPORT_QUEUE_SUPERADMIN_ONLY',
    );
    expect(network.isSuperadmin).toHaveBeenCalledWith(USUARIO);
    expect(queue.list).not.toHaveBeenCalled();
    expect(queue.pendingCount).not.toHaveBeenCalled();
  });

  it('el superadmin pasa, con su id como actor y la query ya validada', async () => {
    const { controller, queue } = banco();
    await expect(controller.list(USUARIO, QUERY)).resolves.toMatchObject({ reports: [] });
    expect(queue.list).toHaveBeenCalledWith(USUARIO, QUERY);
    await expect(controller.pendingCount(USUARIO)).resolves.toEqual({
      total: 3,
      platform: 2,
      network: 1,
    });
    expect(queue.pendingCount).toHaveBeenCalledWith(USUARIO);
  });
});

describe('DepositReportQueueController: RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  // `@Roles` está en la clase: los handlers no declaran nada propio.
  function contextFor(): ExecutionContext {
    return {
      getHandler: () => () => undefined,
      getClass: () => DepositReportQueueController,
    } as unknown as ExecutionContext;
  }

  function allowed(role: Role | undefined): boolean {
    return requestContextStorage.run({ userId: USUARIO, role }, () => {
      try {
        return guard.canActivate(contextFor());
      } catch {
        return false;
      }
    });
  }

  it('declara los roles de plataforma', () => {
    expect(Reflect.getMetadata(ROLES_KEY, DepositReportQueueController)).toEqual([
      ...PLATFORM_ROLES,
    ]);
  });

  it('un rol de nodo no llega al controller; el superadmin sí', () => {
    expect(allowed('superadmin')).toBe(true);
    for (const role of [
      'consolidator_admin',
      'tenant_admin',
      'agency_admin',
      'admin',
      'vendedor',
    ] as const) {
      expect(allowed(role)).toBe(false);
    }
    expect(allowed(undefined)).toBe(false);
  });
});
