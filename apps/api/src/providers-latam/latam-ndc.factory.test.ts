import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { LatamNdcProviderFactory } from './latam-ndc.factory.js';

function resolved(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: 'owner-1',
    providerCode: 'latam-ndc',
    label: 'default',
    config: { apiUrl: 'https://example.test' },
    credentials: {
      apiKey: 'k',
      apiSecret: 's',
      agencyId: 'A',
      agencyIata: '12345678',
      country: 'CO',
    },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Stub mínimo de ProviderCredentialsService con un `resolve` controlable. */
function factoryWith(resolve: ProviderCredentialsService['resolve']): LatamNdcProviderFactory {
  return new LatamNdcProviderFactory({ resolve } as unknown as ProviderCredentialsService);
}

describe('LatamNdcProviderFactory', () => {
  it('reuses the same adapter instance for identical resolved credentials (token cache)', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t1');
    expect(a).toBe(b);
  });

  it('rebuilds the adapter when credentials rotate (updatedAt changes)', async () => {
    let updatedAt = new Date('2026-01-01T00:00:00Z');
    const factory = factoryWith(() => Promise.resolve(resolved({ updatedAt })));
    const a = await factory.forTenant('t1');
    updatedAt = new Date('2026-02-01T00:00:00Z');
    const b = await factory.forTenant('t1');
    expect(a).not.toBe(b);
  });

  it('falls back to env credentials when the tenant resolves nothing', async () => {
    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t2');
    // Ambos caen al mismo adapter "env".
    expect(a).toBe(b);
  });

  it('uses distinct adapters for BYOC vs env fallback', async () => {
    let mode: 'byoc' | 'env' = 'byoc';
    const factory = factoryWith(() =>
      mode === 'env' ? Promise.reject(new NotFoundException('none')) : Promise.resolve(resolved()),
    );
    const byoc = await factory.forTenant('t1');
    mode = 'env';
    const env = await factory.forTenant('t2');
    expect(byoc).not.toBe(env);
  });

  it('propagates non-NotFound errors from the resolver', async () => {
    const factory = factoryWith(() => Promise.reject(new Error('db down')));
    await expect(factory.forTenant('t1')).rejects.toThrow('db down');
  });
});
