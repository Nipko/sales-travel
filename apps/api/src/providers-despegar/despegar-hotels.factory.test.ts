import { NotFoundException } from '@nestjs/common';
import { DespegarApiError, DespegarHotelsAdapter } from '@sales-travel/despegar-hotels';
import { describe, expect, it } from 'vitest';
import { humanizeDespegarError } from '../hotels/despegar-hotels-errors.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type { HotelProviderFactory } from '../providers/hotel-provider.types.js';
import { DespegarHotelProviderAdapter } from './despegar-hotel-provider.adapter.js';
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
    await expect(factory.resolveForTenant('t1')).rejects.toThrow('db down');
  });
});

describe('DespegarHotelsProviderFactory — contrato del registry de hoteles', () => {
  it('se declara proveedor de hoteles, llamado en cada búsqueda', () => {
    const factory: HotelProviderFactory = factoryWith(() => Promise.resolve(resolved()));

    expect(factory.code).toBe('despegar-hotels');
    expect(factory.vertical).toBe('hotels');
    expect(factory.defaultCallPolicy).toBe('always');
    expect(factory.capabilities).toEqual({
      retrieve: true,
      cancel: true,
      retrieveByClientReference: false,
      reconcileByDate: false,
      // Lee reservas, pero sin un HCN con SLA que seguir: no entra al seguimiento.
      hcn: false,
    });
  });

  it('declara lo que la búsqueda hacía antes del registry: 50 hoteles por `hotel_id`, en el espacio de la plataforma', () => {
    // Cambiar el orden o el límite cambia qué hoteles ve el vendedor: es otro PR, con telemetría.
    const factory: HotelProviderFactory = factoryWith(() => Promise.resolve(resolved()));

    expect(factory.searchProfile).toEqual({
      idSpace: 'platform',
      maxHotelsPerSearch: 50,
      catalogOrder: 'hotel_id',
    });
  });

  it('`forTenant` sigue entregando el ACL concreto: lo usan las rutas de reserva de Despegar', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));

    expect(await factory.forTenant('t1')).toBeInstanceOf(DespegarHotelsAdapter);
  });

  it('`resolveForTenant` entrega el contrato neutral y dice de dónde son las credenciales', async () => {
    let cuenta: 'propia' | 'heredada' | 'ninguna' = 'propia';
    const factory = factoryWith(() => {
      if (cuenta === 'ninguna') return Promise.reject(new NotFoundException('none'));
      return Promise.resolve(
        resolved(cuenta === 'heredada' ? { ownerTenantId: 'consolidador', inherited: true } : {}),
      );
    });

    const propia = await factory.resolveForTenant('t1');
    cuenta = 'heredada';
    const heredada = await factory.resolveForTenant('t1');
    cuenta = 'ninguna';
    const plataforma = await factory.resolveForTenant('t1');

    expect(propia.adapter).toBeInstanceOf(DespegarHotelProviderAdapter);
    expect([propia, heredada, plataforma].map((r) => r.credentialSource)).toEqual([
      'own',
      'inherited',
      'env',
    ]);
    // La cuenta de Despegar no declara política: manda la del factory o el override de entorno.
    expect(propia.callPolicy).toBeUndefined();
  });

  it('el ACL y su envoltorio salen de la MISMA entrada del caché', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));

    const primero = await factory.resolveForTenant('t1');
    await factory.forTenant('t1');
    const segundo = await factory.resolveForTenant('t1');

    expect(segundo.adapter).toBe(primero.adapter);
    expect((factory as unknown as { cache: Map<string, unknown> }).cache.size).toBe(1);
  });

  it('traduce los errores de Despegar con el mismo texto que el filtro de la vertical', () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    const err = new DespegarApiError(
      401,
      '{"message":"invalid apikey"}',
      '/hotels-api/availability',
    );

    expect(factory.humanizeError(err)).toBe(humanizeDespegarError(err.status, err.body));
    expect(factory.humanizeError(new Error('pedido incompleto'))).toBe('pedido incompleto');
    expect(factory.humanizeError('texto suelto')).toBe('texto suelto');
  });
});
