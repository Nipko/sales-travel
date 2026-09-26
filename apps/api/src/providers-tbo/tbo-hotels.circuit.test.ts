import { Logger, NotFoundException } from '@nestjs/common';
import { TboApiError, TboRequestBuildError, type TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TenantType } from '../database/database.types.js';
import { fakeHotelsDb } from '../hotels/__fixtures__/fake-hotels-db.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import type { HotelDetailInput } from '../hotels/hotels.schemas.js';
import { HotelsService } from '../hotels/hotels.service.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { ProviderNotAvailableError, type ProviderFlagsPort } from '../providers/provider.types.js';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { tboCircuitEffect } from './tbo-hotels-errors.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';
import { HotelSearchContextStore } from '../hotels/hotel-search-context.store.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';

/**
 * Toda llamada a TBO pasa por el breaker, con la huella de la cuenta y el efecto de sus errores
 * (08 RF-36 y RNF-03; docs/tbo/01 §12.3). Se prueba por la puerta del servicio de hoteles con el
 * registry, el factory y el ACL REALES; sólo el `fetch` y la bóveda son dobles.
 *
 * El camino es el detalle de un hotel (D-TBO-19 A): llega a TBO sin catálogo ni mapa de destinos
 * sembrados. La búsqueda por destino sale por el mismo circuito, con la misma cuenta, y se prueba
 * en `hotels/hotels.service.tbo-search.test.ts`.
 */

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const OTRO_CONSOLIDADOR = '44444444-4444-4444-8444-444444444444';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const AGENCIA_DEL_OTRO = '22222222-2222-4222-8222-222222222222';

const DUENO: Readonly<Record<string, string>> = {
  [CONSOLIDADOR]: CONSOLIDADOR,
  [AGENCIA]: CONSOLIDADOR,
  [OTRO_CONSOLIDADOR]: OTRO_CONSOLIDADOR,
  [AGENCIA_DEL_OTRO]: OTRO_CONSOLIDADOR,
};

const TIPOS: Readonly<Record<string, TenantType>> = {
  [CONSOLIDADOR]: 'consolidator',
  [OTRO_CONSOLIDADOR]: 'consolidator',
};

/** Cada consolidador con su cuenta TBO de test, heredada por su agencia. */
function boveda(consultas: string[] = []): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    consultas.push(tenantId);
    const owner = DUENO[tenantId];
    if (owner === undefined) return Promise.reject(new NotFoundException('sin cuenta'));
    return Promise.resolve({
      id: `acc-${owner}`,
      ownerTenantId: owner,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'usuario-compartido', password: 'Pa55w0rd' },
      inherited: owner !== tenantId,
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
  };
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(TIPOS[id]);
  return { resolve, ownerTenantType } as unknown as ProviderCredentialsService;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SIN_DISPONIBILIDAD = (): Response =>
  json(200, { Status: { Code: 201, Description: 'No Available rooms' } });

interface Banco {
  service: HotelsService;
  breaker: CircuitBreakerService;
  fetch: Mock<TboFetch>;
  /** Tenants por los que se le preguntó a la bóveda. */
  consultas: string[];
}

