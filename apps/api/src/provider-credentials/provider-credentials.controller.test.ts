import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { NetworkService } from '../network/network.service.js';
import { ProviderCredentialsController } from './provider-credentials.controller.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from './provider-credentials.service.js';

const PASSWORD = 'p4ssw0rd-de-la-oficina';

function resolved(over: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: 'owner-1',
    providerCode: 'sabre',
    label: 'default',
    config: {},
    credentials: { epr: '1234567', password: PASSWORD, homePcc: 'AB1C' },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function controllerCon(
  cuenta: ResolvedProviderAccount,
  puedeGestionar = true,
): ProviderCredentialsController {
  const service = {
    resolve: () => Promise.resolve(cuenta),
  } as unknown as ProviderCredentialsService;
  const network = {
    canManageTenant: () => Promise.resolve(puedeGestionar),
  } as unknown as NetworkService;
  const audit = { emit: () => Promise.resolve() } as unknown as AuditService;
  return new ProviderCredentialsController(service, network, audit);
}

/**
 * `GET /provider-accounts/resolve` es el diagnóstico que consulta el panel de red. Resolver NO es
 * funcionar: una cuenta activa a la que le falta un campo obligatorio resuelve igual, y después
 * el proveedor desaparece de las búsquedas sin que nadie vea un error. Por eso la respuesta dice
 * también si está completa.
 */
describe('GET /provider-accounts/resolve', () => {
  it('una cuenta resoluble pero INCOMPLETA se declara incompleta y nombra el campo', async () => {
    const controller = controllerCon(
      resolved({ credentials: { epr: '1234567', password: PASSWORD } }),
    );
    const out = await controller.resolve('u1', 't1', 'sabre');
    expect(out.readiness).toBe('incomplete');
    expect(out.missingRequiredFields).toEqual(['homePcc']);
  });

  it('una cuenta completa lo dice, y sigue diciendo de dónde sale', async () => {
    const controller = controllerCon(resolved({ inherited: true, ownerTenantId: 'consolidador' }));
    const out = await controller.resolve('u1', 't1', 'sabre');
    expect(out.readiness).toBe('complete');
    expect(out.inherited).toBe(true);
    expect(out.ownerTenantId).toBe('consolidador');
  });

  it('de un proveedor sin reglas declaradas responde `unknown`, no `complete`', async () => {
    const controller = controllerCon(
      resolved({ providerCode: 'latam-ndc', credentials: { apiKey: 'k' } }),
    );
    expect((await controller.resolve('u1', 't1', 'latam-ndc')).readiness).toBe('unknown');
  });

  it('la respuesta NUNCA lleva el valor de una credencial, ni el objeto entero', async () => {
    const controller = controllerCon(resolved());
    const out = await controller.resolve('u1', 't1', 'sabre');
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(out).not.toHaveProperty('credentials');
  });

  it('sigue exigiendo autorización jerárquica antes de contestar nada', async () => {
    const controller = controllerCon(resolved(), false);
    await expect(controller.resolve('u1', 't1', 'sabre')).rejects.toThrow(ForbiddenException);
  });
});
