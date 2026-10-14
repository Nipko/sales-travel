import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { SALES_OPERATION_KEY } from '../auth/decorators/sales-operation.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { HotelReadinessController } from './hotel-readiness.controller.js';
import type { HotelReadinessService, HotelReadinessView } from './hotel-readiness.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

const VISTA: HotelReadinessView = {
  provider: 'tbo-hotels',
  nodes: [],
  omitted: 0,
  partial: false,
};

function banco({ esSuperadmin = true } = {}) {
  const service = { readiness: vi.fn(() => Promise.resolve(VISTA)) };
  const network = { isSuperadmin: vi.fn(() => Promise.resolve(esSuperadmin)) };
  const controller = new HotelReadinessController(
    service as unknown as HotelReadinessService,
    network as unknown as NetworkService,
  );
  return { controller, service, network };
}

describe('GET /admin/hotels/readiness: sólo el superadmin', () => {
  it('sin usuario, 401', async () => {
    const { controller, service } = banco();

    await expect(controller.readiness(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.readiness).not.toHaveBeenCalled();
  });

  it('quien no es superadmin recibe 403 y el servicio no se entera', async () => {
    const { controller, service, network } = banco({ esSuperadmin: false });

    await expect(controller.readiness(USUARIO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(network.isSuperadmin).toHaveBeenCalledWith(USUARIO);
    expect(service.readiness).not.toHaveBeenCalled();
  });

  it('el superadmin recibe la revisión, hecha con su usuario', async () => {
    const { controller, service } = banco();

    await expect(controller.readiness(USUARIO)).resolves.toBe(VISTA);
    expect(service.readiness).toHaveBeenCalledWith(USUARIO);
  });

  describe('RolesGuard con la metadata REAL del controlador', () => {
    const guard = new RolesGuard(new Reflector());
    const handler = Object.getOwnPropertyDescriptor(HotelReadinessController.prototype, 'readiness')
      ?.value as () => unknown;
    const ctx = {
      getHandler: () => handler,
      getClass: () => HotelReadinessController,
    } as unknown as ExecutionContext;

    function como(role: Role, platformUser = false): boolean {
      return requestContextStorage.run({ userId: USUARIO, role, platformUser }, () =>
        guard.canActivate(ctx),
      );
    }

    it.each<Role>(['consolidator_admin', 'tenant_admin', 'agency_admin', 'admin', 'vendedor'])(
      '%s no llega al handler: es un diagnóstico de la plataforma',
      (role) => {
        expect(() => como(role)).toThrow(ForbiddenException);
      },
    );

    it('no es una venta: el superadmin pasa el guard aunque no venda', () => {
      expect(Reflect.getMetadata(SALES_OPERATION_KEY, handler)).toBeUndefined();
      expect(como('superadmin', true)).toBe(true);
      // Pasa el guard por ser de plataforma; el handler exige además superadmin.
      expect(como('platform_admin', true)).toBe(true);
    });
  });
});
