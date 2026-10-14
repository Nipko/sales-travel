import { type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { DepositReportQueueController } from './deposit-report-queue.controller.js';
import { DepositReportQueueQuerySchema } from './deposit-report-queue.schemas.js';
import type { DepositReportQueueService } from './deposit-report-queue.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

function banco() {
  const queue = {
    list: vi.fn(() =>
      Promise.resolve({ status: 'pending', reports: [], nextCursor: null, totals: [] }),
    ),
    pendingCount: vi.fn(() => Promise.resolve({ total: 3, platform: 2, network: 1 })),
  };
  const controller = new DepositReportQueueController(
    queue as unknown as DepositReportQueueService,
  );
  return { controller, queue };
}

const QUERY = DepositReportQueueQuerySchema.parse({});

describe('DepositReportQueueController: sólo el superadmin', () => {
  it('la clase entera pasa por SuperadminGuard (platform_admin queda fuera)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DepositReportQueueController)).toEqual([
      SuperadminGuard,
    ]);
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
