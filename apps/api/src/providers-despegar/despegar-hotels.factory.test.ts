import { Logger, NotFoundException } from '@nestjs/common';
import { DespegarApiError, DespegarHotelsAdapter } from '@sales-travel/despegar-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { humanizeDespegarError } from '../hotels/despegar-hotels-errors.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type { HotelProviderFactory } from '../providers/hotel-provider.types.js';
import { ProviderAccountIncompleteError } from '../providers/provider.types.js';
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

/** Las entradas del caché: dicen si se construyó algún adapter. */
function cacheDe(factory: DespegarHotelsProviderFactory): Map<string, unknown> {
  return (factory as unknown as { cache: Map<string, unknown> }).cache;
}

const PLATAFORMA_KEY = 'plataforma-key';

beforeEach(() => {
  // Nada del entorno de quien corre los tests: cada caso dice si la plataforma tiene clave.
  vi.stubEnv('DESPEGAR_API_KEY', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
    vi.stubEnv('DESPEGAR_API_KEY', PLATAFORMA_KEY);
    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    const a = await factory.forTenant('t1');
    const b = await factory.forTenant('t2');
    expect(a).toBe(b);
  });

  it('usa adapters distintos para BYOC vs fallback env', async () => {
    vi.stubEnv('DESPEGAR_API_KEY', PLATAFORMA_KEY);
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
    vi.stubEnv('DESPEGAR_API_KEY', PLATAFORMA_KEY);
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
    expect(cacheDe(factory).size).toBe(1);
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

/**
 * Producción, 2026-09-29: sin `DESPEGAR_API_KEY` ni cuentas en la bóveda, Despegar seguía activo con
 * una clave vacía y cada sugerencia y cada búsqueda salían a cobrar un 401. Sin clave, ahora queda
 * AUSENTE antes de construir nada o de tocar la red; con clave, todo sigue como antes.
 */
describe('DespegarHotelsProviderFactory — puerta de credenciales', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  function sinCuenta(): DespegarHotelsProviderFactory {
    return factoryWith(() => Promise.reject(new NotFoundException('sin cuenta')));
  }

  /** Un `fetch` global que responde vacío y deja ver con qué clave salió cada llamada. */
  function redEspiada(): MockInstance<typeof fetch> {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('{"items":[]}', { status: 200 })));
  }

  function claveDe(red: MockInstance<typeof fetch>, llamada = 0): unknown {
    const init = red.mock.calls[llamada]?.[1];
    return (init?.headers as Record<string, string> | undefined)?.['x-apikey'];
  }

  it('sin cuenta y sin DESPEGAR_API_KEY: ausente como "sin cuenta", sin construir adapter ni salir a la red', async () => {
    const red = redEspiada();
    const factory = sinCuenta();

    const err = await factory.resolveForTenant('t1').catch((e: unknown) => e);

    // `NotFoundException` a secas: el registry la traduce a `no-credentials`. No hay cuenta que
    // completar, así que NO puede ser la de cuenta incompleta.
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ProviderAccountIncompleteError);
    await expect(factory.forTenant('t1')).rejects.toBeInstanceOf(NotFoundException);
    expect(cacheDe(factory).size).toBe(0);
    expect(red).not.toHaveBeenCalled();
  });

  it('una DESPEGAR_API_KEY de sólo espacios cuenta como ausente', async () => {
    vi.stubEnv('DESPEGAR_API_KEY', '   \t ');
    const factory = sinCuenta();

    await expect(factory.resolveForTenant('t1')).rejects.toBeInstanceOf(NotFoundException);
    expect(cacheDe(factory).size).toBe(0);
  });

  it('la falta de clave de la plataforma se avisa UNA vez por proceso, no en cada búsqueda', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const factory = sinCuenta();

    await factory.resolveForTenant('t1').catch(() => undefined);
    await factory.resolveForTenant('t2').catch(() => undefined);
    await factory.forTenant('t1').catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('DESPEGAR_API_KEY vacía');
  });

  it('con DESPEGAR_API_KEY, sin cuenta: activo por el escalón de plataforma, con esa clave', async () => {
    vi.stubEnv('DESPEGAR_API_KEY', PLATAFORMA_KEY);
    const red = redEspiada();
    const factory = sinCuenta();

    const r = await factory.resolveForTenant('t1');
    await (await factory.forTenant('t1')).suggest('bogo');

    expect(r.credentialSource).toBe('env');
    expect(r.adapter).toBeInstanceOf(DespegarHotelProviderAdapter);
    expect(claveDe(red)).toBe(PLATAFORMA_KEY);
  });

  it('con la clave de la cuenta en la bóveda: activo aunque la plataforma no tenga, con la de la cuenta', async () => {
    const red = redEspiada();
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: { apiKey: 'clave-de-la-agencia' } })),
    );

    const r = await factory.resolveForTenant('t1');
    await (await factory.forTenant('t1')).suggest('bogo');

    expect(r.credentialSource).toBe('own');
    expect(claveDe(red)).toBe('clave-de-la-agencia');
  });

  it('la clave se lee también como `apikey` y sale recortada', async () => {
    const red = redEspiada();
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: { apikey: '  clave-heredada  ' }, inherited: true })),
    );

    const r = await factory.resolveForTenant('t1');
    await (await factory.forTenant('t1')).suggest('bogo');

    expect(r.credentialSource).toBe('inherited');
    expect(claveDe(red)).toBe('clave-heredada');
  });

  it('una cuenta sin clave toma la de la plataforma, como antes, y sigue saliendo como suya', async () => {
    vi.stubEnv('DESPEGAR_API_KEY', PLATAFORMA_KEY);
    const red = redEspiada();
    const factory = factoryWith(() => Promise.resolve(resolved({ credentials: { apiKey: ' ' } })));

    const r = await factory.resolveForTenant('t1');
    await (await factory.forTenant('t1')).suggest('bogo');

    expect(r.credentialSource).toBe('own');
    expect(claveDe(red)).toBe(PLATAFORMA_KEY);
  });

  it('una cuenta sin clave y sin clave de plataforma: cuenta incompleta que nombra el campo, sin valores', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const red = redEspiada();
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: { apiKey: '', secreto: 'no-se-loguea' } })),
    );

    const err = await factory.resolveForTenant('t1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderAccountIncompleteError);
    expect((err as ProviderAccountIncompleteError).missingFields).toEqual(['apiKey']);
    await expect(factory.forTenant('t1')).rejects.toBeInstanceOf(ProviderAccountIncompleteError);
    expect(cacheDe(factory).size).toBe(0);
    expect(red).not.toHaveBeenCalled();
    // Por tenant y cada vez: es una cuenta que ALGUIEN tiene que completar.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('no-se-loguea');
  });
});
