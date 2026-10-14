import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { encryptCredentials } from '../provider-credentials/credentials-cipher.js';
import {
  ProviderAccountInUseError,
  ProviderCredentialsService,
} from '../provider-credentials/provider-credentials.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { ProviderOrderAccountUnavailableError } from '../providers/provider.types.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { SABRE_PROVIDER_CODE, SabreProviderFactory } from '../providers-sabre/sabre.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { OrdersService } from './orders.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * La post-venta de una orden de VUELO con la cuenta que la creó, contra Postgres real (RF-29;
 * migraciones 0045 y 0081).
 *
 * Un proveedor de vuelos que opera su post-venta por cuenta (el de Sabre, sin red: nada de esto
 * llama a Sabre) guarda en la orden la cuenta de la bóveda con la que reservó. Desde entonces:
 *
 *   - la reserva se opera con ESA cuenta aunque la agencia cargue después otra, y sólo si sigue en
 *     la red del tenant que la hizo (0045);
 *   - la cuenta queda retenida mientras la reserva esté viva, que para un vuelo es hasta el día
 *     siguiente a la vuelta, o a la ida si no hay vuelta (0081). Sin 0081, cada vuelo confirmado la
 *     retenía para siempre: no tiene check-out.
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOBYPASSRLS) con el tenant fijado; el
 * superusuario sólo siembra. Requiere las migraciones hasta la 0081. Se SALTA sin PGHOST.
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
  '0081_flight_orders_active_by_travel_date.sql',
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

/**
 * `current_date` de la base en la sesión de la API: 0081 compara contra él, y los casos de abajo
 * caen justo en el borde (ayer cuenta, anteayer no). Con la fecha UTC de este proceso, una base en
 * otra zona (la local está en America/Bogota) cambiaba de día cinco horas antes y el test fallaba de
 * noche.
 */
let hoyDeLaBase: string | undefined;

function fecha(diasDesdeHoy: number): string {
  const hoy = hoyDeLaBase === undefined ? Date.now() : Date.parse(`${hoyDeLaBase}T00:00:00Z`);
  return new Date(hoy + diasDesdeHoy * 86_400_000).toISOString().slice(0, 10);
}

/** Los criterios de un vuelo como los guarda la orden (`FlightSearchCriteria`). */
function vuelo(ida: string, vuelta?: string): Record<string, unknown> {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: ida,
    ...(vuelta === undefined ? {} : { returnDate: vuelta }),
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  };
}

