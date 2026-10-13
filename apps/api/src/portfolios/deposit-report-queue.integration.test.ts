import { randomBytes, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import {
  DepositReportQueueQuerySchema,
  InvalidQueueCursorError,
  type DepositReportQueueQuery,
} from './deposit-report-queue.schemas.js';
import { DepositReportQueueService } from './deposit-report-queue.service.js';
import { PortfoliosService } from './portfolios.service.js';
import { WalletFinancingService } from './wallet-financing.service.js';

/**
 * La cola de depósitos informados de toda la red (Plataforma → Aprobaciones), como `app_user`: el
 * rol de producción, sujeto a la RLS de 0052. Como superusuario se vería todo sin filtrar.
 *
 * La red: Planetour → consolidador C → agencia A (la financia C); Planetour → agencia directa D (la
 * financia Planetour). La base es compartida con otros tests: cada consulta busca por el sufijo del
 * test (`q`), que está en el nombre de sus nodos.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

d('cola de depósitos informados de toda la red (API como app_user)', () => {
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
  const queue = new DepositReportQueueService(database);
  const financing = new WalletFinancingService(database, new AuditService(database));
  const portfolios = new PortfoliosService(
    database,
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );

  const tenants: string[] = [];
  const users: string[] = [];

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`qdep-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`qdep-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function wallet(tenantId: string, currency: string): Promise<void> {
    await admin.query(
      `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
       VALUES ($1, $2, 0, 0)`,
      [tenantId, currency],
    );
  }

  async function report(
    actor: string,
    tenantId: string,
    currency: string,
    amountMinor: number,
    reference: string,
  ): Promise<string> {
    const r = await portfolios.submitDepositReport(
      actor,
      tenantId,
      { currency, amountMinor, reference, depositedOn: '2026-10-10', notes: 'Transferencia' },
      randomUUID(),
    );
    return r.id;
  }

  /** La query como la deja el pipe, buscando sólo lo de este test. */
  const q = (extra: Record<string, unknown> = {}): DepositReportQueueQuery =>
    DepositReportQueueQuerySchema.parse({ q: sfx, ...extra });

  let platform: string;
  let consolidator: string;
  let agency: string;
  let direct: string;

  let superadmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;
  let directAdmin: string;

  let agencyCop: string;
  let directUsd: string;
  let directCop: string;

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    direct = await tenant('d', 'agency', platform);

    superadmin = await user('sa', platform, 'superadmin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    directAdmin = await user('da', direct, 'tenant_admin');

    await wallet(agency, 'COP');
    await wallet(direct, 'USD');
    await wallet(direct, 'COP');

    // En orden: la cola los muestra del más viejo al más nuevo.
    agencyCop = await report(agencyAdmin, agency, 'COP', 70_000, `TRX-A-${sfx}`);
    directUsd = await report(directAdmin, direct, 'USD', 12_000, `WIRE-${sfx}`);
    directCop = await report(directAdmin, direct, 'COP', 5_000, `CONSIG-${sfx}`);
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

  it('el superadmin ve los pendientes de toda la red, del más viejo al más nuevo, con nodo y financiador', async () => {
    const view = await queue.list(superadmin, q());

    expect(view.status).toBe('pending');
    expect(view.nextCursor).toBeNull();
    expect(view.reports.map((r) => r.id)).toEqual([agencyCop, directUsd, directCop]);

    const [fromAgency, fromDirect] = view.reports;
    expect(fromAgency).toMatchObject({
      tenantId: agency,
      currency: 'COP',
      exponent: 2,
      amountMinor: 70_000,
      reference: `TRX-A-${sfx}`,
      depositedOn: '2026-10-10',
      notes: 'Transferencia',
      status: 'pending',
      reportedBy: agencyAdmin,
      reportedByName: 'Usuario aa',
      resolvedBy: null,
      tenant: { id: agency, name: `qdep-a-${sfx}`, tenantType: 'agency', isBranch: false },
      financier: { id: consolidator, name: `qdep-c-${sfx}`, tenantType: 'consolidator' },
      financedByPlatform: false,
    });
    expect(fromAgency!.reportedAt).toBeInstanceOf(Date);
    expect(fromDirect).toMatchObject({
      tenantId: direct,
      financier: { id: platform, tenantType: 'platform' },
      financedByPlatform: true,
    });

    // Por moneda, de todo lo filtrado: nunca se suman monedas distintas.
    expect(view.totals).toEqual([
      { currency: 'COP', exponent: 2, count: 2, amountMinor: 75_000 },
      { currency: 'USD', exponent: 2, count: 1, amountMinor: 12_000 },
    ]);
  });

  it('filtra por quién financia, moneda, subárbol y referencia', async () => {
    const ids = async (extra: Record<string, unknown>) =>
      (await queue.list(superadmin, q(extra))).reports.map((r) => r.id);

    expect(await ids({ financedBy: 'platform' })).toEqual([directUsd, directCop]);
    expect(await ids({ financedBy: 'network' })).toEqual([agencyCop]);
    expect(await ids({ currency: 'USD' })).toEqual([directUsd]);
    expect(await ids({ tenantId: consolidator })).toEqual([agencyCop]);
    expect(await ids({ tenantId: direct })).toEqual([directUsd, directCop]);
    expect(
      (
        await queue.list(superadmin, DepositReportQueueQuerySchema.parse({ q: `wire-${sfx}` }))
      ).reports.map((r) => r.id),
    ).toEqual([directUsd]);
    // Los comodines de ILIKE se buscan tal cual: `%` no encuentra todo.
    expect(
      (await queue.list(superadmin, DepositReportQueueQuerySchema.parse({ q: `%${sfx}` }))).reports,
    ).toEqual([]);
  });

  it('pagina con cursor sin repetir ni saltear', async () => {
    const first = await queue.list(superadmin, q({ limit: '2' }));
    expect(first.reports.map((r) => r.id)).toEqual([agencyCop, directUsd]);
    expect(first.nextCursor).not.toBeNull();
    // Los totales son de todo lo filtrado, no de la página.
    expect(first.totals.reduce((n, t) => n + t.count, 0)).toBe(3);

    const second = await queue.list(superadmin, q({ limit: '2', cursor: first.nextCursor }));
    expect(second.reports.map((r) => r.id)).toEqual([directCop]);
    expect(second.nextCursor).toBeNull();
  });

  it('un cursor que no armó la API es un 400', async () => {
    await expect(
      queue.list(superadmin, { ...q(), cursor: 'no-es-un-cursor' }),
    ).rejects.toBeInstanceOf(InvalidQueueCursorError);
  });

  it('quien no es superadmin sólo ve lo que financia: el consolidador sus agencias, la agencia nada propio', async () => {
    expect((await queue.list(consolidatorAdmin, q())).reports.map((r) => r.id)).toEqual([
      agencyCop,
    ]);
    expect((await queue.list(agencyAdmin, q())).reports).toEqual([]);
    expect((await queue.list(directAdmin, q())).reports).toEqual([]);
    expect(await queue.pendingCount(consolidatorAdmin)).toEqual({
      total: 1,
      platform: 0,
      network: 1,
    });
    expect(await queue.pendingCount(agencyAdmin)).toEqual({ total: 0, platform: 0, network: 0 });
  });

  it('el contador del superadmin separa lo que financia Planetour del resto de la red', async () => {
    const count = await queue.pendingCount(superadmin);
    // La base es compartida: otros tests pueden tener pendientes propios en este momento.
    expect(count.platform).toBeGreaterThanOrEqual(2);
    expect(count.network).toBeGreaterThanOrEqual(1);
    expect(count.total).toBe(count.platform + count.network);
  });

  it('al resolverlos salen de la cola y quedan en el historial, del último resuelto hacia atrás', async () => {
    await financing.approveDepositReport(superadmin, direct, directUsd, {
      reason: 'Visto en el extracto',
    });
    await financing.rejectDepositReport(superadmin, direct, directCop, {
      reason: 'No aparece en el banco',
    });

    expect((await queue.list(superadmin, q())).reports.map((r) => r.id)).toEqual([agencyCop]);

    const approved = await queue.list(superadmin, q({ status: 'approved' }));
    expect(approved.reports).toHaveLength(1);
    expect(approved.reports[0]).toMatchObject({
      id: directUsd,
      status: 'approved',
      resolvedBy: superadmin,
      resolvedByName: 'Usuario sa',
      resolutionReason: 'Visto en el extracto',
    });
    expect(approved.reports[0]!.resolvedAt).toBeInstanceOf(Date);
    expect(approved.reports[0]!.portfolioTransactionId).not.toBeNull();
    expect(approved.totals).toEqual([
      { currency: 'USD', exponent: 2, count: 1, amountMinor: 12_000 },
    ]);

    const rejected = await queue.list(superadmin, q({ status: 'rejected' }));
    expect(rejected.reports.map((r) => [r.id, r.resolutionReason])).toEqual([
      [directCop, 'No aparece en el banco'],
    ]);

    // Una segunda resolución de A después: el historial la pone primero.
    await financing.rejectDepositReport(superadmin, agency, agencyCop, { reason: 'Duplicado' });
    const history = await queue.list(superadmin, q({ status: 'rejected', limit: '1' }));
    expect(history.reports.map((r) => r.id)).toEqual([agencyCop]);
    const older = await queue.list(
      superadmin,
      q({ status: 'rejected', limit: '1', cursor: history.nextCursor }),
    );
    expect(older.reports.map((r) => r.id)).toEqual([directCop]);
    expect(older.nextCursor).toBeNull();
  });
});
