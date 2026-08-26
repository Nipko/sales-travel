import { Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlightProviderRegistry } from './flight-provider.registry.js';
import {
  ProviderNotAvailableError,
  type FlightProviderAdapter,
  type ProviderFlagsPort,
  type TenantProviderFactory,
} from './provider.types.js';
import { StubProviderFactory } from './__fixtures__/stub-provider.factory.js';

/**
 * El registry es el punto donde la plataforma deja de tener "el proveedor" y pasa a tener
 * proveedores. Todo lo que se prueba acá usa proveedores ANÓNIMOS in-repo: nada de esto
 * depende de qué proveedor real entre segundo, ni de que entre alguno.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';

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
  factories: TenantProviderFactory<FlightProviderAdapter>[],
  port: ProviderFlagsPort = flags(false).port,
): FlightProviderRegistry {
  return new FlightProviderRegistry(factories, port);
}

describe('FlightProviderRegistry', () => {
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
        new StubProviderFactory({ code: 'zeta-air' }),
        new StubProviderFactory({ code: 'alfa-air' }),
        new StubProviderFactory({ code: 'mika-air' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.code)).toEqual(['alfa-air', 'mika-air', 'zeta-air']);
    });

    it('`codesForTenant` devuelve el mismo orden que `forTenant`', async () => {
      const r = registry([
        new StubProviderFactory({ code: 'zeta-air' }),
        new StubProviderFactory({ code: 'alfa-air' }),
      ]);

      expect(await r.codesForTenant(TENANT)).toEqual(['alfa-air', 'zeta-air']);
    });

    it('dos factories con el mismo code tumban el arranque, no se pisan en silencio', () => {
      expect(() =>
        registry([
          new StubProviderFactory({ code: 'alfa-air' }),
          new StubProviderFactory({ code: 'alfa-air' }),
        ]),
      ).toThrow(/duplicado/);
    });
  });

  describe('callPolicy', () => {
    it("'opt-in' con el flag apagado NO recibe ninguna llamada y sale como skipped", async () => {
      const stub = new StubProviderFactory({ code: 'alfa-air', callPolicy: 'opt-in' });
      const r = registry([stub], flags(false).port);

      const { active, skipped } = await r.forTenant(TENANT);

      expect(active).toEqual([]);
      expect(skipped).toEqual([{ code: 'alfa-air', reason: 'opt-in-disabled' }]);
      // Ni al proveedor ni a la bóveda de credenciales: el flag se mira ANTES de resolver.
      expect(stub.resolveCalls).toEqual([]);
    });

    it("'opt-in' con el flag encendido entra al fan-out como uno más", async () => {
      const stub = new StubProviderFactory({ code: 'alfa-air', callPolicy: 'opt-in' });
      const { port, isEnabledForTenant } = flags(true);
      const r = registry([stub], port);

      const { active, skipped } = await r.forTenant(TENANT);

      expect(active.map((p) => p.code)).toEqual(['alfa-air']);
      expect(skipped).toEqual([]);
      expect(isEnabledForTenant).toHaveBeenCalledWith(TENANT, 'alfa-air');
    });

    it('el flag es POR TENANT: activo para uno no es activo para el otro', async () => {
      const stub = new StubProviderFactory({ code: 'alfa-air', callPolicy: 'opt-in' });
      const r = registry([stub], flags((tenantId) => tenantId === TENANT).port);

      expect((await r.forTenant(TENANT)).active).toHaveLength(1);
      expect((await r.forTenant(OTRO_TENANT)).active).toHaveLength(0);
    });

    it("'fallback' se resuelve y llega al servicio con su política puesta", async () => {
      const r = registry([new StubProviderFactory({ code: 'alfa-air', callPolicy: 'fallback' })]);

      const { active } = await r.forTenant(TENANT);
      expect(active[0]?.callPolicy).toBe('fallback');
    });

    it('la variable de entorno pisa la política declarada por el proveedor', async () => {
      vi.stubEnv('FLIGHT_PROVIDER_CALL_POLICIES', 'alfa-air:opt-in');
      const stub = new StubProviderFactory({ code: 'alfa-air', callPolicy: 'always' });
      const r = registry([stub], flags(false).port);

      // Declarado 'always', gobernado a 'opt-in' sin tocar código: es el pomo con el que se
      // apaga un proveedor caro el día que se conozca su fee por búsqueda.
      const { active, skipped } = await r.forTenant(TENANT);
      expect(active).toEqual([]);
      expect(skipped[0]?.reason).toBe('opt-in-disabled');
    });

    it('una política mal escrita en el entorno tumba el arranque', () => {
      vi.stubEnv('FLIGHT_PROVIDER_CALL_POLICIES', 'alfa-air:siempre');
      expect(() => registry([new StubProviderFactory({ code: 'alfa-air' })])).toThrow();
    });
  });

  describe('habilitación por credenciales', () => {
    it('credenciales propias o heredadas habilitan al proveedor', async () => {
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air', credentialSource: 'own' }),
        new StubProviderFactory({ code: 'beta-air', credentialSource: 'inherited' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.credentialSource)).toEqual(['own', 'inherited']);
    });

    it('sin credenciales propias, la cuenta de la plataforma NO habilita por defecto', async () => {
      const r = registry([new StubProviderFactory({ code: 'alfa-air', credentialSource: 'env' })]);

      // Si esto pasara, un tenant sin credenciales saldría igual al proveedor con la cuenta
      // de la plataforma: consultas facturadas a quien no las pidió y tarifas de un PCC ajeno.
      expect((await r.forTenant(TENANT)).active).toEqual([]);
    });

    it('el fallback a credenciales de plataforma se habilita proveedor por proveedor', async () => {
      vi.stubEnv('PLATFORM_DEFAULT_FLIGHT_PROVIDERS', 'alfa-air');
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air', credentialSource: 'env' }),
        new StubProviderFactory({ code: 'beta-air', credentialSource: 'env' }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.code)).toEqual(['alfa-air']);
    });

    it('un tenant sin cuenta resoluble no habilita el proveedor, pero no rompe la búsqueda', async () => {
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air' }),
        new StubProviderFactory({ code: 'beta-air', failResolve: true }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.code)).toEqual(['alfa-air']);
    });

    it('un fallo REAL de la bóveda se propaga: no se degrada en silencio', async () => {
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air', failResolveWith: new Error('bóveda caída') }),
      ]);

      await expect(r.forTenant(TENANT)).rejects.toThrow('bóveda caída');
    });
  });

  describe('byCode', () => {
    it('devuelve el proveedor pedido con sus capacidades', async () => {
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air' }),
        new StubProviderFactory({ code: 'beta-air', capabilities: { reshop: false } }),
      ]);

      const beta = await r.byCode(TENANT, 'beta-air');
      expect(beta.code).toBe('beta-air');
      expect(beta.capabilities.reshop).toBe(false);
      expect(beta.capabilities.cancel).toBe(true);
    });

    it('un proveedor desconocido es 400 con mensaje, no un 500 opaco', async () => {
      const r = registry([new StubProviderFactory({ code: 'alfa-air' })]);

      await expect(r.byCode(TENANT, 'no-existe')).rejects.toBeInstanceOf(ProviderNotAvailableError);
    });

    it('un proveedor sin credenciales para este tenant también es 400', async () => {
      const r = registry([new StubProviderFactory({ code: 'alfa-air', failResolve: true })]);

      await expect(r.byCode(TENANT, 'alfa-air')).rejects.toBeInstanceOf(ProviderNotAvailableError);
    });

    it('NO consulta el flag de opt-in: una orden ya hecha se puede seguir operando', async () => {
      const stub = new StubProviderFactory({ code: 'alfa-air', callPolicy: 'opt-in' });
      const { port, isEnabledForTenant } = flags(false);
      const r = registry([stub], port);

      await expect(r.byCode(TENANT, 'alfa-air')).resolves.toMatchObject({ code: 'alfa-air' });
      expect(isEnabledForTenant).not.toHaveBeenCalled();
    });
  });

  describe('metadatos', () => {
    it('`simulated` refleja el modo mock del adapter resuelto', async () => {
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air', isMock: true }),
        new StubProviderFactory({ code: 'beta-air', isMock: false }),
      ]);

      const { active } = await r.forTenant(TENANT);
      expect(active.map((p) => p.simulated)).toEqual([true, false]);
    });

    it('`capabilitiesOf` no toca credenciales y distingue al desconocido', () => {
      const r = registry([
        new StubProviderFactory({ code: 'alfa-air', capabilities: { pay: false } }),
      ]);

      expect(r.capabilitiesOf('alfa-air')?.pay).toBe(false);
      expect(r.capabilitiesOf('alfa-air')?.retrieve).toBe(true);
      // Un proveedor de otra vertical (o inexistente) no tiene capacidades de vuelo.
      expect(r.capabilitiesOf('agent-cars')).toBeUndefined();
    });

    it('`humanizeError` delega en el proveedor y tiene salida para el desconocido', () => {
      const r = registry([new StubProviderFactory({ code: 'alfa-air' })]);

      expect(r.humanizeError('alfa-air', new Error('boom'))).toBe('[alfa-air] boom');
      expect(r.humanizeError('no-existe', new Error('boom'))).toBe('boom');
      expect(r.humanizeError('no-existe', 'texto suelto')).toBe('texto suelto');
    });
  });

  it('propaga NotFoundException del factory como "no habilitado", no como 404 al vendedor', async () => {
    const stub = new StubProviderFactory({
      code: 'alfa-air',
      failResolveWith: new NotFoundException('sin cuenta'),
    });
    const r = registry([stub]);

    await expect(r.forTenant(TENANT)).resolves.toEqual({ active: [], skipped: [] });
  });
});
