import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { RegisteredProvider } from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { KillSwitchStore, PanelKillSwitch } from './kill-switch.store.js';
import {
  UnknownPlatformProviderError,
  type ProviderEnablementService,
} from './provider-enablement.service.js';
import {
  KillSwitchFromEnvError,
  PROVIDER_CIRCUIT_RESET_EVENT,
  ProviderHealthService,
} from './provider-health.service.js';

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const PLATAFORMA = '10000000-0000-4000-8000-000000000000';
const AHORA = new Date('2026-10-13T12:00:00Z');

const REGISTRADOS: RegisteredProvider[] = [
  { code: 'sabre', vertical: 'flights', callPolicy: 'always' },
  { code: 'tbo-hotels', vertical: 'hotels', callPolicy: 'opt-in' },
];

const CAÍDO = (): Promise<never> => Promise.reject(new Error('proveedor caído'));

function apagado(over: Partial<PanelKillSwitch> = {}): PanelKillSwitch {
  return {
    providerCode: 'tbo-hotels',
    level: 'sales',
    reason: 'TBO cobra de más',
    setBy: SUPERADMIN,
    setByEmail: 'root@plataforma.test',
    setAt: new Date('2026-10-13T11:00:00Z'),
    expiresAt: null,
    ...over,
  };
}

/** Los apagados del panel en memoria, con `set` y `clear` que sólo registran. */
class ApagadosFalsos {
  readonly porCodigo = new Map<string, PanelKillSwitch>();
  readonly set = vi.fn(
    (
      _actor: string,
      code: string,
      input: { level: 'all' | 'sales'; reason: string; expiresInMinutes: number | null },
    ) => {
      const k = apagado({ providerCode: code, level: input.level, reason: input.reason });
      this.porCodigo.set(code, k);
      return Promise.resolve(k);
    },
  );
  readonly clear = vi.fn((_actor: string, code: string) => {
    const k = this.porCodigo.get(code);
    this.porCodigo.delete(code);
    return Promise.resolve(k);
  });

  active(code: string): PanelKillSwitch | undefined {
    return this.porCodigo.get(code);
  }

  panelLevel(code: string) {
    return this.porCodigo.get(code)?.level;
  }
}

function banco({
  avisos = [{ provider: 'tbo-hotels', n: '3' }] as { provider: string | null; n: string }[],
  lecturaFalla = false,
  auditFalla = false,
} = {}) {
  const contextos: { userId?: string }[] = [];
  let tabla = '';
  const cadena: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'execute') {
          return () =>
            lecturaFalla
              ? Promise.reject(Object.assign(new Error('timeout'), { name: 'DatabaseError' }))
              : Promise.resolve(avisos);
        }
        if (prop === 'executeTakeFirst') {
          return () => Promise.resolve(tabla === 'tenants' ? { id: PLATAFORMA } : undefined);
        }
        return (...args: unknown[]) => {
          if (prop === 'selectFrom') tabla = String(args[0]);
          return cadena;
        };
      },
    },
  );
  const db = {
    withRequestContext: <T>(ctx: { userId?: string }, fn: (trx: unknown) => Promise<T>) => {
      contextos.push(ctx);
      return fn(cadena);
    },
  } as unknown as DatabaseService;

  const enablement = {
    registered: () => REGISTRADOS,
    provider: (code: string) => {
      const p = REGISTRADOS.find((r) => r.code === code);
      if (p === undefined) throw new UnknownPlatformProviderError(code);
      return p;
    },
  } as unknown as ProviderEnablementService;

  const apagados = new ApagadosFalsos();
  const breaker = new CircuitBreakerService(apagados as unknown as KillSwitchStore);
  const audit = new RecordingAuditService();
  if (auditFalla) {
    vi.spyOn(audit, 'emitWithin').mockRejectedValue(new Error('domain_events no responde'));
  }
  const service = new ProviderHealthService(
    db,
    enablement,
    breaker,
    apagados as unknown as KillSwitchStore,
    audit.asService(),
  );
  return { service, breaker, apagados, audit, contextos };
}

async function abrir(breaker: CircuitBreakerService, code: string): Promise<void> {
  for (let i = 0; i < 5; i++) await breaker.execute(code, CAÍDO).catch(() => undefined);
}

