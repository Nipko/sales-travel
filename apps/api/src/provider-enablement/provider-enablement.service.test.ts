import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { EnvHotelProviderFlags } from '../providers/hotel-providers.module.js';
import { EnvProviderFlags } from '../providers/providers.module.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { PlatformProviderFlags } from './platform-provider-flags.js';
import type { EnablementSetting } from './provider-enablement.policy.js';
import {
  PROVIDER_ENABLEMENT_EVENT,
  PlatformTenantNotFoundError,
  ProviderEnablementService,
  UnknownPlatformProviderError,
} from './provider-enablement.service.js';
import type {
  EnablementValue,
  ProviderEnablementRow,
  ProviderEnablementStore,
} from './provider-enablement.store.js';

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const CONSOLIDADOR = '10000000-0000-4000-8000-000000000001';
const AGENCIA = '10000000-0000-4000-8000-000000000002';
const OTRA = '10000000-0000-4000-8000-000000000009';

interface Nodo {
  readonly name: string;
  readonly slug: string;
  readonly parent: string | null;
}

const ARBOL: ReadonlyMap<string, Nodo> = new Map([
  [CONSOLIDADOR, { name: 'Consolidador', slug: 'cons', parent: null }],
  [AGENCIA, { name: 'Agencia', slug: 'ag', parent: CONSOLIDADOR }],
  [OTRA, { name: 'Otra red', slug: 'otra', parent: null }],
]);

function cadena(tenantId: string): { id: string; depth: number }[] {
  const ids: string[] = [];
  for (let id: string | null = tenantId; id !== null; id = ARBOL.get(id)?.parent ?? null) {
    ids.unshift(id);
  }
  return ids.map((id, i) => ({ id, depth: i + 1 }));
}

/** `provider_enablement` en memoria, con las mismas operaciones que usa el servicio. */
class AlmacenEnMemoria {
  readonly filas: ProviderEnablementRow[] = [];
  readonly invalidate = vi.fn();
  private secuencia = 0;

  settingsFor(tenantId: string): Promise<EnablementSetting[]> {
    const nodos = cadena(tenantId);
    return Promise.resolve(
      this.filas.flatMap((f): EnablementSetting[] => {
        if (f.tenantId === null) {
          return [{ providerCode: f.providerCode, tenantId: null, depth: 0, enabled: f.enabled }];
        }
        const nodo = nodos.find((n) => n.id === f.tenantId);
        return nodo === undefined
          ? []
          : [
              {
                providerCode: f.providerCode,
                tenantId: f.tenantId,
                depth: nodo.depth,
                enabled: f.enabled,
              },
            ];
      }),
    );
  }

  listRows(): Promise<ProviderEnablementRow[]> {
    return Promise.resolve([...this.filas]);
  }

  lock(_trx: unknown, code: string, tenantId: string | null) {
    const f = this.buscar(code, tenantId);
    return Promise.resolve(
      f === undefined ? undefined : { id: f.id, enabled: f.enabled, reason: f.reason },
    );
  }

  upsert(
    _trx: unknown,
    input: {
      providerCode: string;
      tenantId: string | null;
      enabled: boolean;
      reason: string | null;
      actorUserId: string;
    },
  ): Promise<string> {
    const previa = this.buscar(input.providerCode, input.tenantId);
    const nodo = input.tenantId === null ? undefined : ARBOL.get(input.tenantId);
    const fila: ProviderEnablementRow = {
      id: previa?.id ?? `fila-${++this.secuencia}`,
      providerCode: input.providerCode,
      tenantId: input.tenantId,
      tenantName: nodo?.name ?? null,
      tenantSlug: nodo?.slug ?? null,
      enabled: input.enabled,
      reason: input.reason,
      updatedBy: input.actorUserId,
      updatedByEmail: 'root@plataforma.test',
      updatedAt: new Date('2026-09-28T12:00:00Z'),
    };
    if (previa !== undefined) this.filas.splice(this.filas.indexOf(previa), 1, fila);
    else this.filas.push(fila);
    return Promise.resolve(fila.id);
  }

  remove(_trx: unknown, code: string, tenantId: string | null): Promise<boolean> {
    const f = this.buscar(code, tenantId);
    if (f === undefined) return Promise.resolve(false);
    this.filas.splice(this.filas.indexOf(f), 1);
    return Promise.resolve(true);
  }

  private buscar(code: string, tenantId: string | null): ProviderEnablementRow | undefined {
    return this.filas.find((f) => f.providerCode === code && f.tenantId === tenantId);
  }
}

