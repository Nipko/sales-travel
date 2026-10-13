import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { ProviderEnablementController } from './provider-enablement.controller.js';
import {
  ClearKillSwitchSchema,
  ProviderCodeParamSchema,
  ResetCircuitSchema,
  SetKillSwitchSchema,
  SetProviderEnablementSchema,
  TenantIdParamSchema,
} from './provider-enablement.schemas.js';
import type { ProviderEnablementService } from './provider-enablement.service.js';
import type { ProviderHealthService } from './provider-health.service.js';

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
  const health = {
    health: vi.fn(() => Promise.resolve([])),
    setKillSwitch: vi.fn(() => Promise.resolve({ code: 'sabre' })),
    clearKillSwitch: vi.fn(() => Promise.resolve({ code: 'sabre' })),
    resetCircuit: vi.fn(() => Promise.resolve({ code: 'sabre' })),
  };
  const network = {
    isSuperadmin: vi.fn(() => Promise.resolve(esSuperadmin)),
  };
  const controller = new ProviderEnablementController(
    service as unknown as ProviderEnablementService,
    network as unknown as NetworkService,
    health as unknown as ProviderHealthService,
  );
  return { controller, service, health, network };
}

const APAGAR = { level: 'sales', reason: 'TBO cobra de más', expiresInMinutes: 60 } as const;

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
    ['ver la salud', (c: ProviderEnablementController) => c.providersHealth(USUARIO)],
    [
      'apagar de emergencia',
      (c: ProviderEnablementController) => c.setKillSwitch(USUARIO, 'sabre', APAGAR),
    ],
    [
      'levantar el apagado',
      (c: ProviderEnablementController) => c.clearKillSwitch(USUARIO, 'sabre', {}),
    ],
    [
      'cerrar el circuito',
      (c: ProviderEnablementController) =>
        c.resetCircuit(USUARIO, 'sabre', { reason: 'Sabre volvió' }),
    ],
  ])('%s: quien no es superadmin recibe 403 y el servicio no se entera', async (_q, llamar) => {
    const { controller, service, health, network } = banco({ esSuperadmin: false });

    await expect(llamar(controller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(network.isSuperadmin).toHaveBeenCalledWith(USUARIO);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(health)) expect(fn).not.toHaveBeenCalled();
  });

  it('las palancas de un incidente llegan al servicio con el superadmin como actor', async () => {
    const { controller, health } = banco();

    await controller.providersHealth(USUARIO);
    await controller.setKillSwitch(USUARIO, 'tbo-hotels', APAGAR);
    await controller.clearKillSwitch(USUARIO, 'tbo-hotels', {});
    await controller.clearKillSwitch(USUARIO, 'tbo-hotels', { reason: 'TBO corrigió' });
    await controller.resetCircuit(USUARIO, 'sabre', { reason: 'Sabre volvió' });

    expect(health.health).toHaveBeenCalledWith(USUARIO);
    expect(health.setKillSwitch).toHaveBeenCalledWith(USUARIO, 'tbo-hotels', APAGAR);
    expect(health.clearKillSwitch).toHaveBeenNthCalledWith(1, USUARIO, 'tbo-hotels', null);
    expect(health.clearKillSwitch).toHaveBeenNthCalledWith(
      2,
      USUARIO,
      'tbo-hotels',
      'TBO corrigió',
    );
    expect(health.resetCircuit).toHaveBeenCalledWith(USUARIO, 'sabre', 'Sabre volvió');
  });

  it('la clase lleva SuperadminGuard: 403 antes de validar el cuerpo', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ProviderEnablementController) as unknown[];
    expect(guards).toContain(SuperadminGuard);
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

  describe('apagado de emergencia', () => {
    const apagar = new ZodValidationPipe(SetKillSwitchSchema);

    it.each([60, 240, 1440, null])('acepta el vencimiento %j', (expiresInMinutes) => {
      expect(apagar.transform({ ...APAGAR, expiresInMinutes })).toEqual({
        ...APAGAR,
        expiresInMinutes,
      });
    });

    it('recorta el motivo', () => {
      expect(apagar.transform({ ...APAGAR, reason: '  TBO cobra de más  ' })).toMatchObject({
        reason: 'TBO cobra de más',
      });
    });

    it.each([
      ['un nivel que no existe', { ...APAGAR, level: 'todo' }],
      ['sin motivo', { level: 'all', expiresInMinutes: null }],
      ['motivo de menos de 5', { ...APAGAR, reason: '  ab  ' }],
      ['motivo de más de 500', { ...APAGAR, reason: 'x'.repeat(501) }],
      ['un vencimiento fuera de la lista', { ...APAGAR, expiresInMinutes: 30 }],
      ['sin vencimiento declarado', { level: 'all', reason: 'Responde basura' }],
      ['campos de más', { ...APAGAR, providerCode: 'sabre' }],
    ])('rechaza: %s', (_q, body) => {
      expect(() => apagar.transform(body)).toThrow(BadRequestException);
    });

    it('levantar: motivo opcional, normalizado como el de la habilitación', () => {
      const levantar = new ZodValidationPipe(ClearKillSwitchSchema);
      expect(levantar.transform({})).toEqual({});
      expect(levantar.transform({ reason: '   ' })).toEqual({ reason: null });
      expect(levantar.transform({ reason: ' Listo ' })).toEqual({ reason: 'Listo' });
      expect(() => levantar.transform({ reason: 'x'.repeat(501) })).toThrow(BadRequestException);
      expect(() => levantar.transform({ level: 'all' })).toThrow(BadRequestException);
    });

    it('cerrar el circuito: motivo obligatorio', () => {
      const cerrar = new ZodValidationPipe(ResetCircuitSchema);
      expect(cerrar.transform({ reason: ' Sabre volvió ' })).toEqual({ reason: 'Sabre volvió' });
      expect(() => cerrar.transform({})).toThrow(BadRequestException);
      expect(() => cerrar.transform({ reason: 'ya' })).toThrow(BadRequestException);
    });
  });

  it('el tenant tiene que ser un uuid', () => {
    expect(tenant.transform(TENANT)).toBe(TENANT);
    expect(() => tenant.transform('tbo-cert')).toThrow(BadRequestException);
  });

  it('el tenant sale en minúsculas: la vista y la auditoría no se parten por la capitalización', () => {
    expect(tenant.transform(TENANT.toUpperCase())).toBe(TENANT);
  });
});
