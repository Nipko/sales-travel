import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { HotelOrderCancellationStore } from './hotel-order-cancellation.store.js';
import { StaleCancelClaimStore } from './stale-cancel-claim.store.js';

/**
 * Los claims de cancelación en vuelo contra Postgres real (HARD-1; 0021 y 0037): qué lista el
 * barrido, el CAS que los vence y que el seguimiento de hoteles se escribe en la MISMA transacción.
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado; el
 * superusuario sólo siembra y mira. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const MIN = 60_000;

/** `DatabaseService` que entra como `app_user`, el rol de la API. */
class ComoAppUser extends DatabaseService {
  override async withTenant<T>(
    tenantId: string,
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      await sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
  }
}

d('claims de cancelación vencidos contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new StaleCancelClaimStore(database);
  const tracking = new HotelOrderCancellationStore(database);
  const sfx = randomBytes(4).toString('hex');

  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let numero = 0;

  async function crearTenant(slug: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
       VALUES ($1::text, $1::text, 'CO', 'USD', 'agency') RETURNING id`,
      [slug],
    );
    return rows[0]!.id;
  }

  /** Una orden `pending` con su claim de cancelación, tomado hace `minutos`. */
  async function claim(
    tenantId: string,
    minutos: number,
    status: 'pending' | 'failed' = 'pending',
  ): Promise<{ orderId: string; operationId: string }> {
    numero += 1;
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                           selected_offer, passengers, contact_info, total_amount, currency,
                           order_number, status)
       VALUES ($1, $2, 'stub-air', $3, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
               1000, 'USD', $4, 'pending')
       RETURNING id`,
      [tenantId, usuario, `PNR${sfx}${numero}`.toUpperCase(), 900_000 + numero],
    );
    const orderId = order.rows[0]!.id;
    // `updated_at` explícito en el INSERT: el trigger de 0021 sólo lo mueve en un UPDATE.
    const op = await pool.query<{ id: string }>(
      `INSERT INTO order_operations (tenant_id, order_id, type, status, result, actor_user_id,
                                     created_at, updated_at)
       VALUES ($1, $2, 'cancel', $3,
               '{"status":"pending","outcome":"UNVERIFIED","priorOrderStatus":"confirmed"}'::jsonb,
               $4, now() - make_interval(mins => $5), now() - make_interval(mins => $5))
       RETURNING id`,
      [tenantId, orderId, status, usuario, minutos],
    );
    return { orderId, operationId: op.rows[0]!.id };
  }

  async function operacion(id: string) {
    const { rows } = await pool.query<{
      status: string;
      last_error: string | null;
      result: Record<string, unknown>;
    }>('SELECT status, last_error, result FROM order_operations WHERE id = $1', [id]);
    return rows[0]!;
  }

  const corte = (): number => Date.now() - 15 * MIN;

  beforeAll(async () => {
    database.onModuleInit();
    agenciaA = await crearTenant(`sc-a-${sfx}`);
    agenciaB = await crearTenant(`sc-b-${sfx}`);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`sc-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of [agenciaA, agenciaB]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('lista sólo los claims pendientes del tenant tomados antes del corte, el más viejo primero', async () => {
    const viejo = await claim(agenciaA, 40);
    const menosViejo = await claim(agenciaA, 20);
    await claim(agenciaA, 1);
    await claim(agenciaA, 60, 'failed');
    await claim(agenciaB, 60);

    const stale = await store.listStale(agenciaA, { claimedBefore: corte(), limit: 10 });

    expect(stale.map((c) => c.operationId)).toEqual([viejo.operationId, menosViejo.operationId]);
    expect(stale[0]).toEqual({
      operationId: viejo.operationId,
      orderId: viejo.orderId,
      provider: 'stub-air',
      userId: usuario,
      actorUserId: usuario,
      priorStatus: 'confirmed',
    });
    expect(await store.listStale(agenciaA, { claimedBefore: corte(), limit: 1 })).toHaveLength(1);
  });

  it('lo vence con su CAS, y la escritura que lo acompaña va en la misma transacción', async () => {
    const c = await claim(agenciaA, 30);
    const expiry = {
      claimedBefore: corte(),
      lastError: 'Cancelación no verificada; requiere conciliación.',
      result: { status: 'failed', outcome: 'UNVERIFIED', staleClaim: true },
    };

    const ok = await store.expire(agenciaA, c, expiry, (trx) =>
      tracking.writeOutcome(trx, agenciaA, c.orderId, {
        at: Date.now(),
        source: 'cancel',
        subStatus: 'cancel-unverified',
        openCalendar: { anchorAt: Date.now(), nextAt: Date.now() + 2 * MIN },
      }),
    );

    expect(ok).toBe(true);
    expect(await operacion(c.operationId)).toEqual({
      status: 'failed',
      last_error: 'Cancelación no verificada; requiere conciliación.',
      result: { status: 'failed', outcome: 'UNVERIFIED', staleClaim: true },
    });
    const t = await pool.query<{ sub_status: string; cancel_verify_step: number }>(
      'SELECT sub_status, cancel_verify_step FROM hotel_order_tracking WHERE order_id = $1',
      [c.orderId],
    );
    expect(t.rows[0]).toEqual({ sub_status: 'cancel-unverified', cancel_verify_step: 0 });
    // Ya no está en vuelo: una segunda corrida no lo toca.
    expect(await store.expire(agenciaA, c, expiry)).toBe(false);
  });

  it('no vence un claim tomado después del corte (un reintento que lo refrescó)', async () => {
    const c = await claim(agenciaA, 30);
    const claimedBefore = corte();
    // El reintento lo toma de nuevo: el trigger mueve `updated_at` a ahora.
    await pool.query(`UPDATE order_operations SET last_error = NULL WHERE id = $1`, [
      c.operationId,
    ]);

    expect(await store.expire(agenciaA, c, { claimedBefore, lastError: 'x', result: {} })).toBe(
      false,
    );
    expect((await operacion(c.operationId)).status).toBe('pending');
  });

  it('si la escritura que lo acompaña falla, el claim sigue en vuelo', async () => {
    const c = await claim(agenciaA, 30);

    await expect(
      store.expire(agenciaA, c, { claimedBefore: corte(), lastError: 'x', result: {} }, () =>
        Promise.reject(new Error('base caída')),
      ),
    ).rejects.toThrow('base caída');
    expect((await operacion(c.operationId)).status).toBe('pending');
  });

  it('RLS: el claim de otra agencia no se lista ni se vence', async () => {
    const ajeno = await claim(agenciaB, 30);

    const stale = await store.listStale(agenciaA, { claimedBefore: corte(), limit: 50 });
    expect(stale.map((c) => c.operationId)).not.toContain(ajeno.operationId);
    expect(
      await store.expire(agenciaA, ajeno, { claimedBefore: corte(), lastError: 'x', result: {} }),
    ).toBe(false);
    expect((await operacion(ajeno.operationId)).status).toBe('pending');
  });
});