/** Lo justo de `DatabaseService`: la transacción con contexto y la lectura del tenant. */
function baseFalsa(): {
  db: DatabaseService;
  contextos: { userId?: string; tenantId?: string }[];
} {
  const contextos: { userId?: string; tenantId?: string }[] = [];
  let buscado = '';
  const consulta = {
    select: () => consulta,
    where: (_col: string, _op: string, valor: string) => {
      buscado = valor;
      return consulta;
    },
    executeTakeFirst: () => {
      const nodo = ARBOL.get(buscado);
      return Promise.resolve(
        nodo === undefined ? undefined : { id: buscado, name: nodo.name, slug: nodo.slug },
      );
    },
  };
  const db = {
    db: { selectFrom: () => consulta },
    withRequestContext: <T>(
      ctx: { userId?: string; tenantId?: string },
      fn: (trx: unknown) => Promise<T>,
    ): Promise<T> => {
      contextos.push(ctx);
      return fn({});
    },
  } as unknown as DatabaseService;
  return { db, contextos };
}

function banco() {
  const almacen = new AlmacenEnMemoria();
  const audit = new RecordingAuditService();
  const { db, contextos } = baseFalsa();
  const legacyFlights = new EnvProviderFlags();
  const legacyHotels = new EnvHotelProviderFlags();
  const alfaAir = new StubProviderFactory({ code: 'alfa-air' });
  const tbo = new StubHotelProviderFactory({ code: 'tbo-hotels', callPolicy: 'opt-in' });
  const flights = new FlightProviderRegistry(
    [alfaAir],
    new PlatformProviderFlags(almacen, legacyFlights),
  );
  const hotels = new HotelProviderRegistry(
    [tbo, new StubHotelProviderFactory({ code: 'despegar-hotels' })],
    new PlatformProviderFlags(almacen, legacyHotels),
  );
  const service = new ProviderEnablementService(
    db,
    almacen as unknown as ProviderEnablementStore,
    flights,
    hotels,
    audit.asService(),
    legacyFlights,
    legacyHotels,
  );
  return { service, almacen, audit, contextos, flights, hotels, alfaAir, tbo };
}

const APAGAR: EnablementValue = { enabled: false, reason: 'Deuda vencida' };

