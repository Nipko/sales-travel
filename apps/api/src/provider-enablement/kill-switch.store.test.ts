import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import {
  KILL_SWITCH_CLEARED_EVENT,
  KILL_SWITCH_REFRESH_MS,
  KILL_SWITCH_SET_EVENT,
  KillSwitchStore,
  type PanelKillSwitch,
} from './kill-switch.store.js';

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const PLATAFORMA = '10000000-0000-4000-8000-000000000000';

function apagado(over: Partial<PanelKillSwitch> = {}): PanelKillSwitch {
  return {
    providerCode: 'tbo-hotels',
    level: 'all',
    reason: 'TBO cobra de más',
    setBy: SUPERADMIN,
    setByEmail: 'root@plataforma.test',
    setAt: new Date('2026-10-13T12:00:00Z'),
    expiresAt: null,
    ...over,
  };
}

/** Una fila de `provider_kill_switches` como la devuelve Postgres. */
function fila(k: PanelKillSwitch, active = true) {
  return {
    provider_code: k.providerCode,
    level: k.level,
    reason: k.reason,
    set_by: k.setBy,
    set_by_email: k.setByEmail,
    set_at: k.setAt,
    expires_at: k.expiresAt,
    active,
  };
}

interface Respuestas {
  /** Lo que devuelve el SELECT ... FOR UPDATE del apagado actual. */
  lock?: ReturnType<typeof fila>;
  /** Lo que devuelve el INSERT ... RETURNING. */
  inserted?: ReturnType<typeof fila>;
  deleted?: number;
}

/**
 * Lo justo de `DatabaseService` para `set` y `clear`: la transacción con contexto y un query builder
 * que responde según la tabla. El SQL de verdad lo prueba kill-switch.integration.test.ts.
 */