function banco(
  responder: () => Response = SIN_DISPONIBILIDAD,
  flags: ProviderFlagsPort = hotelFlags(true),
): Banco {
  const fetch = vi.fn<TboFetch>(() => Promise.resolve(responder()));
  const consultas: string[] = [];
  const breaker = new CircuitBreakerService();
  const service = new HotelsService(
    hotelRegistry([new TboHotelsProviderFactory(boveda(consultas), fetch)], flags),
    fakeHotelsDb().service,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    {} as unknown as SearchTelemetryService,
    breaker,
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  return { service, breaker, fetch, consultas };
}

const DETALLE: HotelDetailInput = {
  provider: 'tbo-hotels',
  hotelId: '1120548',
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  guestNationality: 'CO',
};

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.stubEnv('PROVIDERS_DISABLED', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('TBO pasa por el breaker con la huella de su cuenta', () => {
  it('el detalle de un hotel TBO sale por el circuito, con `accountRef` y el efecto de TBO', async () => {
    const b = banco();
    const execute = vi.spyOn(b.breaker, 'execute');

    const oferta = await b.service.getHotelDetail(AGENCIA, DETALLE);

    expect(oferta).toEqual({ hotelId: DETALLE.hotelId, roompacks: [] });
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const [codigo, , opciones] = execute.mock.calls[0] ?? [];
    expect(codigo).toBe('tbo-hotels');
    expect(opciones?.accountRef).toMatch(/^[0-9a-f]{16}$/);
    expect(opciones?.effectOf).toBe(tboCircuitEffect);
  });

  it('un `401` suspende SÓLO esa cuenta: su red deja de salir, la de otro consolidador no', async () => {
    const b = banco(() => new Response('', { status: 401 }));

    await expect(b.service.getHotelDetail(AGENCIA, DETALLE)).rejects.toBeInstanceOf(TboApiError);
    expect(b.fetch).toHaveBeenCalledTimes(1);

    // La misma cuenta, desde otro nodo de la misma red: no sale.
    const suspendida = await b.service
      .getHotelDetail(CONSOLIDADOR, DETALLE)
      .catch((e: unknown) => e);
    expect(suspendida).toBeInstanceOf(BreakerRejectionError);
    expect((suspendida as BreakerRejectionError).reason).toBe('account-circuit');
    expect(b.fetch).toHaveBeenCalledTimes(1);

    // Otra cuenta, con el MISMO usuario de TBO: sale igual.
    await expect(b.service.getHotelDetail(AGENCIA_DEL_OTRO, DETALLE)).rejects.toBeInstanceOf(
      TboApiError,
    );
    expect(b.fetch).toHaveBeenCalledTimes(2);

    // El circuito del proveedor no se enteró, y el público no nombra cuentas.
    expect(b.breaker.snapshot()).toEqual({ 'tbo-hotels': { state: 'closed', failures: 0 } });
  });

  /*
   * MUTACIÓN: sin el `effectOf` que declara el factory, cada rechazo local cuenta como caída y la
   * sexta llamada ya no llega al ACL: el breaker la corta con el circuito abierto para toda la red.
   */
  it('cinco búsquedas que TBO no admite (sin nacionalidad) no abren el circuito del proveedor', async () => {
    const b = banco();
    const sinNacionalidad: HotelDetailInput = { ...DETALLE, guestNationality: undefined };

    for (let i = 0; i < 6; i++) {
      await expect(b.service.getHotelDetail(AGENCIA, sinNacionalidad)).rejects.toBeInstanceOf(
        TboRequestBuildError,
      );
    }

    expect(b.fetch).not.toHaveBeenCalled();
    expect(b.breaker.snapshot()['tbo-hotels']).toEqual({ state: 'closed', failures: 0 });
  });

  /*
   * MUTACIÓN: con `byCode` en lugar de `byCodeForSale` en el servicio, el detalle sale a TBO con la
   * cuenta heredada aunque el tenant no tenga el flag, y este caso se pone en rojo.
   */
  it('sin el flag de `opt-in`, nombrar a TBO en el detalle no lo enciende: ni bóveda ni cable (D-TBO-18 A)', async () => {
    const b = banco(
      SIN_DISPONIBILIDAD,
      hotelFlags((tenantId) => tenantId === CONSOLIDADOR),
    );

    const err = await b.service.getHotelDetail(AGENCIA, DETALLE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderNotAvailableError);
    expect(b.consultas).toEqual([]);
    expect(b.fetch).not.toHaveBeenCalled();

    // El consolidador, con el flag, sí llega: la puerta es por tenant, no por cuenta.
    await expect(b.service.getHotelDetail(CONSOLIDADOR, DETALLE)).resolves.toEqual({
      hotelId: DETALLE.hotelId,
      roompacks: [],
    });
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('`tbo-hotels:ventas` frena el detalle antes del cable', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'tbo-hotels:ventas');
    const b = banco();

    const err = await b.service.getHotelDetail(AGENCIA, DETALLE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BreakerRejectionError);
    expect((err as BreakerRejectionError).reason).toBe('kill-switch');
    expect(b.fetch).not.toHaveBeenCalled();
  });
});
