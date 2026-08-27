import { Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountIncompleteError } from '../providers/provider.types.js';
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

/** Las cinco variables con las que la plataforma tiene credenciales propias de LATAM. */
function credencialesDePlataforma(): void {
  vi.stubEnv('LATAM_API_KEY', 'plataforma-key');
  vi.stubEnv('LATAM_API_SECRET', 'plataforma-secret');
  vi.stubEnv('LATAM_AGENCY_ID', 'PLAT');
  vi.stubEnv('LATAM_AGENCY_IATA', '87654321');
  vi.stubEnv('LATAM_COUNTRY', 'CO');
}

describe('LatamNdcProviderFactory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
    // El escalón de credenciales de plataforma se CONSERVA: es como opera hoy producción.
    credencialesDePlataforma();
    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t2');
    // Ambos caen al mismo adapter "env".
    expect(a).toBe(b);
  });

  it('uses distinct adapters for BYOC vs env fallback', async () => {
    credencialesDePlataforma();
    let mode: 'byoc' | 'env' = 'byoc';
    const factory = factoryWith(() =>
      mode === 'env' ? Promise.reject(new NotFoundException('none')) : Promise.resolve(resolved()),
    );
    const byoc = await factory.forTenant('t1');
    mode = 'env';
    const env = await factory.forTenant('t2');
    expect(byoc).not.toBe(env);
  });

  describe('sin credenciales usables el proveedor NO se sirve', () => {
    // El escalón que desapareció: cuando no había ni cuenta ni entorno, el adapter devolvía
    // tres ofertas de fixture con la misma forma canónica que una tarifa real.
    it('sin cuenta y sin entorno, lanza en vez de construir un adapter simulado', async () => {
      // `NotFoundException` a secas y no `ProviderAccountIncompleteError`: no hay cuenta que
      // completar, así que el registry lo cuenta como ausencia de credenciales.
      const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
      const err = await factory.forTenant('t1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err).not.toBeInstanceOf(ProviderAccountIncompleteError);
    });

    it('con la cuenta a medias, lanza y NOMBRA el campo que falta', async () => {
      const factory = factoryWith(() =>
        Promise.resolve(
          resolved({
            credentials: { apiKey: 'k', apiSecret: 's', agencyId: 'A', country: 'CO' },
          }),
        ),
      );

      const err = await factory.forTenant('t1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderAccountIncompleteError);
      expect((err as ProviderAccountIncompleteError).missingFields).toEqual(['agencyIata']);
    });

    it('ni el entorno ni el JSONB de la cuenta pueden reencender la simulación', async () => {
      // `LATAM_FORCE_MOCK` y `config.mock` eran los dos interruptores. Ninguno existe ya: con
      // los dos puestos y sin credenciales, el proveedor sigue sin servirse.
      vi.stubEnv('LATAM_FORCE_MOCK', 'true');
      const factory = factoryWith(() =>
        Promise.resolve(resolved({ credentials: {}, config: { mock: true } })),
      );
      await expect(factory.forTenant('t1')).rejects.toBeInstanceOf(ProviderAccountIncompleteError);
    });

    it('el error no lleva valores de credencial, sólo nombres de campo', async () => {
      const factory = factoryWith(() =>
        Promise.resolve(
          resolved({ credentials: { apiKey: 'clave-secreta-de-la-agencia', country: 'CO' } }),
        ),
      );

      const err = await factory.forTenant('t1').catch((e: unknown) => e);
      const texto = err instanceof Error ? err.message : String(err);
      expect(texto).toContain('apiSecret');
      expect(texto).not.toContain('clave-secreta-de-la-agencia');
    });
  });

  it('propagates non-NotFound errors from the resolver', async () => {
    const factory = factoryWith(() => Promise.reject(new Error('db down')));
    await expect(factory.forTenant('t1')).rejects.toThrow('db down');
  });
});
