import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { DespegarHotelsProviderFactory } from './despegar-hotels.factory.js';

function resolved(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: 'owner-1',
    providerCode: 'despegar-hotels',
    label: 'default',
    config: { baseUrl: 'https://example.test/v3', language: 'ES', countryCode: 'CO' },
    credentials: { apiKey: 'k' },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function factoryWith(
  resolve: ProviderCredentialsService['resolve'],
): DespegarHotelsProviderFactory {
  return new DespegarHotelsProviderFactory({ resolve } as unknown as ProviderCredentialsService);
}

describe('DespegarHotelsProviderFactory', () => {
  it('reusa la instancia para credenciales idénticas (cache)', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t1');
    expect(a).toBe(b);
  });

  it('reconstruye el adapter al rotar credenciales (cambia updatedAt)', async () => {
    let updatedAt = new Date('2026-01-01T00:00:00Z');
    const factory = factoryWith(() => Promise.resolve(resolved({ updatedAt })));
    const a = await factory.forTenant('t1');
    updatedAt = new Date('2026-02-01T00:00:00Z');
    const b = await factory.forTenant('t1');
    expect(a).not.toBe(b);
  });

  it('cae al fallback de entorno cuando el tenant no resuelve nada', async () => {
    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t2');
    expect(a).toBe(b);
  });

  it('usa adapters distintos para BYOC vs fallback env', async () => {
    let mode: 'byoc' | 'env' = 'byoc';
    const factory = factoryWith(() =>
      mode === 'env' ? Promise.reject(new NotFoundException('none')) : Promise.resolve(resolved()),
    );
    const byoc = await factory.forTenant('t1');
    mode = 'env';
    const env = await factory.forTenant('t2');
    expect(byoc).not.toBe(env);
  });

  it('propaga errores que no son NotFound', async () => {
    const factory = factoryWith(() => Promise.reject(new Error('db down')));
    await expect(factory.forTenant('t1')).rejects.toThrow('db down');
  });
});
