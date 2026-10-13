import { randomBytes } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { TicketIssueResult } from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { FlightOrderTrackingStore } from './flight-order-tracking.store.js';
import { OrdersService } from './orders.service.js';
import { requestedIssueResult } from './ticket-issue.plan.js';
import { FlightTicketIssueService } from './ticket-issue.service.js';
import { PENDING_PROVIDER_WRITE_CONSTRAINT, TicketIssueStore } from './ticket-issue.store.js';

/**
 * La emisión de tiquetes (SAB-08) contra Postgres real: el índice de 0083, las CAS de la operación
 * `issue`, el cierre en `ticketed` todo o nada y que una cancelación no corra con una emisión en
 * curso. Sólo significa algo bajo RLS: todo lo que la API ejecuta corre como `app_user`
 * (NOBYPASSRLS) con el tenant fijado; el superusuario sólo siembra y mira.
 *
 * Nada llama a un proveedor real: el de esta suite es anónimo. Requiere las migraciones hasta la
 * 0083. Se SALTA sin PGHOST.
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

/** SQLSTATE y constraint con que falla `p`, o `'ok'`. */
async function violacion(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return `${err.code ?? 'sin-codigo'}:${err.constraint ?? ''}`;
  }
}

const TIQUETES = ['0451234567890', '0451234567891'];