function baseFalsa(respuestas: Respuestas) {
  const contextos: { userId?: string }[] = [];
  let tabla = '';
  const cadena: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return undefined;
        if (prop === 'executeTakeFirst') {
          return () =>
            Promise.resolve(
              tabla === 'users'
                ? { email: 'root@plataforma.test' }
                : tabla === 'tenants'
                  ? { id: PLATAFORMA }
                  : tabla === 'provider_kill_switches' && respuestas.deleted !== undefined
                    ? { numDeletedRows: BigInt(respuestas.deleted) }
                    : respuestas.lock,
            );
        }
        if (prop === 'executeTakeFirstOrThrow') return () => Promise.resolve(respuestas.inserted);
        return (...args: unknown[]) => {
          if (prop === 'selectFrom' || prop === 'insertInto' || prop === 'deleteFrom') {
            tabla = String(args[0]);
          }
          if (prop === 'onConflict') (args[0] as (oc: unknown) => unknown)(cadena);
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
  return { db, contextos };
}

/** El almacén con la lectura en manos del test. */
class AlmacenProbado extends KillSwitchStore {
  readonly lecturas = vi.fn<() => Promise<PanelKillSwitch[]>>(() => Promise.resolve([]));

  protected override read(): Promise<PanelKillSwitch[]> {
    return this.lecturas();
  }
}

function montar(respuestas: Respuestas = {}, work?: InflightWorkRegistry) {
  const audit = new RecordingAuditService();
  const { db, contextos } = baseFalsa(respuestas);
  const store = new AlmacenProbado(db, audit.asService(), work);
  return { store, audit, contextos };
}

describe('KillSwitchStore', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('la copia en memoria', () => {
    it('arranca sin apagados y aplica lo que lee', async () => {
      const { store } = montar();
      expect(store.panelLevel('tbo-hotels')).toBeUndefined();

      store.lecturas.mockResolvedValueOnce([apagado({ level: 'sales' })]);
      await expect(store.refresh()).resolves.toBe(true);

      expect(store.panelLevel('tbo-hotels')).toBe('sales');
      expect(store.active('tbo-hotels')).toMatchObject({ reason: 'TBO cobra de más' });
      expect(store.panelLevel('sabre')).toBeUndefined();
    });

    it('un apagado vencido entre lectura y lectura ya no apaga', async () => {
      const { store } = montar();
      const vence = new Date('2026-10-13T13:00:00Z');
      store.lecturas.mockResolvedValueOnce([apagado({ expiresAt: vence })]);
      await store.refresh();

      expect(store.panelLevel('tbo-hotels', vence.getTime() - 1)).toBe('all');
      expect(store.panelLevel('tbo-hotels', vence.getTime())).toBeUndefined();
      expect(store.active('tbo-hotels', vence.getTime() + 1)).toBeUndefined();
    });

    it('una lectura que falla deja la anterior: un error de la base no enciende nada', async () => {
      const { store } = montar();
      store.lecturas.mockResolvedValueOnce([apagado()]);
      await store.refresh();

      store.lecturas.mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { name: 'DatabaseError' }),
      );
      await expect(store.refresh()).resolves.toBe(false);

      expect(store.panelLevel('tbo-hotels')).toBe('all');
      expect(warn).toHaveBeenCalledWith(
        'no se pudieron releer los apagados de emergencia; se mantiene la última lectura: DatabaseError',
      );
    });

    it('una lectura que vuelve vacía sí levanta: lo levantaron en otra réplica', async () => {
      const { store } = montar();
      store.lecturas.mockResolvedValueOnce([apagado()]);
      await store.refresh();
      store.lecturas.mockResolvedValueOnce([]);
      await store.refresh();
      expect(store.panelLevel('tbo-hotels')).toBeUndefined();
    });

    it('una lectura lenta que termina después de otra más nueva no la pisa', async () => {
      const { store } = montar();
      let lenta!: (rows: PanelKillSwitch[]) => void;
      store.lecturas.mockImplementationOnce(
        () => new Promise<PanelKillSwitch[]>((resolve) => (lenta = resolve)),
      );
      const vieja = store.refresh();
      store.lecturas.mockResolvedValueOnce([apagado()]);
      await store.refresh();

      lenta([]);
      await expect(vieja).resolves.toBe(false);
      expect(store.panelLevel('tbo-hotels')).toBe('all');
    });
  });

  describe('poner y levantar', () => {
    it('poner: en la transacción del superadmin, con su evento en la plataforma y aplicado al instante', async () => {
      const nuevo = apagado({ level: 'sales', expiresAt: new Date('2026-10-13T13:00:00Z') });
      const { store, audit, contextos } = montar({ inserted: fila(nuevo) });
      // La relectura tras escribir falla: la copia igual tiene el apagado recién escrito.
      store.lecturas.mockRejectedValue(new Error('base caída'));

      const res = await store.set(SUPERADMIN, 'tbo-hotels', {
        level: 'sales',
        reason: 'TBO cobra de más',
        expiresInMinutes: 60,
      });

      expect(contextos).toEqual([{ userId: SUPERADMIN }]);
      expect(res).toEqual(nuevo);
      expect(store.panelLevel('tbo-hotels', Date.parse('2026-10-13T12:30:00Z'))).toBe('sales');
      expect(audit.events).toEqual([
        {
          eventType: KILL_SWITCH_SET_EVENT,
          tenantId: PLATAFORMA,
          actorUserId: SUPERADMIN,
          aggregateType: 'provider_kill_switch',
          aggregateId: 'tbo-hotels',
          payload: {
            providerCode: 'tbo-hotels',
            level: 'sales',
            reason: 'TBO cobra de más',
            expiresAt: '2026-10-13T13:00:00.000Z',
            before: null,
          },
        },
      ]);
    });

    it('reemplazar uno vigente audita el antes', async () => {
      const antes = apagado({ level: 'sales' });
      const { store, audit } = montar({ lock: fila(antes), inserted: fila(apagado()) });

      await store.set(SUPERADMIN, 'tbo-hotels', {
        level: 'all',
        reason: 'TBO cobra de más',
        expiresInMinutes: null,
      });

      expect(audit.first(KILL_SWITCH_SET_EVENT)?.payload).toMatchObject({
        level: 'all',
        expiresAt: null,
        before: {
          level: 'sales',
          reason: 'TBO cobra de más',
          setBy: SUPERADMIN,
          setAt: '2026-10-13T12:00:00.000Z',
          expiresAt: null,
        },
      });
    });

    it('una lectura que empezó antes de poner y termina después no lo borra', async () => {
      const { store } = montar({ inserted: fila(apagado()) });
      let lenta!: (rows: PanelKillSwitch[]) => void;
      store.lecturas.mockImplementationOnce(
        () => new Promise<PanelKillSwitch[]>((resolve) => (lenta = resolve)),
      );
      const vieja = store.refresh();
      store.lecturas.mockRejectedValueOnce(new Error('base caída'));

      await store.set(SUPERADMIN, 'tbo-hotels', {
        level: 'all',
        reason: 'TBO cobra de más',
        expiresInMinutes: null,
      });
      lenta([]);
      await vieja;

      expect(store.panelLevel('tbo-hotels')).toBe('all');
    });

    it('levantar: borra, audita el antes con el motivo y lo saca de la copia', async () => {
      const antes = apagado();
      const { store, audit } = montar({ lock: fila(antes), deleted: 1 });
      store.lecturas.mockResolvedValueOnce([antes]);
      await store.refresh();

      const res = await store.clear(SUPERADMIN, 'tbo-hotels', 'TBO corrigió la tarifa');

      expect(res).toEqual(antes);
      expect(store.panelLevel('tbo-hotels')).toBeUndefined();
      expect(audit.events).toEqual([
        {
          eventType: KILL_SWITCH_CLEARED_EVENT,
          tenantId: PLATAFORMA,
          actorUserId: SUPERADMIN,
          aggregateType: 'provider_kill_switch',
          aggregateId: 'tbo-hotels',
          payload: {
            providerCode: 'tbo-hotels',
            reason: 'TBO corrigió la tarifa',
            before: {
              level: 'all',
              reason: 'TBO cobra de más',
              setBy: SUPERADMIN,
              setAt: '2026-10-13T12:00:00.000Z',
              expiresAt: null,
            },
          },
        },
      ]);
    });

    it('levantar sin apagado vigente (o vencido) no escribe ni audita', async () => {
      for (const lock of [undefined, fila(apagado(), false)]) {
        const { store, audit } = montar(lock === undefined ? {} : { lock });
        await expect(store.clear(SUPERADMIN, 'tbo-hotels', null)).resolves.toBeUndefined();
        expect(audit.events).toEqual([]);
        expect(store.lecturas).not.toHaveBeenCalled();
      }
    });

    it('si la base no deja borrar lo que deja ver, quien pide ya no es superadmin: 403', async () => {
      const { store, audit } = montar({ lock: fila(apagado()), deleted: 0 });
      await expect(store.clear(SUPERADMIN, 'tbo-hotels', null)).rejects.toBeInstanceOf(
        SuperadminRequiredError,
      );
      expect(audit.events).toEqual([]);
    });
  });

  describe('la relectura periódica', () => {
    it('lee al arrancar y cada 10 s; al destruir el módulo deja de leer', async () => {
      vi.useFakeTimers();
      const { store } = montar();
      store.lecturas.mockResolvedValue([apagado()]);

      await store.onApplicationBootstrap();
      expect(store.lecturas).toHaveBeenCalledTimes(1);
      expect(store.panelLevel('tbo-hotels')).toBe('all');

      await vi.advanceTimersByTimeAsync(KILL_SWITCH_REFRESH_MS);
      expect(store.lecturas).toHaveBeenCalledTimes(2);

      store.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(3 * KILL_SWITCH_REFRESH_MS);
      expect(store.lecturas).toHaveBeenCalledTimes(2);
    });

    it('si la base no responde al arrancar, arranca igual y reintenta', async () => {
      vi.useFakeTimers();
      const { store } = montar();
      store.lecturas.mockRejectedValueOnce(new Error('base caída'));
      store.lecturas.mockResolvedValue([apagado()]);

      await store.onApplicationBootstrap();
      expect(store.panelLevel('tbo-hotels')).toBeUndefined();

      await vi.advanceTimersByTimeAsync(KILL_SWITCH_REFRESH_MS);
      expect(store.panelLevel('tbo-hotels')).toBe('all');
      store.onModuleDestroy();
    });

    it('una lectura lenta no se solapa con la siguiente', async () => {
      vi.useFakeTimers();
      const { store } = montar();
      await store.onApplicationBootstrap();
      let lenta!: (rows: PanelKillSwitch[]) => void;
      store.lecturas.mockImplementationOnce(
        () => new Promise<PanelKillSwitch[]>((resolve) => (lenta = resolve)),
      );

      await vi.advanceTimersByTimeAsync(3 * KILL_SWITCH_REFRESH_MS);
      expect(store.lecturas).toHaveBeenCalledTimes(2);

      lenta([]);
      await vi.advanceTimersByTimeAsync(KILL_SWITCH_REFRESH_MS);
      expect(store.lecturas).toHaveBeenCalledTimes(3);
      store.onModuleDestroy();
    });

    it('el apagado ordenado corta el temporizador y espera la lectura en curso', async () => {
      vi.useFakeTimers();
      const work = new InflightWorkRegistry();
      const { store } = montar({}, work);
      await store.onApplicationBootstrap();
      let lenta!: (rows: PanelKillSwitch[]) => void;
      store.lecturas.mockImplementationOnce(
        () => new Promise<PanelKillSwitch[]>((resolve) => (lenta = resolve)),
      );
      await vi.advanceTimersByTimeAsync(KILL_SWITCH_REFRESH_MS);
      expect(work.countsByKind()).toEqual({ 'provider-kill-switch-refresh': 1 });

      work.startShutdown(() => undefined);
      lenta([]);
      await work.whenIdle();
      await vi.advanceTimersByTimeAsync(3 * KILL_SWITCH_REFRESH_MS);
      expect(store.lecturas).toHaveBeenCalledTimes(2);
    });

    it('si el apagado llega mientras arranca, no queda un temporizador vivo', async () => {
      vi.useFakeTimers();
      const work = new InflightWorkRegistry();
      const { store } = montar({}, work);
      let lenta!: (rows: PanelKillSwitch[]) => void;
      store.lecturas.mockImplementationOnce(
        () => new Promise<PanelKillSwitch[]>((resolve) => (lenta = resolve)),
      );
      const arranque = store.onApplicationBootstrap();
      work.startShutdown(() => undefined);
      lenta([]);
      await arranque;

      await vi.advanceTimersByTimeAsync(3 * KILL_SWITCH_REFRESH_MS);
      expect(store.lecturas).toHaveBeenCalledTimes(1);
    });
  });
});
