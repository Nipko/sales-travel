import { Logger } from '@nestjs/common';
import type * as TboHotels from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';

/**
 * El interruptor `TBO_ROOM_DETAILS` del detalle por habitación de HotelDetails (Q-65): el factory lo
 * lee al arrancar y se lo pasa al cliente de contenido de cada cuenta. El paquete del ACL no lee
 * `process.env`. Va en su propio archivo porque espía la construcción del cliente con `vi.mock`.
 */

const opciones = vi.hoisted(() => [] as unknown[]);

vi.mock('@sales-travel/tbo-hotels', async (importOriginal) => {
  const original = await importOriginal<typeof TboHotels>();
  class EspiaDeContenido extends original.TboStaticContentClient {
    constructor(...args: ConstructorParameters<typeof original.TboStaticContentClient>) {
      super(...args);
      opciones.push(args[3]);
    }
  }
  return { ...original, TboStaticContentClient: EspiaDeContenido };
});

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';

function boveda(): ProviderCredentialsService {
  const cuenta: ResolvedProviderAccount = {
    id: 'acc-consolidador',
    ownerTenantId: CONSOLIDADOR,
    providerCode: 'tbo-hotels',
    label: 'default',
    config: { environment: 'test' },
    credentials: { username: 'consolidador-demo', password: 'Pa55w0rd-tbo' },
    inherited: false,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
  return {
    resolve: vi.fn(() => Promise.resolve(cuenta)),
    ownerTenantType: vi.fn(() => Promise.resolve('consolidator')),
  } as unknown as ProviderCredentialsService;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  opciones.length = 0;
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function avisos(): string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

describe('TboHotelsProviderFactory — `TBO_ROOM_DETAILS`', () => {
  it.each([
    [undefined, 'on'],
    ['', 'on'],
    ['on', 'on'],
    ['OFF', 'off'],
    [' off ', 'off'],
  ] as const)('%j → `%s`, sin aviso, y llega al cliente de contenido', async (valor, esperado) => {
    if (valor === undefined) vi.stubEnv('TBO_ROOM_DETAILS', undefined);
    else vi.stubEnv('TBO_ROOM_DETAILS', valor);

    const factory = new TboHotelsProviderFactory(boveda());
    await factory.resolveForTenant(CONSOLIDADOR);

    expect(factory.roomDetails).toBe(esperado);
    expect(opciones).toEqual([{ roomDetails: esperado }]);
    expect(avisos().filter((aviso) => aviso.includes('TBO_ROOM_DETAILS'))).toEqual([]);
  });

  it('un valor que no es `on` ni `off` lo apaga y lo avisa UNA vez, sin repetir el valor', async () => {
    vi.stubEnv('TBO_ROOM_DETAILS', 'quizas-secreto');

    const factory = new TboHotelsProviderFactory(boveda());
    await factory.resolveForTenant(CONSOLIDADOR);

    expect(factory.roomDetails).toBe('off');
    expect(opciones).toEqual([{ roomDetails: 'off' }]);
    const sobreElInterruptor = avisos().filter((aviso) => aviso.includes('TBO_ROOM_DETAILS'));
    expect(sobreElInterruptor).toHaveLength(1);
    expect(sobreElInterruptor[0]).not.toContain('quizas-secreto');
  });
});
