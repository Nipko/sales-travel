import { randomBytes } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { OrderModifyResult } from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { ModifyTravelersSchema } from './dto.js';
import { ORDER_EVENTS } from './order-events.js';
import { TRAVELERS_MESSAGES } from './order-travelers.plan.js';
import { FlightTravelersService, TRAVELERS_STALE_AFTER_MS } from './order-travelers.service.js';
import { OrderTravelersStore } from './order-travelers.store.js';
import type { OrderRow } from './orders.service.js';

/**
 * Los datos de los pasajeros de una reserva (SAB-25) contra Postgres real, por las puertas públicas
 * de `FlightTravelersService`.
 *
 * Lo que sólo significa algo con la base: el claim `modify` ES el lock de la reserva (el índice de
 * 0083 lo comparte con emitir y con los servicios: una escritura pendiente por orden), una orden
 * ajena no se toca ni se ve bajo la RLS forzada, lo que queda guardado no lleva el documento ni el
 * viajero frecuente, y el barrido pasa a revisión lo que quedó colgado. Todo lo que la API ejecuta
 * corre como `app_user` (NOBYPASSRLS) con el tenant fijado; el superusuario sólo siembra y mira. Se
 * SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

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

const PASAPORTE = 'AB1234567';
const VIEJO = 'ZX9876543';
const VIAJERO = '55667788';

const CAMBIO = ModifyTravelersSchema.parse({
  travelers: [
    {
      index: 0,
      identityDocument: {
        type: 'PASSPORT',
        number: PASAPORTE,
        issuingCountry: 'CO',
        nationality: 'CO',
        expiryDate: '2034-05-31',
      },
      loyalty: { carrierCode: 'AV', number: VIAJERO },
      specialServices: ['DBML'],
    },
  ],
});

const HECHO: OrderModifyResult = {
  outcome: 'MODIFIED',
  unchanged: false,
  applied: [
    { index: 0, field: 'identityDocuments' },
    { index: 0, field: 'loyalty' },
    { index: 0, field: 'specialServices' },
  ],
  pending: [],
  attempts: 1,
  issues: [],
};

d('datos de los pasajeros de una reserva (SAB-25) contra Postgres', () => {
  const sfx = randomBytes(4).toString('hex');
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new OrderTravelersStore(database);
  const air = `vuelos-${sfx}`;
  const factory = new StubProviderFactory({ code: air, capabilities: { modify: true } });
  const registry = new FlightProviderRegistry([factory], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const audit = new RecordingAuditService();
  const service = new FlightTravelersService(store, registry, audit.asService());

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

  /** Una orden de vuelo del tenant, insertada como `app_user`, como la saga. */
  async function orden(tenantId: string, status = 'confirmed'): Promise<OrderRow> {
    numero += 1;
    const pasajeros = [
      {
        paxId: 'P1',
        paxType: 'ADT',
        givenName: 'Ana',
        surname: 'Pérez',
        gender: 'F',
        birthdate: '1990-01-01',
        citizenshipCountryCode: 'CO',
        identityDoc: {
          type: 'P',
          number: VIEJO,
          issuingCountryCode: 'CO',
          expiryDate: '2027-01-01',
        },
      },
    ];
    const { rows } = await comoApp(
      tenantId,
      `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                           selected_offer, passengers, contact_info, total_amount, order_number,
                           status, provider_raw)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::jsonb, $6::jsonb, '{}'::jsonb, 34012, $7, $8,
               '{}'::jsonb)
       RETURNING *`,
      [
        tenantId,
        usuario,
        air,
        `P${sfx}${numero}`.toUpperCase().slice(0, 12),
        JSON.stringify({ provider: { name: air, offerRef: 'R', source: 'ATPCO' } }),
        JSON.stringify(pasajeros),
        numero,
        status,
      ],
    );
    return rows[0] as OrderRow;
  }

  async function operaciones(orderId: string) {
    const { rows } = await pool.query<{
      type: string;
      status: string;
      result: Record<string, unknown>;
      last_error: string | null;
    }>(
      `SELECT type, status, result, last_error FROM order_operations
        WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    );
    return rows;
  }

  /** El puerto del stub: lo que el test prepara, con el lock tomado mientras corre. */
  function puerto(tenantId: string, modify: () => Promise<OrderModifyResult>) {
    const modifyTravelers = vi.fn(modify);
    Object.assign(factory.adapterFor(tenantId), {
      supportedModifications: () => ['identityDocuments', 'loyalty', 'specialServices'],
      readTravelers: () =>
        Promise.resolve({ travelers: [], supported: ['identityDocuments'], warnings: [] }),
      modifyTravelers,
    });
    return modifyTravelers;
  }

  beforeAll(async () => {
    database.onModuleInit();
    consolidador = await crearTenant(`tv-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`tv-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`tv-b-${sfx}`, 'agency', consolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`tv-${sfx}@test.local`],
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
    const { rows } = await comoApp(
      agenciaA,
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('un cambio hecho: la operación cerrada sin un valor, y la orden con el documento enmascarado', async () => {
    const fila = await orden(agenciaA);
    puerto(agenciaA, () => Promise.resolve(HECHO));
    const reply = await service.requestModify(agenciaA, fila, usuario, CAMBIO);
    expect(reply).toMatchObject({ outcome: 'MODIFIED', message: TRAVELERS_MESSAGES.saved });

    const ops = await operaciones(fila.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'modify', status: 'success', last_error: null });
    expect(ops[0]?.result).toMatchObject({ kind: 'travelers', outcome: 'MODIFIED' });
    const guardado = JSON.stringify(ops);
    for (const secreto of [PASAPORTE, VIAJERO, VIEJO, 'DBML']) {
      expect(guardado).not.toContain(secreto);
    }

    const { rows } = await pool.query<{ passengers: Record<string, unknown>[] }>(
      'SELECT passengers FROM orders WHERE id = $1',
      [fila.id],
    );
    const pasajero = rows[0]?.passengers[0];
    expect(pasajero?.['identityDoc']).toEqual({
      type: 'P',
      numberLast4: '4567',
      issuingCountryCode: 'CO',
      expiryDate: '2034-05-31',
    });
    expect(pasajero?.['loyaltyProgramAccount']).toEqual({
      airlineDesigCode: 'AV',
      accountNumberLast4: '7788',
    });
    // El número viejo se fue con el cambio; el nuevo nunca llegó a la base.
    const orden2 = JSON.stringify(rows[0]);
    expect(orden2).not.toContain(VIEJO);
    expect(orden2).not.toContain(PASAPORTE);
    expect(orden2).not.toContain('DBML');
  });

  it('el cierre escribe sobre los pasajeros de la orden al cerrar, no sobre la copia de antes del claim', async () => {
    // El pedido leyó la orden (con el pasaporte viejo entero) y, antes de su claim, cerró otro
    // cambio que dejó el documento corregido y enmascarado.
    const copia = await orden(agenciaA);
    const corregido = {
      type: 'P',
      numberLast4: '2468',
      issuingCountryCode: 'CO',
      expiryDate: '2033-03-03',
    };
    await pool.query(
      `UPDATE orders SET passengers = jsonb_set(passengers, '{0,identityDoc}', $2::jsonb)
        WHERE id = $1`,
      [copia.id, JSON.stringify(corregido)],
    );
    puerto(agenciaA, () =>
      Promise.resolve({ ...HECHO, applied: [{ index: 0, field: 'loyalty' }] }),
    );
    const soloViajero = ModifyTravelersSchema.parse({
      travelers: [{ index: 0, loyalty: { carrierCode: 'AV', number: VIAJERO } }],
    });
    await expect(
      service.requestModify(agenciaA, copia, usuario, soloViajero),
    ).resolves.toMatchObject({ outcome: 'MODIFIED' });

    const { rows } = await pool.query<{ passengers: Record<string, unknown>[] }>(
      'SELECT passengers FROM orders WHERE id = $1',
      [copia.id],
    );
    const pasajero = rows[0]?.passengers[0];
    // Lo del otro cambio sigue; el viajero frecuente nuevo, enmascarado.
    expect(pasajero?.['identityDoc']).toEqual(corregido);
    expect(pasajero?.['loyaltyProgramAccount']).toEqual({
      airlineDesigCode: 'AV',
      accountNumberLast4: '7788',
    });
    // Y el pasaporte viejo entero no vuelve a la base desde la copia.
    expect(JSON.stringify(rows[0])).not.toContain(VIEJO);
  });

  it('el claim es el lock: con un cambio en vuelo, otro cambio, una emisión y servicios chocan', async () => {
    const fila = await orden(agenciaA);
    let soltar: (value: OrderModifyResult) => void = () => undefined;
    const enVuelo = new Promise<OrderModifyResult>((resolve) => {
      soltar = resolve;
    });
    const modify = puerto(agenciaA, () => enVuelo);

    const primero = service.requestModify(agenciaA, fila, usuario, CAMBIO);
    await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(1));

    // Otro cambio de datos: 409 sin llegar al proveedor.
    const segundo = await service
      .requestModify(agenciaA, fila, usuario, CAMBIO)
      .catch((e: unknown) => e);
    expect(segundo).toBeInstanceOf(ConflictException);
    expect((segundo as ConflictException).message).toBe(TRAVELERS_MESSAGES.alreadyPending);
    expect(modify).toHaveBeenCalledTimes(1);

    // Una emisión (o un cambio de servicios) choca con el mismo índice de 0083.
    for (const type of ['issue', 'add-services', 'remove-services']) {
      const err = await comoApp(
        agenciaA,
        `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
         VALUES ($1, $2, $3, 'pending', '{}'::jsonb)`,
        [agenciaA, fila.id, type],
      ).catch((e: unknown) => e);
      expect((err as { code?: string }).code, type).toBe('23505');
      expect((err as { constraint?: string }).constraint).toBe(
        'uq_order_operations_pending_provider_write',
      );
    }

    soltar(HECHO);
    await expect(primero).resolves.toMatchObject({ outcome: 'MODIFIED' });
    // Cerrado el primero, se puede volver a pedir.
    puerto(agenciaA, () => Promise.resolve({ ...HECHO, unchanged: true, attempts: 0 }));
    await expect(service.requestModify(agenciaA, fila, usuario, CAMBIO)).resolves.toMatchObject({
      outcome: 'MODIFIED',
      unchanged: true,
    });
  });

  it('con una emisión pendiente no se modifica: 409 y el proveedor no se entera', async () => {
    const fila = await orden(agenciaA);
    const modify = puerto(agenciaA, () => Promise.resolve(HECHO));
    await comoApp(
      agenciaA,
      `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
       VALUES ($1, $2, 'issue', 'pending', '{}'::jsonb)`,
      [agenciaA, fila.id],
    );
    await expect(service.requestModify(agenciaA, fila, usuario, CAMBIO)).rejects.toThrow(
      new ConflictException(TRAVELERS_MESSAGES.alreadyPending),
    );
    expect(modify).not.toHaveBeenCalled();
  });

  it('con una cancelación en curso (la orden queda pending) tampoco', async () => {
    const fila = await orden(agenciaA);
    const modify = puerto(agenciaA, () => Promise.resolve(HECHO));
    await comoApp(agenciaA, `UPDATE orders SET status = 'pending' WHERE id = $1`, [fila.id]);
    await expect(service.requestModify(agenciaA, fila, usuario, CAMBIO)).rejects.toThrow(
      new ConflictException(TRAVELERS_MESSAGES.notModifiable),
    );
    expect(modify).not.toHaveBeenCalled();
    expect(await operaciones(fila.id)).toEqual([]);
  });

  it('una orden ajena no se toca ni se ve: el claim no la encuentra bajo la RLS', async () => {
    const ajena = await orden(agenciaA);
    const modify = puerto(agenciaB, () => Promise.resolve(HECHO));
    await expect(service.requestModify(agenciaB, ajena, usuario, CAMBIO)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(modify).not.toHaveBeenCalled();
    expect(await operaciones(ajena.id)).toEqual([]);

    // Y las operaciones `modify` de A no las lee B.
    puerto(agenciaA, () => Promise.resolve(HECHO));
    await service.requestModify(agenciaA, ajena, usuario, CAMBIO);
    const deB = await comoApp(
      agenciaB,
      `SELECT count(*)::int AS n FROM order_operations WHERE order_id = $1`,
      [ajena.id],
    );
    expect(deB.rows[0]).toEqual({ n: 0 });
    const deA = await comoApp(
      agenciaA,
      `SELECT count(*)::int AS n FROM order_operations WHERE order_id = $1 AND type = 'modify'`,
      [ajena.id],
    );
    expect(deA.rows[0]).toEqual({ n: 1 });
    // Ni escribe una a su nombre sobre la orden de A.
    const err = await comoApp(
      agenciaB,
      `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
       VALUES ($1, $2, 'modify', 'pending', '{}'::jsonb)`,
      [agenciaA, ajena.id],
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('42501');
  });

  it('el barrido pasa a revisión una `modify` colgada, una vez, y libera la reserva', async () => {
    const fila = await orden(agenciaA);
    await comoApp(
      agenciaA,
      `INSERT INTO order_operations (tenant_id, order_id, type, status, result, actor_user_id)
       VALUES ($1, $2, 'modify', 'pending', $3::jsonb, $4)`,
      [
        agenciaA,
        fila.id,
        JSON.stringify({
          kind: 'travelers',
          stage: 'sent',
          requestedAt: '2026-10-14T00:00:00Z',
          testContent: false,
          fields: [{ index: 0, field: 'identityDocuments' }],
          reconciliationRequired: true,
          retryForbidden: false,
        }),
        usuario,
      ],
    );
    const antes = audit.ofType(ORDER_EVENTS.escalated).length;

    // Recién creada no está colgada: el barrido de ahora no la toca.
    await service.sweepTenant(agenciaA, Date.now());
    expect((await operaciones(fila.id))[0]?.status).toBe('pending');

    // Pasado el plazo, sí. (`updated_at` lo pone el trigger: se adelanta el reloj del barrido.)
    const despues = Date.now() + TRAVELERS_STALE_AFTER_MS + 60_000;
    const report = await service.sweepTenant(agenciaA, despues);
    expect(report.examined).toBeGreaterThanOrEqual(1);
    const ops = await operaciones(fila.id);
    expect(ops[0]).toMatchObject({
      type: 'modify',
      status: 'failed',
      last_error: TRAVELERS_MESSAGES.unverified,
    });
    expect(ops[0]?.result).toMatchObject({ outcome: 'UNVERIFIED', escalated: true });
    expect(audit.ofType(ORDER_EVENTS.escalated).length).toBe(antes + 1);

    // Otra corrida no la vuelve a escalar.
    await service.sweepTenant(agenciaA, despues);
    expect(audit.ofType(ORDER_EVENTS.escalated).length).toBe(antes + 1);

    // Y la reserva vuelve a admitir cambios.
    puerto(agenciaA, () => Promise.resolve(HECHO));
    await expect(service.requestModify(agenciaA, fila, usuario, CAMBIO)).resolves.toMatchObject({
      outcome: 'MODIFIED',
    });
  });
});
