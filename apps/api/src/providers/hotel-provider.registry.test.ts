import { Logger, NotFoundException } from '@nestjs/common';
import { HotelOfferSchema } from '@sales-travel/canonical';
import type {
  HotelBookingByClientReferencePort,
  HotelBookingsByDatePort,
  HotelPaymentOptionsPort,
  HotelPriceJumpRecoveryPort,
  HotelRatesDetailPort,
  HotelSuggestPort,
} from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { DespegarHotelsProviderFactory } from '../providers-despegar/despegar-hotels.factory.js';
import { HotelProviderRegistry } from './hotel-provider.registry.js';
import {
  supportsHotelBookingByClientReference,
  supportsHotelBookingsByDate,
  supportsHotelPaymentOptions,
  supportsHotelPriceJumpRecovery,
  supportsHotelRatesDetail,
  supportsHotelSuggest,
  type HotelProviderFactory,
} from './hotel-provider.types.js';
import { EnvHotelProviderFlags } from './hotel-providers.module.js';
import {
  ProviderAccountIncompleteError,
  ProviderAccountNotAllowedError,
  ProviderNotAvailableError,
  type ProviderFlagsPort,
} from './provider.types.js';
import {
  StubHotelProviderFactory,
  stubHotelOffer,
} from './__fixtures__/stub-hotel-provider.factory.js';

/**
 * El registry es el punto donde la vertical de hoteles deja de tener "el proveedor" y pasa a
 * tener proveedores. Los casos genéricos usan un proveedor ANÓNIMO; Despegar entra sólo donde lo
 * que se prueba es suyo: el fallback a la cuenta de la plataforma.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';

const CRITERIO = {
  hotelIds: ['H-1'],
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  currency: 'USD',
};

function flags(enabled: boolean | ((tenantId: string, code: string) => boolean)): {
  port: ProviderFlagsPort;
  isEnabledForTenant: ReturnType<typeof vi.fn>;
} {
  const isEnabledForTenant = vi.fn((tenantId: string, code: string) =>
    Promise.resolve(typeof enabled === 'function' ? enabled(tenantId, code) : enabled),
  );
  return { port: { isEnabledForTenant }, isEnabledForTenant };
}

function registry(
  factories: HotelProviderFactory[],
  port: ProviderFlagsPort = flags(false).port,
): HotelProviderRegistry {
  return new HotelProviderRegistry(factories, port);
}

/** El factory REAL de Despegar con una bóveda que nunca resuelve: sólo queda el escalón `env`. */
function despegarSinCuenta(): DespegarHotelsProviderFactory {
  const resolve = (): Promise<ResolvedProviderAccount> =>
    Promise.reject(new NotFoundException('sin cuenta'));
  return new DespegarHotelsProviderFactory({ resolve } as unknown as ProviderCredentialsService);
}

