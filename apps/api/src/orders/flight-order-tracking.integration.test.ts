import { randomBytes } from 'node:crypto';
import type { OrderView } from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { FlightOrderTrackingStore, flightReadOf } from './flight-order-tracking.store.js';

/**
 * El seguimiento de las órdenes de vuelo (0082) contra Postgres real.
 *
 * Lo que se prueba sólo significa algo bajo RLS: el aislamiento entre agencias, la FK compuesta que
 * no deja colgar filas de una orden ajena, los CHECK y la transición de un documento entre lecturas.
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado; el
 * superusuario sólo siembra y mira. Requiere las migraciones hasta la 0082. Se SALTA sin PGHOST.
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

const TIQUETE = '0457123456789';
const EMD = '1251934576908';

function vista(extra: Partial<OrderView> = {}): OrderView {
  return { found: true, airlineLocators: [], warnings: [], ...extra };
}

d('seguimiento de órdenes de vuelo (0082) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new FlightOrderTrackingStore(database);
  const sfx = randomBytes(4).toString('hex');

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  /** Una orden de vuelo del tenant, insertada como `app_user`, como la saga. */
  async function orden(tenantId: string): Promise<string> {
    numero += 1;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                             selected_offer, passengers, contact_info, total_amount, order_number,
                             status, provider_raw)
         VALUES ($1, $2, 'vuelos-${sfx}', $3, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
                 34012, $4, 'confirmed', '{}'::jsonb)
         RETURNING id`,
        [tenantId, usuario, `P${sfx}${numero}`.toUpperCase().slice(0, 12), numero],
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

  /** Ejecuta `text` como `app_user` con el tenant fijado. */
  async function comoApp(tenantId: string, text: string, values: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const r = await c.query(text, values);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    database.onModuleInit();
    consolidador = await crearTenant(`ft-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`ft-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`ft-b-${sfx}`, 'agency', consolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`ft-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of [agenciaA, agenciaB, consolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('app_user no es superusuario ni salta la RLS', async () => {
    const rol = await database.withTenant(agenciaA, async (trx) => {
      const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(trx);
      return r.rows[0];
    });
    // Si esto falla, los casos de aislamiento de abajo no prueban nada.
    expect(rol).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('una lectura queda guardada y se lee igual: localizadores, documentos y plazo', async () => {
    const ordenA = await orden(agenciaA);
    const cambios = await store.recordRead(
      agenciaA,
      ordenA,
      flightReadOf(
        vista({
          airlineLocators: [
            { carrierCode: 'LA', locator: 'XKCD12' },
            { carrierCode: 'AV', locator: 'QWERT9' },
          ],
          documents: [
            {
              number: TIQUETE,
              kind: 'TICKET',
              status: 'ISSUED',
              travelerIndex: 0,
              providerStatusCode: 'TE',
            },
            {
              number: EMD,
              kind: 'EMD',
              status: 'ISSUED',
              travelerIndex: 1,
              providerStatusCode: 'ME',
            },
          ],
          ticketingDeadline: { date: '2026-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
        }),
        new Date('2026-10-13T15:00:00.000Z'),
      ),
    );
    expect(cambios).toEqual({ added: 2, statusChanged: 0 });

    const leido = (await store.listTracking(agenciaA, [ordenA])).get(ordenA);
    expect(leido).toEqual({
      orderId: ordenA,
      airlineLocators: [
        { carrierCode: 'LA', locator: 'XKCD12' },
        { carrierCode: 'AV', locator: 'QWERT9' },
      ],
      documents: [
        {
          number: TIQUETE,
          kind: 'TICKET',
          travelerIndex: 0,
          status: 'ISSUED',
          providerStatusCode: 'TE',
        },
        { number: EMD, kind: 'EMD', travelerIndex: 1, status: 'ISSUED', providerStatusCode: 'ME' },
      ],
      // La fecha sale como texto: un `DATE` leído como `Date` de JS cae a medianoche local y en
      // Bogotá se corre al día anterior.
      ticketingDeadline: { date: '2026-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
      lastReadAt: new Date('2026-10-13T15:00:00.000Z'),
    });

    // Una lectura filtrada que no trae nada no borra lo guardado.
    expect(await store.recordRead(agenciaA, ordenA, flightReadOf(vista(), new Date()))).toEqual({
      added: 0,
      statusChanged: 0,
    });
    const otraVez = (await store.listTracking(agenciaA, [ordenA])).get(ordenA);
    expect(otraVez?.airlineLocators).toHaveLength(2);
    expect(otraVez?.documents).toHaveLength(2);
    expect(otraVez?.ticketingDeadline).toEqual(leido?.ticketingDeadline);
  });

  it('un plazo UTC guarda su instante', async () => {
    const ordenA = await orden(agenciaA);
    await store.recordRead(
      agenciaA,
      ordenA,
      flightReadOf(
        vista({ ticketingDeadline: { date: '2026-10-20', time: '20:00', zone: 'UTC' } }),
        new Date(),
      ),
    );
    expect((await store.listTracking(agenciaA, [ordenA])).get(ordenA)?.ticketingDeadline).toEqual({
      date: '2026-10-20',
      time: '20:00',
      zone: 'UTC',
      at: new Date('2026-10-20T20:00:00.000Z'),
    });
  });

  it('la transición entre lecturas: devuelto con su instante, y no vuelve a emitido', async () => {
    const ordenA = await orden(agenciaA);
    const emitido = { number: TIQUETE, kind: 'TICKET' as const, status: 'ISSUED' as const };
    const t1 = new Date('2026-10-13T15:00:00.000Z');
    const t2 = new Date('2026-10-14T15:00:00.000Z');
    await store.recordRead(agenciaA, ordenA, flightReadOf(vista({ documents: [emitido] }), t1));

    expect(
      await store.recordRead(
        agenciaA,
        ordenA,
        flightReadOf(
          vista({ documents: [{ ...emitido, status: 'REFUNDED', providerStatusCode: 'TR' }] }),
          t2,
        ),
      ),
    ).toEqual({ added: 0, statusChanged: 1 });
    // El TE viejo de un conjuntivo, o una lectura atrasada, no lo reactiva.
    expect(
      await store.recordRead(
        agenciaA,
        ordenA,
        flightReadOf(vista({ documents: [emitido] }), new Date()),
      ),
    ).toEqual({ added: 0, statusChanged: 0 });

    const { rows } = await pool.query(
      `SELECT status, provider_status_code, issued_at, refunded_at, voided_at
         FROM order_flight_documents WHERE order_id = $1`,
      [ordenA],
    );
    expect(rows).toEqual([
      {
        status: 'REFUNDED',
        provider_status_code: 'TR',
        issued_at: t1,
        refunded_at: t2,
        voided_at: null,
      },
    ]);
  });

  it('dos lecturas a la vez de la misma orden no cuentan dos veces el mismo alta', async () => {
    const ordenA = await orden(agenciaA);
    const read = flightReadOf(
      vista({ documents: [{ number: TIQUETE, kind: 'TICKET', status: 'ISSUED' }] }),
      new Date(),
    );
    const resultados = await Promise.all([
      store.recordRead(agenciaA, ordenA, read),
      store.recordRead(agenciaA, ordenA, read),
      store.recordRead(agenciaA, ordenA, read),
    ]);
    expect(resultados.reduce((n, r) => n + r.added, 0)).toBe(1);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM order_flight_documents WHERE order_id = $1',
      [ordenA],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  describe('aislamiento entre agencias', () => {
    let ordenA: string;

    beforeAll(async () => {
      ordenA = await orden(agenciaA);
      await store.recordRead(
        agenciaA,
        ordenA,
        flightReadOf(
          vista({
            airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
            documents: [{ number: TIQUETE, kind: 'TICKET', status: 'ISSUED' }],
          }),
          new Date(),
        ),
      );
    });

    it('la agencia B no lee el seguimiento ni los documentos de la A, aunque pida su id', async () => {
      expect(await store.listTracking(agenciaB, [ordenA])).toEqual(new Map());
      const tracking = await comoApp(
        agenciaB,
        'SELECT count(*)::int AS n FROM flight_order_tracking WHERE order_id = $1',
        [ordenA],
      );
      const documentos = await comoApp(
        agenciaB,
        'SELECT count(*)::int AS n FROM order_flight_documents WHERE order_id = $1',
        [ordenA],
      );
      expect([tracking.rows[0], documentos.rows[0]]).toEqual([{ n: 0 }, { n: 0 }]);
      // Y la A sí.
      expect((await store.listTracking(agenciaA, [ordenA])).get(ordenA)?.documents).toHaveLength(1);
    });

    it('la agencia B no puede colgar ni pisar filas de la orden de la A', async () => {
      const lectura = flightReadOf(
        vista({ documents: [{ number: EMD, kind: 'EMD', status: 'ISSUED' }] }),
        new Date(),
      );
      // Sobre el seguimiento que la A ya tiene, el upsert de la B choca con una fila que su policy
      // no le deja ver ni actualizar.
      expect(await sqlstate(store.recordRead(agenciaB, ordenA, lectura))).toBe('42501');
      // Sobre una orden de la A sin seguimiento, con su propio tenant_id: la FK compuesta no
      // encuentra (orden, B) en orders.
      const sinSeguimiento = await orden(agenciaA);
      expect(await sqlstate(store.recordRead(agenciaB, sinSeguimiento, lectura))).toBe('23503');
      expect((await store.listTracking(agenciaA, [sinSeguimiento])).size).toBe(0);
      // Con el tenant_id de la A: la policy no deja escribir una fila de otro tenant.
      expect(
        await sqlstate(
          comoApp(
            agenciaB,
            `INSERT INTO order_flight_documents (tenant_id, order_id, number, kind, status)
             VALUES ($1, $2, $3, 'TICKET', 'VOIDED')`,
            [agenciaA, ordenA, EMD],
          ),
        ),
      ).toBe('42501');
      // Y un UPDATE desde la B no ve la fila: no la toca.
      const r = await comoApp(
        agenciaB,
        `UPDATE order_flight_documents SET status = 'VOIDED' WHERE order_id = $1`,
        [ordenA],
      );
      expect(r.rowCount).toBe(0);
      const { rows } = await pool.query(
        'SELECT status FROM order_flight_documents WHERE order_id = $1',
        [ordenA],
      );
      expect(rows).toEqual([{ status: 'ISSUED' }]);
    });
  });

  it('los CHECK rechazan lo que no es un documento ni un plazo', async () => {
    const ordenA = await orden(agenciaA);
    const documento = (number: string, extra = '') =>
      sqlstate(
        comoApp(
          agenciaA,
          `INSERT INTO order_flight_documents (tenant_id, order_id, number, kind, status${extra === '' ? '' : ', provider_status_code'})
           VALUES ($1, $2, $3, 'TICKET', 'ISSUED'${extra === '' ? '' : ', $4'})`,
          extra === '' ? [agenciaA, ordenA, number] : [agenciaA, ordenA, number, extra],
        ),
      );
    const seguimiento = (columnas: string, valores: string) =>
      sqlstate(
        comoApp(
          agenciaA,
          `INSERT INTO flight_order_tracking (order_id, tenant_id, ${columnas})
           VALUES ($1, $2, ${valores})`,
          [ordenA, agenciaA],
        ),
      );

    // 23514 = check_violation.
    expect({
      corto: await documento('12345'),
      conjuntivo: await documento('1609786952746/47'),
      codigoLibre: await documento(TIQUETE, 'te'),
      fechaSinZona: await seguimiento('ticketing_deadline_date', `'2026-10-20'`),
      horaSinFecha: await seguimiento('ticketing_deadline_time', `'10:00'`),
      horaRara: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_time',
        `'2026-10-20', 'UTC', '24:00'`,
      ),
      instanteConHoraDeOficina: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_at',
        `'2026-10-20', 'PROVIDER_LOCAL', now()`,
      ),
      zonaRara: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone',
        `'2026-10-20', 'LOCAL'`,
      ),
      localizadoresNoLista: await seguimiento('airline_locators', `'{}'::jsonb`),
    }).toEqual({
      corto: '23514',
      conjuntivo: '23514',
      codigoLibre: '23514',
      fechaSinZona: '23514',
      horaSinFecha: '23514',
      horaRara: '23514',
      instanteConHoraDeOficina: '23514',
      zonaRara: '23514',
      localizadoresNoLista: '23514',
    });
    // Y un mismo número no se repite dentro de la orden (23505).
    expect(await documento(TIQUETE)).toBe('ok');
    expect(await documento(TIQUETE)).toBe('23505');
  });

  it('borrar la orden se lleva su seguimiento y sus documentos', async () => {
    const ordenA = await orden(agenciaA);
    await store.recordRead(
      agenciaA,
      ordenA,
      flightReadOf(
        vista({
          airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
          documents: [{ number: TIQUETE, kind: 'TICKET', status: 'ISSUED' }],
        }),
        new Date(),
      ),
    );
    await pool.query('DELETE FROM orders WHERE id = $1', [ordenA]);
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM flight_order_tracking WHERE order_id = $1)::int AS t,
              (SELECT count(*) FROM order_flight_documents WHERE order_id = $1)::int AS d`,
      [ordenA],
    );
    expect(rows[0]).toEqual({ t: 0, d: 0 });
  });
});