describe('ProviderHealthService', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('PROVIDERS_DISABLED', '');
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('la salud', () => {
    it('cada proveedor registrado, sano por defecto, con sus avisos de cuenta de 24 h', async () => {
      const b = banco();
      const vista = await b.service.health(SUPERADMIN, AHORA);

      expect(b.contextos).toEqual([{ userId: SUPERADMIN }]);
      expect(vista).toEqual([
        {
          code: 'sabre',
          vertical: 'flights',
          circuit: { state: 'closed', failures: 0, openedAt: null, lastFailureAt: null },
          suspendedAccounts: 0,
          killSwitch: { effective: null, env: null, panel: null },
          accountIssues24h: 0,
        },
        {
          code: 'tbo-hotels',
          vertical: 'hotels',
          circuit: { state: 'closed', failures: 0, openedAt: null, lastFailureAt: null },
          suspendedAccounts: 0,
          killSwitch: { effective: null, env: null, panel: null },
          accountIssues24h: 3,
        },
      ]);
    });

    it('un circuito abierto, las cuentas en pausa y el apagado, con su origen', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(AHORA);
      const b = banco();
      await abrir(b.breaker, 'sabre');
      vi.stubEnv('PROVIDERS_DISABLED', 'sabre:ventas');
      await b.breaker
        .execute(
          'tbo-hotels',
          () =>
            Promise.reject(
              Object.assign(new Error('401'), { failure: { circuit: 'OPEN_ACCOUNT' } }),
            ),
          { accountRef: 'acct-secreta', scope: 'post-sale' },
        )
        .catch(() => undefined);
      b.apagados.porCodigo.set('tbo-hotels', apagado());

      const [sabre, tbo] = await b.service.health(SUPERADMIN, AHORA);

      expect(sabre).toMatchObject({
        circuit: {
          state: 'open',
          failures: 5,
          openedAt: '2026-10-13T12:00:00.000Z',
          lastFailureAt: '2026-10-13T12:00:00.000Z',
        },
        killSwitch: { effective: 'sales', env: 'sales', panel: null },
      });
      expect(tbo).toMatchObject({
        suspendedAccounts: 1,
        killSwitch: {
          effective: 'sales',
          env: null,
          panel: {
            level: 'sales',
            reason: 'TBO cobra de más',
            setByEmail: 'root@plataforma.test',
            setAt: '2026-10-13T11:00:00.000Z',
            expiresAt: null,
          },
        },
      });
      expect(JSON.stringify([sabre, tbo])).not.toContain('acct-secreta');
    });

    it('si no se pueden contar los avisos, `null` y el resto sale igual', async () => {
      const b = banco({ lecturaFalla: true });
      const vista = await b.service.health(SUPERADMIN, AHORA);

      expect(vista.map((p) => p.accountIssues24h)).toEqual([null, null]);
      expect(vista.map((p) => p.circuit.state)).toEqual(['closed', 'closed']);
      expect(warn).toHaveBeenCalledWith(
        'no se pudieron contar los avisos de cuenta: DatabaseError',
      );
    });

    it('un aviso sin proveedor en el payload no se cuenta para nadie', async () => {
      const b = banco({ avisos: [{ provider: null, n: '4' }] });
      const vista = await b.service.health(SUPERADMIN, AHORA);
      expect(vista.map((p) => p.accountIssues24h)).toEqual([0, 0]);
    });
  });

  describe('apagado de emergencia', () => {
    it('poner: lo escribe el almacén y devuelve el proveedor como quedó', async () => {
      const b = banco();
      const vista = await b.service.setKillSwitch(SUPERADMIN, 'tbo-hotels', {
        level: 'all',
        reason: 'TBO cobra de más',
        expiresInMinutes: 240,
      });

      expect(b.apagados.set).toHaveBeenCalledWith(SUPERADMIN, 'tbo-hotels', {
        level: 'all',
        reason: 'TBO cobra de más',
        expiresInMinutes: 240,
      });
      expect(vista).toMatchObject({
        code: 'tbo-hotels',
        killSwitch: { effective: 'all', env: null, panel: { level: 'all' } },
      });
    });

    it('un proveedor que no está registrado es 404, sin escribir', async () => {
      const b = banco();
      await expect(
        b.service.setKillSwitch(SUPERADMIN, 'no-existe', {
          level: 'all',
          reason: 'Prueba de 404',
          expiresInMinutes: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(b.service.clearKillSwitch(SUPERADMIN, 'no-existe', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(b.apagados.set).not.toHaveBeenCalled();
      expect(b.apagados.clear).not.toHaveBeenCalled();
    });

    it('levantar el del panel devuelve el proveedor encendido', async () => {
      const b = banco();
      b.apagados.porCodigo.set('tbo-hotels', apagado());

      const vista = await b.service.clearKillSwitch(SUPERADMIN, 'tbo-hotels', 'Listo');

      expect(b.apagados.clear).toHaveBeenCalledWith(SUPERADMIN, 'tbo-hotels', 'Listo');
      expect(vista.killSwitch).toEqual({ effective: null, env: null, panel: null });
    });

    it('levantar el del panel con la variable también puesta: queda el de la variable', async () => {
      vi.stubEnv('PROVIDERS_DISABLED', 'tbo-hotels:ventas');
      const b = banco();
      b.apagados.porCodigo.set('tbo-hotels', apagado({ level: 'all' }));

      const vista = await b.service.clearKillSwitch(SUPERADMIN, 'tbo-hotels', null);
      expect(vista.killSwitch).toEqual({ effective: 'sales', env: 'sales', panel: null });
    });

    it('si sólo lo apaga la variable, 409 KILL_SWITCH_FROM_ENV: se quita desplegando', async () => {
      vi.stubEnv('PROVIDERS_DISABLED', 'tbo-hotels');
      const b = banco();

      const err = await b.service
        .clearKillSwitch(SUPERADMIN, 'tbo-hotels', null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(KillSwitchFromEnvError);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err).toMatchObject({
        reason: 'KILL_SWITCH_FROM_ENV',
        message: 'Este apagado viene de la variable PROVIDERS_DISABLED: se quita desplegando.',
      });
      expect((err as ConflictException).getStatus()).toBe(409);
    });

    it('sin ningún apagado, levantar no hace nada', async () => {
      const b = banco();
      const vista = await b.service.clearKillSwitch(SUPERADMIN, 'sabre', null);
      expect(vista.killSwitch.effective).toBeNull();
    });
  });

  describe('cerrar el circuito', () => {
    it('audita en la plataforma con el antes y después lo cierra', async () => {
      const b = banco();
      await abrir(b.breaker, 'sabre');

      const vista = await b.service.resetCircuit(SUPERADMIN, 'sabre', 'Sabre confirmó que volvió');

      expect(vista.circuit).toEqual({
        state: 'closed',
        failures: 0,
        openedAt: null,
        lastFailureAt: expect.any(String) as string,
      });
      expect(b.audit.events).toEqual([
        {
          eventType: PROVIDER_CIRCUIT_RESET_EVENT,
          tenantId: PLATAFORMA,
          actorUserId: SUPERADMIN,
          aggregateType: 'provider_circuit',
          aggregateId: 'sabre',
          payload: {
            providerCode: 'sabre',
            reason: 'Sabre confirmó que volvió',
            before: expect.objectContaining({
              state: 'open',
              failures: 5,
              suspendedAccounts: 0,
            }) as unknown,
          },
        },
      ]);
    });

    it('con el circuito cerrado y sin fallos no audita nada', async () => {
      const b = banco();
      await b.breaker.execute('sabre', () => Promise.resolve('ok'));
      await b.service.resetCircuit(SUPERADMIN, 'sabre', 'Por las dudas');
      await b.service.resetCircuit(SUPERADMIN, 'tbo-hotels', 'Sin circuito todavía');
      expect(b.audit.events).toEqual([]);
    });

    it('si la auditoría no entra, el circuito sigue abierto', async () => {
      const b = banco({ auditFalla: true });
      await abrir(b.breaker, 'sabre');

      await expect(
        b.service.resetCircuit(SUPERADMIN, 'sabre', 'Sabre confirmó que volvió'),
      ).rejects.toThrow('domain_events no responde');
      expect(b.breaker.snapshot()['sabre']?.state).toBe('open');
    });

    it('un proveedor que no está registrado es 404', async () => {
      const b = banco();
      await expect(
        b.service.resetCircuit(SUPERADMIN, 'no-existe', 'Prueba de 404'),
      ).rejects.toBeInstanceOf(UnknownPlatformProviderError);
    });
  });
});
