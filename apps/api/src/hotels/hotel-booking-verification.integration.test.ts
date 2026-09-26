import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { HotelBookingVerificationStore } from './hotel-booking-verification.store.js';

/**
 * El calendario de verificación (migración 0044) y su store contra Postgres real (docs/tbo/09
 * PR-4.7; 08 RNF-10).
 *
 * El store corre como la API: `app_user` (NOBYPASSRLS) con el tenant fijado. Como superusuario la
 * RLS no aplica y el aislamiento no probaría nada, así que `withTenant` baja de rol en cada
 * transacción. Lo que se prueba: que el SQL que el doble sólo compila corre de verdad, los CAS, el
 * filtro del barrido (vencidos, huérfanas, sólo hoteles abiertos con referencia) y los CHECK nuevos.
 *
 * Requiere las migraciones hasta la 0044. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

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

/** SQLSTATE con que falla `p`, o `'ok'`. */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'sin-codigo';
  }
}

const MIN = 60_000;

d('calendario de verificación de hoteles (0044) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new HotelBookingVerificationStore(database);
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `hotel-verif-${sfx}`;

  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let numero = 0;

  async function crearTenant(slug: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency') RETURNING id`,
      [slug],
    );
    return rows[0]!.id;
  }

  interface Orden {
    tenantId?: string;
    ref?: string | null;
    vertical?: string;
    status?: string;
    providerRaw?: string | null;
    /** Hace cuánto se escribió la orden. */
    escritaHace?: number;
  }

  async function orden(opts: Orden = {}): Promise<string> {
    numero += 1;
    const tenantId = opts.tenantId ?? agenciaA;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                             contact_info, total_amount, order_number, status, provider_raw,
                             provider_booking_ref, updated_at)
         VALUES ($1, $2, $3, jsonb_build_object('vertical', $4::text), '{}'::jsonb, '[]'::jsonb,
                 '{}'::jsonb, 34012, $5, $6, $7::jsonb, $8, now() - make_interval(secs => $9))
         RETURNING id`,
        [
          tenantId,
          usuario,
          PROVEEDOR,
          opts.vertical ?? 'hotels',
          numero,
          opts.status ?? 'pending',
          opts.providerRaw ?? null,
          opts.ref === undefined
            ? `STT${sfx.toUpperCase()}${String(numero).padStart(9, '0')}`
            : opts.ref,
          (opts.escritaHace ?? 0) / 1000,
        ],
      );
      await c.query('COMMIT');
      return rows[0]!.id;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    database.onModuleInit();
    agenciaA = await crearTenant(`verif-a-${sfx}`);
    agenciaB = await crearTenant(`verif-b-${sfx}`);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`verif-${sfx}@test.local`],
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

  it('abre el calendario una sola vez y lo lee con la orden', async () => {
    const id = await orden();
    const ahora = Date.now();

    const primera = await store.startCalendar(agenciaA, id, {
      anchorAt: ahora,
      step: 0,
      nextAt: ahora + 2 * MIN,
    });
    const segunda = await store.startCalendar(agenciaA, id, {
      anchorAt: ahora + MIN,
      step: 0,
      nextAt: ahora + 3 * MIN,
    });

    expect({ primera, segunda }).toEqual({ primera: true, segunda: false });
    expect(await store.findTarget(agenciaA, id)).toMatchObject({
      orderId: id,
      provider: PROVEEDOR,
      userId: usuario,
      open: true,
      anchorAt: ahora,
      step: 0,
      nextAt: ahora + 2 * MIN,
    });
    const { rows } = await pool.query<{ sub_status: string }>(
      'SELECT sub_status FROM hotel_order_tracking WHERE order_id = $1',
      [id],
    );
    expect(rows).toEqual([{ sub_status: 'create-uncertain' }]);
  });

  it('una fila de seguimiento sin calendario (otra escritura previa) sí lo recibe', async () => {
    const id = await orden();
    await pool.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, provider_status, provider_status_at, provider_status_source)
       VALUES ($1, $2, 'Confirmed', now(), 'book')`,
      [id, agenciaA],
    );

    expect(
      await store.startCalendar(agenciaA, id, {
        anchorAt: Date.now(),
        step: 1,
        nextAt: Date.now(),
      }),
    ).toBe(true);
  });

  it('avanza sólo desde el paso guardado, y detiene el calendario con el estado leído', async () => {
    const id = await orden();
    const ahora = Date.now();
    await store.startCalendar(agenciaA, id, { anchorAt: ahora, step: 0, nextAt: ahora });

    const desdeOtroPaso = await store.advance(agenciaA, id, 1, { step: 2, nextAt: null });
    const avanza = await store.advance(agenciaA, id, 0, { step: 1, nextAt: ahora + 5 * MIN });
    const detiene = await store.advance(agenciaA, id, 1, {
      step: 2,
      nextAt: null,
      subStatus: 'unknown',
      providerStatus: { value: 'OnHold', at: ahora },
    });

    expect({ desdeOtroPaso, avanza, detiene }).toEqual({
      desdeOtroPaso: false,
      avanza: true,
      detiene: true,
    });
    const { rows } = await pool.query(
      `SELECT verify_step, verify_next_at, sub_status, provider_status, provider_status_source
         FROM hotel_order_tracking WHERE order_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        verify_step: 2,
        verify_next_at: null,
        sub_status: 'unknown',
        provider_status: 'OnHold',
        provider_status_source: 'verify',
      },
    ]);
  });

  it('el barrido ve los pasos vencidos y las huérfanas, sólo hoteles abiertos con referencia y del tenant', async () => {
    const ahora = Date.now();
    const vencida = await orden();
    await store.startCalendar(agenciaA, vencida, {
      anchorAt: ahora - 20 * MIN,
      step: 1,
      nextAt: ahora - 15 * MIN,
    });
    const aTiempo = await orden();
    await store.startCalendar(agenciaA, aTiempo, {
      anchorAt: ahora,
      step: 0,
      nextAt: ahora + 2 * MIN,
    });
    const detenida = await orden({ escritaHace: 60 * MIN });
    await store.startCalendar(agenciaA, detenida, { anchorAt: ahora, step: 0, nextAt: ahora });
    await store.advance(agenciaA, detenida, 0, { step: 4, nextAt: null });
    const huerfana = await orden({ escritaHace: 30 * MIN });
    const reciente = await orden({ escritaHace: MIN });
    const consolidada = await orden({
      escritaHace: 30 * MIN,
      status: 'confirmed',
      providerRaw: '{"phase":"create"}',
    });
    const vuelo = await orden({ escritaHace: 30 * MIN, vertical: 'flights' });
    const sinReferencia = await orden({ escritaHace: 30 * MIN, ref: null });
    const deOtro = await orden({ tenantId: agenciaB, escritaHace: 30 * MIN });

    const query = { dueBefore: ahora - 5 * MIN, orphanBefore: ahora - 7.5 * MIN, limit: 50 };
    const vistasPorA = (await store.listDue(agenciaA, query)).map((t) => t.orderId);
    const vistasPorB = (await store.listDue(agenciaB, query)).map((t) => t.orderId);

    expect(vistasPorA).toEqual(expect.arrayContaining([vencida, huerfana]));
    for (const id of [aTiempo, detenida, reciente, consolidada, vuelo, sinReferencia, deOtro]) {
      expect(vistasPorA).not.toContain(id);
    }
    expect(vistasPorB).toEqual([deOtro]);
    expect(await store.findTarget(agenciaB, vencida)).toBeUndefined();
  });

  it('una agencia no puede colgarle un calendario a la orden de otra', async () => {
    const deA = await orden();

    // La policy acepta la fila (es de B) y la FK (order_id, tenant_id) la rechaza.
    expect(
      await sqlstate(store.startCalendar(agenciaB, deA, { anchorAt: 0, step: 0, nextAt: 0 })),
    ).toBe('23503');
    expect(await store.advance(agenciaB, deA, 0, { step: 1, nextAt: null })).toBe(false);
  });

  it('los CHECK de 0044: paso y ancla juntos, y nada programado sin calendario', async () => {
    const id = await orden();
    const insertar = (columnas: string, valores: string) =>
      sqlstate(
        pool.query(
          `INSERT INTO hotel_order_tracking (order_id, tenant_id, ${columnas}) VALUES ($1, $2, ${valores})`,
          [id, agenciaA],
        ),
      );

    // 23514 = check_violation.
    expect({
      pasoSinAncla: await insertar('verify_step', '0'),
      anclaSinPaso: await insertar('verify_anchor_at', 'now()'),
      programadoSinCalendario: await insertar('verify_next_at', 'now()'),
      pasoNegativo: await insertar('verify_anchor_at, verify_step', 'now(), -1'),
    }).toEqual({
      pasoSinAncla: '23514',
      anclaSinPaso: '23514',
      programadoSinCalendario: '23514',
      pasoNegativo: '23514',
    });
  });
});

// ---------------------------------------------------------------------------
// Sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no puede contar como
// verde. Esto vigila lo que el bloque de arriba da por supuesto de la migración.
// ---------------------------------------------------------------------------

describe('calendario de verificación 0044, sin base de datos', () => {
  const texto = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'db',
      'migrations',
      '0044_hotel_booking_verification.sql',
    ),
    'utf8',
  ).replace(/--.*$/gm, '');

  it('agrega ancla, paso y próxima hora a la fila de seguimiento, sin tabla nueva', () => {
    expect(texto).toMatch(/ADD COLUMN verify_anchor_at TIMESTAMPTZ/);
    expect(texto).toMatch(/ADD COLUMN verify_step\s+SMALLINT CHECK \(verify_step >= 0\)/);
    expect(texto).toMatch(/ADD COLUMN verify_next_at\s+TIMESTAMPTZ/);
    expect(texto).not.toMatch(/CREATE TABLE/);
  });

  it('paso y ancla van juntos, y nada se programa sin calendario', () => {
    expect(texto).toMatch(/CHECK \(\(verify_anchor_at IS NULL\) = \(verify_step IS NULL\)\)/);
    expect(texto).toMatch(/CHECK \(verify_next_at IS NULL OR verify_anchor_at IS NOT NULL\)/);
  });

  it('el barrido busca los vencidos por un índice parcial', () => {
    expect(texto).toMatch(
      /CREATE INDEX idx_hotel_order_tracking_verify_due\s+ON hotel_order_tracking \(verify_next_at\)\s+WHERE verify_next_at IS NOT NULL;/,
    );
  });
});
