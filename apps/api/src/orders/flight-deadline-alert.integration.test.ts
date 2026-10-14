import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailMessage, MailerService } from '../mail/mailer.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { FlightDeadlineAlertService } from './flight-deadline-alert.service.js';
import { FlightDeadlineAlertStore } from './flight-deadline-alert.store.js';
import { FlightOrderTrackingStore, flightReadOf } from './flight-order-tracking.store.js';

/**
 * El aviso del plazo de emisión por vencer (SAB-14, 0084) contra Postgres real.
 *
 * Lo que se prueba sólo significa algo con la base: los CHECK de la zona de la oficina, qué órdenes
 * elige el barrido bajo RLS (confirmadas, sin tiquete emitido, sin emisión en curso, dentro de la
 * ventana y sin el aviso), el CAS que hace el aviso idempotente aun con dos corridas a la vez, que
 * una lectura con otro instante vuelva a abrir los avisos, y a quién se le escribe. Todo lo que la
 * API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira. Requiere las
 * migraciones hasta la 0084. Se SALTA sin PGHOST.
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

/** SQLSTATE con que falla `p`, o `'ok'`. */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'sin-codigo';
  }
}

const HORA = 60 * 60 * 1000;

d('aviso del plazo de emisión (0084) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const tracking = new FlightOrderTrackingStore(database);
  const store = new FlightDeadlineAlertStore(database);
  const sfx = randomBytes(4).toString('hex');
  // El reloj de los casos: el barrido recibe `now`, la base guarda instantes absolutos.
  const AHORA = Date.now();

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let vendedor: string;
  let suspendido: string;
  let sinMembresia: string;
  let delConsolidador: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null, pais = 'CO') {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, $4, 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool)), pais],
    );
    return rows[0]!.id;
  }

  async function crearUsuario(nombre: string, estado = 'active'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id`,
      [`${nombre}-${sfx}@test.local`, estado],
    );
    return rows[0]!.id;
  }

  async function membresia(tenantId: string, userId: string, estado = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', $3)`,
      [tenantId, userId, estado],
    );
  }

  /** Una orden de vuelo, insertada como `app_user`, como la saga. */
  async function orden(
    tenantId: string,
    opts: { status?: string; userId?: string; test?: boolean } = {},
  ): Promise<string> {
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
         VALUES ($1, $2, 'vuelos-${sfx}', $3,
                 '{"origin":"BOG","destination":"LIM","departureDate":"2026-12-01"}'::jsonb,
                 $5::jsonb,
                 '[{"givenName":"Ana María","surname":"Ríos"}]'::jsonb,
                 '{"email":"pasajera@test.local"}'::jsonb,
                 34012, $4, $6, '{}'::jsonb)
         RETURNING id`,
        [
          tenantId,
          opts.userId ?? vendedor,
          `P${sfx}${numero}`.toUpperCase().slice(0, 12),
          numero,
          JSON.stringify({ provider: { environment: opts.test === true ? 'test' : 'live' } }),
          opts.status ?? 'confirmed',
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

  /** Lee la orden al proveedor con un plazo en la hora de la oficina (Bogotá, UTC-5). */
  async function leerPlazo(tenantId: string, orderId: string, at: number): Promise<void> {
    // La hora de pared de Bogotá del instante pedido, al minuto.
    const pared = new Date(Math.floor(at / 60_000) * 60_000 - 5 * HORA);
    await tracking.recordRead(
      tenantId,
      orderId,
      flightReadOf(
        {
          found: true,
          airlineLocators: [],
          warnings: [],
          ticketingDeadline: {
            date: pared.toISOString().slice(0, 10),
            time: pared.toISOString().slice(11, 16),
            zone: 'PROVIDER_LOCAL',
            timeZone: 'America/Bogota',
          },
        },
        new Date(AHORA),
      ),
    );
  }

  async function avisos(orderId: string) {
    const { rows } = await pool.query<{
      deadline_alerted_24h_at: Date | null;
      deadline_alerted_2h_at: Date | null;
      ticketing_deadline_at: Date | null;
    }>(
      `SELECT deadline_alerted_24h_at, deadline_alerted_2h_at, ticketing_deadline_at
         FROM flight_order_tracking WHERE order_id = $1`,
      [orderId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    database.onModuleInit();
    consolidador = await crearTenant(`fd-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`fd-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`fd-b-${sfx}`, 'agency', consolidador, 'BR');
    vendedor = await crearUsuario('vendedor');
    suspendido = await crearUsuario('suspendido', 'suspended');
    sinMembresia = await crearUsuario('sin-membresia');
    delConsolidador = await crearUsuario('del-consolidador');
    await membresia(agenciaA, vendedor);
    await membresia(agenciaB, vendedor);
    await membresia(agenciaA, suspendido);
    await membresia(consolidador, delConsolidador);
  });

  afterAll(async () => {
    const tenants = [agenciaA, agenciaB, consolidador].filter(Boolean);
    if (tenants.length > 0) {
      await pool.query('DELETE FROM wallet_hold_groups WHERE origin_tenant_id = ANY($1::uuid[])', [
        tenants,
      ]);
    }
    for (const id of tenants) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    const usuarios = [vendedor, suspendido, sinMembresia, delConsolidador].filter(Boolean);
    if (usuarios.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [usuarios]);
    }
    await database.onModuleDestroy();
    await pool.end();
  });

  it('app_user no es superusuario ni salta la RLS', async () => {
    const rol = await database.withTenant(agenciaA, async (trx) => {
      const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(trx);
      return r.rows[0];
    });
    expect(rol).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('la hora de la oficina con la zona de la cuenta se guarda con su instante UTC', async () => {
    const o = await orden(agenciaA, { status: 'cancelled' });
    await tracking.recordRead(
      agenciaA,
      o,
      flightReadOf(
        {
          found: true,
          airlineLocators: [],
          warnings: [],
          ticketingDeadline: {
            date: '2026-10-20',
            time: '18:00',
            zone: 'PROVIDER_LOCAL',
            timeZone: 'America/Bogota',
          },
        },
        new Date(AHORA),
      ),
    );
    const { rows } = await pool.query<{ zona: string; at: Date }>(
      `SELECT ticketing_deadline_time_zone AS zona, ticketing_deadline_at AS at
         FROM flight_order_tracking WHERE order_id = $1`,
      [o],
    );
    expect(rows[0]).toEqual({ zona: 'America/Bogota', at: new Date('2026-10-20T23:00:00.000Z') });
    const leido = (await tracking.listTracking(agenciaA, [o])).get(o)?.ticketingDeadline;
    expect(leido).toEqual({
      date: '2026-10-20',
      time: '18:00',
      zone: 'PROVIDER_LOCAL',
      timeZone: 'America/Bogota',
      at: new Date('2026-10-20T23:00:00.000Z'),
    });
  });

  it('los CHECK de 0084: zona sólo con la hora de la oficina, instante sólo con zona conocida', async () => {
    const o = await orden(agenciaA, { status: 'cancelled' });
    const seguimiento = (columnas: string, valores: string) =>
      sqlstate(
        comoApp(
          agenciaA,
          `INSERT INTO flight_order_tracking (order_id, tenant_id, ${columnas})
           VALUES ($1, $2, ${valores})`,
          [o, agenciaA],
        ),
      );
    // 23514 = check_violation.
    expect({
      zonaConUtc: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_time, ticketing_deadline_time_zone',
        `'2026-10-20', 'UTC', '18:00', 'America/Bogota'`,
      ),
      instanteSinZonaDeOficina: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_time, ticketing_deadline_at',
        `'2026-10-20', 'PROVIDER_LOCAL', '18:00', now()`,
      ),
      instanteSinHora: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_time_zone, ticketing_deadline_at',
        `'2026-10-20', 'PROVIDER_LOCAL', 'America/Bogota', now()`,
      ),
      zonaConFormaRara: await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_time_zone',
        `'2026-10-20', 'PROVIDER_LOCAL', 'America/Bogota; DROP'`,
      ),
    }).toEqual({
      zonaConUtc: '23514',
      instanteSinZonaDeOficina: '23514',
      instanteSinHora: '23514',
      zonaConFormaRara: '23514',
    });
    expect(
      await seguimiento(
        'ticketing_deadline_date, ticketing_deadline_zone, ticketing_deadline_time, ticketing_deadline_time_zone, ticketing_deadline_at',
        `'2026-10-20', 'PROVIDER_LOCAL', '18:00', 'America/Argentina/Buenos_Aires', now()`,
      ),
    ).toBe('ok');
  });

  it('listDue elige sólo lo que toca avisar, bajo la RLS del tenant', async () => {
    const debida = await orden(agenciaA);
    await leerPlazo(agenciaA, debida, AHORA + 10 * HORA);
    const lejana = await orden(agenciaA);
    await leerPlazo(agenciaA, lejana, AHORA + 30 * HORA);
    const vencida = await orden(agenciaA);
    await leerPlazo(agenciaA, vencida, AHORA - HORA);
    const emitida = await orden(agenciaA, { status: 'ticketed' });
    await leerPlazo(agenciaA, emitida, AHORA + 10 * HORA);
    const conTiquete = await orden(agenciaA);
    await leerPlazo(agenciaA, conTiquete, AHORA + 10 * HORA);
    await comoApp(
      agenciaA,
      `INSERT INTO order_flight_documents (tenant_id, order_id, number, kind, status)
       VALUES ($1, $2, '0457123456789', 'TICKET', 'ISSUED')`,
      [agenciaA, conTiquete],
    );
    const conEmd = await orden(agenciaA);
    await leerPlazo(agenciaA, conEmd, AHORA + 10 * HORA);
    await comoApp(
      agenciaA,
      `INSERT INTO order_flight_documents (tenant_id, order_id, number, kind, status)
       VALUES ($1, $2, '1251934576908', 'EMD', 'ISSUED')`,
      [agenciaA, conEmd],
    );
    const emitiendo = await orden(agenciaA);
    await leerPlazo(agenciaA, emitiendo, AHORA + 10 * HORA);
    await comoApp(
      agenciaA,
      `INSERT INTO order_operations (tenant_id, order_id, type, status) VALUES ($1, $2, 'issue', 'pending')`,
      [agenciaA, emitiendo],
    );
    const avisada24 = await orden(agenciaA);
    await leerPlazo(agenciaA, avisada24, AHORA + 10 * HORA);
    await pool.query(
      `UPDATE flight_order_tracking SET deadline_alerted_24h_at = now() WHERE order_id = $1`,
      [avisada24],
    );
    const ultimas2h = await orden(agenciaA);
    await leerPlazo(agenciaA, ultimas2h, AHORA + HORA);
    await pool.query(
      `UPDATE flight_order_tracking SET deadline_alerted_24h_at = now() WHERE order_id = $1`,
      [ultimas2h],
    );
    // Retiene cartera: el barrido lo lee con la RLS del nodo que vende.
    await pool.query(
      `INSERT INTO wallet_hold_groups (order_id, origin_tenant_id, currency, sale_amount_minor,
                                       provider_code, credential_source, mode, status, created_by)
       VALUES ($1, $2, 'COP', 34012, 'vuelos-${sfx}', 'legacy', 'legacy', 'held', $3)`,
      [debida, agenciaA, vendedor],
    );
    const sinZona = await orden(agenciaA);
    await tracking.recordRead(
      agenciaA,
      sinZona,
      flightReadOf(
        {
          found: true,
          airlineLocators: [],
          warnings: [],
          ticketingDeadline: { date: '2026-10-14', time: '18:00', zone: 'PROVIDER_LOCAL' },
        },
        new Date(AHORA),
      ),
    );
    const deOtraAgencia = await orden(agenciaB);
    await leerPlazo(agenciaB, deOtraAgencia, AHORA + 10 * HORA);

    const due = await store.listDue(agenciaA, new Date(AHORA));
    const ids = due.map((o) => o.orderId);

    expect(ids).toEqual(expect.arrayContaining([debida, conEmd, ultimas2h]));
    for (const fuera of [
      lejana,
      vencida,
      emitida,
      conTiquete,
      emitiendo,
      avisada24,
      sinZona,
      deOtraAgencia,
    ]) {
      expect(ids).not.toContain(fuera);
    }
    // Las de plazo más cercano primero.
    expect(ids.indexOf(ultimas2h)).toBeLessThan(ids.indexOf(debida));
    const fila = due.find((o) => o.orderId === debida);
    expect(fila).toMatchObject({
      userId: vendedor,
      deadlineZone: 'PROVIDER_LOCAL',
      officeTimeZone: 'America/Bogota',
      alerted24hAt: null,
      alerted2hAt: null,
      walletHold: 'held',
    });
    expect(due.find((o) => o.orderId === conEmd)?.walletHold).toBeNull();
    // La agencia B ve la suya y no las de A.
    const deB = (await store.listDue(agenciaB, new Date(AHORA))).map((o) => o.orderId);
    expect(deB).toEqual([deOtraAgencia]);
  });

  it('el CAS: dos corridas a la vez marcan una sola vez, y el de 2 h cierra los dos', async () => {
    const o = await orden(agenciaA);
    await leerPlazo(agenciaA, o, AHORA + 10 * HORA);
    const plazo = (await avisos(o))!.ticketing_deadline_at!;
    const enTransaccion = vi.fn(() => Promise.resolve());

    const ganadas = await Promise.all(
      [0, 1, 2].map(() => store.claim(agenciaA, o, '24h', plazo, new Date(AHORA), enTransaccion)),
    );
    expect(ganadas.filter(Boolean)).toHaveLength(1);
    expect(enTransaccion).toHaveBeenCalledTimes(1);
    expect((await avisos(o))?.deadline_alerted_24h_at).toEqual(new Date(AHORA));

    // Con un instante que ya no es el guardado, no se toma: el aviso diría otra hora.
    expect(
      await store.claim(
        agenciaA,
        o,
        '2h',
        new Date(plazo.getTime() + 60_000),
        new Date(AHORA),
        enTransaccion,
      ),
    ).toBe(false);

    const despues = new Date(AHORA + 9 * HORA);
    expect(await store.claim(agenciaA, o, '2h', plazo, despues, enTransaccion)).toBe(true);
    expect(await avisos(o)).toMatchObject({
      deadline_alerted_24h_at: new Date(AHORA),
      deadline_alerted_2h_at: despues,
    });
    // Nada más se toma después del de 2 h.
    expect(await store.claim(agenciaA, o, '2h', plazo, despues, enTransaccion)).toBe(false);
    expect(await store.claim(agenciaA, o, '24h', plazo, despues, enTransaccion)).toBe(false);
  });

  it('el CAS no toma una orden que dejó de estar confirmada, ni la de otro tenant', async () => {
    const o = await orden(agenciaA);
    await leerPlazo(agenciaA, o, AHORA + 10 * HORA);
    const plazo = (await avisos(o))!.ticketing_deadline_at!;
    const nada = () => Promise.resolve();
    expect(await store.claim(agenciaB, o, '24h', plazo, new Date(AHORA), nada)).toBe(false);
    await comoApp(agenciaA, `UPDATE orders SET status = 'ticketed' WHERE id = $1`, [o]);
    expect(await store.claim(agenciaA, o, '24h', plazo, new Date(AHORA), nada)).toBe(false);
    expect((await avisos(o))?.deadline_alerted_24h_at).toBeNull();
  });

  it('si el evento falla, el aviso no queda marcado: van en la misma transacción', async () => {
    const o = await orden(agenciaA);
    await leerPlazo(agenciaA, o, AHORA + 10 * HORA);
    const plazo = (await avisos(o))!.ticketing_deadline_at!;
    await expect(
      store.claim(agenciaA, o, '24h', plazo, new Date(AHORA), () =>
        Promise.reject(new Error('domain_events caído')),
      ),
    ).rejects.toThrow('domain_events caído');
    expect((await avisos(o))?.deadline_alerted_24h_at).toBeNull();
  });

  it('una lectura con el mismo instante conserva los avisos; con otro, los vuelve a abrir', async () => {
    const o = await orden(agenciaA);
    await leerPlazo(agenciaA, o, AHORA + HORA);
    await pool.query(
      `UPDATE flight_order_tracking
          SET deadline_alerted_24h_at = now(), deadline_alerted_2h_at = now()
        WHERE order_id = $1`,
      [o],
    );
    const marcados = await avisos(o);
    expect(marcados?.deadline_alerted_24h_at).toBeInstanceOf(Date);
    expect(marcados?.deadline_alerted_2h_at).toBeInstanceOf(Date);
    await leerPlazo(agenciaA, o, AHORA + HORA);
    expect(await avisos(o)).toEqual(marcados);
    // Una lectura sin plazo no toca nada.
    await tracking.recordRead(
      agenciaA,
      o,
      flightReadOf({ found: true, airlineLocators: [], warnings: [] }, new Date(AHORA)),
    );
    expect(await avisos(o)).toEqual(marcados);
    // La aerolínea extendió el plazo: los avisos del plazo anterior ya no valen.
    await leerPlazo(agenciaA, o, AHORA + 20 * HORA);
    expect(await avisos(o)).toMatchObject({
      deadline_alerted_24h_at: null,
      deadline_alerted_2h_at: null,
    });
  });

  it('a quién se escribe: el vendedor activo con membresía activa en la orden o en su red', async () => {
    expect(await store.recipientFor(agenciaA, vendedor)).toEqual({
      email: `vendedor-${sfx}@test.local`,
      countryCode: 'CO',
    });
    expect(await store.recipientFor(agenciaB, vendedor)).toEqual({
      email: `vendedor-${sfx}@test.local`,
      countryCode: 'BR',
    });
    // Quien vende desde el consolidador por una agencia de su red.
    expect((await store.recipientFor(agenciaA, delConsolidador)).email).toBe(
      `del-consolidador-${sfx}@test.local`,
    );
    // Un usuario suspendido o sin membresía no recibe datos de la reserva.
    expect((await store.recipientFor(agenciaA, suspendido)).email).toBeNull();
    expect((await store.recipientFor(agenciaA, sinMembresia)).email).toBeNull();
    // Ni uno de otra rama: la membresía de B no le abre las de A.
    const soloB = await crearUsuario('solo-b');
    try {
      await membresia(agenciaB, soloB);
      expect((await store.recipientFor(agenciaA, soloB)).email).toBeNull();
      await pool.query(`UPDATE memberships SET status = 'suspended' WHERE user_id = $1`, [soloB]);
      expect((await store.recipientFor(agenciaB, soloB)).email).toBeNull();
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [soloB]);
    }
  });

  it('el barrido de punta a punta: un aviso por umbral, con su evento, aunque corra dos veces', async () => {
    // Una agencia propia: el barrido mira todo el tenant.
    const agencia = await crearTenant(`fd-e-${sfx}`, 'agency', consolidador);
    try {
      await membresia(agencia, vendedor);
      const o = await orden(agencia, { test: true });
      await leerPlazo(agencia, o, AHORA + 10 * HORA);
      const mails: MailMessage[] = [];
      const service = new FlightDeadlineAlertService(
        store,
        new AuditService(database),
        {
          sendToTenant: (_t: string | null, msg: MailMessage) => {
            mails.push(msg);
            return Promise.resolve(true);
          },
        } as unknown as MailerService,
        { resolve: () => Promise.resolve(null) } as unknown as BrandingService,
      );

      expect(await service.sweepTenant(agencia, AHORA)).toMatchObject({
        examined: 1,
        alerted: 1,
        mailed: 1,
      });
      expect(await service.sweepTenant(agencia, AHORA + 15 * 60_000)).toMatchObject({
        examined: 0,
        alerted: 0,
      });
      // Ya en las últimas 2 h, el de 2 h; y después nada más.
      expect(await service.sweepTenant(agencia, AHORA + 8.5 * HORA)).toMatchObject({
        alerted: 1,
        mailed: 1,
      });
      expect(await service.sweepTenant(agencia, AHORA + 9 * HORA)).toMatchObject({ examined: 0 });

      expect(mails.map((m) => m.to)).toEqual([
        `vendedor-${sfx}@test.local`,
        `vendedor-${sfx}@test.local`,
      ]);
      expect(mails[0]?.subject).toMatch(/^\[PRUEBA\] La reserva #\d+ vence para emitir /);
      expect(mails[1]?.subject).toMatch(/^\[PRUEBA\] Urgente: la reserva #\d+ vence para emitir /);
      expect(mails[0]?.html).toContain('Ana');
      expect(mails[0]?.html).not.toContain('Ríos');
      expect(mails.map((m) => m.to)).not.toContain('pasajera@test.local');

      const { rows: eventos } = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events
          WHERE aggregate_id = $1 AND event_type = 'OrderTicketingDeadlineApproaching'
          ORDER BY occurred_at`,
        [o],
      );
      expect(eventos.map((e) => e.payload['threshold'])).toEqual(['24h', '2h']);
      expect(eventos[0]?.payload).toMatchObject({ testContent: true, walletHold: null });
      expect(JSON.stringify(eventos)).not.toContain('@test.local');
    } finally {
      await pool.query('DELETE FROM tenants WHERE id = $1', [agencia]);
    }
  });
});
