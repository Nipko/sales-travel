import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { EnvHotelProviderFlags } from '../providers/hotel-providers.module.js';
import { EnvProviderFlags } from '../providers/providers.module.js';
import { PlatformProviderFlags } from './platform-provider-flags.js';
import type { EnablementSetting } from './provider-enablement.policy.js';
import {
  ENABLEMENT_CACHE_TTL_MS,
  ProviderEnablementStore,
  type EnablementSettingsSource,
} from './provider-enablement.store.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO = '22222222-2222-4222-8222-222222222222';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';

function fuente(settings: readonly EnablementSetting[]): EnablementSettingsSource & {
  settingsFor: ReturnType<typeof vi.fn>;
} {
  return { settingsFor: vi.fn(() => Promise.resolve(settings)) };
}

describe('PlatformProviderFlags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('un ajuste de la base decide, y la variable legado ni se consulta', async () => {
    vi.stubEnv('HOTEL_PROVIDERS_OPT_IN', 'tbo-hotels');
    const legacy = new EnvHotelProviderFlags();
    const legado = vi.spyOn(legacy, 'decisionFor');
    const flags = new PlatformProviderFlags(
      fuente([{ providerCode: 'tbo-hotels', tenantId: null, depth: 0, enabled: false }]),
      legacy,
    );

    expect(await flags.decisionFor(TENANT, 'tbo-hotels')).toEqual({
      enabled: false,
      origin: 'global',
    });
    expect(legado).not.toHaveBeenCalled();
  });

  it('el ajuste de un ancestro vale para la red, con el tenant que decidió', async () => {
    const flags = new PlatformProviderFlags(
      fuente([{ providerCode: 'tbo-hotels', tenantId: CONSOLIDADOR, depth: 1, enabled: true }]),
      new EnvHotelProviderFlags(),
    );

    expect(await flags.decisionFor(TENANT, 'tbo-hotels')).toEqual({
      enabled: true,
      origin: 'tenant',
      tenantId: CONSOLIDADOR,
    });
  });

  it('sin ajustes en la base, la variable legado sigue encendiendo (compatibilidad)', async () => {
    vi.stubEnv('HOTEL_PROVIDERS_OPT_IN', `tbo-hotels@${TENANT}`);
    const flags = new PlatformProviderFlags(fuente([]), new EnvHotelProviderFlags());

    expect(await flags.decisionFor(TENANT, 'tbo-hotels')).toEqual({
      enabled: true,
      origin: 'legacy-env',
    });
    expect(await flags.decisionFor(OTRO, 'tbo-hotels')).toBeUndefined();
  });

  it('los ajustes de OTRO proveedor no cuentan como ajuste de éste', async () => {
    vi.stubEnv('FLIGHT_PROVIDERS_OPT_IN', 'sabre');
    const flags = new PlatformProviderFlags(
      fuente([{ providerCode: 'latam-ndc', tenantId: null, depth: 0, enabled: false }]),
      new EnvProviderFlags(),
    );

    expect(await flags.decisionFor(TENANT, 'sabre')).toEqual({
      enabled: true,
      origin: 'legacy-env',
    });
  });

  it('sin ajustes ni variable, no opina: manda la política del proveedor', async () => {
    const flags = new PlatformProviderFlags(fuente([]), new EnvProviderFlags());
    expect(await flags.decisionFor(TENANT, 'sabre')).toBeUndefined();
  });
});

/** El almacén con la lectura de la cadena contada y a medida, sin base. */
class AlmacenContado extends ProviderEnablementStore {
  lecturas = 0;
  respuesta: () => Promise<EnablementSetting[]> = () => Promise.resolve([]);

  constructor() {
    super({} as DatabaseService);
  }

  protected override readChain(): Promise<EnablementSetting[]> {
    this.lecturas += 1;
    return this.respuesta();
  }
}

describe('ProviderEnablementStore: caché', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dentro del TTL no vuelve a la base: una búsqueda no paga una lectura por proveedor', async () => {
    const almacen = new AlmacenContado();

    await almacen.settingsFor(TENANT);
    await almacen.settingsFor(TENANT);
    vi.advanceTimersByTime(ENABLEMENT_CACHE_TTL_MS - 1);
    await almacen.settingsFor(TENANT);

    expect(almacen.lecturas).toBe(1);
  });

  it('la caché es POR TENANT', async () => {
    const almacen = new AlmacenContado();

    await almacen.settingsFor(TENANT);
    await almacen.settingsFor(OTRO);

    expect(almacen.lecturas).toBe(2);
  });

  it('vencido el TTL, relee: otra réplica ve el cambio a los pocos segundos', async () => {
    const almacen = new AlmacenContado();

    await almacen.settingsFor(TENANT);
    vi.advanceTimersByTime(ENABLEMENT_CACHE_TTL_MS);
    await almacen.settingsFor(TENANT);

    expect(almacen.lecturas).toBe(2);
  });

  it('escribir invalida: en esta réplica el cambio se ve al instante', async () => {
    const almacen = new AlmacenContado();
    await almacen.settingsFor(TENANT);

    const apagado: EnablementSetting = {
      providerCode: 'sabre',
      tenantId: null,
      depth: 0,
      enabled: false,
    };
    almacen.respuesta = () => Promise.resolve([apagado]);
    almacen.invalidate();

    expect(await almacen.settingsFor(TENANT)).toEqual([apagado]);
    expect(almacen.lecturas).toBe(2);
  });

  it('una lectura que empezó antes de un cambio no vuelve a llenar la caché con lo de antes', async () => {
    const almacen = new AlmacenContado();
    let soltar: (v: EnablementSetting[]) => void = () => undefined;
    almacen.respuesta = () =>
      new Promise((resolve) => {
        soltar = resolve;
      });

    const enVuelo = almacen.settingsFor(TENANT);
    almacen.invalidate();
    soltar([]);
    await enVuelo;

    almacen.respuesta = () => Promise.resolve([]);
    await almacen.settingsFor(TENANT);
    expect(almacen.lecturas).toBe(2);
  });

  it('si la base falla y hay una lectura previa, usa la previa: no enciende lo apagado', async () => {
    const almacen = new AlmacenContado();
    const apagado: EnablementSetting = {
      providerCode: 'sabre',
      tenantId: TENANT,
      depth: 2,
      enabled: false,
    };
    almacen.respuesta = () => Promise.resolve([apagado]);
    await almacen.settingsFor(TENANT);

    vi.advanceTimersByTime(ENABLEMENT_CACHE_TTL_MS);
    almacen.respuesta = () => Promise.reject(new Error('conexión perdida'));

    expect(await almacen.settingsFor(TENANT)).toEqual([apagado]);
  });

  it('si la base falla sin lectura previa, el error se propaga: no se adivina', async () => {
    const almacen = new AlmacenContado();
    almacen.respuesta = () => Promise.reject(new Error('conexión perdida'));

    await expect(almacen.settingsFor(TENANT)).rejects.toThrow('conexión perdida');
  });
});