d('emisión de tiquetes (0083) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const store = new TicketIssueStore(database);
  const tracking = new FlightOrderTrackingStore(database);
  const sfx = randomBytes(4).toString('hex');
  const AIR = `vuelos-${sfx}`;

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

  /** Una orden de vuelo confirmada del tenant, insertada como `app_user`, como la saga. */
  async function orden(tenantId: string, status = 'confirmed'): Promise<string> {
    numero += 1;
    const { rows } = await comoApp(
      tenantId,
      `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                           selected_offer, passengers, contact_info, total_amount, order_number,
                           status, provider_raw)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, '[{"givenName":"Ana"},{"givenName":"Luis"}]'::jsonb,
               '{}'::jsonb, 34012, $5, $6, '{}'::jsonb)
       RETURNING id`,
      [tenantId, usuario, AIR, `P${sfx}${numero}`.toUpperCase().slice(0, 12), numero, status],
    );
    return (rows[0] as { id: string }).id;
  }

  async function estadoDeOrden(orderId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0]?.status;
  }

  async function operaciones(orderId: string) {
    const { rows } = await pool.query<{
      id: string;
      type: string;
      status: string;
      result: unknown;
    }>(
      'SELECT id, type, status, result FROM order_operations WHERE order_id = $1 ORDER BY created_at',
      [orderId],
    );
    return rows;
  }

  function pedido() {
    return requestedIssueResult({ at: new Date(), testContent: false });
  }

  beforeAll(async () => {
    database.onModuleInit();
    consolidador = await crearTenant(`ti-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`ti-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`ti-b-${sfx}`, 'agency', consolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`ti-${sfx}@test.local`],
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

  describe('el índice de 0083', () => {
    it('no deja dos escrituras pendientes en el proveedor para la misma orden', async () => {
      const o = await orden(agenciaA);
      const insertar = (type: string) =>
        comoApp(
          agenciaA,
          `INSERT INTO order_operations (tenant_id, order_id, type, status) VALUES ($1, $2, $3, 'pending')`,
          [agenciaA, o, type],
        );

      expect(await violacion(insertar('issue'))).toBe('ok');
      for (const type of ['issue', 'modify', 'add-services']) {
        expect(await violacion(insertar(type))).toBe(`23505:${PENDING_PROVIDER_WRITE_CONSTRAINT}`);
      }
      // La cancelación tiene su propio índice (0037): éste no la mira. Que no corran juntas lo
      // decide la API dentro del claim (abajo).
      expect(await violacion(insertar('cancel'))).toBe('ok');
      // Otros tipos y otras órdenes no se pisan.
      expect(await violacion(insertar('retrieve'))).toBe('ok');
      expect(
        await violacion(
          comoApp(
            agenciaA,
            `INSERT INTO order_operations (tenant_id, order_id, type, status) VALUES ($1, $2, 'issue', 'pending')`,
            [agenciaA, await orden(agenciaA)],
          ),
        ),
      ).toBe('ok');
    });

    it('una emisión cerrada deja pedir otra', async () => {
      const o = await orden(agenciaA);
      const insertar = (status: string) =>
        comoApp(
          agenciaA,
          `INSERT INTO order_operations (tenant_id, order_id, type, status) VALUES ($1, $2, 'issue', $3)`,
          [agenciaA, o, status],
        );
      expect(await violacion(insertar('failed'))).toBe('ok');
      expect(await violacion(insertar('pending'))).toBe('ok');
    });
  });

  describe('TicketIssueStore', () => {
    it('dos pedidos a la vez: uno toma el claim y el otro ve la emisión en curso', async () => {
      const o = await orden(agenciaA);

      const resultados = await Promise.all([
        store.claim(agenciaA, o, usuario, pedido()),
        store.claim(agenciaA, o, usuario, pedido()),
      ]);

      expect(resultados.filter((r) => r.claimed)).toHaveLength(1);
      expect(resultados.filter((r) => !r.claimed)).toEqual([
        { claimed: false, refusal: 'already-pending' },
      ]);
      expect((await operaciones(o)).map((op) => [op.type, op.status])).toEqual([
        ['issue', 'pending'],
      ]);
    });

    it('rechaza una orden no confirmada, una ajena y una con la emisión anterior en duda', async () => {
      const pendiente = await orden(agenciaA, 'pending');
      expect(await store.claim(agenciaA, pendiente, usuario, pedido())).toEqual({
        claimed: false,
        refusal: 'not-confirmed',
      });

      const ajena = await orden(agenciaB);
      expect(await store.claim(agenciaA, ajena, usuario, pedido())).toEqual({
        claimed: false,
        refusal: 'not-found',
      });

      const enDuda = await orden(agenciaA);
      await comoApp(
        agenciaA,
        `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
         VALUES ($1, $2, 'issue', 'failed', $3::jsonb)`,
        [
          agenciaA,
          enDuda,
          JSON.stringify({
            ...pedido(),
            stage: 'settled',
            reconciliationRequired: true,
            retryForbidden: true,
          }),
        ],
      );
      expect(await store.claim(agenciaA, enDuda, usuario, pedido())).toEqual({
        claimed: false,
        refusal: 'previous-unverified',
      });
    });

    it('el write-ahead lo gana una sola ejecución, y desde `sent` no se vuelve atrás', async () => {
      const o = await orden(agenciaA);
      const claim = await store.claim(agenciaA, o, usuario, pedido());
      if (!claim.claimed) throw new Error('sin claim');
      const enviada = { ...pedido(), stage: 'sent' as const, sentAt: new Date().toISOString() };

      const ganadores = await Promise.all([
        store.markSent(agenciaA, claim.operationId, enviada),
        store.markSent(agenciaA, claim.operationId, enviada),
      ]);

      expect(ganadores.filter(Boolean)).toHaveLength(1);
      expect(
        await store.settle(
          agenciaA,
          claim.operationId,
          { from: ['pending'], stage: 'requested' },
          'failed',
          pedido(),
          null,
        ),
      ).toBe(false);
      const op = await store.getOperation(agenciaA, o, claim.operationId);
      expect(op?.result.stage).toBe('sent');
      // Otro tenant no la ve.
      expect(await store.getOperation(agenciaB, o, claim.operationId)).toBeUndefined();
    });

    it('el cierre es todo o nada: si falla algo dentro, ni la orden ni la operación cambian', async () => {
      const o = await orden(agenciaA);
      const claim = await store.claim(agenciaA, o, usuario, pedido());
      if (!claim.claimed) throw new Error('sin claim');

      await expect(
        store.finalizeTicketed(agenciaA, o, claim.operationId, pedido(), async (trx) => {
          await tracking.recordReadWithin(trx, agenciaA, o, {
            at: new Date(),
            airlineLocators: [],
            documents: [
              { number: TIQUETES[0]!, kind: 'TICKET', travelerIndex: 0, status: 'ISSUED' },
            ],
          });
          throw new Error('el evento no entró');
        }),
      ).rejects.toThrow('el evento no entró');

      expect(await estadoDeOrden(o)).toBe('confirmed');
      expect((await operaciones(o)).map((op) => op.status)).toEqual(['pending']);
      const { rows } = await pool.query(
        'SELECT 1 FROM order_flight_documents WHERE order_id = $1',
        [o],
      );
      expect(rows).toEqual([]);
    });

    it('con la orden ya cancelada, el cierre no la pisa', async () => {
      const o = await orden(agenciaA);
      const claim = await store.claim(agenciaA, o, usuario, pedido());
      if (!claim.claimed) throw new Error('sin claim');
      await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [o]);

      const cierre = await store.finalizeTicketed(agenciaA, o, claim.operationId, pedido(), () =>
        Promise.resolve(),
      );

      expect(cierre).toEqual({ kind: 'order-changed' });
      expect(await estadoDeOrden(o)).toBe('cancelled');
      expect((await operaciones(o)).map((op) => op.status)).toEqual(['pending']);
    });

    it('el barrido ve sólo lo vencido de su tenant', async () => {
      const o = await orden(agenciaA);
      const claim = await store.claim(agenciaA, o, usuario, pedido());
      if (!claim.claimed) throw new Error('sin claim');
      const futuro = new Date(Date.now() + 60_000);

      expect((await store.listStale(agenciaA, futuro)).map((op) => op.id)).toContain(
        claim.operationId,
      );
      expect(
        (await store.listStale(agenciaA, new Date(Date.now() - 60_000))).map((op) => op.id),
      ).not.toContain(claim.operationId);
      expect((await store.listStale(agenciaB, futuro)).map((op) => op.id)).not.toContain(
        claim.operationId,
      );
    });
  });

  describe('de punta a punta, con un proveedor anónimo', () => {
    function servicio() {
      const factory = new StubProviderFactory({ code: AIR, capabilities: { issue: true } });
      const registry = new FlightProviderRegistry([factory], {
        decisionFor: () => Promise.resolve(undefined),
      });
      const queue = new RecordingQueueService();
      const issueTickets = vi.fn(
        (): Promise<TicketIssueResult> =>
          Promise.resolve({
            outcome: 'ISSUED',
            documents: TIQUETES.map((number, travelerIndex) => ({
              number,
              kind: 'TICKET' as const,
              travelerIndex,
              status: 'ISSUED' as const,
            })),
            warnings: [],
            issues: [],
            idempotencyKey: 'clave',
            formOfPaymentType: 'CASH',
          }),
      );
      Object.assign(factory.adapterFor(agenciaA), {
        issueTickets,
        checkTickets: vi.fn(),
      });
      const issues = new FlightTicketIssueService(
        store,
        registry,
        queue.asService(),
        new AuditService(database),
        { sendToTenant: vi.fn(() => Promise.resolve(true)) } as unknown as MailerService,
        { resolve: () => Promise.resolve(null) } as unknown as BrandingService,
        tracking,
      );
      const orders = new OrdersService(
        database,
        registry,
        queue.asService(),
        {} as unknown as AgentCarsProviderFactory,
        new RecordingAuditService().asService(),
        { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      );
      return { issues, orders, queue, issueTickets };
    }

    it('pedir y emitir deja la orden emitida, sus tiquetes guardados y el evento en la misma transacción', async () => {
      const s = servicio();
      const o = await orden(agenciaA);
      const fila = await s.orders.findById(agenciaA, o);
      if (fila === undefined) throw new Error('sin orden');

      const { operationId } = await s.issues.requestIssue(agenciaA, fila, usuario);
      await s.issues.runIssueById(agenciaA, o, operationId, usuario);

      expect(s.issueTickets).toHaveBeenCalledOnce();
      expect(await estadoDeOrden(o)).toBe('ticketed');
      const { rows: docs } = await pool.query<{ number: string; status: string }>(
        'SELECT number, status FROM order_flight_documents WHERE order_id = $1 ORDER BY number',
        [o],
      );
      expect(docs).toEqual(TIQUETES.map((number) => ({ number, status: 'ISSUED' })));
      const { rows: eventos } = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events WHERE aggregate_id = $1 AND event_type = 'OrderTicketed'`,
        [o],
      );
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.payload).toMatchObject({ outcome: 'ISSUED', documents: 2 });
      expect(JSON.stringify(eventos)).not.toContain(TIQUETES[0]);

      const historial = await s.orders.listOperations(agenciaA, o);
      expect(historial).toEqual([
        expect.objectContaining({ type: 'issue', status: 'success', retryable: false }),
      ]);
    });

    it('una cancelación no corre con una emisión en curso: 409 y no toma nada', async () => {
      const s = servicio();
      const o = await orden(agenciaA);
      const fila = await s.orders.findById(agenciaA, o);
      if (fila === undefined || fila.provider_order_id === null) throw new Error('sin orden');
      await s.issues.requestIssue(agenciaA, fila, usuario);

      await expect(
        s.orders.cancelOrder(agenciaA, o, fila.provider_order_id, usuario),
      ).rejects.toThrow(
        new ConflictException(
          'Hay una emisión en curso para esta reserva. Espera a que termine antes de cancelarla.',
        ),
      );
      expect(await estadoDeOrden(o)).toBe('confirmed');
      expect((await operaciones(o)).map((op) => [op.type, op.status])).toEqual([
        ['issue', 'pending'],
      ]);
    });

    it('y una emisión no se pide con una cancelación en curso', async () => {
      const s = servicio();
      const o = await orden(agenciaA);
      const fila = await s.orders.findById(agenciaA, o);
      if (fila === undefined) throw new Error('sin orden');
      // Una cancelación tomada deja la orden `pending` (claim de 0037).
      await pool.query(`UPDATE orders SET status = 'pending' WHERE id = $1`, [o]);

      await expect(s.issues.requestIssue(agenciaA, fila, usuario)).rejects.toThrow(
        'Sólo se puede emitir una reserva confirmada.',
      );
      expect(await operaciones(o)).toEqual([]);
    });

    it('el historial dice qué se puede hacer con una emisión fallida o en duda', async () => {
      const s = servicio();
      const o = await orden(agenciaA);
      await comoApp(
        agenciaA,
        `INSERT INTO order_operations (tenant_id, order_id, type, status, result, last_error)
         VALUES ($1, $2, 'issue', 'failed', $3::jsonb, 'No se pudo emitir: x.')`,
        [agenciaA, o, JSON.stringify({ ...pedido(), stage: 'settled', retryable: true })],
      );
      await comoApp(
        agenciaA,
        `INSERT INTO order_operations (tenant_id, order_id, type, status, result)
         VALUES ($1, $2, 'issue', 'failed', $3::jsonb)`,
        [
          agenciaA,
          o,
          JSON.stringify({ ...pedido(), stage: 'settled', reconciliationRequired: true }),
        ],
      );

      const historial = await s.orders.listOperations(agenciaA, o);

      expect(
        historial.map((op) => ({
          retryable: op.retryable,
          reconciliationRequired: op.reconciliationRequired,
        })),
      ).toEqual(
        expect.arrayContaining([
          { retryable: true, reconciliationRequired: false },
          { retryable: false, reconciliationRequired: true },
        ]),
      );
    });
  });
});