describe('ProviderEnablementService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('escrituras', () => {
    it('apagar para un tenant: guarda, audita el antes y el después, e invalida la caché', async () => {
      const b = banco();

      const vista = await b.service.setTenant(SUPERADMIN, 'alfa-air', AGENCIA, APAGAR);

      expect(b.contextos).toEqual([{ userId: SUPERADMIN }]);
      expect(b.audit.ofType(PROVIDER_ENABLEMENT_EVENT)).toEqual([
        {
          eventType: PROVIDER_ENABLEMENT_EVENT,
          actorUserId: SUPERADMIN,
          aggregateType: 'provider_enablement',
          aggregateId: `alfa-air@${AGENCIA}`,
          payload: {
            providerCode: 'alfa-air',
            scope: 'tenant',
            targetTenantId: AGENCIA,
            before: null,
            after: APAGAR,
          },
        },
      ]);
      expect(b.almacen.invalidate).toHaveBeenCalledTimes(1);
      expect(vista.overrides).toEqual([
        expect.objectContaining({
          tenantId: AGENCIA,
          tenantName: 'Agencia',
          enabled: false,
          reason: 'Deuda vencida',
          updatedBy: SUPERADMIN,
        }),
      ]);
    });

    it('la búsqueda del tenant lo ve apagado en cuanto se escribe, y la de otra red no', async () => {
      const b = banco();
      await b.service.setTenant(SUPERADMIN, 'alfa-air', AGENCIA, APAGAR);

      expect((await b.flights.forTenant(AGENCIA)).skipped).toEqual([
        expect.objectContaining({ code: 'alfa-air', reason: 'platform-disabled' }),
      ]);
      expect((await b.flights.forTenant(OTRA)).active.map((p) => p.code)).toEqual(['alfa-air']);
      // Ni la bóveda se consultó para la agencia apagada.
      expect(b.alfaAir.resolveCalls).toEqual([OTRA]);
    });

    it('reenviar el mismo estado no escribe ni audita otra vez', async () => {
      const b = banco();
      await b.service.setGlobal(SUPERADMIN, 'tbo-hotels', { enabled: true, reason: null });
      await b.service.setGlobal(SUPERADMIN, 'tbo-hotels', { enabled: true, reason: null });

      expect(b.audit.ofType(PROVIDER_ENABLEMENT_EVENT)).toHaveLength(1);
      expect(b.almacen.invalidate).toHaveBeenCalledTimes(1);
    });

    it('cambiar sólo el motivo sí es un cambio, con el antes en la auditoría', async () => {
      const b = banco();
      await b.service.setGlobal(SUPERADMIN, 'tbo-hotels', { enabled: true, reason: null });
      await b.service.setGlobal(SUPERADMIN, 'tbo-hotels', { enabled: true, reason: 'Contrato' });

      expect(b.audit.ofType(PROVIDER_ENABLEMENT_EVENT)[1]?.payload).toMatchObject({
        scope: 'global',
        targetTenantId: null,
        before: { enabled: true, reason: null },
        after: { enabled: true, reason: 'Contrato' },
      });
    });

    it('quitar un ajuste audita con `after: null`; quitar lo que no está no hace nada', async () => {
      const b = banco();
      await b.service.clearGlobal(SUPERADMIN, 'tbo-hotels');
      expect(b.audit.events).toEqual([]);
      expect(b.almacen.invalidate).not.toHaveBeenCalled();

      await b.service.setGlobal(SUPERADMIN, 'tbo-hotels', { enabled: true, reason: null });
      const vista = await b.service.clearGlobal(SUPERADMIN, 'tbo-hotels');

      expect(vista.global).toBeNull();
      expect(b.audit.ofType(PROVIDER_ENABLEMENT_EVENT)[1]).toMatchObject({
        aggregateId: 'tbo-hotels',
        payload: { before: { enabled: true, reason: null }, after: null },
      });
    });

    it('un proveedor que no está en ningún registry es 404, sin escribir', async () => {
      const b = banco();
      const err = await b.service
        .setGlobal(SUPERADMIN, 'no-existe', APAGAR)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnknownPlatformProviderError);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(b.contextos).toEqual([]);
      expect(b.audit.events).toEqual([]);
    });

    it('un tenant que no existe es 404, sin escribir', async () => {
      const b = banco();
      await expect(
        b.service.setTenant(SUPERADMIN, 'alfa-air', '10000000-0000-4000-8000-00000000dead', APAGAR),
      ).rejects.toBeInstanceOf(PlatformTenantNotFoundError);
      await expect(
        b.service.forTenant('10000000-0000-4000-8000-00000000dead'),
      ).rejects.toBeInstanceOf(PlatformTenantNotFoundError);
      expect(b.contextos).toEqual([]);
    });
  });

  describe('lecturas', () => {
    it('la lista trae cada proveedor con su global, sus excepciones y lo que ve un tenant sin ajustes', async () => {
      vi.stubEnv('HOTEL_PROVIDERS_OPT_IN', `tbo-hotels@${OTRA}`);
      const b = banco();
      await b.service.setTenant(SUPERADMIN, 'tbo-hotels', CONSOLIDADOR, {
        enabled: true,
        reason: null,
      });

      const lista = await b.service.list();

      expect(lista.map((p) => [p.vertical, p.code])).toEqual([
        ['flights', 'alfa-air'],
        ['hotels', 'despegar-hotels'],
        ['hotels', 'tbo-hotels'],
      ]);
      const tbo = lista.find((p) => p.code === 'tbo-hotels');
      expect(tbo).toMatchObject({
        callPolicy: 'opt-in',
        defaultEnabled: false,
        killSwitch: null,
        legacyEnv: { allTenants: false, tenantIds: [OTRA] },
        global: null,
        baseline: { enabled: false, origin: 'default' },
      });
      expect(tbo?.overrides.map((o) => [o.tenantId, o.enabled])).toEqual([[CONSOLIDADOR, true]]);
    });

    it('el estado efectivo de un tenant dice de dónde sale: override de un ancestro, global, legado, default', async () => {
      vi.stubEnv('FLIGHT_PROVIDERS_OPT_IN', 'alfa-air');
      const b = banco();
      await b.service.setTenant(SUPERADMIN, 'tbo-hotels', CONSOLIDADOR, {
        enabled: true,
        reason: 'Piloto',
      });
      await b.service.setGlobal(SUPERADMIN, 'despegar-hotels', APAGAR);

      const vista = await b.service.forTenant(AGENCIA);

      expect(vista).toMatchObject({ tenantId: AGENCIA, tenantName: 'Agencia', tenantSlug: 'ag' });
      const por = new Map(vista.providers.map((p) => [p.code, p]));
      expect(por.get('tbo-hotels')).toMatchObject({
        own: null,
        effective: {
          enabled: true,
          origin: 'tenant',
          originTenantId: CONSOLIDADOR,
          originTenantName: 'Consolidador',
        },
      });
      expect(por.get('despegar-hotels')?.effective).toEqual({ enabled: false, origin: 'global' });
      expect(por.get('alfa-air')?.effective).toEqual({ enabled: true, origin: 'legacy-env' });
    });

    it('el kill-switch le gana a todo y se informa con su nivel', async () => {
      vi.stubEnv('PROVIDERS_DISABLED', 'tbo-hotels:ventas');
      const b = banco();
      await b.service.setTenant(SUPERADMIN, 'tbo-hotels', AGENCIA, { enabled: true, reason: null });

      const tbo = (await b.service.forTenant(AGENCIA)).providers.find(
        (p) => p.code === 'tbo-hotels',
      );

      expect(tbo?.killSwitch).toBe('sales');
      expect(tbo?.own).toMatchObject({ enabled: true });
      expect(tbo?.effective).toEqual({
        enabled: false,
        origin: 'kill-switch',
        killSwitch: 'sales',
      });
    });

    it('sin nada decidido, la política: `opt-in` apagado y `always` encendido', async () => {
      const b = banco();
      const por = new Map((await b.service.forTenant(OTRA)).providers.map((p) => [p.code, p]));

      expect(por.get('tbo-hotels')?.effective).toEqual({ enabled: false, origin: 'default' });
      expect(por.get('alfa-air')?.effective).toEqual({ enabled: true, origin: 'default' });
    });
  });
});
