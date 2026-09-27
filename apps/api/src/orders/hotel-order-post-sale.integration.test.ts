import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import type { HotelBookingView, SearchContext } from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import { encryptCredentials } from '../provider-credentials/credentials-cipher.js';
import {
  ProviderAccountInUseError,
  ProviderCredentialsService,
} from '../provider-credentials/provider-credentials.service.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import {
  ProviderOrderAccountUnavailableError,
  type TenantAdapter,
} from '../providers/provider.types.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { ExternalOrderIntentService } from './external-order-intent.service.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { ProviderAccountChangedError } from './order-create-intent.store.js';
import { OrdersService } from './orders.service.js';

/**
 * La post-venta de una orden de hotel con la cuenta que la creó, contra Postgres real (docs/tbo/09
 * PR-5.2; 08 RF-29 CA 1 a 3; migración 0045).
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado: como
 * superusuario la RLS no aplica y el aislamiento no probaría nada. El superusuario sólo siembra.
 *
 * La red es la del caso que motiva RF-29: un consolidador con una cuenta heredable y dos agencias
 * que reservan con ella; y otro consolidador, fuera de esa red, con su agencia.
 *
 * Requiere las migraciones hasta la 0045. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const MIGRACION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'db',
  'migrations',
  '0045_order_provider_account_post_sale.sql',
);

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

function fecha(diasDesdeHoy: number): string {
  return new Date(Date.now() + diasDesdeHoy * 86_400_000).toISOString().slice(0, 10);
}

d('post-venta de hoteles con la cuenta de la reserva (0045) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const creds = new ProviderCredentialsService(database);
  const sfx = randomBytes(4).toString('hex');
  // Sintético: el índice de referencias es global y esto no puede chocar con una reserva real.
  const PROVEEDOR = `hotel-ps-${sfx}`;
  const OTRO_PROVEEDOR = `hotel-ps-otro-${sfx}`;

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let otroConsolidador: string;
  let agenciaAjena: string;
  let usuario: string;
  let cuentaRed: string;
  let cuentaAjena: string;
  let ordenA: string;
  let ordenB: string;
  let ordenAPasada: string;
  let ordenAjena: string;
  let ordenOtroProveedor: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre],
    );
    return rows[0]!.id;
  }

  async function crearCuenta(tenantId: string, usuarioTbo: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, '{"environment":"test"}'::jsonb, true, 'active') RETURNING id`,
      [
        tenantId,
        PROVEEDOR,
        encryptCredentials(JSON.stringify({ username: usuarioTbo, password: 'no-es-real' })),
      ],
    );
    return rows[0]!.id;
  }

  interface Orden {
    tenantId: string;
    cuenta: string;
    status?: string;
    checkout?: string;
    provider?: string;
  }

  /** Inserta la orden como `app_user` y su tenant, como la saga de reserva. */
  async function orden(o: Orden): Promise<string> {
    numero += 1;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [o.tenantId]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, search_criteria,
                             selected_offer, passengers, contact_info, total_amount, order_number,
                             status, provider_raw, provider_booking_ref, provider_account_id)
         VALUES ($1, $2, $3, $4, jsonb_build_object('vertical', 'hotels', 'checkoutDate', $5::text),
                 '{}'::jsonb, '[{"firstName":"Ana"}]'::jsonb, '{"email":"ana@x.test"}'::jsonb,
                 34012, $6, $7, '{"phase":"create"}'::jsonb, $8, $9)
         RETURNING id`,
        [
          o.tenantId,
          usuario,
          o.provider ?? PROVEEDOR,
          `LOC${sfx}${numero}`.toUpperCase(),
          o.checkout ?? fecha(30),
          numero,
          o.status ?? 'confirmed',
          `STT${sfx.toUpperCase()}${String(numero).padStart(9, '0')}`,
          o.cuenta,
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

  /** Proveedor anónimo cuya post-venta resuelve la cuenta con la bóveda REAL (0045). */
  class ProveedorDeLaRed extends StubHotelProviderFactory {
    readonly cuentasUsadas: string[] = [];
    readonly porCuenta = new Map<string, StubHotelAdapter>();

    constructor() {
      super({ code: PROVEEDOR, capabilities: { retrieve: true, cancel: true } });
    }

    async resolveForOrder(
      tenantId: string,
      orderId: string,
    ): Promise<TenantAdapter<HotelProviderAdapter>> {
      const cuenta = await creds.resolveForOrder(tenantId, orderId);
      this.cuentasUsadas.push(cuenta.id);
      let adapter = this.porCuenta.get(cuenta.id);
      if (adapter === undefined) {
        adapter = new StubHotelAdapter(PROVEEDOR);
        adapter.getBooking.mockImplementation((id: string, _ctx: SearchContext) =>
          Promise.resolve<HotelBookingView>({
            found: true,
            providerBookingId: id,
            status: 'CONFIRMED',
            providerStatus: 'Confirmed',
            hotelConfirmationNumber: 'HCN-77',
            warnings: [],
          }),
        );
        this.porCuenta.set(cuenta.id, adapter);
      }
      return {
        adapter,
        credentialSource: cuenta.inherited ? 'inherited' : 'own',
        accountOwnerTenantId: cuenta.ownerTenantId,
      };
    }
  }

  function servicios() {
    const proveedor = new ProveedorDeLaRed();
    const audit = new RecordingAuditService();
    const reads = new HotelOrderReadsService(
      hotelRegistry([proveedor], hotelFlags(false)),
      new HotelOrderTrackingStore(database),
      new CircuitBreakerService(),
      audit.asService(),
    );
    const orders = new OrdersService(
      database,
      {} as unknown as FlightProviderRegistry,
      new RecordingQueueService().asService(),
      {} as unknown as AgentCarsProviderFactory,
      audit.asService(),
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      reads,
    );
    return { proveedor, audit, reads, orders };
  }

  beforeAll(async () => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    database.onModuleInit();

    consolidador = await crearTenant(`ps-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`ps-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`ps-b-${sfx}`, 'agency', consolidador);
    otroConsolidador = await crearTenant(`ps-x-${sfx}`, 'consolidator', null);
    agenciaAjena = await crearTenant(`ps-y-${sfx}`, 'agency', otroConsolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`ps-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;

    cuentaRed = await crearCuenta(consolidador, 'usuario-del-consolidador');
    cuentaAjena = await crearCuenta(otroConsolidador, 'usuario-ajeno');

    ordenA = await orden({ tenantId: agenciaA, cuenta: cuentaRed });
    ordenB = await orden({ tenantId: agenciaB, cuenta: cuentaRed });
    ordenAPasada = await orden({ tenantId: agenciaA, cuenta: cuentaRed, checkout: fecha(-5) });
    await orden({ tenantId: agenciaA, cuenta: cuentaRed, status: 'cancelled' });
    // La FK se verifica sin RLS: una agencia de otra red PUEDE guardar la cuenta de esta red.
    ordenAjena = await orden({ tenantId: agenciaAjena, cuenta: cuentaRed });
    ordenOtroProveedor = await orden({
      tenantId: agenciaA,
      cuenta: cuentaRed,
      provider: OTRO_PROVEEDOR,
    });
  });

  afterAll(async () => {
    // Las órdenes de la agencia ajena apuntan a la cuenta de la red: se van primero.
    for (const id of [agenciaAjena, agenciaA, agenciaB, consolidador, otroConsolidador]) {
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

  describe('la cuenta de la orden (pendiente a: sigue en la red del tenant)', () => {
    it('la agencia resuelve la cuenta heredada de SU orden, con el secreto, sin poder leer la fila', async () => {
      const cuenta = await creds.resolveForOrder(agenciaA, ordenA);
      expect(cuenta).toMatchObject({
        id: cuentaRed,
        ownerTenantId: consolidador,
        providerCode: PROVEEDOR,
        inherited: true,
        credentials: { username: 'usuario-del-consolidador' },
      });
    });

    it('RF-29 CA 1: con cuenta propia nueva, la orden vieja sigue con la heredada', async () => {
      const propia = await crearCuenta(agenciaA, 'usuario-propio');
      try {
        expect((await creds.resolve(agenciaA, PROVEEDOR)).id).toBe(propia);
        expect((await creds.resolveForOrder(agenciaA, ordenA)).id).toBe(cuentaRed);
      } finally {
        await pool.query('DELETE FROM provider_accounts WHERE id = $1', [propia]);
      }
    });

    it('RF-29 CA 3: la agencia B no resuelve la cuenta de una orden de la A', async () => {
      await expect(creds.resolveForOrder(agenciaB, ordenA)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('una orden de otra red que guardó esta cuenta no la usa', async () => {
      // Su red tiene su propia cuenta; la de la orden no es de su red.
      expect((await creds.resolve(agenciaAjena, PROVEEDOR)).id).toBe(cuentaAjena);
      await expect(creds.resolveForOrder(agenciaAjena, ordenAjena)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('la cuenta tiene que ser del mismo proveedor que la orden', async () => {
      await expect(creds.resolveForOrder(agenciaA, ordenOtroProveedor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['desactivada', `UPDATE provider_accounts SET status = 'disabled' WHERE id = $1`],
      ['en sandbox', `UPDATE provider_accounts SET status = 'sandbox' WHERE id = $1`],
      [
        'que dejó de heredarse',
        `UPDATE provider_accounts SET is_inheritable = false WHERE id = $1`,
      ],
    ])('una cuenta %s ya no opera la post-venta de la agencia', async (_caso, cambio) => {
      await pool.query(cambio, [cuentaRed]);
      try {
        await expect(creds.resolveForOrder(agenciaA, ordenA)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      } finally {
        await pool.query(
          `UPDATE provider_accounts SET status = 'active', is_inheritable = true WHERE id = $1`,
          [cuentaRed],
        );
      }
      // Y vuelve a operar cuando vuelve a la red.
      expect((await creds.resolveForOrder(agenciaA, ordenA)).id).toBe(cuentaRed);
    });

    it('sin el tenant de la orden fijado, la función no devuelve nada', async () => {
      const filas = await database.withTenant(agenciaB, async (trx) => {
        const r = await sql<{ id: string | null }>`
          SELECT id FROM resolve_order_provider_account(${ordenA}::uuid)`.execute(trx);
        return r.rows.filter((row) => row.id !== null);
      });
      expect(filas).toEqual([]);
    });
  });

  describe('RF-29 CA 3: la agencia B no lee ni cancela la orden de la A', () => {
    it('ni la fila, ni la consulta manual, ni la cancelación, ni el seguimiento; y nada sale al proveedor', async () => {
      const s = servicios();

      expect(await s.orders.findById(agenciaB, ordenA)).toBeUndefined();
      await expect(
        s.orders.retrieveOrder(agenciaB, {
          id: ordenA,
          provider: PROVEEDOR,
          provider_order_id: 'X',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(s.orders.cancelOrder(agenciaB, ordenA, 'X')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await s.reads.trackingOf(agenciaB, [ordenA])).toEqual(new Map());

      expect(s.proveedor.cuentasUsadas).toEqual([]);
      expect(s.audit.events).toEqual([]);
      const { rows } = await pool.query(
        `SELECT 1 FROM order_operations WHERE order_id = $1 UNION ALL
         SELECT 1 FROM hotel_order_tracking WHERE order_id = $1`,
        [ordenA],
      );
      expect(rows).toEqual([]);
    });

    it('la agencia A sí: consulta con la cuenta de la reserva y el seguimiento queda escrito bajo su RLS', async () => {
      const s = servicios();
      const row = await s.orders.findById(agenciaA, ordenA);
      expect(row).toBeDefined();

      const result = await s.orders.retrieveOrder(agenciaA, row!, usuario);

      expect(s.proveedor.cuentasUsadas).toEqual([cuentaRed]);
      expect(result).toMatchObject({
        vertical: 'hotels',
        found: true,
        tracking: {
          providerStatus: 'Confirmed',
          providerStatusSource: 'retrieve',
          hotelConfirmationNumber: 'HCN-77',
          hcnState: 'received',
        },
      });
      const { rows } = await pool.query<{ tenant_id: string; provider_status: string }>(
        `SELECT tenant_id, provider_status FROM hotel_order_tracking WHERE order_id = $1`,
        [ordenA],
      );
      expect(rows).toEqual([{ tenant_id: agenciaA, provider_status: 'Confirmed' }]);
      expect((await s.reads.trackingOf(agenciaA, [ordenA])).get(ordenA)).toMatchObject({
        hotelConfirmationNumber: 'HCN-77',
      });
      // Ningún evento lleva los datos del huésped que la orden sí guarda.
      expect(s.audit.dump()).not.toContain('Ana');
      expect(s.audit.dump()).not.toContain('ana@x.test');
    });

    it('la agencia de otra red que guardó la cuenta recibe el 409 de cuenta no disponible, sin llamar', async () => {
      const s = servicios();
      const row = await s.orders.findById(agenciaAjena, ordenAjena);

      await expect(s.orders.retrieveOrder(agenciaAjena, row!)).rejects.toBeInstanceOf(
        ProviderOrderAccountUnavailableError,
      );
      expect(s.proveedor.cuentasUsadas).toEqual([]);
    });
  });

  describe('RF-29 CA 2: no se desactiva una cuenta con reservas activas', () => {
    function upsert(cambio: { status?: 'active' | 'disabled'; isInheritable?: boolean }) {
      return creds.upsert({
        tenantId: consolidador,
        providerCode: PROVEEDOR,
        credentials: { username: 'usuario-del-consolidador', password: 'rotada' },
        config: { environment: 'test' },
        ...cambio,
      });
    }

    async function estado(): Promise<{ status: string; is_inheritable: boolean }> {
      const { rows } = await pool.query<{ status: string; is_inheritable: boolean }>(
        'SELECT status, is_inheritable FROM provider_accounts WHERE id = $1',
        [cuentaRed],
      );
      return rows[0]!;
    }

    it('cuenta las reservas activas de toda la red, y sólo le contesta al dueño', async () => {
      const conteo = (tenantId: string) =>
        database.withTenant(tenantId, async (trx) => {
          const r = await sql<{ own_orders: number; inherited_orders: number }>`
            SELECT own_orders, inherited_orders
            FROM provider_account_active_orders(${cuentaRed}::uuid)`.execute(trx);
          return r.rows;
        });

      // A y B confirmadas con salida futura, la de la agencia ajena y la de otro proveedor, que también
      // apuntan a la cuenta: ante la duda, una reserva viva la retiene. La pasada y la cancelada, no.
      expect(await conteo(consolidador)).toEqual([{ own_orders: 0, inherited_orders: 4 }]);
      expect(await conteo(agenciaA)).toEqual([]);
      expect(await conteo(otroConsolidador)).toEqual([]);
    });

    it('desactivarla se rechaza con mensaje y la cuenta sigue activa', async () => {
      const error = await upsert({ status: 'disabled' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderAccountInUseError);
      expect(error).toMatchObject({ publicDetails: { activeOrders: 4 } });
      expect((error as Error).message).toContain('No se puede desactivar');
      expect(await estado()).toEqual({ status: 'active', is_inheritable: true });
    });

    it('dejar de heredarla se rechaza con reservas de la red', async () => {
      await expect(upsert({ status: 'active', isInheritable: false })).rejects.toBeInstanceOf(
        ProviderAccountInUseError,
      );
      expect(await estado()).toEqual({ status: 'active', is_inheritable: true });
    });

    it('rotar la contraseña se puede', async () => {
      await expect(upsert({ status: 'active', isInheritable: true })).resolves.toEqual({
        id: cuentaRed,
      });
      expect((await creds.resolveForOrder(agenciaA, ordenA)).credentials).toMatchObject({
        password: 'rotada',
      });
    });

    it('una reserva pendiente cuenta aunque su salida ya haya pasado', async () => {
      await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = ANY($1)`, [
        [ordenA, ordenB, ordenAjena, ordenOtroProveedor],
      ]);
      await pool.query(`UPDATE orders SET status = 'pending' WHERE id = $1`, [ordenAPasada]);

      await expect(upsert({ status: 'disabled' })).rejects.toMatchObject({
        publicDetails: { activeOrders: 1 },
      });
    });

    it('sin reservas activas, se desactiva', async () => {
      await pool.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [ordenAPasada]);

      await expect(upsert({ status: 'disabled' })).resolves.toEqual({ id: cuentaRed });
      expect(await estado()).toEqual({ status: 'disabled', is_inheritable: true });
    });
  });

  describe('el registro de una lectura es CAS sobre la foto de la orden', () => {
    it('una lectura que llega tarde no pisa la escritura de otro camino; con la foto nueva, sí', async () => {
      const store = new HotelOrderTrackingStore(database);
      // Después de los conteos de RF-29 CA 2: esta orden no puede cambiarlos.
      const id = await orden({ tenantId: agenciaA, cuenta: cuentaRed });
      const foto = await store.findReadTarget(agenciaA, id);
      expect(foto?.snapshot).toMatchObject({ subStatus: null, providerStatus: null, hcn: null });

      // Entre la lectura de la orden y la respuesta del proveedor, otro camino la ve cancelada.
      const otro = await store.recordRead(agenciaA, id, {
        source: 'verify',
        at: Date.now(),
        record: { providerStatus: 'Cancelled', refundAwaited: false },
        subStatus: null,
        expected: foto!.snapshot,
      });
      const tarde = await store.recordRead(agenciaA, id, {
        source: 'retrieve',
        at: Date.now(),
        record: { providerStatus: 'Confirmed', refundAwaited: false },
        subStatus: null,
        hcn: { hcn: 'HCN-VIEJO', markReceived: true },
        expected: foto!.snapshot,
      });

      expect([otro, tarde]).toEqual([true, false]);
      const fila = async () =>
        (
          await pool.query<{
            provider_status: string;
            provider_status_source: string;
            hcn: string | null;
          }>(
            `SELECT provider_status, provider_status_source, hcn FROM hotel_order_tracking WHERE order_id = $1`,
            [id],
          )
        ).rows;
      expect(await fila()).toEqual([
        { provider_status: 'Cancelled', provider_status_source: 'verify', hcn: null },
      ]);

      const nueva = await store.findReadTarget(agenciaA, id);
      await expect(
        store.recordRead(agenciaA, id, {
          source: 'retrieve',
          at: Date.now(),
          record: { providerStatus: 'Cancelled', refundAwaited: true },
          expected: nueva!.snapshot,
        }),
      ).resolves.toBe(true);
      expect(await fila()).toEqual([
        { provider_status: 'Cancelled', provider_status_source: 'retrieve', hcn: null },
      ]);
    });
  });

  describe('pendiente b: una cuenta tbo-hotels con reservas vivas no se apunta a otra cuenta de TBO', () => {
    const TBO = 'tbo-hotels';
    let consolidadorTbo: string;
    let agenciaTbo: string;
    let cuentaTbo: string;
    let reservaViva: string;

    function upsertTbo(cambio: {
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
    }) {
      return creds.upsert({
        tenantId: consolidadorTbo,
        providerCode: TBO,
        credentials: { username: 'usuario-tbo', password: 'rotada' },
        config: { environment: 'test' },
        status: 'active',
        isInheritable: true,
        ...cambio,
      });
    }

    async function version(): Promise<string> {
      const { rows } = await pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM provider_accounts WHERE id = $1',
        [cuentaTbo],
      );
      return rows[0]!.updated_at.toISOString();
    }

    beforeAll(async () => {
      consolidadorTbo = await crearTenant(`ps-tc-${sfx}`, 'consolidator', null);
      agenciaTbo = await crearTenant(`ps-ta-${sfx}`, 'agency', consolidadorTbo);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
         VALUES ($1, $2, 'default', $3, '{"environment":"test"}'::jsonb, true, 'active') RETURNING id`,
        [
          consolidadorTbo,
          TBO,
          encryptCredentials(JSON.stringify({ username: 'usuario-tbo', password: 'no-es-real' })),
        ],
      );
      cuentaTbo = rows[0]!.id;
      reservaViva = await orden({ tenantId: agenciaTbo, cuenta: cuentaTbo, provider: TBO });
    });

    afterAll(async () => {
      for (const id of [agenciaTbo, consolidadorTbo]) {
        if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
      }
    });

    it.each([
      ['otro usuario', { credentials: { username: 'otro-usuario-tbo', password: 'x' } }],
      [
        'otro entorno',
        { config: { environment: 'live', baseUrl: 'https://tbo.example/HotelAPI' } },
      ],
      ['otra URL', { config: { environment: 'test', baseUrl: 'https://otro.example/HotelAPI' } }],
    ])('%s → 409 PROVIDER_ACCOUNT_IN_USE, y la cuenta sigue como estaba', async (_caso, cambio) => {
      const antes = await version();

      const error = await upsertTbo(cambio).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderAccountInUseError);
      expect(error).toMatchObject({
        reason: 'PROVIDER_ACCOUNT_IN_USE',
        publicDetails: { activeOrders: 1 },
      });
      expect(await version()).toBe(antes);
      expect((await creds.resolveForOrder(agenciaTbo, reservaViva)).credentials).toEqual({
        username: 'usuario-tbo',
        password: 'no-es-real',
      });
    });

    it('otra contraseña del mismo usuario se guarda, y la reserva sigue con la misma cuenta', async () => {
      await expect(upsertTbo({})).resolves.toEqual({ id: cuentaTbo });
      expect((await creds.resolveForOrder(agenciaTbo, reservaViva)).credentials).toEqual({
        username: 'usuario-tbo',
        password: 'rotada',
      });
    });

    it('el intent abierto con una versión vieja de la cuenta no se compromete; con la vigente, sí', async () => {
      const intents = new ExternalOrderIntentService(database);
      const abrir = (providerAccountVersion: string, n: number) =>
        intents.openExternalCreateIntent(agenciaTbo, usuario, {
          provider: TBO,
          vertical: 'hotels',
          idempotencyKey: randomUUID(),
          searchCriteria: { checkoutDate: fecha(40) },
          selectedOffer: { offerRef: `offer-${sfx}` },
          passengers: [{ room: 1 }],
          contactInfo: { email: `huesped-${sfx}@example.test` },
          totalAmountMinor: 34_012,
          currency: 'USD',
          providerBookingRef: `STV${sfx.toUpperCase()}${String(n).padStart(9, '0')}`,
          providerAccountId: cuentaTbo,
          providerAccountVersion,
        });
      const vieja = await version();
      await upsertTbo({ credentials: { username: 'usuario-tbo', password: 'otra-vez' } });

      await expect(abrir(vieja, 1)).rejects.toBeInstanceOf(ProviderAccountChangedError);
      const { rows } = await pool.query(
        'SELECT 1 FROM orders WHERE tenant_id = $1 AND provider_booking_ref = $2',
        [agenciaTbo, `STV${sfx.toUpperCase()}${String(1).padStart(9, '0')}`],
      );
      expect(rows).toEqual([]);

      const intent = await abrir(await version(), 2);
      expect(intent).toMatchObject({ status: 'pending', provider_account_id: cuentaTbo });

      // Ya comprometido, el intent cuenta como reserva viva: la cuenta no se apunta a otra.
      await expect(
        upsertTbo({ credentials: { username: 'otro-usuario-tbo', password: 'x' } }),
      ).rejects.toMatchObject({ publicDetails: { activeOrders: 2 } });

      // Desactivada, un intent con su versión tampoco se compromete.
      await pool.query(`UPDATE orders SET status = 'failed' WHERE provider_account_id = $1`, [
        cuentaTbo,
      ]);
      await creds.upsert({
        tenantId: consolidadorTbo,
        providerCode: TBO,
        credentials: { username: 'usuario-tbo', password: 'otra-vez' },
        config: { environment: 'test' },
        status: 'disabled',
      });
      await expect(abrir(await version(), 3)).rejects.toBeInstanceOf(ProviderAccountChangedError);
    });
  });
});

// ---------------------------------------------------------------------------
// Sondas sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no cuenta
// como verde. Estas vigilan lo que el bloque de arriba da por supuesto.
// ---------------------------------------------------------------------------

describe('0045, sin base de datos', () => {
  const texto = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');

  function funcion(nombre: string): string {
    const m = new RegExp(`CREATE FUNCTION ${nombre}\\([\\s\\S]*?\\$\\$;`).exec(texto);
    expect(m, `falta ${nombre}`).not.toBeNull();
    return m?.[0] ?? '';
  }

  it.each(['resolve_order_provider_account', 'provider_account_active_orders'])(
    '%s es SECURITY DEFINER acotada: search_path fijo, sólo app_user y filtra el tenant activo',
    (nombre) => {
      const cuerpo = funcion(nombre);
      expect(cuerpo).toMatch(/SECURITY DEFINER/);
      expect(cuerpo).toMatch(/SET search_path = public/);
      // Corre sin las policies: el filtro del tenant activo es lo único que la acota.
      expect(cuerpo).toMatch(/current_setting\('app\.current_tenant_id', true\)/);
      expect(texto).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${nombre}\\(uuid\\) FROM PUBLIC;`));
      expect(texto).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${nombre}\\(uuid\\) TO app_user;`),
      );
    },
  );

  it('la cuenta de la orden exige el mismo proveedor, cuenta activa y la herencia de 0012', () => {
    const cuerpo = funcion('resolve_order_provider_account');
    expect(cuerpo).toMatch(/pa\.provider_code = o\.provider/);
    expect(cuerpo).toMatch(/pa\.status = 'active'/);
    expect(cuerpo).toMatch(/pa\.is_inheritable AND owner_t\.path OPERATOR\(public\.@>\) me\.path/);
  });

  it('el conteo devuelve conteos agrupados por la cuenta: sin fila si no es del tenant activo', () => {
    const cuerpo = funcion('provider_account_active_orders');
    expect(cuerpo).toMatch(/RETURNS TABLE \(own_orders integer, inherited_orders integer\)/);
    expect(cuerpo).toMatch(/GROUP BY pa\.id/);
    expect(cuerpo).not.toMatch(/SELECT\s+(o|pa)\.\*/);
  });
});
