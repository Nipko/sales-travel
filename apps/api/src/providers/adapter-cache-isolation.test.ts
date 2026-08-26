import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { FlightProviderRegistry } from './flight-provider.registry.js';
import type { ProviderFlagsPort } from './provider.types.js';

/**
 * Aislamiento del caché de adapters entre tenants (exigido por `CLAUDE.md`).
 *
 * El factory cachea instancias para conservar el caché de token OAuth, que vive DENTRO del
 * adapter. Si esa caché se compartiera entre tenants con credenciales distintas, una agencia
 * saldría al proveedor con el token de otra: cotizaría con el PCC ajeno y la reserva se
 * facturaría a quien no la hizo. Se prueba contra el factory real, no contra un doble.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';

function cuenta(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: TENANT_A,
    providerCode: 'latam-ndc',
    label: 'default',
    config: { apiUrl: 'https://example.test' },
    credentials: { apiKey: 'k', apiSecret: 's', agencyId: 'A', agencyName: 'A', country: 'CO' },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function factoryCon(resolve: ProviderCredentialsService['resolve']): LatamNdcProviderFactory {
  return new LatamNdcProviderFactory({ resolve } as unknown as ProviderCredentialsService);
}

/** El caché es privado a propósito; el test lo mira para poder afirmar que se purga. */
function entradasDeCache(factory: LatamNdcProviderFactory): string[] {
  return [...(factory as unknown as { cache: Map<string, unknown> }).cache.keys()];
}

const flagsApagados: ProviderFlagsPort = { isEnabledForTenant: () => Promise.resolve(false) };

describe('aislamiento del caché de adapters entre tenants', () => {
  beforeEach(() => {
    // El ACL avisa por consola en qué modo arranca; acá sólo ensucia la salida del test.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dos tenants con credenciales propias distintas NO comparten adapter', async () => {
    const factory = factoryCon((tenantId) =>
      Promise.resolve(cuenta({ ownerTenantId: tenantId, credentials: { apiKey: tenantId } })),
    );

    const a = await factory.forTenant(TENANT_A);
    const b = await factory.forTenant(TENANT_B);

    expect(a).not.toBe(b);
  });

  it('dos tenants que HEREDAN la misma cuenta comparten adapter, y eso es lo correcto', async () => {
    const factory = factoryCon(() =>
      Promise.resolve(cuenta({ ownerTenantId: CONSOLIDADOR, inherited: true })),
    );

    const a = await factory.forTenant(TENANT_A);
    const b = await factory.forTenant(TENANT_B);

    // Son las MISMAS credenciales del consolidador: el caché de token es por credencial, no
    // por tenant. Compartirlo acá no filtra nada y evita pedir un token por cada agencia.
    expect(a).toBe(b);
  });

  it('al rotar credenciales se construye otro adapter y la entrada vieja se descarta', async () => {
    let updatedAt = new Date('2026-01-01T00:00:00Z');
    const factory = factoryCon(() => Promise.resolve(cuenta({ updatedAt })));

    const viejo = await factory.forTenant(TENANT_A);
    const antes = entradasDeCache(factory);

    updatedAt = new Date('2026-02-01T00:00:00Z');
    const nuevo = await factory.forTenant(TENANT_A);

    expect(nuevo).not.toBe(viejo);
    // Sin la purga, el adapter con las credenciales revocadas seguiría vivo y accesible.
    const despues = entradasDeCache(factory);
    expect(despues).toHaveLength(1);
    expect(despues).not.toEqual(antes);
  });

  it('el adapter de credenciales de plataforma no se mezcla con el de una agencia', async () => {
    let hayCuenta = true;
    const factory = factoryCon(() =>
      hayCuenta
        ? Promise.resolve(cuenta())
        : Promise.reject(new NotFoundException('sin cuenta activa')),
    );

    const propio = await factory.forTenant(TENANT_A);
    hayCuenta = false;
    const plataforma = await factory.forTenant(TENANT_B);

    expect(propio).not.toBe(plataforma);
  });

  it('el registry devuelve adapters distintos a tenants distintos, con su origen declarado', async () => {
    const factory = factoryCon((tenantId) =>
      tenantId === TENANT_A
        ? Promise.resolve(cuenta({ ownerTenantId: TENANT_A, credentials: { apiKey: 'a' } }))
        : Promise.resolve(
            cuenta({ ownerTenantId: CONSOLIDADOR, inherited: true, credentials: { apiKey: 'c' } }),
          ),
    );
    const registry = new FlightProviderRegistry([factory], flagsApagados);

    const a = await registry.byCode(TENANT_A, 'latam-ndc');
    const b = await registry.byCode(TENANT_B, 'latam-ndc');

    expect(a.adapter).not.toBe(b.adapter);
    expect(a.credentialSource).toBe('own');
    expect(b.credentialSource).toBe('inherited');
  });

  it('el mismo tenant reutiliza su adapter entre búsquedas (el token no se repide)', async () => {
    const factory = factoryCon(() => Promise.resolve(cuenta()));
    const registry = new FlightProviderRegistry([factory], flagsApagados);

    const primera = await registry.forTenant(TENANT_A);
    const segunda = await registry.forTenant(TENANT_A);

    expect(primera.active[0]?.adapter).toBe(segunda.active[0]?.adapter);
  });
});
