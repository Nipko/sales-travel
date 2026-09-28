import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import type { Role } from '../database/database.types.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { ProviderPayloadsController } from './provider-payloads.controller.js';
import type { ProviderPayloadsService } from './provider-payloads.service.js';
import type { ProviderPayloadExport } from './provider-payloads.types.js';

/**
 * El borde HTTP de la bóveda (docs/tbo/09 PR-4.9): quién entra, quién puede pedir lo de `live` sin
 * redactar, y que una búsqueda vacía no distinga "no existe" de "no es tuya".
 */

const USUARIO = '77777777-7777-4777-8777-777777777777';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const ORDEN = '99999999-9999-4999-8999-999999999999';

const CON_DATOS: ProviderPayloadExport = {
  lookup: { kind: 'request', requestId: 'req-1' },
  entries: [
    {
      providerCode: 'tbo-hotels',
      requestId: 'req-1',
      attempt: 1,
      operation: 'book',
      environment: 'live',
      accountRef: null,
      orderId: null,
      sentAt: '2026-09-25T12:00:00.000Z',
      durationMs: 10,
      httpStatus: 500,
      providerStatusCode: 500,
      outcome: 'UPSTREAM',
      redacted: true,
      request: { kind: 'absent' },
      response: { kind: 'absent' },
    },
  ],
};

function servicio(resultado: ProviderPayloadExport = CON_DATOS) {
  const exportByRequestId = vi.fn(() => Promise.resolve(resultado));
  const exportByOrderId = vi.fn(() =>
    Promise.resolve({ ...resultado, lookup: { kind: 'order' as const, orderId: ORDEN } }),
  );
  const controller = new ProviderPayloadsController({
    exportByRequestId,
    exportByOrderId,
  } as unknown as ProviderPayloadsService);
  return { controller, exportByRequestId, exportByOrderId };
}

function como<T>(role: Role | undefined, fn: () => Promise<T>): Promise<T> {
  const ctx: RequestContext = {
    userId: USUARIO,
    tenantId: CONSOLIDADOR,
    ...(role ? { role } : {}),
  };
  return requestContextStorage.run(ctx, fn);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProviderPayloadsController', () => {
  it('sólo para consolidator_admin (y la plataforma, que RolesGuard deja pasar siempre)', () => {
    const roles: unknown = Reflect.getMetadata(ROLES_KEY, ProviderPayloadsController);
    expect(roles).toEqual(['consolidator_admin']);
  });

  it('pasa al servicio el usuario y el tenant activo, y el filtro de proveedor', async () => {
    const { controller, exportByRequestId, exportByOrderId } = servicio();

    await como('consolidator_admin', () =>
      controller.byRequest(USUARIO, 'req-1', { provider: 'tbo-hotels' }),
    );
    await como('consolidator_admin', () => controller.byOrder(USUARIO, ORDEN, {}));

    expect(exportByRequestId).toHaveBeenCalledWith(
      'req-1',
      { userId: USUARIO, tenantId: CONSOLIDADOR },
      { providerCode: 'tbo-hotels' },
    );
    expect(exportByOrderId).toHaveBeenCalledWith(
      ORDEN,
      { userId: USUARIO, tenantId: CONSOLIDADOR },
      {},
    );
  });

  it('sin redactar (con ticket) sólo la plataforma: el consolidador recibe 403 y no se lee nada', async () => {
    const { controller, exportByRequestId } = servicio();

    await expect(
      como('consolidator_admin', () =>
        controller.byRequest(USUARIO, 'req-1', { supportTicket: 'TBO-4521' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(exportByRequestId).not.toHaveBeenCalled();

    await como('platform_admin', () =>
      controller.byRequest(USUARIO, 'req-1', { supportTicket: 'TBO-4521' }),
    );
    await como('superadmin', () =>
      controller.byOrder(USUARIO, ORDEN, { supportTicket: 'TBO-4522' }),
    );
    expect(exportByRequestId).toHaveBeenCalledWith('req-1', expect.anything(), {
      reveal: { supportTicket: 'TBO-4521' },
    });
  });

  it('sin usuario es 401; sin resultados, 404 igual para "no existe" y "no es tuya"', async () => {
    await expect(
      como('consolidator_admin', () => servicio().controller.byRequest(undefined, 'req-1', {})),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const vacio = servicio({ lookup: { kind: 'request', requestId: 'req-1' }, entries: [] });
    await expect(
      como('consolidator_admin', () => vacio.controller.byRequest(USUARIO, 'req-1', {})),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
