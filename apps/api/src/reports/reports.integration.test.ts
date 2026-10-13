import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { ReportsService } from './reports.service.js';

/**
 * Reportes e Inicio contra la base, como `app_user` (el rol de producción, sujeto a la RLS): sólo
 * órdenes confirmadas de la agencia activa, de los últimos 12 meses, cada moneda por separado y los
 * vendedores que de verdad vendieron.
 *
 * La agencia A vende en COP y en USD con dos vendedores; la agencia B (otra red) vende también, y
 * nada suyo puede aparecer en los reportes de A.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const BOGOTA = 'America/Bogota';

d('Reportes de ventas (orders como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar los datos y desmontarlos. */
  const admin = new pg.Pool();
  const appPool = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });
  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appPool }) });
  const service = new ReportsService(database);

  const tenants: string[] = [];
  const users: string[] = [];
  let seq = 0;

  async function tenant(slug: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', $2) RETURNING id`,
      [`rep-${slug}-${sfx}`, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, name: string | null, tenantId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`rep-${label}-${sfx}@test.local`, name],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', 'active')`,
      [tenantId, rows[0]!.id],
    );
    return rows[0]!.id;
  }

  async function order(
    tenantId: string,
    userId: string,
    o: {
      status: string;
      amount: number;
      currency?: string;
      provider?: string;
      vertical?: string;
      ago?: string;
    },
  ): Promise<void> {
    seq += 1;
    await admin.query(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, currency, order_number, status, created_at,
                           updated_at)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $5, $6, $7, $8,
               now() - $9::interval, now() - $9::interval)`,
      [
        tenantId,
        userId,
        o.provider ?? 'latam-ndc',
        JSON.stringify(o.vertical === undefined ? {} : { vertical: o.vertical }),
        o.amount,
        o.currency ?? 'COP',
        seq,
        o.status,
        o.ago ?? '0 seconds',
      ],
    );
  }

  let agencyA: string;
  let agencyB: string;
  let ana: string;
  let sinNombre: string;
  let thisMonth: string;
  let tenMonthsAgo: string;
  let firstMonth: string;

  beforeAll(async () => {
    const platform = await platformRootId(admin);
    agencyA = await tenant('a', platform);
    agencyB = await tenant('b', platform);
    ana = await user('ana', 'Ana Ruiz', agencyA);
    sinNombre = await user('sn', null, agencyA);
    const otra = await user('otra', 'Otra Agencia', agencyB);

    // Este mes, en A.
    await order(agencyA, ana, { status: 'confirmed', amount: 100_000 });
    await order(agencyA, ana, { status: 'ticketed', amount: 200_000 });
    await order(agencyA, ana, { status: 'confirmed', amount: 50_000, currency: 'USD' });
    await order(agencyA, sinNombre, {
      status: 'confirmed',
      amount: 400_000,
      provider: 'tbo-hotels',
      vertical: 'hotels',
    });
    // No son ventas: ni canceladas, ni fallidas, ni en curso.
    await order(agencyA, ana, { status: 'cancelled', amount: 9_000_000 });
    await order(agencyA, ana, { status: 'failed', amount: 9_000_000 });
    await order(agencyA, ana, { status: 'pending', amount: 9_000_000 });
    // Dentro de los 12 meses, pero no de este mes.
    await order(agencyA, ana, { status: 'confirmed', amount: 7_000, ago: '10 months' });
    // Fuera de los 12 meses.
    await order(agencyA, ana, { status: 'confirmed', amount: 8_000_000, ago: '13 months' });
    // Otra agencia.
    await order(agencyB, otra, { status: 'confirmed', amount: 5_000_000 });

    const { rows } = await admin.query<{ now: string; ten: string; first: string }>(
      `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM') AS now,
              to_char((now() - interval '10 months') AT TIME ZONE $1, 'YYYY-MM') AS ten,
              to_char(date_trunc('month', now() AT TIME ZONE $1) - interval '11 months', 'YYYY-MM') AS first`,
      [BOGOTA],
    );
    thisMonth = rows[0]!.now;
    tenMonthsAgo = rows[0]!.ten;
    firstMonth = rows[0]!.first;
  });

  afterAll(async () => {
    await admin.query('DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])', [tenants]);
    for (const id of tenants) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('el período son los 12 meses que terminan en el actual, en hora de Bogotá', async () => {
    const metrics = await service.getSalesMetrics(agencyA);
    expect(metrics.period).toEqual({ from: firstMonth, to: thisMonth, timeZone: BOGOTA });
  });

  it('por vertical: sólo lo confirmado del período, COP y USD aparte', async () => {
    const metrics = await service.getSalesMetrics(agencyA);
    expect(metrics.byVertical).toEqual([
      { vertical: 'hotels', currency: 'COP', totalAmountMinor: 400_000, count: 1 },
      { vertical: 'flights', currency: 'COP', totalAmountMinor: 307_000, count: 3 },
      { vertical: 'flights', currency: 'USD', totalAmountMinor: 50_000, count: 1 },
    ]);
  });

  it('por mes: cada moneda en su fila', async () => {
    const metrics = await service.getSalesMetrics(agencyA);
    expect(metrics.monthlyTrend).toEqual([
      { month: tenMonthsAgo, currency: 'COP', amountMinor: 7_000, count: 1 },
      { month: thisMonth, currency: 'COP', amountMinor: 700_000, count: 3 },
      { month: thisMonth, currency: 'USD', amountMinor: 50_000, count: 1 },
    ]);
  });

  it('los vendedores salen de las órdenes reales; sin nombre, su correo', async () => {
    const metrics = await service.getSalesMetrics(agencyA);
    expect(metrics.topPerformers).toEqual([
      {
        userId: sinNombre,
        name: `rep-sn-${sfx}@test.local`,
        currency: 'COP',
        salesMinor: 400_000,
        count: 1,
      },
      { userId: ana, name: 'Ana Ruiz', currency: 'COP', salesMinor: 307_000, count: 3 },
      { userId: ana, name: 'Ana Ruiz', currency: 'USD', salesMinor: 50_000, count: 1 },
    ]);
    expect(JSON.stringify(metrics)).not.toContain('Carlos Mendoza');
  });

  it('una agencia sin ventas ve listas vacías, aunque otra de la red venda', async () => {
    const empty = await tenant('vacia', await platformRootId(admin));
    const metrics = await service.getSalesMetrics(empty);
    expect(metrics.byVertical).toEqual([]);
    expect(metrics.monthlyTrend).toEqual([]);
    expect(metrics.topPerformers).toEqual([]);
    const kpis = await service.getDashboardKpis(empty);
    expect(kpis.salesThisMonth).toEqual([]);
    expect(kpis.confirmedThisMonth).toBe(0);
  });

  it('una moneda escrita en minúsculas o con espacios es la misma moneda, en código ISO', async () => {
    const agency = await tenant('moneda', await platformRootId(admin));
    const seller = await user('moneda', 'Eva Gil', agency);
    await order(agency, seller, { status: 'confirmed', amount: 1_000, currency: 'COP' });
    await order(agency, seller, { status: 'ticketed', amount: 2_000, currency: ' cop ' });
    const metrics = await service.getSalesMetrics(agency);
    expect(metrics.byVertical).toEqual([
      { vertical: 'flights', currency: 'COP', totalAmountMinor: 3_000, count: 2 },
    ]);
    expect(metrics.monthlyTrend).toEqual([
      { month: thisMonth, currency: 'COP', amountMinor: 3_000, count: 2 },
    ]);
    expect(metrics.topPerformers).toEqual([
      { userId: seller, name: 'Eva Gil', currency: 'COP', salesMinor: 3_000, count: 2 },
    ]);
    const kpis = await service.getDashboardKpis(agency);
    expect(kpis.salesThisMonth).toEqual([{ currency: 'COP', amountMinor: 3_000 }]);
  });

  it('Inicio: las ventas del mes por moneda, sin lo de meses anteriores ni de otra agencia', async () => {
    const kpis = await service.getDashboardKpis(agencyA);
    expect(kpis.confirmedThisMonth).toBe(4);
    expect(kpis.salesThisMonth).toEqual([
      { currency: 'COP', amountMinor: 700_000 },
      { currency: 'USD', amountMinor: 50_000 },
    ]);
    const other = await service.getDashboardKpis(agencyB);
    expect(other.salesThisMonth).toEqual([{ currency: 'COP', amountMinor: 5_000_000 }]);
  });
});
