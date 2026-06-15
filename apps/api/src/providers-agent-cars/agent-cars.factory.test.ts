import { NotFoundException } from '@nestjs/common';
import { AgentCarsAdapter, type AgentCarsConfig } from '@sales-travel/agent-cars';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { AgentCarsProviderFactory } from './agent-cars.factory.js';

/** Lee la config con la que se construyó el adapter (es `private readonly cfg`). */
function configOf(adapter: AgentCarsAdapter): AgentCarsConfig {
  return (adapter as unknown as { cfg: AgentCarsConfig }).cfg;
}

function resolved(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: 'owner-1',
    providerCode: 'agent-cars',
    label: 'default',
    config: { baseUrl: 'https://byoc.test/v2/sites', sourceCountry: 'CO', language: 'ES' },
    credentials: { accessToken: 'byoc-token' },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function factoryWith(
  resolve: ProviderCredentialsService['resolve'],
): AgentCarsProviderFactory {
  return new AgentCarsProviderFactory({ resolve } as unknown as ProviderCredentialsService);
}

const ENV_KEYS = [
  'AGENT_CARS_ACCESS_TOKEN',
  'AGENT_CARS_BASE_URL',
  'AGENT_CARS_SUGGEST_URL',
  'AGENT_CARS_SOURCE',
  'AGENT_CARS_LANGUAGE',
] as const;

describe('AgentCarsProviderFactory', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('(a) resuelve la config desde BYOC (accessToken + baseUrl/sourceCountry)', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    const adapter = await factory.forTenant('t1');
    const cfg = configOf(adapter);

    expect(cfg.accessToken).toBe('byoc-token');
    expect(cfg.baseUrl).toBe('https://byoc.test/v2/sites');
    expect(cfg.sourceCountry).toBe('CO');
    expect(cfg.language).toBe('ES');
  });

  it('(b) cae al fallback de entorno cuando resolve lanza NotFoundException', async () => {
    process.env['AGENT_CARS_ACCESS_TOKEN'] = 'env-token';
    process.env['AGENT_CARS_BASE_URL'] = 'https://env.test/v2/sites';
    process.env['AGENT_CARS_SOURCE'] = 'AR';

    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    const adapter = await factory.forTenant('t1');
    const cfg = configOf(adapter);

    expect(cfg.accessToken).toBe('env-token');
    expect(cfg.baseUrl).toBe('https://env.test/v2/sites');
    expect(cfg.sourceCountry).toBe('AR');
  });

  it('(b.bis) reusa la MISMA instancia env para distintos tenants sin BYOC', async () => {
    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t2');
    expect(a).toBe(b);
  });

  it('(c) cachea por key byoc:owner:updatedAt y devuelve la MISMA instancia', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t1');
    expect(a).toBe(b);
  });

  it('(d) evicta la entrada vieja al rotar updatedAt (reconstruye el adapter)', async () => {
    let updatedAt = new Date('2026-01-01T00:00:00Z');
    const factory = factoryWith(() => Promise.resolve(resolved({ updatedAt })));
    const a = await factory.forTenant('t1');
    updatedAt = new Date('2026-02-01T00:00:00Z');
    const b = await factory.forTenant('t1');
    expect(a).not.toBe(b);
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
