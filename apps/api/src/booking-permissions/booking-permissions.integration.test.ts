import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import {
  BOOKING_PERMISSION_EVENTS,
  BookingPermissionsService,
} from './booking-permissions.service.js';

/**
 * "Puede reservar tarifas no reembolsables" lo fija quien financia a cada nodo (pedido del founder
 * del 2026-09-29, punto e; db/migrations/0055), por el servicio de la API y como `app_user`: el rol
 * de producción, sujeto a la RLS y a la guarda de 0055. Como superusuario nada de esto se evaluaría.
 *
 * La red: Planetour → consolidador C → agencia A → sub-agencia S; C → agencia hermana B; Planetour →
 * otro consolidador C2 → agencia X.
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD), como las de carteras.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

interface Failure {
  readonly reason?: string;
  getStatus?: () => number;
}

/** `status/motivo` del error con que falla `p`. */
async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as Failure;
    return `${e.getStatus?.() ?? '?'}/${e.reason ?? '?'}`;
  }
  throw new Error('esperaba un rechazo');
}

/** El SQLSTATE y la regla con que la base rechaza `p`. */
async function dbError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return `${e.code ?? '?'}/${e.constraint ?? '-'}`;
  }
  throw new Error('esperaba un rechazo de la base');
}

d('no reembolsables: el permiso lo fija quien financia (API como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar la red, mirar y desmontar. */
  const admin = new pg.Pool();
  const database = new DatabaseService();
  database.db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        user: 'app_user',
        password: process.env['APP_USER_PASSWORD'],
        host: process.env['PGHOST'],
        port: Number(process.env['PGPORT'] ?? 5432),
        database: process.env['PGDATABASE'],
      }),
    }),
  });
  const permissions = new BookingPermissionsService(database, new AuditService(database));

  const tenants: string[] = [];
  const users: string[] = [];

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`nref-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`nref-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function events(tenantId: string) {
    const { rows } = await admin.query<{
      actor: string | null;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id AS actor, aggregate_id, payload FROM domain_events
        WHERE tenant_id = $1 AND event_type = $2 ORDER BY occurred_at`,
      [tenantId, BOOKING_PERMISSION_EVENTS.nonRefundableRatesChanged],
    );
    return rows;
  }

  const bloquear = { nonRefundableRates: 'blocked' as const, reason: 'Riesgo de cartera' };
  const permitir = { nonRefundableRates: 'allowed' as const, reason: 'Cartera al día' };

  let platform: string;
  let consolidator: string;
  let agency: string;
  let subagency: string;
  let sibling: string;
  let otherConsolidator: string;
  let foreign: string;

  let superadmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;
  let siblingAdmin: string;
  let otherAdmin: string;

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    subagency = await tenant('s', 'subagency', agency);
    sibling = await tenant('b', 'agency', consolidator);
    otherConsolidator = await tenant('c2', 'consolidator', platform);
    foreign = await tenant('x', 'agency', otherConsolidator);

    superadmin = await user('sa', platform, 'superadmin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    siblingAdmin = await user('ba', sibling, 'tenant_admin');
    otherAdmin = await user('c2a', otherConsolidator, 'consolidator_admin');
  });

  afterAll(async () => {
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('sin fila rige "permitido": la agencia reserva no reembolsables con la confirmación', async () => {
    expect(await permissions.nonRefundableRates(agency)).toEqual({ effective: 'allowed' });
    expect(await permissions.financedView(consolidatorAdmin, agency)).toMatchObject({
      tenant: { id: agency, tenantType: 'agency' },
      nonRefundableRates: {
        setting: 'allowed',
        effective: 'allowed',
        inheritedBlock: false,
        updatedAt: null,
        updatedByName: null,
      },
    });
  });

  it('la agencia no se fija el suyo; ni la hermana, ni otro consolidador', async () => {
    for (const [actor, target] of [
      [agencyAdmin, agency],
      [siblingAdmin, agency],
      [otherAdmin, agency],
      [consolidatorAdmin, foreign],
    ] as const) {
      expect(await denied(permissions.financedView(actor, target))).toBe(
        '403/BOOKING_PERMISSIONS_FINANCIER_REQUIRED',
      );
      expect(await denied(permissions.setNonRefundableRates(actor, target, bloquear))).toBe(
        '403/BOOKING_PERMISSIONS_FINANCIER_REQUIRED',
      );
    }
    // Ni el consolidador el de la sub-agencia de su agencia: a esa la financia la agencia.
    expect(
      await denied(permissions.setNonRefundableRates(consolidatorAdmin, subagency, bloquear)),
    ).toBe('403/BOOKING_PERMISSIONS_FINANCIER_REQUIRED');
    const { rows } = await admin.query(
      'SELECT 1 FROM tenant_booking_permissions WHERE tenant_id = ANY($1::uuid[])',
      [[agency, foreign, subagency]],
    );
    expect(rows).toHaveLength(0);
  });

  it('el consolidador bloquea a su agencia: rige para ella y, heredado, para su sub-agencia', async () => {
    const view = await permissions.setNonRefundableRates(consolidatorAdmin, agency, bloquear);

    expect(view.nonRefundableRates).toMatchObject({
      setting: 'blocked',
      effective: 'blocked',
      inheritedBlock: false,
      updatedByName: 'Usuario ca',
    });
    expect(view.nonRefundableRates.updatedAt).not.toBeNull();
    expect(await permissions.nonRefundableRates(agency)).toEqual({
      effective: 'blocked',
      blockedBy: 'own',
    });
    expect(await permissions.nonRefundableRates(subagency)).toEqual({
      effective: 'blocked',
      blockedBy: 'inherited',
    });
    // La hermana no se entera.
    expect(await permissions.nonRefundableRates(sibling)).toEqual({ effective: 'allowed' });

    const rastro = await events(agency);
    expect(rastro).toHaveLength(1);
    expect(rastro[0]).toMatchObject({
      actor: consolidatorAdmin,
      aggregate_id: agency,
      payload: { from: 'allowed', to: 'blocked', reason: 'Riesgo de cartera', source: 'api' },
    });
  });

  it('la agencia ve el bloqueo heredado de su sub-agencia: habilitarla no lo levanta', async () => {
    const view = await permissions.financedView(agencyAdmin, subagency);
    expect(view.nonRefundableRates).toMatchObject({
      setting: 'allowed',
      effective: 'blocked',
      inheritedBlock: true,
    });
  });

  it('volver a fijar el mismo valor no escribe ni deja otro rastro', async () => {
    await permissions.setNonRefundableRates(consolidatorAdmin, agency, bloquear);
    expect(await events(agency)).toHaveLength(1);
  });

  it('el superadmin fija el de cualquier nodo: bloquear al consolidador bloquea a toda su red', async () => {
    await permissions.setNonRefundableRates(consolidatorAdmin, agency, permitir);
    expect(await permissions.nonRefundableRates(agency)).toEqual({ effective: 'allowed' });

    await permissions.setNonRefundableRates(superadmin, consolidator, bloquear);
    expect(await permissions.nonRefundableRates(agency)).toEqual({
      effective: 'blocked',
      blockedBy: 'inherited',
    });
    expect(await permissions.nonRefundableRates(sibling)).toEqual({
      effective: 'blocked',
      blockedBy: 'inherited',
    });
    expect(await permissions.nonRefundableRates(foreign)).toEqual({ effective: 'allowed' });

    await permissions.setNonRefundableRates(superadmin, consolidator, permitir);
    expect(await permissions.nonRefundableRates(sibling)).toEqual({ effective: 'allowed' });
    expect((await events(consolidator)).map((e) => e.payload['to'])).toEqual([
      'blocked',
      'allowed',
    ]);
  });

  describe('la base, sin pasar por el servicio (app_user)', () => {
    it('la agencia no puede escribirse el permiso: la RLS lo frena', async () => {
      const err = await dbError(
        database.withRequestContext({ userId: agencyAdmin, tenantId: agency }, (trx) =>
          trx
            .insertInto('tenant_booking_permissions')
            .values({ tenant_id: agency, non_refundable_rates: 'allowed', updated_by: agencyAdmin })
            .execute(),
        ),
      );
      expect(err.startsWith('42501/')).toBe(true);
      expect(await permissions.nonRefundableRates(agency)).toEqual({ effective: 'allowed' });
    });

    it('quien financia no firma a nombre de otro usuario', async () => {
      const err = await dbError(
        database.withRequestContext({ userId: consolidatorAdmin, tenantId: sibling }, (trx) =>
          trx
            .insertInto('tenant_booking_permissions')
            .values({ tenant_id: sibling, non_refundable_rates: 'blocked', updated_by: superadmin })
            .execute(),
        ),
      );
      expect(err).toBe('42501/booking_permissions_author');
    });

    it('nadie lo borra desde la aplicación', async () => {
      await permissions.setNonRefundableRates(consolidatorAdmin, sibling, bloquear);
      const err = await dbError(
        database.withRequestContext({ userId: consolidatorAdmin, tenantId: sibling }, (trx) =>
          trx.deleteFrom('tenant_booking_permissions').where('tenant_id', '=', sibling).execute(),
        ),
      );
      expect(err.startsWith('42501/')).toBe(true);
      expect(await permissions.nonRefundableRates(sibling)).toEqual({
        effective: 'blocked',
        blockedBy: 'own',
      });
    });

    it('el bloqueo de un nodo ajeno no se consulta: lanza en vez de responder "permitido"', async () => {
      const err = await dbError(
        database.withTenant(sibling, (trx) =>
          sql`SELECT non_refundable_rates_block(${foreign}::uuid) AS block`.execute(trx),
        ),
      );
      expect(err).toBe('42501/booking_permissions_scope');
    });
  });
});
