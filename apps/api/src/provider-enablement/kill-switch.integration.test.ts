import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { HOTEL_EVENTS } from '../hotels/hotel-events.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import {
  KILL_SWITCH_CLEARED_EVENT,
  KILL_SWITCH_SET_EVENT,
  KillSwitchStore,
} from './kill-switch.store.js';
import type { ProviderEnablementService } from './provider-enablement.service.js';
import { ProviderHealthService } from './provider-health.service.js';

/**
 * El apagado de emergencia del panel contra Postgres de verdad (0077).
 *
 * Lo que los tests sin base no pueden probar: que la RLS deja leer a cualquiera y escribir sólo al
 * superadmin de la plataforma y a su nombre, los CHECK, que el apagado y su `domain_event` entran o
 * no entran juntos, que el breaker lo aplica al confirmar (y otra réplica al releer) y que los
 * avisos de cuenta se cuentan con la RLS del superadmin.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS): como superusuario la RLS no aplicaría
 * y no probaría nada. El superusuario sólo siembra y mira. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

/** Una sentencia de `ensayo` que corre como el superusuario que siembra, no como `app_user`. */
const SUPERUSUARIO = Symbol('superusuario');

/** `DatabaseService` que entra como `app_user`, el rol de la API. */
class ComoAppUser extends DatabaseService {
  override async withRequestContext<T>(
    ctx: { userId?: string; tenantId?: string },
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      if (ctx.userId) {
        await sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
      }
      if (ctx.tenantId) {
        await sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`.execute(trx);
      }
      return fn(trx);
    });
  }
}

/** Una auditoría que escribe el evento y después falla: la transacción entera tiene que caerse. */
class AuditoriaQueFalla extends AuditService {
  override async emitWithin(trx: Transaction<DB>, event: AuditEvent): Promise<void> {
    await super.emitWithin(trx, event);
    throw new Error('la auditoría no entró');
  }
}

d('provider_kill_switches (0077) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  // Códigos únicos por corrida: la base de CI es compartida y un apagado es de toda la plataforma.
  const A = `ks-a-${sfx}`;
  const B = `ks-b-${sfx}`;

  let plataforma: string;
  let consolidador: string;
  let superadmin: string;
  let admin: string;

  async function usuario(email: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [email],
    );
    const id = rows[0]!.id;
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, id, role],
    );
    return id;
  }

  /**
   * Qué pasa con una sentencia, sin dejar nada: `ok:<filas>` o el SQLSTATE. Como `app_user` con el
   * usuario dado (o sin usuario, `null`), o como el superusuario que siembra ({@link SUPERUSUARIO})
   * para los CHECK.
   */
  async function ensayo(
    quien: string | null | typeof SUPERUSUARIO,
    text: string,
    values: unknown[] = [],
  ): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (quien !== SUPERUSUARIO) {
        await c.query('SET LOCAL ROLE app_user');
        if (quien !== null) {
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [quien]);
        }
      }
      const res = await c.query(text, values);
      return `ok:${res.command === 'SELECT' ? res.rows.length : (res.rowCount ?? 0)}`;
    } catch (e) {
      return (e as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /**
   * Los apagados y los eventos de los códigos de esta corrida. Borrar de `domain_events` sólo lo
   * puede el superusuario (0015 se lo quita a `app_user`), y sólo lo propio: la base es compartida.
   */
  async function limpiar(): Promise<void> {
    await pool.query('DELETE FROM provider_kill_switches WHERE provider_code = ANY($1::text[])', [
      [A, B],
    ]);
    await pool.query(
      `DELETE FROM domain_events
        WHERE aggregate_id = ANY($1::text[]) OR payload->>'provider' = ANY($1::text[])`,
      [[A, B]],
    );
  }

  interface EventoFila {
    event_type: string;
    tenant_id: string | null;
    actor_user_id: string | null;
    payload: Record<string, unknown>;
  }

  async function eventos(code: string): Promise<EventoFila[]> {
    const { rows } = await pool.query<EventoFila>(
      `SELECT event_type, tenant_id, actor_user_id, payload FROM domain_events
        WHERE aggregate_type = 'provider_kill_switch' AND aggregate_id = $1
        ORDER BY occurred_at, id`,
      [code],
    );
    return rows;
  }

  beforeAll(async () => {
    database.onModuleInit();
    plataforma = await platformRootId(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'consolidator', $2) RETURNING id`,
      [`ks-cons-${sfx}`, plataforma],
    );
    consolidador = rows[0]!.id;
    superadmin = await usuario(`ks-root-${sfx}@example.com`, plataforma, 'superadmin');
    admin = await usuario(`ks-admin-${sfx}@example.com`, consolidador, 'consolidator_admin');
  });

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await limpiar();
  });

  afterAll(async () => {
    await limpiar();
    await pool.query('DELETE FROM memberships WHERE user_id = ANY($1::uuid[])', [
      [superadmin, admin],
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[superadmin, admin]]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [consolidador]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('RLS y CHECK', () => {
    const INSERTAR = `INSERT INTO provider_kill_switches (provider_code, level, reason, set_by)
                      VALUES ($1, 'all', 'Incidente de prueba', $2)`;

    it('quien no es superadmin no inserta: 42501', async () => {
      expect(await ensayo(admin, INSERTAR, [A, admin])).toBe('42501');
      expect(await ensayo(null, INSERTAR, [A, superadmin])).toBe('42501');
    });

    it('el superadmin inserta, pero sólo a su nombre', async () => {
      expect(await ensayo(superadmin, INSERTAR, [A, superadmin])).toBe('ok:1');
      expect(await ensayo(superadmin, INSERTAR, [A, admin])).toBe('42501');
    });

    it('cualquiera lee, aun sin usuario (el breaker); sólo el superadmin borra', async () => {
      await pool.query(INSERTAR, [A, superadmin]);

      expect(
        await ensayo(null, 'SELECT 1 FROM provider_kill_switches WHERE provider_code = $1', [A]),
      ).toBe('ok:1');
      expect(
        await ensayo(admin, 'DELETE FROM provider_kill_switches WHERE provider_code = $1', [A]),
      ).toBe('ok:0');
      expect(
        await ensayo(
          admin,
          `UPDATE provider_kill_switches SET level = 'sales' WHERE provider_code = $1`,
          [A],
        ),
      ).toBe('ok:0');
      expect(
        await ensayo(superadmin, 'DELETE FROM provider_kill_switches WHERE provider_code = $1', [
          A,
        ]),
      ).toBe('ok:1');
    });

    it.each([
      [
        'un nivel que no existe',
        `INSERT INTO provider_kill_switches (provider_code, level, reason, set_by) VALUES ($1, 'todo', 'Incidente', $2)`,
      ],
      [
        'un motivo en blanco',
        `INSERT INTO provider_kill_switches (provider_code, level, reason, set_by) VALUES ($1, 'all', '   ', $2)`,
      ],
      [
        'un vencimiento que no es futuro',
        `INSERT INTO provider_kill_switches (provider_code, level, reason, set_by, expires_at) VALUES ($1, 'all', 'Incidente', $2, now())`,
      ],
      [
        'un código mal formado',
        `INSERT INTO provider_kill_switches (provider_code, level, reason, set_by) VALUES ('-' || $1, 'all', 'Incidente', $2)`,
      ],
    ])('CHECK: %s', async (_q, text) => {
      expect(await ensayo(SUPERUSUARIO, text, [A, superadmin])).toBe('23514');
    });
  });

  describe('poner y levantar por el almacén', () => {
    it('el apagado y su evento entran en la misma transacción, en la plataforma', async () => {
      const store = new KillSwitchStore(database, new AuditService(database));

      const k = await store.set(superadmin, A, {
        level: 'sales',
        reason: 'El proveedor cobra de más',
        expiresInMinutes: 60,
      });

      expect(k).toMatchObject({
        providerCode: A,
        level: 'sales',
        setBy: superadmin,
        setByEmail: `ks-root-${sfx}@example.com`,
      });
      expect(k.expiresAt!.getTime() - k.setAt.getTime()).toBe(60 * 60_000);
      const { rows } = await pool.query(
        'SELECT level, set_by FROM provider_kill_switches WHERE provider_code = $1',
        [A],
      );
      expect(rows).toEqual([{ level: 'sales', set_by: superadmin }]);
      const evs = await eventos(A);
      expect(evs).toEqual([
        {
          event_type: KILL_SWITCH_SET_EVENT,
          tenant_id: plataforma,
          actor_user_id: superadmin,
          payload: {
            providerCode: A,
            level: 'sales',
            reason: 'El proveedor cobra de más',
            expiresAt: k.expiresAt!.toISOString(),
            before: null,
          },
        },
      ]);
    });

    it('si la auditoría no entra, el apagado tampoco', async () => {
      const store = new KillSwitchStore(database, new AuditoriaQueFalla(database));

      await expect(
        store.set(superadmin, A, {
          level: 'all',
          reason: 'Prueba de atomicidad',
          expiresInMinutes: null,
        }),
      ).rejects.toThrow('la auditoría no entró');

      const { rows } = await pool.query(
        'SELECT 1 FROM provider_kill_switches WHERE provider_code = $1',
        [A],
      );
      expect(rows).toEqual([]);
      expect(await eventos(A)).toEqual([]);
      expect(store.panelLevel(A)).toBeUndefined();
    });

    it('quien no es superadmin no apaga ni por el almacén: lo para la base', async () => {
      const store = new KillSwitchStore(database, new AuditService(database));
      await expect(
        store.set(admin, A, {
          level: 'all',
          reason: 'Intento sin permiso',
          expiresInMinutes: null,
        }),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await eventos(A)).toEqual([]);
    });

    it('el breaker lo aplica al confirmar, otra réplica al releer, y levantarlo lo devuelve', async () => {
      const store = new KillSwitchStore(database, new AuditService(database));
      const breaker = new CircuitBreakerService(store);
      const otraReplica = new KillSwitchStore(database, new AuditService(database));
      const ok = (): Promise<string> => Promise.resolve('ok');

      await store.set(superadmin, A, {
        level: 'sales',
        reason: 'Responde mal',
        expiresInMinutes: null,
      });

      await expect(breaker.execute(A, ok, { scope: 'sales' })).rejects.toMatchObject({
        reason: 'kill-switch',
        sentToProvider: false,
      });
      await expect(breaker.execute(A, ok, { scope: 'post-sale' })).resolves.toBe('ok');
      await expect(breaker.execute(B, ok, { scope: 'sales' })).resolves.toBe('ok');

      expect(otraReplica.panelLevel(A)).toBeUndefined();
      await otraReplica.refresh();
      expect(otraReplica.panelLevel(A)).toBe('sales');

      const antes = await store.clear(superadmin, A, 'Ya responde bien');
      expect(antes).toMatchObject({ level: 'sales', reason: 'Responde mal' });
      await expect(breaker.execute(A, ok, { scope: 'sales' })).resolves.toBe('ok');
      expect((await eventos(A)).map((e) => [e.event_type, e.payload['reason']])).toEqual([
        [KILL_SWITCH_SET_EVENT, 'Responde mal'],
        [KILL_SWITCH_CLEARED_EVENT, 'Ya responde bien'],
      ]);
    });

    it('un apagado vencido no se lee, no se levanta y el próximo lo reemplaza sin antes', async () => {
      await pool.query(
        `INSERT INTO provider_kill_switches (provider_code, level, reason, set_by, set_at, expires_at)
         VALUES ($1, 'all', 'Incidente de ayer', $2, now() - interval '2 days', now() - interval '1 day')`,
        [A, superadmin],
      );
      const store = new KillSwitchStore(database, new AuditService(database));

      await store.refresh();
      expect(store.panelLevel(A)).toBeUndefined();
      await expect(store.clear(superadmin, A, null)).resolves.toBeUndefined();

      await store.set(superadmin, A, {
        level: 'sales',
        reason: 'Incidente de hoy',
        expiresInMinutes: 1440,
      });
      const evs = await eventos(A);
      expect(evs).toHaveLength(1);
      expect(evs[0]?.payload['before']).toBeNull();
      expect(store.panelLevel(A)).toBe('sales');
    });
  });

  it('la salud cuenta los avisos de cuenta de 24 h con la RLS del superadmin', async () => {
    const insertar = (code: string, edad: string) =>
      pool.query(
        `INSERT INTO domain_events (tenant_id, event_type, aggregate_type, payload, occurred_at)
         VALUES ($1, $2, 'provider_account', jsonb_build_object('provider', $3::text, 'vertical', 'hotels'),
                 now() - $4::interval)`,
        [consolidador, HOTEL_EVENTS.providerAccountIssue, code, edad],
      );
    await insertar(A, '1 hour');
    await insertar(A, '23 hours');
    await insertar(A, '25 hours');
    await insertar(B, '2 hours');

    const store = new KillSwitchStore(database, new AuditService(database));
    const enablement = {
      registered: () => [
        { code: A, vertical: 'hotels', callPolicy: 'always' },
        { code: B, vertical: 'hotels', callPolicy: 'always' },
      ],
    } as unknown as ProviderEnablementService;
    const health = new ProviderHealthService(
      database,
      enablement,
      new CircuitBreakerService(store),
      store,
      new AuditService(database),
    );

    const vista = await health.health(superadmin);
    expect(vista.map((p) => [p.code, p.accountIssues24h])).toEqual([
      [A, 2],
      [B, 1],
    ]);
    // Un usuario sin el subárbol del consolidador no los ve.
    const ajeno = await health.health('00000000-0000-4000-8000-000000000000');
    expect(ajeno.map((p) => p.accountIssues24h)).toEqual([0, 0]);
  });
});