d('post-venta de vuelos con la cuenta de la reserva (0045, 0081) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const creds = new ProviderCredentialsService(database);
  const registry = new FlightProviderRegistry([new SabreProviderFactory(creds)], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const sfx = randomBytes(4).toString('hex');
  // Sintético: el conteo de 0081 no mira el proveedor, y un hotel tiene que seguir como antes.
  const HOTEL = `hotel-fo-${sfx}`;

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let otroConsolidador: string;
  let agenciaAjena: string;
  let usuario: string;
  let cuentaRed: string;
  let ordenA: string;
  let ordenAjena: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  async function crearCuenta(
    tenantId: string,
    opts: { provider?: string; homePcc?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, '{}'::jsonb, true, 'active') RETURNING id`,
      [
        tenantId,
        opts.provider ?? SABRE_PROVIDER_CODE,
        encryptCredentials(
          JSON.stringify({
            epr: 'EPR-NO-REAL',
            password: 'no-es-real',
            homePcc: opts.homePcc ?? 'A1B2',
          }),
        ),
      ],
    );
    return rows[0]!.id;
  }

  interface Orden {
    tenantId: string;
    cuenta: string;
    criterios: Record<string, unknown>;
    status?: string;
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
                             status, provider_raw, provider_account_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, '[{"givenName":"Ana"}]'::jsonb,
                 '{"email":"ana@x.test"}'::jsonb, 34012, $6, $7, '{"phase":"create"}'::jsonb, $8)
         RETURNING id`,
        [
          o.tenantId,
          usuario,
          o.provider ?? SABRE_PROVIDER_CODE,
          `P${sfx}${numero}`.toUpperCase().slice(0, 12),
          JSON.stringify(o.criterios),
          numero,
          o.status ?? 'confirmed',
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

  function servicio(): OrdersService {
    return new OrdersService(
      database,
      registry,
      new RecordingQueueService().asService(),
      {} as unknown as AgentCarsProviderFactory,
      new RecordingAuditService().asService(),
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    );
  }

  function conteo(tenantId: string, cuenta: string) {
    return database.withTenant(tenantId, async (trx) => {
      const r = await sql<{ own_orders: number; inherited_orders: number }>`
        SELECT own_orders, inherited_orders
        FROM provider_account_active_orders(${cuenta}::uuid)`.execute(trx);
      return r.rows;
    });
  }

  beforeAll(async () => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    database.onModuleInit();
    // Ningún tenant: sólo se lee la fecha, con la misma sesión (rol y zona) que usa la API.
    hoyDeLaBase = await database.withTenant('00000000-0000-0000-0000-000000000000', async (trx) => {
      const r = await sql<{
        hoy: string;
      }>`SELECT to_char(current_date, 'YYYY-MM-DD') AS hoy`.execute(trx);
      return r.rows[0]!.hoy;
    });

    consolidador = await crearTenant(`fo-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`fo-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`fo-b-${sfx}`, 'agency', consolidador);
    otroConsolidador = await crearTenant(`fo-x-${sfx}`, 'consolidator', null);
    agenciaAjena = await crearTenant(`fo-y-${sfx}`, 'agency', otroConsolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`fo-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;

    cuentaRed = await crearCuenta(consolidador);
    await crearCuenta(otroConsolidador, { homePcc: 'Z9Y8' });

    ordenA = await orden({ tenantId: agenciaA, cuenta: cuentaRed, criterios: vuelo(fecha(20)) });
    // La FK se verifica sin RLS: una agencia de otra red PUEDE guardar la cuenta de esta red.
    ordenAjena = await orden({
      tenantId: agenciaAjena,
      cuenta: cuentaRed,
      criterios: vuelo(fecha(20)),
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

  describe('la cuenta de la orden de vuelo (0045)', () => {
    it('RF-29 CA 1: con cuenta propia nueva, el vuelo ya reservado sigue con la heredada', async () => {
      const propia = await crearCuenta(agenciaA, { homePcc: 'C3D4' });
      try {
        // La venta nueva sale con la propia; la post-venta del vuelo viejo, con la de la red.
        expect((await registry.byCode(agenciaA, SABRE_PROVIDER_CODE)).accountId).toBe(propia);
        const p = await registry.forOrder(agenciaA, {
          orderId: ordenA,
          provider: SABRE_PROVIDER_CODE,
          providerAccountId: cuentaRed,
        });
        expect(p).toMatchObject({
          accountId: cuentaRed,
          credentialSource: 'inherited',
          environment: 'test',
        });
      } finally {
        await pool.query('DELETE FROM provider_accounts WHERE id = $1', [propia]);
      }
    });

    it('RF-29 CA 3: la agencia B no resuelve la cuenta del vuelo de la A, y tampoco lo ve', async () => {
      await expect(creds.resolveForOrder(agenciaB, ordenA)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        registry.forOrder(agenciaB, {
          orderId: ordenA,
          provider: SABRE_PROVIDER_CODE,
          providerAccountId: cuentaRed,
        }),
      ).rejects.toBeInstanceOf(ProviderOrderAccountUnavailableError);

      const orders = servicio();
      expect(await orders.findById(agenciaB, ordenA)).toBeUndefined();
      // Aunque alguien le pase la fila: la cuenta se resuelve desde la orden y con SU tenant.
      await expect(
        orders.retrieveOrder(agenciaB, {
          id: ordenA,
          provider: SABRE_PROVIDER_CODE,
          provider_order_id: 'ABC123',
          provider_account_id: cuentaRed,
        }),
      ).rejects.toBeInstanceOf(ProviderOrderAccountUnavailableError);
    });

    it('la agencia de otra red que guardó la cuenta recibe el 409, nunca la de su propia red', async () => {
      // Su red tiene su propia cuenta de Sabre; la de la orden no es de su red.
      expect((await registry.byCode(agenciaAjena, SABRE_PROVIDER_CODE)).accountId).not.toBe(
        cuentaRed,
      );
      const orders = servicio();
      const row = await orders.findById(agenciaAjena, ordenAjena);
      expect(row).toBeDefined();

      await expect(orders.retrieveOrder(agenciaAjena, row!)).rejects.toBeInstanceOf(
        ProviderOrderAccountUnavailableError,
      );
    });

    it('la agencia A resuelve la cuenta de SU vuelo con el secreto, sin poder leer la fila', async () => {
      const cuenta = await creds.resolveForOrder(agenciaA, ordenA);
      expect(cuenta).toMatchObject({
        id: cuentaRed,
        ownerTenantId: consolidador,
        providerCode: SABRE_PROVIDER_CODE,
        inherited: true,
        credentials: { homePcc: 'A1B2' },
      });
      const visibles = await database.withTenant(agenciaA, async (trx) => {
        const r = await sql<{ id: string }>`
          SELECT id FROM provider_accounts WHERE id = ${cuentaRed}::uuid`.execute(trx);
        return r.rows;
      });
      expect(visibles).toEqual([]);
    });
  });

  describe('0081: un vuelo retiene su cuenta hasta el día siguiente al fin del viaje', () => {
    let consolidadorConteo: string;
    let agenciaConteo: string;
    let cuentaConteo: string;
    let cuentaHotel: string;
    const vivos: string[] = [];

    function upsertSabre(status: 'active' | 'disabled') {
      return creds.upsert({
        tenantId: consolidadorConteo,
        providerCode: SABRE_PROVIDER_CODE,
        credentials: { epr: 'EPR-NO-REAL', password: 'rotada', homePcc: 'A1B2' },
        config: {},
        status,
        isInheritable: true,
      });
    }

    beforeAll(async () => {
      consolidadorConteo = await crearTenant(`fo-cc-${sfx}`, 'consolidator', null);
      agenciaConteo = await crearTenant(`fo-ca-${sfx}`, 'agency', consolidadorConteo);
      cuentaConteo = await crearCuenta(consolidadorConteo);
      cuentaHotel = await crearCuenta(consolidadorConteo, { provider: HOTEL });

      const de = (criterios: Record<string, unknown>, status?: string, tenantId = agenciaConteo) =>
        orden({
          tenantId,
          cuenta: cuentaConteo,
          criterios,
          ...(status === undefined ? {} : { status }),
        });

      // No cuentan: ya volaron (anteayer, sin vuelta), o se cancelaron.
      await de(vuelo(fecha(-2)));
      await de(vuelo(fecha(-9), fecha(-2)), 'ticketed');
      await de(vuelo(fecha(15)), 'cancelled');
      await de(vuelo(fecha(15)), 'failed');
      // Cuentan: por volar, ida pasada con vuelta por delante, ayer (el día de margen), pendiente
      // aunque haya pasado (sólo se cierra leyendo con esta cuenta), sin fecha legible, y una del
      // propio dueño.
      vivos.push(await de(vuelo(fecha(15))));
      vivos.push(await de(vuelo(fecha(-5), fecha(3)), 'ticketed'));
      vivos.push(await de(vuelo(fecha(-1))));
      vivos.push(await de(vuelo(fecha(-30)), 'pending'));
      vivos.push(await de({ origin: 'BOG', destination: 'LIM', departureDate: 'mañana' }));
      vivos.push(await de(vuelo(fecha(15)), 'confirmed', consolidadorConteo));

      // Un hotel, como antes: el check-out manda.
      const hotel = (checkoutDate: string) =>
        orden({
          tenantId: agenciaConteo,
          cuenta: cuentaHotel,
          provider: HOTEL,
          criterios: { vertical: 'hotels', checkoutDate },
        });
      await hotel(fecha(-3));
      await hotel(fecha(-2));
      await hotel(fecha(5));
    });

    afterAll(async () => {
      for (const id of [agenciaConteo, consolidadorConteo]) {
        if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
      }
    });

    it('cuenta los vuelos vivos de toda la red, y sólo le contesta al dueño', async () => {
      expect(await conteo(consolidadorConteo, cuentaConteo)).toEqual([
        { own_orders: 1, inherited_orders: 5 },
      ]);
      expect(await conteo(agenciaConteo, cuentaConteo)).toEqual([]);
      expect(await conteo(consolidador, cuentaConteo)).toEqual([]);
    });

    it('un hotel se cuenta igual que antes: hasta el día siguiente al check-out', async () => {
      expect(await conteo(consolidadorConteo, cuentaHotel)).toEqual([
        { own_orders: 0, inherited_orders: 1 },
      ]);
    });

    it('con vuelos por volar no se le cambia la oficina ni el entorno; la contraseña, sí', async () => {
      const cambio = (credentials: Record<string, unknown>, config: Record<string, unknown>) =>
        creds.upsert({
          tenantId: consolidadorConteo,
          providerCode: SABRE_PROVIDER_CODE,
          credentials: { epr: 'EPR-NO-REAL', password: 'rotada', homePcc: 'A1B2', ...credentials },
          config,
          status: 'active',
          isInheritable: true,
        });

      // Las reservas viven en el PCC A1B2 de CERT: con otro PCC o en producción no existen.
      for (const [credentials, config] of [
        [{ homePcc: 'Z9Y8' }, {}],
        [{}, { environment: 'prod' }],
      ] as const) {
        const error = await cambio(credentials, config).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderAccountInUseError);
        expect(error).toMatchObject({ publicDetails: { activeOrders: 6 } });
      }

      // Otra contraseña, u otro EPR, de la misma oficina en el mismo entorno: la misma cuenta.
      await expect(cambio({ epr: 'OTRO-EPR' }, { environment: 'cert' })).resolves.toEqual({
        id: cuentaConteo,
      });
      // Y la reserva se sigue operando con ella, ya con el EPR nuevo.
      await expect(creds.resolveForOrder(agenciaConteo, vivos[0]!)).resolves.toMatchObject({
        id: cuentaConteo,
        credentials: { epr: 'OTRO-EPR', homePcc: 'A1B2' },
      });
    });

    it('con vuelos por volar no se desactiva; ya volados o cerrados, sí', async () => {
      const error = await upsertSabre('disabled').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderAccountInUseError);
      expect(error).toMatchObject({ publicDetails: { activeOrders: 6 } });

      // El viaje terminó hace dos días en todos: sin 0081 seguirían contando para siempre.
      await pool.query(
        `UPDATE orders SET status = 'confirmed', search_criteria = $2::jsonb WHERE id = ANY($1)`,
        [vivos, JSON.stringify(vuelo(fecha(-6), fecha(-2)))],
      );

      await expect(upsertSabre('disabled')).resolves.toEqual({ id: cuentaConteo });
    });
  });
});

// ---------------------------------------------------------------------------
// Sonda sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no cuenta como
// verde. Ésta vigila lo que el bloque de arriba da por supuesto de 0081.
// ---------------------------------------------------------------------------

describe('0081, sin base de datos', () => {
  const texto = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');
  const cuerpo =
    /CREATE OR REPLACE FUNCTION provider_account_active_orders\([\s\S]*?\$\$;/.exec(texto)?.[0] ??
    '';

  it('redefine la función con la misma firma y la misma salida', () => {
    expect(cuerpo).toMatch(/provider_account_active_orders\(p_account_id UUID\)/);
    expect(cuerpo).toMatch(/RETURNS TABLE \(own_orders integer, inherited_orders integer\)/);
    expect(cuerpo).toMatch(/GROUP BY pa\.id/);
    expect(cuerpo).not.toMatch(/SELECT\s+(o|pa)\.\*/);
  });

  it('sigue siendo SECURITY DEFINER acotada: search_path cerrado, sólo app_user y el tenant activo', () => {
    expect(cuerpo).toMatch(/SECURITY DEFINER/);
    expect(cuerpo).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
    // Corre sin las policies: el filtro del dueño es lo único que la acota.
    expect(cuerpo).toMatch(
      /pa\.tenant_id::text = current_setting\('app\.current_tenant_id', true\)/,
    );
    expect(texto).toMatch(
      /REVOKE ALL ON FUNCTION provider_account_active_orders\(uuid\) FROM PUBLIC;/,
    );
    expect(texto).toMatch(
      /GRANT EXECUTE ON FUNCTION provider_account_active_orders\(uuid\) TO app_user;/,
    );
  });

  it('una reserva activa es la de `order_is_active` (0051): un solo criterio para toda la base', () => {
    expect(cuerpo).toMatch(/public\.order_is_active\(o\.status, o\.search_criteria\)/);
    expect(cuerpo).not.toMatch(/checkoutDate/);
  });

  it('no nombra a ningún proveedor', () => {
    expect(texto.toLowerCase()).not.toMatch(/sabre|latam|tbo|despegar|agent-cars/);
  });
});