describe('HotelProviderRegistry', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('orden estable', () => {
    it('ordena por code alfabéticamente, no por orden de inyección', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'zeta-hotels' }),
        new StubHotelProviderFactory({ code: 'alfa-hotels' }),
        new StubHotelProviderFactory({ code: 'mika-hotels' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.code)).toEqual(['alfa-hotels', 'mika-hotels', 'zeta-hotels']);
    });

    it('`codesForTenant` devuelve el mismo orden que `forTenant`', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'zeta-hotels' }),
        new StubHotelProviderFactory({ code: 'alfa-hotels' }),
      ]);

      expect(await r.codesForTenant(TENANT)).toEqual(['alfa-hotels', 'zeta-hotels']);
    });

    it('dos factories con el mismo code tumban el arranque, no se pisan en silencio', () => {
      expect(() =>
        registry([
          new StubHotelProviderFactory({ code: 'alfa-hotels' }),
          new StubHotelProviderFactory({ code: 'alfa-hotels' }),
        ]),
      ).toThrow(/duplicado/);
    });

    it('un factory de otra vertical en la lista de hoteles tumba el arranque', () => {
      const deVuelos = Object.assign(new StubHotelProviderFactory({ code: 'alfa-air' }), {
        vertical: 'flights',
      }) as unknown as HotelProviderFactory;

      expect(() => registry([deVuelos])).toThrow(/no es un proveedor de hoteles/);
    });
  });

  describe('callPolicy', () => {
    it("'opt-in' con el flag apagado NO recibe ninguna llamada y sale como skipped", async () => {
      const stub = new StubHotelProviderFactory({ code: 'alfa-hotels', callPolicy: 'opt-in' });
      const r = registry([stub], flags(false).port);

      const { active, skipped, unavailable } = await r.forTenant(TENANT);

      expect(active).toEqual([]);
      expect(unavailable).toEqual([]);
      expect(skipped).toEqual([{ code: 'alfa-hotels', reason: 'opt-in-disabled' }]);
      // Ni a la bóveda de credenciales ni al proveedor: el flag se mira ANTES de resolver.
      expect(stub.resolveCalls).toEqual([]);
      expect(stub.adapterFor(TENANT).searchAvailability).not.toHaveBeenCalled();
    });

    it("'opt-in' con el flag encendido entra como uno más", async () => {
      const stub = new StubHotelProviderFactory({ code: 'alfa-hotels', callPolicy: 'opt-in' });
      const { port, isEnabledForTenant } = flags(true);
      const r = registry([stub], port);

      const { active, skipped } = await r.forTenant(TENANT);

      expect(active.map((p) => [p.code, p.callPolicy])).toEqual([['alfa-hotels', 'opt-in']]);
      expect(skipped).toEqual([]);
      expect(isEnabledForTenant).toHaveBeenCalledWith(TENANT, 'alfa-hotels');
    });

    it('el flag es POR TENANT: activo para uno no es activo para el otro', async () => {
      const stub = new StubHotelProviderFactory({ code: 'alfa-hotels', callPolicy: 'opt-in' });
      const r = registry([stub], flags((tenantId) => tenantId === TENANT).port);

      expect((await r.forTenant(TENANT)).active).toHaveLength(1);
      expect((await r.forTenant(OTRO_TENANT)).active).toHaveLength(0);
    });

    it('la política que declara la cuenta gana al default del proveedor', async () => {
      const r = registry([
        new StubHotelProviderFactory({
          code: 'alfa-hotels',
          callPolicy: 'always',
          accountCallPolicy: 'fallback',
        }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active[0]?.callPolicy).toBe('fallback');
    });

    it('la variable de entorno pisa la política declarada por el proveedor y por la cuenta', async () => {
      vi.stubEnv('HOTEL_PROVIDER_CALL_POLICIES', 'alfa-hotels:opt-in');
      const stub = new StubHotelProviderFactory({
        code: 'alfa-hotels',
        callPolicy: 'always',
        accountCallPolicy: 'always',
      });
      const r = registry([stub], flags(false).port);

      // Es el pomo con el que se apaga un proveedor caro sin tocar código.
      const { active, skipped } = await r.forTenant(TENANT);
      expect(active).toEqual([]);
      expect(skipped[0]?.reason).toBe('opt-in-disabled');
    });

    it('una cuenta que declara `always` no desarma el override de entorno a `fallback`', async () => {
      // Con 'opt-in' el caso anterior corta antes de resolver la cuenta; aquí sí se resuelve, y
      // lo que llega al fan-out tiene que ser el kill-switch, no lo que pidió la cuenta.
      vi.stubEnv('HOTEL_PROVIDER_CALL_POLICIES', 'alfa-hotels:fallback');
      const r = registry([
        new StubHotelProviderFactory({
          code: 'alfa-hotels',
          callPolicy: 'always',
          accountCallPolicy: 'always',
        }),
      ]);

      expect((await r.forTenant(TENANT)).active.map((p) => p.callPolicy)).toEqual(['fallback']);
      expect((await r.byCode(TENANT, 'alfa-hotels')).callPolicy).toBe('fallback');
    });

    it('la política de VUELOS no gobierna hoteles aunque el code coincida', async () => {
      vi.stubEnv('FLIGHT_PROVIDER_CALL_POLICIES', 'alfa-hotels:opt-in');
      const r = registry([new StubHotelProviderFactory({ code: 'alfa-hotels' })]);

      expect((await r.forTenant(TENANT)).active.map((p) => p.callPolicy)).toEqual(['always']);
    });

    it('una política mal escrita en el entorno tumba el arranque', () => {
      vi.stubEnv('HOTEL_PROVIDER_CALL_POLICIES', 'alfa-hotels:siempre');
      expect(() => registry([new StubHotelProviderFactory({ code: 'alfa-hotels' })])).toThrow();
    });
  });

  describe('habilitación por credenciales', () => {
    it('credenciales propias o heredadas habilitan al proveedor', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels', credentialSource: 'own' }),
        new StubHotelProviderFactory({ code: 'beta-hotels', credentialSource: 'inherited' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.credentialSource)).toEqual(['own', 'inherited']);
    });

    it('un proveedor sin cuenta y fuera de PLATFORM_DEFAULT_HOTEL_PROVIDERS queda ausente', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels', credentialSource: 'env' }),
      ]);

      // Si esto pasara, un tenant sin cuenta saldría al proveedor con la de la plataforma:
      // consultas y reservas facturadas a quien no las pidió.
      const { active, unavailable } = await r.forTenant(TENANT);
      expect(active).toEqual([]);
      expect(unavailable.map((u) => [u.code, u.reason])).toEqual([
        ['alfa-hotels', 'no-credentials'],
      ]);
    });

    it('Despegar conserva el fallback de plataforma SÓLO porque figura en la lista por defecto', async () => {
      const r = registry([despegarSinCuenta()]);

      const { active, unavailable } = await r.forTenant(TENANT);
      expect(active.map((p) => [p.code, p.credentialSource])).toEqual([['despegar-hotels', 'env']]);
      expect(unavailable).toEqual([]);
    });

    it('sacar a Despegar de la lista le quita el fallback: queda ausente con motivo', async () => {
      vi.stubEnv('PLATFORM_DEFAULT_HOTEL_PROVIDERS', '');
      const r = registry([despegarSinCuenta()]);

      const { active, unavailable } = await r.forTenant(TENANT);
      expect(active).toEqual([]);
      expect(unavailable.map((u) => [u.code, u.reason])).toEqual([
        ['despegar-hotels', 'no-credentials'],
      ]);
    });

    it('el fallback se habilita proveedor por proveedor y nunca por la lista de vuelos', async () => {
      vi.stubEnv('PLATFORM_DEFAULT_HOTEL_PROVIDERS', 'alfa-hotels');
      vi.stubEnv('PLATFORM_DEFAULT_FLIGHT_PROVIDERS', 'beta-hotels');
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels', credentialSource: 'env' }),
        new StubHotelProviderFactory({ code: 'beta-hotels', credentialSource: 'env' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.code)).toEqual(['alfa-hotels']);
    });

    it('un tenant sin cuenta resoluble no habilita el proveedor, pero no rompe la búsqueda', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels' }),
        new StubHotelProviderFactory({ code: 'beta-hotels', failResolve: true }),
      ]);

      const { active, unavailable } = await r.forTenant(TENANT);
      expect(active.map((p) => p.code)).toEqual(['alfa-hotels']);
      expect(unavailable.map((u) => u.code)).toEqual(['beta-hotels']);
      expect(unavailable[0]?.detail).toContain('Credenciales');
    });

    it('una cuenta INCOMPLETA se distingue de una cuenta ausente y nombra el campo', async () => {
      const r = registry([
        new StubHotelProviderFactory({
          code: 'alfa-hotels',
          failResolveWith: new ProviderAccountIncompleteError('alfa-hotels', ['password']),
        }),
      ]);

      const { active, unavailable } = await r.forTenant(TENANT);

      expect(active).toEqual([]);
      expect(unavailable[0]?.reason).toBe('incomplete-account');
      expect(unavailable[0]?.detail).toContain('password');
    });

    it('una cuenta que el proveedor NO admite queda ausente con la acción que él mismo dice', async () => {
      const detalle = 'Este proveedor sólo opera con la cuenta del consolidador.';
      const r = registry([
        new StubHotelProviderFactory({
          code: 'alfa-hotels',
          failResolveWith: new ProviderAccountNotAllowedError('alfa-hotels', detalle),
        }),
      ]);

      const { active, unavailable } = await r.forTenant(TENANT);

      expect(active).toEqual([]);
      expect(unavailable).toEqual([
        { code: 'alfa-hotels', reason: 'no-credentials', detail: detalle },
      ]);
      await expect(r.byCode(TENANT, 'alfa-hotels')).rejects.toBeInstanceOf(
        ProviderNotAvailableError,
      );
    });

    it('lo que el factory declara para el breaker viaja con el proveedor resuelto', async () => {
      const circuit = { accountRef: 'acct-1', effectOf: () => 'IGNORE' as const };
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels', circuit }),
        new StubHotelProviderFactory({ code: 'beta-hotels' }),
      ]);

      const { active } = await r.forTenant(TENANT);

      expect(active.find((p) => p.code === 'alfa-hotels')?.circuit).toBe(circuit);
      expect(active.find((p) => p.code === 'beta-hotels')).not.toHaveProperty('circuit');
    });

    it('el dueño de la cuenta viaja con el proveedor resuelto; sin dueño, no aparece (RF-23)', async () => {
      const DUENO = '99999999-9999-4999-8999-999999999999';
      const r = registry([
        new StubHotelProviderFactory({
          code: 'alfa-hotels',
          credentialSource: 'inherited',
          accountOwnerTenantId: DUENO,
        }),
        new StubHotelProviderFactory({ code: 'beta-hotels' }),
      ]);

      const { active } = await r.forTenant(TENANT);

      expect(active.find((p) => p.code === 'alfa-hotels')).toMatchObject({
        credentialSource: 'inherited',
        accountOwnerTenantId: DUENO,
      });
      expect(active.find((p) => p.code === 'beta-hotels')).not.toHaveProperty(
        'accountOwnerTenantId',
      );
      await expect(r.byCode(TENANT, 'alfa-hotels')).resolves.toMatchObject({
        accountOwnerTenantId: DUENO,
      });
    });

    it('un fallo REAL de la bóveda se propaga: no se degrada en silencio', async () => {
      const r = registry([
        new StubHotelProviderFactory({
          code: 'alfa-hotels',
          failResolveWith: new Error('bóveda caída'),
        }),
      ]);

      await expect(r.forTenant(TENANT)).rejects.toThrow('bóveda caída');
    });
  });

  describe('byCode', () => {
    it('devuelve el proveedor pedido con sus capacidades de hotel', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels' }),
        new StubHotelProviderFactory({
          code: 'beta-hotels',
          capabilities: { retrieveByClientReference: false },
        }),
      ]);

      const beta = await r.byCode(TENANT, 'beta-hotels');
      expect(beta.code).toBe('beta-hotels');
      expect(beta.capabilities.retrieveByClientReference).toBe(false);
      expect(beta.capabilities.cancel).toBe(true);
    });

    it('un proveedor desconocido es 400 con mensaje, no un 500 opaco', async () => {
      const r = registry([new StubHotelProviderFactory({ code: 'alfa-hotels' })]);

      await expect(r.byCode(TENANT, 'no-existe')).rejects.toBeInstanceOf(ProviderNotAvailableError);
    });

    it('un proveedor sin credenciales para este tenant también es 400', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels', failResolve: true }),
      ]);

      await expect(r.byCode(TENANT, 'alfa-hotels')).rejects.toBeInstanceOf(
        ProviderNotAvailableError,
      );
    });

    it('NO consulta el flag de opt-in: una reserva ya hecha se puede seguir operando', async () => {
      const stub = new StubHotelProviderFactory({ code: 'alfa-hotels', callPolicy: 'opt-in' });
      const { port, isEnabledForTenant } = flags(false);
      const r = registry([stub], port);

      await expect(r.byCode(TENANT, 'alfa-hotels')).resolves.toMatchObject({
        code: 'alfa-hotels',
      });
      expect(isEnabledForTenant).not.toHaveBeenCalled();
    });

    it('entrega el adapter del proveedor pedido y no el de otro', async () => {
      const alfa = new StubHotelProviderFactory({ code: 'alfa-hotels' });
      const beta = new StubHotelProviderFactory({ code: 'beta-hotels' });
      const r = registry([alfa, beta]);

      const elegido = await r.byCode(TENANT, 'beta-hotels');
      await elegido.adapter.searchAvailability(CRITERIO, { tenantId: TENANT });

      expect(beta.adapterFor(TENANT).searchAvailability).toHaveBeenCalledTimes(1);
      expect(alfa.adapterFor(TENANT).searchAvailability).not.toHaveBeenCalled();
    });
  });

  describe('byCodeForSale', () => {
    it("'opt-in' con el flag apagado es 400 sin tocar la bóveda: nombrarlo no lo enciende", async () => {
      const stub = new StubHotelProviderFactory({ code: 'alfa-hotels', callPolicy: 'opt-in' });
      const { port, isEnabledForTenant } = flags(false);
      const r = registry([stub], port);

      await expect(r.byCodeForSale(TENANT, 'alfa-hotels')).rejects.toBeInstanceOf(
        ProviderNotAvailableError,
      );
      expect(isEnabledForTenant).toHaveBeenCalledWith(TENANT, 'alfa-hotels');
      expect(stub.resolveCalls).toEqual([]);
    });

    it("'opt-in' con el flag encendido para ESE tenant se resuelve como en `byCode`", async () => {
      const stub = new StubHotelProviderFactory({ code: 'alfa-hotels', callPolicy: 'opt-in' });
      const r = registry([stub], flags((tenantId) => tenantId === TENANT).port);

      await expect(r.byCodeForSale(TENANT, 'alfa-hotels')).resolves.toMatchObject({
        code: 'alfa-hotels',
      });
      await expect(r.byCodeForSale(OTRO_TENANT, 'alfa-hotels')).rejects.toBeInstanceOf(
        ProviderNotAvailableError,
      );
    });

    it('lo que no es `opt-in` no mira el flag, y el desconocido sigue siendo 400', async () => {
      const { port, isEnabledForTenant } = flags(false);
      const r = registry([new StubHotelProviderFactory({ code: 'alfa-hotels' })], port);

      await expect(r.byCodeForSale(TENANT, 'alfa-hotels')).resolves.toMatchObject({
        code: 'alfa-hotels',
      });
      await expect(r.byCodeForSale(TENANT, 'no-existe')).rejects.toBeInstanceOf(
        ProviderNotAvailableError,
      );
      expect(isEnabledForTenant).not.toHaveBeenCalled();
    });
  });

  describe('de dónde es cada tarifa (RF-40)', () => {
    it('cada proveedor activo atribuye sus tarifas con su propio code', async () => {
      const r = registry([
        new StubHotelProviderFactory({ code: 'alfa-hotels' }),
        new StubHotelProviderFactory({ code: 'beta-hotels' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      const porProveedor = await Promise.all(
        active.map(async (p) => ({
          code: p.code,
          hoteles: await p.adapter.searchAvailability(CRITERIO, { tenantId: TENANT }),
        })),
      );

      for (const { code, hoteles } of porProveedor) {
        for (const hotel of hoteles) {
          expect(HotelOfferSchema.safeParse(hotel).success).toBe(true);
          for (const pack of hotel.roompacks) expect(pack.provider.name).toBe(code);
        }
      }
    });

    it('la oferta del doble cumple el contrato neutral, también en otra moneda', () => {
      expect(HotelOfferSchema.safeParse(stubHotelOffer('alfa-hotels')).success).toBe(true);
      expect(
        HotelOfferSchema.safeParse(stubHotelOffer('alfa-hotels', { currency: 'COP' })).success,
      ).toBe(true);
    });
  });

  describe('metadatos', () => {
    it('`capabilitiesOf` no toca credenciales y distingue al desconocido', () => {
      const stub = new StubHotelProviderFactory({
        code: 'alfa-hotels',
        capabilities: { reconcileByDate: false },
      });
      const r = registry([stub]);

      expect(r.capabilitiesOf('alfa-hotels')?.reconcileByDate).toBe(false);
      expect(r.capabilitiesOf('alfa-hotels')?.retrieve).toBe(true);
      expect(r.capabilitiesOf('latam-ndc')).toBeUndefined();
      expect(stub.resolveCalls).toEqual([]);
    });

    it('`humanizeError` delega en el proveedor y tiene salida para el desconocido', () => {
      const r = registry([new StubHotelProviderFactory({ code: 'alfa-hotels' })]);

      expect(r.humanizeError('alfa-hotels', new Error('boom'))).toBe('[alfa-hotels] boom');
      expect(r.humanizeError('no-existe', new Error('boom'))).toBe('boom');
      expect(r.humanizeError('no-existe', 'texto suelto')).toBe('texto suelto');
    });

    it('`registered` lista todos los proveedores con su perfil de búsqueda, sin tocar credenciales', () => {
      const zeta = new StubHotelProviderFactory({
        code: 'zeta-hotels',
        callPolicy: 'opt-in',
        searchProfile: { idSpace: 'provider', maxHotelsPerSearch: 100 },
      });
      const alfa = new StubHotelProviderFactory({ code: 'alfa-hotels', failResolve: true });
      const r = registry([zeta, alfa]);

      // Incluye al `opt-in` apagado y al que no tiene cuenta: es la lista de la plataforma.
      expect(r.registered()).toEqual([
        { code: 'alfa-hotels', searchProfile: alfa.searchProfile },
        {
          code: 'zeta-hotels',
          searchProfile: { idSpace: 'provider', maxHotelsPerSearch: 100, catalogOrder: 'hotel_id' },
        },
      ]);
      expect([...zeta.resolveCalls, ...alfa.resolveCalls]).toEqual([]);
    });

    it('cada proveedor resuelto lleva el perfil de búsqueda que declara su factory', async () => {
      const stub = new StubHotelProviderFactory({
        code: 'alfa-hotels',
        searchProfile: { maxHotelsPerSearch: 20, occupancy: { maxChildrenPerRoom: 4 } },
      });
      const r = registry([stub]);

      const { active } = await r.forTenant(TENANT);
      expect(active[0]?.searchProfile).toEqual({
        idSpace: 'platform',
        maxHotelsPerSearch: 20,
        catalogOrder: 'hotel_id',
        occupancy: { maxChildrenPerRoom: 4 },
      });
      expect((await r.byCode(TENANT, 'alfa-hotels')).searchProfile).toBe(stub.searchProfile);
    });
  });
});

/**
 * Despegar declara en `false` la lectura por nuestra referencia y la conciliación por fecha, así
 * que su test sólo ve esas guardas devolviendo `false`: una guarda rota también lo haría. Aquí se
 * prueba cada una en los dos sentidos con un adapter que tiene el método.
 */
describe('capacidades opcionales por presencia del método', () => {
  const casos: [string, (adapter: object) => boolean, string][] = [
    ['sugerencias', supportsHotelSuggest, 'suggestDestinations' satisfies keyof HotelSuggestPort],
    [
      'tarifas de un hotel',
      supportsHotelRatesDetail,
      'getHotelRates' satisfies keyof HotelRatesDetailPort,
    ],
    [
      'medios de pago',
      supportsHotelPaymentOptions,
      'getPaymentOptions' satisfies keyof HotelPaymentOptionsPort,
    ],
    [
      'salto de precio',
      supportsHotelPriceJumpRecovery,
      'confirmPriceJump' satisfies keyof HotelPriceJumpRecoveryPort,
    ],
    [
      'lectura por nuestra referencia',
      supportsHotelBookingByClientReference,
      'getBookingByClientReference' satisfies keyof HotelBookingByClientReferencePort,
    ],
    [
      'reservas por fecha',
      supportsHotelBookingsByDate,
      'listBookingsByDate' satisfies keyof HotelBookingsByDatePort,
    ],
  ];

  it.each(casos)('%s: se detecta sólo si el método existe y es función', (_c, guarda, metodo) => {
    expect(guarda({ [metodo]: () => Promise.resolve() })).toBe(true);
    expect(guarda({})).toBe(false);
    expect(guarda({ [metodo]: 'no es un método' })).toBe(false);
  });

  it('una guarda no confunde el método de otra capacidad con el suyo', () => {
    const soloReferencia = { getBookingByClientReference: () => Promise.resolve() };

    expect(supportsHotelBookingByClientReference(soloReferencia)).toBe(true);
    expect(supportsHotelBookingsByDate(soloReferencia)).toBe(false);
    expect(supportsHotelSuggest(soloReferencia)).toBe(false);
  });
});

describe('EnvHotelProviderFlags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sin variable, ningún proveedor opt-in está activo', async () => {
    const f = new EnvHotelProviderFlags();
    expect(await f.isEnabledForTenant(TENANT, 'alfa-hotels')).toBe(false);
  });

  it('`code` activa para todos y `code@tenant` sólo para ese tenant', async () => {
    vi.stubEnv('HOTEL_PROVIDERS_OPT_IN', `alfa-hotels, beta-hotels@${TENANT}`);
    const f = new EnvHotelProviderFlags();

    expect(await f.isEnabledForTenant(OTRO_TENANT, 'alfa-hotels')).toBe(true);
    expect(await f.isEnabledForTenant(TENANT, 'beta-hotels')).toBe(true);
    expect(await f.isEnabledForTenant(OTRO_TENANT, 'beta-hotels')).toBe(false);
  });

  it('no lee la variable de vuelos: encender un proveedor de vuelos no enciende hoteles', async () => {
    vi.stubEnv('FLIGHT_PROVIDERS_OPT_IN', 'alfa-hotels');
    const f = new EnvHotelProviderFlags();

    expect(await f.isEnabledForTenant(TENANT, 'alfa-hotels')).toBe(false);
  });

  it('una entrada mal escrita tumba el arranque', () => {
    vi.stubEnv('HOTEL_PROVIDERS_OPT_IN', 'Alfa Hotels');
    expect(() => new EnvHotelProviderFlags()).toThrow();
  });
});
