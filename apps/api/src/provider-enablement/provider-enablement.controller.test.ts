import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { ProviderEnablementController } from './provider-enablement.controller.js';
import {
  ProviderCodeParamSchema,
  SetProviderEnablementSchema,
  TenantIdParamSchema,
} from './provider-enablement.schemas.js';
import type { ProviderEnablementService } from './provider-enablement.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const TENANT = '11111111-1111-4111-8111-111111111111';

function banco({ esSuperadmin = true } = {}) {
  const service = {
    list: vi.fn(() => Promise.resolve([])),
    forTenant: vi.fn(() => Promise.resolve({ tenantId: TENANT, providers: [] })),
    setGlobal: vi.fn(() => Promise.resolve({ code: 'sabre' })),
    clearGlobal: vi.fn(() => Promise.resolve({ code: 'sabre' })),
    setTenant: vi.fn(() => Promise.resolve({ code: 'sabre' })),
    clearTenant: vi.fn(() => Promise.resolve({ code: 'sabre' })),
  };
  const network = {
    isSuperadmin: vi.fn(() => Promise.resolve(esSuperadmin)),
  };
  const controller = new ProviderEnablementController(
    service as unknown as ProviderEnablementService,
    network as unknown as NetworkService,
  );
  return { controller, service, network };
}

describe('ProviderEnablementController: sólo el superadmin', () => {
  it('sin usuario, 401', async () => {
    const { controller, service } = banco();
    await expect(controller.list(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.list).not.toHaveBeenCalled();
  });

  it.each([
    ['listar', (c: ProviderEnablementController) => c.list(USUARIO)],
    ['ver un tenant', (c: ProviderEnablementController) => c.forTenant(USUARIO, TENANT)],
    [
      'fijar el global',
      (c: ProviderEnablementController) => c.setGlobal(USUARIO, 'sabre', { enabled: false }),
    ],
    ['quitar el global', (c: ProviderEnablementController) => c.clearGlobal(USUARIO, 'sabre')],
    [
      'fijar un tenant',
      (c: ProviderEnablementController) =>
        c.setTenant(USUARIO, 'sabre', TENANT, { enabled: false }),
    ],
    [
      'quitar un tenant',
      (c: ProviderEnablementController) => c.clearTenant(USUARIO, 'sabre', TENANT),
    ],
  ])('%s: quien no es superadmin recibe 403 y el servicio no se entera', async (_q, llamar) => {
    const { controller, service, network } = banco({ esSuperadmin: false });

    await expect(llamar(controller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(network.isSuperadmin).toHaveBeenCalledWith(USUARIO);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('el superadmin pasa, y el actor que llega al servicio es él', async () => {
    const { controller, service } = banco();

    await controller.setTenant(USUARIO, 'sabre', TENANT, { enabled: false, reason: 'Mora' });
    await controller.setGlobal(USUARIO, 'tbo-hotels', { enabled: true });

    expect(service.setTenant).toHaveBeenCalledWith(USUARIO, 'sabre', TENANT, {
      enabled: false,
      reason: 'Mora',
    });
    expect(service.setGlobal).toHaveBeenCalledWith(USUARIO, 'tbo-hotels', {
      enabled: true,
      reason: null,
    });
  });

  describe('RolesGuard con la metadata REAL del controlador', () => {
    const guard = new RolesGuard(new Reflector());
    // `@Roles` está en la clase: el handler no declara nada propio.
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => ProviderEnablementController,
    } as unknown as ExecutionContext;

    function como(role: Role): boolean {
      return requestContextStorage.run({ userId: USUARIO, role }, () => guard.canActivate(ctx));
    }

    it.each<Role>(['consolidator_admin', 'tenant_admin', 'agency_admin', 'admin', 'vendedor'])(
      '%s no llega al handler: un nodo no gobierna proveedores de la plataforma',
      (role) => {
        expect(() => como(role)).toThrow(ForbiddenException);
      },
    );

    it('los roles de plataforma pasan el guard (el handler exige además superadmin)', () => {
      expect(como('superadmin')).toBe(true);
      expect(como('platform_admin')).toBe(true);
    });
  });
});

describe('Zod en los bordes', () => {
  const cuerpo = new ZodValidationPipe(SetProviderEnablementSchema);
  const codigo = new ZodValidationPipe(ProviderCodeParamSchema);
  const tenant = new ZodValidationPipe(TenantIdParamSchema);

  it('acepta el cuerpo mínimo y normaliza el motivo', () => {
    expect(cuerpo.transform({ enabled: true })).toEqual({ enabled: true });
    expect(cuerpo.transform({ enabled: false, reason: '  Mora  ' })).toEqual({
      enabled: false,
      reason: 'Mora',
    });
    // Vacío o sólo espacios es "sin motivo", no un motivo en blanco.
    expect(cuerpo.transform({ enabled: false, reason: '   ' })).toEqual({
      enabled: false,
      reason: null,
    });
    expect(cuerpo.transform({ enabled: false, reason: null })).toEqual({
      enabled: false,
      reason: null,
    });
  });

  it.each([
    ['sin `enabled`', {}],
    ['`enabled` no booleano', { enabled: 'si' }],
    ['`enabled: null` (quitar es el DELETE)', { enabled: null }],
    ['motivo de más de 500', { enabled: true, reason: 'x'.repeat(501) }],
    ['campos de más', { enabled: true, tenantId: TENANT }],
  ])('rechaza el cuerpo: %s', (_q, body) => {
    expect(() => cuerpo.transform(body)).toThrow(BadRequestException);
  });

  it.each(['Sabre', 'sabre hotels', 'sabre;drop', '', 'x'.repeat(65)])(
    'rechaza el código de proveedor %j',
    (valor) => {
      expect(() => codigo.transform(valor)).toThrow(BadRequestException);
    },
  );

  it('acepta un código de proveedor de los registries', () => {
    expect(codigo.transform('tbo-hotels')).toBe('tbo-hotels');
  });

  it('el tenant tiene que ser un uuid', () => {
    expect(tenant.transform(TENANT)).toBe(TENANT);
    expect(() => tenant.transform('tbo-cert')).toThrow(BadRequestException);
  });

  it('el tenant sale en minúsculas: la vista y la auditoría no se parten por la capitalización', () => {
    expect(tenant.transform(TENANT.toUpperCase())).toBe(TENANT);
  });
});
