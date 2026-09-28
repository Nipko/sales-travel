import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { EnvHotelProviderFlags } from '../providers/hotel-providers.module.js';
import { EnvProviderFlags } from '../providers/providers.module.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { PlatformProviderFlags } from './platform-provider-flags.js';
import { platformDecision, type EnablementSetting } from './provider-enablement.policy.js';
import {
  PROVIDER_ENABLEMENT_EVENT,
  ProviderEnablementService,
} from './provider-enablement.service.js';
import { ProviderEnablementStore } from './provider-enablement.store.js';

/**
 * La habilitación de proveedores contra Postgres de verdad (0048).
 *
 * Lo que los tests sin base no pueden probar: que `provider_enablement_chain` devuelve la rama
 * EXACTA del tenant (ni un nodo de otra red), que la RLS deja leer a cualquiera y escribir sólo al
 * superadmin, los índices únicos y los CHECK, el borrado en cascada, y que el servicio escribe el
 * ajuste y su `domain_event` en la misma transacción y la búsqueda lo ve al instante.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS): como superusuario la RLS no aplicaría
 * y no probaría nada. El superusuario sólo siembra y mira. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

/** Una sentencia de {@link ensayo} que corre como el superusuario que siembra, no como `app_user`. */
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

d('provider_enablement (0048) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  // Códigos únicos por corrida: la base de CI es compartida y los ajustes globales son globales.
  const VUELO = `pe-air-${sfx}`;
  const HOTEL = `pe-hotels-${sfx}`;

  let plataforma: string;
  let consolidador: string;
  let agencia: string;
  let sub: string;
  let otraRed: string;
  let superadmin: string;
  let admin: string;

  async function tenant(slug: string, type: string, parent: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, type, parent],
    );
    return rows[0]!.id;
  }

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

  /** Una lectura como `app_user` sin usuario en el contexto, como la búsqueda. Sin escribir. */
  async function comoApp<R extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      return await c.query<R>(text, values);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /**
   * Qué pasa con una sentencia, sin dejar nada: `ok:<filas>` o el SQLSTATE. Como `app_user` con el
   * usuario dado (o sin usuario, `null`), o como superusuario ({@link SUPERUSUARIO}) para los CHECK.
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

  async function cadena(tenantId: string): Promise<EnablementSetting[]> {
    const { rows } = await comoApp<{
      provider_code: string;
      tenant_id: string | null;
      lvl: number | string;
      enabled: boolean;
    }>('SELECT * FROM provider_enablement_chain($1::uuid)', [tenantId]);
    return rows
      .filter((r) => r.provider_code === VUELO || r.provider_code === HOTEL)
      .map((r) => ({
        providerCode: r.provider_code,
        tenantId: r.tenant_id,
        depth: Number(r.lvl),
        enabled: r.enabled,
      }));
  }

  async function limpiar(): Promise<void> {
    await pool.query('DELETE FROM provider_enablement WHERE provider_code = ANY($1::text[])', [
      [VUELO, HOTEL],
    ]);
  }

  function montar() {
    const store = new ProviderEnablementStore(database);
    const vuelo = new StubProviderFactory({ code: VUELO });
    const hotel = new StubHotelProviderFactory({ code: HOTEL, callPolicy: 'opt-in' });
    const legacyFlights = new EnvProviderFlags();
    const legacyHotels = new EnvHotelProviderFlags();
    const flights = new FlightProviderRegistry(
      [vuelo],
      new PlatformProviderFlags(store, legacyFlights),
    );
    const hotels = new HotelProviderRegistry(
      [hotel],
      new PlatformProviderFlags(store, legacyHotels),
    );
    const service = new ProviderEnablementService(
      database,
      store,
      flights,
      hotels,
      new AuditService(database),
      legacyFlights,
      legacyHotels,
    );
    return { store, flights, hotels, service, vuelo, hotel };
  }

  beforeAll(async () => {
    database.onModuleInit();
    plataforma = await tenant(`pe-plat-${sfx}`, 'platform', null);
    consolidador = await tenant(`pe-cons-${sfx}`, 'consolidator', null);
    agencia = await tenant(`pe-ag-${sfx}`, 'agency', consolidador);
    sub = await tenant(`pe-sub-${sfx}`, 'subagency', agencia);
    otraRed = await tenant(`pe-otra-${sfx}`, 'consolidator', null);
    superadmin = await usuario(`pe-root-${sfx}@example.com`, plataforma, 'superadmin');
    admin = await usuario(`pe-admin-${sfx}@example.com`, consolidador, 'consolidator_admin');
  });

  afterAll(async () => {
    await limpiar();
    await pool.query('DELETE FROM memberships WHERE user_id = ANY($1::uuid[])', [
      [superadmin, admin],
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[superadmin, admin]]);
    await pool.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`pe-%-${sfx}`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('la cadena', () => {
    it('devuelve los ajustes de la rama del tenant y los globales; nunca los de otra red', async () => {
      await limpiar();
      await pool.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES
           ($1, NULL, false), ($1, $2, true), ($1, $3, false), ($1, $4, true), ($1, $5, true)`,
        [VUELO, consolidador, agencia, sub, otraRed],
      );

      const filas = await cadena(sub);

      expect(filas).toEqual([
        { providerCode: VUELO, tenantId: sub, depth: 3, enabled: true },
        { providerCode: VUELO, tenantId: agencia, depth: 2, enabled: false },
        { providerCode: VUELO, tenantId: consolidador, depth: 1, enabled: true },
        { providerCode: VUELO, tenantId: null, depth: 0, enabled: false },
      ]);
      expect(filas.map((f) => f.tenantId)).not.toContain(otraRed);
    });

    it('el plegado sobre la cadena real: el más cercano gana, y sin ajuste propio decide el ancestro', async () => {
      await pool.query(
        'DELETE FROM provider_enablement WHERE provider_code = $1 AND tenant_id = $2',
        [VUELO, sub],
      );

      expect(platformDecision(await cadena(sub), VUELO)).toEqual({
        enabled: false,
        origin: 'tenant',
        tenantId: agencia,
      });
      expect(platformDecision(await cadena(consolidador), VUELO)).toEqual({
        enabled: true,
        origin: 'tenant',
        tenantId: consolidador,
      });
    });

    it('un tenant sin nada en su rama ve sólo el global; uno que no existe, también', async () => {
      await limpiar();
      await pool.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES ($1, NULL, true)`,
        [VUELO],
      );

      expect(await cadena(otraRed)).toEqual([
        { providerCode: VUELO, tenantId: null, depth: 0, enabled: true },
      ]);
      expect(await cadena('00000000-0000-4000-8000-000000000000')).toEqual([
        { providerCode: VUELO, tenantId: null, depth: 0, enabled: true },
      ]);
    });
  });

  describe('RLS y restricciones', () => {
    it('cualquiera lee (el servidor, sin usuario en el contexto); sólo el superadmin escribe', async () => {
      await limpiar();
      await pool.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES ($1, $2, false)`,
        [VUELO, agencia],
      );
      const insertar = `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES ($1, $2, false)`;
      const actualizar = 'UPDATE provider_enablement SET enabled = true WHERE provider_code = $1';
      const borrar = 'DELETE FROM provider_enablement WHERE provider_code = $1';

      expect({
        leerSinUsuario: await ensayo(
          null,
          'SELECT 1 FROM provider_enablement WHERE provider_code = $1',
          [VUELO],
        ),
        insertarSinUsuario: await ensayo(null, insertar, [VUELO, sub]),
        insertarAdmin: await ensayo(admin, insertar, [VUELO, sub]),
        insertarSuperadmin: await ensayo(superadmin, insertar, [VUELO, sub]),
        actualizarAdmin: await ensayo(admin, actualizar, [VUELO]),
        actualizarSuperadmin: await ensayo(superadmin, actualizar, [VUELO]),
        borrarAdmin: await ensayo(admin, borrar, [VUELO]),
        borrarSuperadmin: await ensayo(superadmin, borrar, [VUELO]),
      }).toEqual({
        leerSinUsuario: 'ok:1',
        // 42501: la policy de INSERT no se cumple.
        insertarSinUsuario: '42501',
        insertarAdmin: '42501',
        insertarSuperadmin: 'ok:1',
        // UPDATE y DELETE de quien no es superadmin no ven ninguna fila que tocar.
        actualizarAdmin: 'ok:0',
        actualizarSuperadmin: 'ok:1',
        borrarAdmin: 'ok:0',
        borrarSuperadmin: 'ok:1',
      });
    });

    it('un solo ajuste global por proveedor y uno por (proveedor, tenant)', async () => {
      await limpiar();
      await pool.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES ($1, NULL, true), ($1, $2, true)`,
        [VUELO, agencia],
      );
      const insertar = `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES ($1, $2, false)`;

      expect({
        otroGlobal: await ensayo(SUPERUSUARIO, insertar, [VUELO, null]),
        otroDelTenant: await ensayo(SUPERUSUARIO, insertar, [VUELO, agencia]),
        otroTenant: await ensayo(SUPERUSUARIO, insertar, [VUELO, sub]),
      }).toEqual({ otroGlobal: '23505', otroDelTenant: '23505', otroTenant: 'ok:1' });
    });

    it('el código y el motivo tienen forma: CHECK', async () => {
      const insertar = (code: string, reason: string | null) =>
        ensayo(
          SUPERUSUARIO,
          `INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason) VALUES ($1, $2, true, $3)`,
          [code, otraRed, reason],
        );

      expect({
        mayusculas: await insertar('Con Mayúsculas', null),
        motivoLargo: await insertar(VUELO, 'x'.repeat(501)),
        motivoVacio: await insertar(VUELO, ''),
        valido: await insertar(VUELO, 'x'.repeat(500)),
      }).toEqual({
        mayusculas: '23514',
        motivoLargo: '23514',
        motivoVacio: '23514',
        valido: 'ok:1',
      });
    });

    it('borrar un tenant se lleva sus ajustes', async () => {
      const efimero = await tenant(`pe-efimero-${sfx}`, 'agency', consolidador);
      await pool.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled) VALUES ($1, $2, false)`,
        [HOTEL, efimero],
      );

      await pool.query('DELETE FROM tenants WHERE id = $1', [efimero]);

      const { rows } = await pool.query('SELECT 1 FROM provider_enablement WHERE tenant_id = $1', [
        efimero,
      ]);
      expect(rows).toEqual([]);
    });
  });

  describe('el servicio', () => {
    it('apagar para una agencia se ve AL INSTANTE en su búsqueda: la caché se invalida al escribir', async () => {
      await limpiar();
      const m = montar();

      // Llena la caché con "sin ajustes": el proveedor `always` está encendido.
      expect((await m.flights.forTenant(sub)).active.map((p) => p.code)).toEqual([VUELO]);

      await m.service.setTenant(superadmin, VUELO, agencia, {
        enabled: false,
        reason: 'Deuda vencida',
      });

      const { active, skipped } = await m.flights.forTenant(sub);
      expect(active).toEqual([]);
      expect(skipped).toEqual([
        expect.objectContaining({ code: VUELO, reason: 'platform-disabled' }),
      ]);
      // La otra red no se enteró.
      expect((await m.flights.forTenant(otraRed)).active.map((p) => p.code)).toEqual([VUELO]);
    });

    it('cada cambio deja su domain_event en la misma transacción, con el actor y el antes y el después', async () => {
      await limpiar();
      const m = montar();

      await m.service.setGlobal(superadmin, HOTEL, { enabled: true, reason: null });
      await m.service.setTenant(superadmin, HOTEL, agencia, { enabled: false, reason: 'Piloto' });
      await m.service.clearTenant(superadmin, HOTEL, agencia);

      const { rows } = await pool.query<{
        event_type: string;
        actor_user_id: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, actor_user_id, aggregate_id, payload FROM domain_events
          WHERE aggregate_type = 'provider_enablement' AND aggregate_id LIKE $1
          ORDER BY occurred_at, id`,
        [`${HOTEL}%`],
      );
      expect(rows.map((r) => [r.event_type, r.actor_user_id, r.aggregate_id])).toEqual([
        [PROVIDER_ENABLEMENT_EVENT, superadmin, HOTEL],
        [PROVIDER_ENABLEMENT_EVENT, superadmin, `${HOTEL}@${agencia}`],
        [PROVIDER_ENABLEMENT_EVENT, superadmin, `${HOTEL}@${agencia}`],
      ]);
      expect(rows[1]?.payload).toMatchObject({
        scope: 'tenant',
        targetTenantId: agencia,
        before: null,
        after: { enabled: false, reason: 'Piloto' },
      });
      expect(rows[2]?.payload).toMatchObject({
        before: { enabled: false, reason: 'Piloto' },
        after: null,
      });

      const { rows: ajustes } = await pool.query<{ updated_by: string; tenant_id: string | null }>(
        'SELECT updated_by, tenant_id FROM provider_enablement WHERE provider_code = $1',
        [HOTEL],
      );
      expect(ajustes).toEqual([{ updated_by: superadmin, tenant_id: null }]);
    });

    it('un usuario que no es superadmin no escribe ni por el servicio: lo para la base', async () => {
      await limpiar();
      const m = montar();

      await expect(
        m.service.setGlobal(admin, HOTEL, { enabled: true, reason: null }),
      ).rejects.toMatchObject({ code: '42501' });

      const { rows } = await pool.query(
        `SELECT 1 FROM domain_events WHERE aggregate_id = $1 AND actor_user_id = $2`,
        [HOTEL, admin],
      );
      // Sin ajuste, tampoco queda un evento: la transacción entera se deshizo.
      expect(rows).toEqual([]);
    });

    it('el estado efectivo de una sub-agencia dice qué nodo decidió', async () => {
      await limpiar();
      const m = montar();
      await m.service.setTenant(superadmin, HOTEL, consolidador, { enabled: true, reason: null });

      const vista = await m.service.forTenant(sub);
      const hotel = vista.providers.find((p) => p.code === HOTEL);

      expect(hotel?.own).toBeNull();
      expect(hotel?.effective).toEqual({
        enabled: true,
        origin: 'tenant',
        originTenantId: consolidador,
        originTenantName: `pe-cons-${sfx}`,
      });
      expect((await m.hotels.forTenant(sub)).active.map((p) => p.code)).toEqual([HOTEL]);
    });
  });
});
