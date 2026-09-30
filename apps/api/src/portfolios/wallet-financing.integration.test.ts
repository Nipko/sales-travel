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
import { PortfoliosService } from './portfolios.service.js';
import { WALLET_EVENTS, WalletFinancingService } from './wallet-financing.service.js';

/**
 * Quien financia establece las carteras de cada agencia (decisión del founder del 2026-09-29, opción
 * A), por los servicios de la API y como `app_user`: el rol de producción, sujeto a la RLS y a las
 * guardas de 0052. Como superusuario nada de esto se evaluaría.
 *
 * La red: Planetour → consolidador C → agencia A → sub-agencia S; C → agencia hermana B; Planetour →
 * agencia directa D; Planetour → otro consolidador C2 → agencia X.
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD), como wallets-rls.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

interface Failure {
  readonly reason?: string;
  readonly status?: number;
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

d('quien financia establece las carteras (API como app_user)', () => {
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
      [`wfin-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`wfin-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function events(tenantId: string, eventType: string) {
    const { rows } = await admin.query<{
      actor: string | null;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id AS actor, aggregate_id, payload FROM domain_events
        WHERE tenant_id = $1 AND event_type = $2 ORDER BY occurred_at`,
      [tenantId, eventType],
    );
    return rows;
  }

  const cupo = (creditLimitMinor: number) => ({ creditLimitMinor, reason: 'Cupo aprobado' });
  const usd = (creditLimitMinor = 0) => ({
    currency: 'USD',
    creditLimitMinor,
    reason: 'Opera en dólares',
  });
  const deposito = (amountMinor: number) => ({
    currency: 'COP',
    amountMinor,
    reference: `TRX-${randomBytes(3).toString('hex')}`,
    depositedOn: null,
    notes: null,
  });

  let platform: string;
  let consolidator: string;
  let agency: string;
  let subagency: string;
  let sibling: string;
  let direct: string;
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
    direct = await tenant('d', 'agency', platform);
    otherConsolidator = await tenant('c2', 'consolidator', platform);
    foreign = await tenant('x', 'agency', otherConsolidator);

    superadmin = await user('sa', platform, 'superadmin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    siblingAdmin = await user('ba', sibling, 'tenant_admin');
    otherAdmin = await user('c2a', otherConsolidator, 'consolidator_admin');

    // Como producción: la cartera COP 0/0 que abría la API. Sin cupo, sin saldo.
    for (const t of [agency, sibling]) {
      await admin.query(
        `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
         VALUES ($1, 'COP', 0, 0)`,
        [t],
      );
    }
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

  describe('la agencia no gestiona la suya', () => {
    it('ni habilita monedas, ni fija su cupo, ni se registra depósitos o ajustes', async () => {
      const [cop] = (await financing.overview(consolidatorAdmin, agency)).portfolios;

      expect(await denied(financing.overview(agencyAdmin, agency))).toBe(
        '403/PORTFOLIO_FINANCIER_REQUIRED',
      );
      expect(await denied(financing.enableCurrency(agencyAdmin, agency, usd(9_000_000)))).toBe(
        '403/PORTFOLIO_FINANCIER_REQUIRED',
      );
      expect(
        await denied(financing.updateWallet(agencyAdmin, agency, cop!.id, cupo(9_000_000))),
      ).toBe('403/PORTFOLIO_FINANCIER_REQUIRED');
      expect(
        await denied(
          financing.recordDeposit(
            agencyAdmin,
            agency,
            cop!.id,
            { amountMinor: 1_000_000, reason: 'Me deposito' },
            randomUUID(),
          ),
        ),
      ).toBe('403/PORTFOLIO_FINANCIER_REQUIRED');
      expect(
        await denied(
          financing.recordAdjustment(
            agencyAdmin,
            agency,
            cop!.id,
            { amountMinor: 1_000_000, reason: 'Me ajusto' },
            randomUUID(),
          ),
        ),
      ).toBe('403/PORTFOLIO_FINANCIER_REQUIRED');

      const { rows } = await admin.query<{ n: string; limit: string; balance: string }>(
        `SELECT count(*)::text AS n, max(credit_limit_minor)::text AS limit,
                max(balance_minor)::text AS balance
           FROM agency_portfolios WHERE tenant_id = $1`,
        [agency],
      );
      expect(rows[0]).toEqual({ n: '1', limit: '0', balance: '0' });
    });

    it('pero sí gestiona las de su sub-agencia: la financia ella', async () => {
      const wallet = await financing.enableCurrency(agencyAdmin, subagency, {
        currency: 'COP',
        creditLimitMinor: 50_000,
        reason: 'Cupo inicial',
      });

      expect(wallet).toMatchObject({
        tenantId: subagency,
        currency: 'COP',
        creditLimitMinor: 50_000,
      });
    });
  });

  describe('un consolidador no gestiona fuera de su red', () => {
    it('ni la agencia de otro consolidador, ni una agencia directa de Planetour, ni la raíz', async () => {
      for (const target of [foreign, direct, platform]) {
        expect(await denied(financing.overview(consolidatorAdmin, target))).toBe(
          '403/PORTFOLIO_FINANCIER_REQUIRED',
        );
        expect(await denied(financing.enableCurrency(consolidatorAdmin, target, usd()))).toBe(
          '403/PORTFOLIO_FINANCIER_REQUIRED',
        );
      }
      expect(await denied(financing.overview(otherAdmin, agency))).toBe(
        '403/PORTFOLIO_FINANCIER_REQUIRED',
      );
    });

    it('ni la sub-agencia de su agencia: a esa la financia la agencia', async () => {
      expect(await denied(financing.overview(consolidatorAdmin, subagency))).toBe(
        '403/PORTFOLIO_FINANCIER_REQUIRED',
      );
    });

    it('un nodo que no existe responde igual: 403, sin confirmar el id', async () => {
      expect(await denied(financing.overview(consolidatorAdmin, randomUUID()))).toBe(
        '403/PORTFOLIO_FINANCIER_REQUIRED',
      );
    });
  });

  describe('una agencia hermana no ve otra', () => {
    it('ni por la gestión de quien financia, ni por su propia Cartera B2B', async () => {
      const reportOfA = await portfolios.submitDepositReport(
        agencyAdmin,
        agency,
        deposito(12_000),
        randomUUID(),
      );

      // Thunks y no promesas: creadas juntas, la segunda puede rechazar mientras se espera la
      // primera y queda como rechazo sin manejar (falló así contra Postgres real en el CI del #11).
      for (const read of [
        () => financing.overview(siblingAdmin, agency),
        () => financing.listMovements(siblingAdmin, agency),
        () => financing.listDepositReports(siblingAdmin, agency),
      ]) {
        expect(await denied(read())).toBe('403/PORTFOLIO_FINANCIER_REQUIRED');
      }

      const own = await portfolios.overview(sibling);
      expect(own.portfolios.map((w) => w.tenantId)).toEqual([sibling]);
      expect(own.financier).toEqual({ tenantId: consolidator, name: `wfin-c-${sfx}` });
      expect((await portfolios.listDepositReports(sibling)).map((r) => r.id)).not.toContain(
        reportOfA.id,
      );
      expect(
        (await portfolios.listTransactions(sibling)).every((m) =>
          own.portfolios.some((w) => w.id === m.portfolioId),
        ),
      ).toBe(true);
    });
  });

  describe('el superadmin gestiona cualquiera', () => {
    it('una agencia directa de Planetour, una de un consolidador y una sub-agencia', async () => {
      const onDirect = await financing.enableCurrency(superadmin, direct, usd(1_000_000));
      expect(onDirect).toMatchObject({ currency: 'USD', creditLimitMinor: 1_000_000 });

      const updated = await financing.updateWallet(superadmin, direct, onDirect.id, {
        creditLimitMinor: 2_000_000,
        status: 'suspended',
        reason: 'Revisión de riesgo',
      });
      expect(updated).toMatchObject({ creditLimitMinor: 2_000_000, status: 'suspended' });

      for (const target of [foreign, subagency, platform]) {
        await expect(financing.overview(superadmin, target)).resolves.toMatchObject({
          tenant: { id: target },
        });
      }
    });
  });

  describe('el recorrido completo', () => {
    it('el consolidador habilita USD con cupo; queda auditado y la lista de monedas se achica', async () => {
      // Ya tiene COP (la de producción): primero se ofrece el dólar.
      const before = await financing.overview(consolidatorAdmin, agency);
      expect(before.availableCurrencies[0]).toBe('USD');
      expect(before.availableCurrencies).not.toContain('COP');
      expect(before.availableCurrencies).not.toContain('CLP');

      const wallet = await financing.enableCurrency(consolidatorAdmin, agency, usd(300_000));
      expect(wallet).toMatchObject({
        currency: 'USD',
        exponent: 2,
        creditLimitMinor: 300_000,
        balanceMinor: 0,
        availableMinor: 300_000,
        status: 'active',
      });
      expect(await denied(financing.enableCurrency(consolidatorAdmin, agency, usd()))).toBe(
        '409/PORTFOLIO_ALREADY_ENABLED',
      );

      const after = await financing.overview(consolidatorAdmin, agency);
      expect(after.portfolios.map((w) => w.currency)).toEqual(['COP', 'USD']);
      expect(after.availableCurrencies).not.toContain('USD');

      expect(await events(agency, WALLET_EVENTS.created)).toEqual([
        {
          actor: consolidatorAdmin,
          aggregate_id: wallet.id,
          payload: expect.objectContaining({
            currency: 'USD',
            creditLimitMinor: 300_000,
            reason: 'Opera en dólares',
          }) as unknown,
        },
      ]);
    });

    it('fija el cupo con motivo, y un reenvío igual no audita dos veces', async () => {
      const [cop] = (await financing.overview(consolidatorAdmin, agency)).portfolios;

      await financing.updateWallet(consolidatorAdmin, agency, cop!.id, cupo(5_000_000));
      await financing.updateWallet(consolidatorAdmin, agency, cop!.id, cupo(5_000_000));

      expect(await events(agency, WALLET_EVENTS.creditLimitChanged)).toEqual([
        {
          actor: consolidatorAdmin,
          aggregate_id: cop!.id,
          payload: expect.objectContaining({
            fromMinor: 0,
            toMinor: 5_000_000,
            reason: 'Cupo aprobado',
          }) as unknown,
        },
      ]);
    });

    it('registra un depósito idempotente y un ajuste negativo, firmados por quien actúa', async () => {
      const [cop, usdWallet] = (await financing.overview(consolidatorAdmin, agency)).portfolios;
      expect(usdWallet?.currency).toBe('USD');
      const key = randomUUID();
      const body = { amountMinor: 250_000, reason: 'Transferencia verificada' };

      const first = await financing.recordDeposit(consolidatorAdmin, agency, cop!.id, body, key);
      const retry = await financing.recordDeposit(consolidatorAdmin, agency, cop!.id, body, key);
      expect(retry.transaction.id).toBe(first.transaction.id);
      expect(
        await denied(
          financing.recordDeposit(
            consolidatorAdmin,
            agency,
            cop!.id,
            { ...body, amountMinor: 1 },
            key,
          ),
        ),
      ).toBe('409/PORTFOLIO_IDEMPOTENCY_KEY_REUSED');
      // La misma clave contra la cartera de otra moneda no es un reintento: no acredita en USD.
      expect(
        await denied(financing.recordDeposit(consolidatorAdmin, agency, usdWallet!.id, body, key)),
      ).toBe('409/PORTFOLIO_IDEMPOTENCY_KEY_REUSED');
      const { rows: usdEntries } = await admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM portfolio_transactions WHERE portfolio_id = $1',
        [usdWallet!.id],
      );
      expect(usdEntries[0]!.n).toBe('0');

      const adj = await financing.recordAdjustment(
        consolidatorAdmin,
        agency,
        cop!.id,
        { amountMinor: -50_000, reason: 'Comisión de la red' },
        randomUUID(),
      );
      expect(adj.portfolio.balanceMinor).toBe(first.portfolio.balanceMinor - 50_000);
      expect(adj.transaction).toMatchObject({
        transactionType: 'MANUAL_ADJUSTMENT',
        amountMinor: -50_000,
        createdBy: consolidatorAdmin,
        createdByName: 'Usuario ca',
      });

      expect((await events(agency, WALLET_EVENTS.depositRecorded)).length).toBe(1);
      expect((await events(agency, WALLET_EVENTS.adjustmentRecorded)).length).toBe(1);

      // La agencia ve sus movimientos, con quién los registró.
      const seen = await portfolios.listTransactions(agency, 'COP');
      expect(seen.map((m) => m.id)).toEqual(
        expect.arrayContaining([first.transaction.id, adj.transaction.id]),
      );
    });

    it('la agencia informa un depósito; queda pendiente y no suma hasta que quien financia lo aprueba', async () => {
      const key = randomUUID();
      const input = { ...deposito(70_000), depositedOn: '2026-09-28', notes: 'Consignación' };
      const report = await portfolios.submitDepositReport(agencyAdmin, agency, input, key);
      expect(report).toMatchObject({
        status: 'pending',
        amountMinor: 70_000,
        currency: 'COP',
        depositedOn: '2026-09-28',
        reportedBy: agencyAdmin,
        reportedByName: 'Usuario aa',
      });

      // Un doble envío devuelve el mismo; con otros datos, 409.
      await expect(
        portfolios.submitDepositReport(agencyAdmin, agency, input, key),
      ).resolves.toMatchObject({ id: report.id });
      expect(
        await denied(
          portfolios.submitDepositReport(agencyAdmin, agency, { ...input, amountMinor: 1 }, key),
        ),
      ).toBe('409/PORTFOLIO_IDEMPOTENCY_KEY_REUSED');

      // La agencia no se lo aprueba.
      expect(
        await denied(
          financing.approveDepositReport(agencyAdmin, agency, report.id, { reason: null }),
        ),
      ).toBe('403/PORTFOLIO_FINANCIER_REQUIRED');

      const before = (await portfolios.overview(agency)).portfolios.find(
        (w) => w.currency === 'COP',
      )!;
      const approved = await financing.approveDepositReport(consolidatorAdmin, agency, report.id, {
        reason: null,
      });
      expect(approved.report).toMatchObject({
        status: 'approved',
        resolvedBy: consolidatorAdmin,
        portfolioTransactionId: approved.transaction!.id,
      });
      expect(approved.transaction).toMatchObject({
        transactionType: 'DEPOSIT_PAYMENT',
        amountMinor: 70_000,
        referenceId: report.id,
        createdBy: consolidatorAdmin,
      });
      expect(approved.portfolio.balanceMinor).toBe(before.balanceMinor + 70_000);

      // Una sola vez.
      expect(
        await denied(
          financing.approveDepositReport(consolidatorAdmin, agency, report.id, { reason: null }),
        ),
      ).toBe('409/DEPOSIT_REPORT_NOT_PENDING');

      expect(
        (await events(agency, 'portfolio.deposit_report.approved')).map((e) => e.actor),
      ).toEqual([consolidatorAdmin]);
    });

    it('rechazar exige motivo, no mueve el saldo y queda visible para la agencia', async () => {
      const report = await portfolios.submitDepositReport(
        agencyAdmin,
        agency,
        deposito(9_999),
        randomUUID(),
      );
      const before = (await portfolios.overview(agency)).portfolios.find(
        (w) => w.currency === 'COP',
      )!;

      const rejected = await financing.rejectDepositReport(consolidatorAdmin, agency, report.id, {
        reason: 'No aparece en el extracto',
      });

      expect(rejected.report).toMatchObject({
        status: 'rejected',
        resolutionReason: 'No aparece en el extracto',
        resolvedByName: 'Usuario ca',
      });
      expect(rejected.portfolio.balanceMinor).toBe(before.balanceMinor);
      const mine = await portfolios.listDepositReports(agency, 'rejected');
      expect(mine.map((r) => r.id)).toContain(report.id);
      expect(
        await denied(
          financing.rejectDepositReport(consolidatorAdmin, agency, report.id, {
            reason: 'Otra vez',
          }),
        ),
      ).toBe('409/DEPOSIT_REPORT_NOT_PENDING');
    });

    it('sin cartera en la moneda no se informa un depósito: se le pide a quien financia', async () => {
      expect(
        await denied(
          portfolios.submitDepositReport(
            agencyAdmin,
            agency,
            { ...deposito(1_000), currency: 'BRL' },
            randomUUID(),
          ),
        ),
      ).toBe('409/PORTFOLIO_CURRENCY_NOT_ENABLED');
    });

    it('un depósito informado de otro nodo no existe para este', async () => {
      const report = await portfolios.submitDepositReport(
        siblingAdmin,
        sibling,
        deposito(5_000),
        randomUUID(),
      );
      expect(
        await denied(
          financing.approveDepositReport(consolidatorAdmin, agency, report.id, { reason: null }),
        ),
      ).toBe('404/DEPOSIT_REPORT_NOT_FOUND');
    });
  });
});
