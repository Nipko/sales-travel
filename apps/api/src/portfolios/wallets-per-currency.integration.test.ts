import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyTenant, platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Carteras por moneda, quién financia a cada nodo y depósitos informados (0052), y el paso del
 * crédito interno al cupo de la cartera (0053), contra Postgres y como SUPERUSUARIO: el esquema, las
 * funciones y las reglas que valen para todos. Lo que depende de la RLS y de quién actúa está en
 * `wallets-rls.integration.test.ts`, como app_user.
 *
 * Corre sobre la base compartida por todos los tests de integración (redes colgadas de la raíz
 * común). 0053 se vuelve a correr dentro de una transacción que se deshace. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const CREDITO_A_CARTERAS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'db',
  'migrations',
  '0053_tenant_credit_limit_to_wallets.sql',
);

interface PgFailure {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
}

/** `código/regla` del error de Postgres con que falla `p`. Falla el test si `p` no falla. */
async function rule(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as PgFailure;
    return `${e.code ?? '?'}/${e.constraint ?? '?'}`;
  }
  throw new Error('esperaba un error de Postgres');
}

d('carteras por moneda y depósitos informados (0052, 0053) contra Postgres', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  const tenants: string[] = [];
  const users: string[] = [];
  let platform: string;

  async function tenant(
    slug: string,
    type: string,
    parent: string | null,
    opts: { status?: string; currency?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id,
                            status)
       VALUES ($1::text, $1::text, 'CO', $2, $3, $4, $5) RETURNING id`,
      [`wpc-${slug}-${sfx}`, opts.currency ?? 'COP', type, parent, opts.status ?? 'active'],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, status = 'active'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id`,
      [`wpc-${label}-${sfx}@test.local`, status],
    );
    users.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function member(
    userId: string,
    tenantId: string,
    role: string,
    status = 'active',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function wallet(
    tenantId: string,
    currency: string,
    opts: { limit?: number; balance?: number } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, currency, opts.limit ?? 0, opts.balance ?? 0],
    );
    return rows[0]!.id;
  }

  async function report(
    tenantId: string,
    walletId: string,
    reporter: string,
    opts: { amount?: number; currency?: string; key?: string; status?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO portfolio_deposit_reports
         (tenant_id, portfolio_id, amount_minor, currency, reference, reported_by, idempotency_key,
          status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'transferencia del lunes') RETURNING id`,
      [
        tenantId,
        walletId,
        opts.amount ?? 50_000,
        opts.currency ?? 'COP',
        `TRX-${randomBytes(3).toString('hex')}`,
        reporter,
        opts.key ?? null,
        opts.status ?? 'pending',
      ],
    );
    return rows[0]!.id;
  }

  async function ledgerEntry(
    walletId: string,
    amount: number,
    by: string,
    type = 'DEPOSIT_PAYMENT',
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [walletId, amount, type, by],
    );
    return rows[0]!.id;
  }

  function deposit(walletId: string, amount: number, by: string): Promise<string> {
    return ledgerEntry(walletId, amount, by);
  }

  /** Corre `fn` en una transacción con los GUC del request, y la deshace. */
  async function withGucs<T>(
    ctx: { userId?: string; tenantId?: string },
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (ctx.userId !== undefined) {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.userId]);
      }
      if (ctx.tenantId !== undefined) {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
      }
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  // La red: raíz común → consolidador → agencia → sub-agencia, otra agencia del consolidador, una
  // agencia directa de Planetour, una sucursal y un consolidador suspendido con su agencia.
  let consolidator: string;
  let agency: string;
  let subagency: string;
  let sibling: string;
  let direct: string;
  let branch: string;
  let suspendedConsolidator: string;
  let underSuspended: string;
  let legacy: string;

  let superadmin: string;
  let platformAdmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;
  let seller: string;
  let siblingAdmin: string;
  let suspendedMember: string;
  let suspendedUser: string;
  let adminOfSuspended: string;

  beforeAll(async () => {
    platform = await platformRootId(pool);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    subagency = await tenant('s', 'subagency', agency);
    sibling = await tenant('b', 'agency', consolidator);
    direct = await tenant('d', 'agency', platform);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id,
                            is_branch)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', $2, true) RETURNING id`,
      [`wpc-branch-${sfx}`, platform],
    );
    branch = rows[0]!.id;
    tenants.push(branch);
    suspendedConsolidator = await tenant('cx', 'consolidator', platform, { status: 'suspended' });
    underSuspended = await tenant('ax', 'agency', suspendedConsolidator);
    const c = await pool.connect();
    try {
      legacy = await legacyTenant(c, `wpc-legacy-${sfx}`, 'agency');
      tenants.push(legacy);
    } finally {
      c.release();
    }

    superadmin = await user('sa');
    await member(superadmin, platform, 'superadmin');
    platformAdmin = await user('pa');
    await member(platformAdmin, platform, 'platform_admin');
    consolidatorAdmin = await user('ca');
    await member(consolidatorAdmin, consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa');
    await member(agencyAdmin, agency, 'tenant_admin');
    seller = await user('av');
    await member(seller, consolidator, 'vendedor');
    siblingAdmin = await user('ba');
    await member(siblingAdmin, sibling, 'admin');
    suspendedMember = await user('cs');
    await member(suspendedMember, consolidator, 'consolidator_admin', 'suspended');
    suspendedUser = await user('cu', 'suspended');
    await member(suspendedUser, consolidator, 'tenant_admin');
    adminOfSuspended = await user('cxa');
    await member(adminOfSuspended, suspendedConsolidator, 'consolidator_admin');
  });

  afterAll(async () => {
    // parent_tenant_id es ON DELETE RESTRICT: de la hoja a la raíz. Las carteras, sus movimientos y
    // sus depósitos informados se van en cascada con el tenant.
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await pool.end();
  });

  describe('una cartera por moneda', () => {
    it('un nodo tiene una cartera por moneda y no dos en la misma', async () => {
      const t = await tenant('m1', 'agency', platform);
      await wallet(t, 'COP');
      await wallet(t, 'USD');
      expect(await rule(wallet(t, 'COP'))).toBe('23505/agency_portfolios_tenant_currency_key');
      const { rows } = await pool.query<{ currency: string }>(
        'SELECT currency FROM agency_portfolios WHERE tenant_id = $1 ORDER BY currency',
        [t],
      );
      expect(rows.map((r) => r.currency)).toEqual(['COP', 'USD']);
    });

    it('la moneda es obligatoria y va en ISO 4217 mayúsculas; cupo y estado válidos', async () => {
      const t = await tenant('m2', 'agency', platform);
      expect(
        await rule(pool.query('INSERT INTO agency_portfolios (tenant_id) VALUES ($1)', [t])),
      ).toBe('23502/?');
      expect(await rule(wallet(t, 'usd'))).toBe('23514/agency_portfolios_currency_format');
      expect(await rule(wallet(t, 'EUR', { limit: -1 }))).toBe(
        '23514/agency_portfolios_credit_limit_range',
      );
      expect(
        await rule(
          pool.query(
            `INSERT INTO agency_portfolios (tenant_id, currency, status) VALUES ($1, 'EUR', 'frozen')`,
            [t],
          ),
        ),
      ).toBe('23514/agency_portfolios_status_check');
    });

    it('la moneda y el nodo de una cartera no cambian, ni para el superusuario', async () => {
      const t = await tenant('m3', 'agency', platform);
      const w = await wallet(t, 'COP', { balance: 1_000_000 });
      expect(
        await rule(pool.query(`UPDATE agency_portfolios SET currency = 'USD' WHERE id = $1`, [w])),
      ).toBe('STW01/portfolio_identity_immutable');
      expect(
        await rule(
          pool.query(`UPDATE agency_portfolios SET tenant_id = $2 WHERE id = $1`, [w, direct]),
        ),
      ).toBe('STW01/portfolio_identity_immutable');
      // El upsert de siempre sigue funcionando: no cambia la moneda.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agency_portfolios (tenant_id, currency) VALUES ($1, 'COP')
         ON CONFLICT (tenant_id, currency) DO UPDATE SET currency = EXCLUDED.currency
         RETURNING id`,
        [t],
      );
      expect(rows[0]!.id).toBe(w);
    });
  });

  describe('quién financia (tenant_financier_id)', () => {
    it.each([
      ['la raíz', () => platform, () => null],
      ['un consolidador de Planetour', () => consolidator, () => platform],
      ['una agencia del consolidador', () => agency, () => consolidator],
      ['una sub-agencia', () => subagency, () => agency],
      ['una agencia directa de Planetour', () => direct, () => platform],
      ['una sucursal', () => branch, () => platform],
      ['un nodo legado sin padre', () => legacy, () => null],
    ])('%s', async (_label, node, expected) => {
      const { rows } = await pool.query<{ f: string | null }>(
        'SELECT tenant_financier_id($1::uuid) AS f',
        [node()],
      );
      expect(rows[0]!.f).toBe(expected());
    });
  });

  describe('quién puede financiar (can_finance_tenant)', () => {
    async function can(userId: string | undefined, node: string): Promise<boolean> {
      return withGucs({ ...(userId === undefined ? {} : { userId }) }, async (c) => {
        const { rows } = await c.query<{ ok: boolean }>(
          'SELECT can_finance_tenant($1::uuid) AS ok',
          [node],
        );
        return rows[0]!.ok;
      });
    }

    it.each([
      ['el superadmin, la raíz', true, () => superadmin, () => platform],
      ['el superadmin, una sub-agencia', true, () => superadmin, () => subagency],
      ['el superadmin, un nodo legado', true, () => superadmin, () => legacy],
      [
        'el platform_admin (retirado), una agencia de Planetour',
        false,
        () => platformAdmin,
        () => direct,
      ],
      ['el admin del consolidador, su agencia', true, () => consolidatorAdmin, () => agency],
      [
        'el admin del consolidador, otra agencia suya',
        true,
        () => consolidatorAdmin,
        () => sibling,
      ],
      ['el admin del consolidador, a sí mismo', false, () => consolidatorAdmin, () => consolidator],
      [
        'el admin del consolidador, la sub-agencia de su agencia',
        false,
        () => consolidatorAdmin,
        () => subagency,
      ],
      [
        'el admin del consolidador, una agencia de Planetour',
        false,
        () => consolidatorAdmin,
        () => direct,
      ],
      ['el admin de la agencia, a sí misma', false, () => agencyAdmin, () => agency],
      ['el admin de la agencia, su sub-agencia', true, () => agencyAdmin, () => subagency],
      ['el admin de la agencia, la agencia hermana', false, () => agencyAdmin, () => sibling],
      ['un vendedor del consolidador, su agencia', false, () => seller, () => agency],
      ['una membership suspendida', false, () => suspendedMember, () => agency],
      ['un usuario suspendido', false, () => suspendedUser, () => agency],
      [
        'el admin de un consolidador suspendido, su agencia',
        false,
        () => adminOfSuspended,
        () => underSuspended,
      ],
    ])('%s → %s', async (_label, expected, actor, node) => {
      expect(await can(actor(), node())).toBe(expected);
    });

    it('un admin de nodo EN la plataforma no financia lo que cuelga de Planetour: sólo su superadmin', async () => {
      // La membership vive sólo en esta transacción: la raíz común no carga roles de nodo.
      const u = await user('pt');
      const ok = await withGucs({ userId: u }, async (c) => {
        await c.query(
          `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'tenant_admin', 'active')`,
          [platform, u],
        );
        const { rows } = await c.query<{ direct: boolean; c: boolean }>(
          'SELECT can_finance_tenant($1::uuid) AS direct, can_finance_tenant($2::uuid) AS c',
          [direct, consolidator],
        );
        return rows[0]!;
      });
      expect(ok).toEqual({ direct: false, c: false });
    });

    it('sin usuario en el request, o con uno que no es un UUID, nadie financia', async () => {
      expect(await can(undefined, agency)).toBe(false);
      expect(await can('no-es-un-uuid', agency)).toBe(false);
      expect(await can(randomUUID(), randomUUID())).toBe(false);
    });
  });

  describe('depósitos informados', () => {
    let w: string;

    beforeAll(async () => {
      w = await wallet(agency, 'COP');
      await wallet(agency, 'USD');
    });

    it('nace pendiente, con la fecha de la base y su evento, sin la referencia ni el comentario', async () => {
      const id = await report(agency, w, agencyAdmin);
      const { rows } = await pool.query<{ status: string; fresh: boolean }>(
        `SELECT status, reported_at > now() - interval '1 minute' AS fresh
           FROM portfolio_deposit_reports WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ status: 'pending', fresh: true });
      const ev = await pool.query<{
        event_type: string;
        actor_user_id: string;
        tenant_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, actor_user_id, tenant_id, payload FROM domain_events
          WHERE aggregate_type = 'portfolio_deposit_report' AND aggregate_id = $1`,
        [id],
      );
      expect(ev.rows).toEqual([
        {
          event_type: 'portfolio.deposit_report.submitted',
          actor_user_id: agencyAdmin,
          tenant_id: agency,
          payload: {
            portfolioId: w,
            amountMinor: 50_000,
            currency: 'COP',
            status: 'pending',
            source: 'db:portfolio_deposit_reports',
          },
        },
      ]);
    });

    it('no nace resuelto, ni con una fecha inventada', async () => {
      expect(await rule(report(agency, w, agencyAdmin, { status: 'approved' }))).toBe(
        'STW01/deposit_report_born_pending',
      );
      const { rows } = await pool.query<{ fresh: boolean }>(
        `INSERT INTO portfolio_deposit_reports
           (tenant_id, portfolio_id, amount_minor, currency, reference, reported_by, reported_at)
         VALUES ($1, $2, 1000, 'COP', 'X-1', $3, '2020-01-01')
         RETURNING reported_at > now() - interval '1 minute' AS fresh`,
        [agency, w, agencyAdmin],
      );
      expect(rows[0]!.fresh).toBe(true);
    });

    it('es de ESA cartera: el nodo y la moneda tienen que ser los de la cartera', async () => {
      expect(await rule(report(agency, w, agencyAdmin, { currency: 'USD' }))).toBe(
        '23503/portfolio_deposit_reports_wallet_fk',
      );
      expect(await rule(report(sibling, w, agencyAdmin))).toBe(
        '23503/portfolio_deposit_reports_wallet_fk',
      );
    });

    it('monto positivo y referencia no vacía', async () => {
      expect(await rule(report(agency, w, agencyAdmin, { amount: 0 }))).toBe(
        '23514/portfolio_deposit_reports_amount_range',
      );
      expect(
        await rule(
          pool.query(
            `INSERT INTO portfolio_deposit_reports
               (tenant_id, portfolio_id, amount_minor, currency, reference, reported_by)
             VALUES ($1, $2, 1000, 'COP', '   ', $3)`,
            [agency, w, agencyAdmin],
          ),
        ),
      ).toBe('23514/portfolio_deposit_reports_reference_present');
    });

    it('un doble envío con la misma Idempotency-Key no crea dos pendientes', async () => {
      const key = randomUUID();
      await report(agency, w, agencyAdmin, { key });
      expect(await rule(report(agency, w, agencyAdmin, { key }))).toBe(
        '23505/uq_portfolio_deposit_reports_idempotency_key',
      );
      const other = await wallet(sibling, 'COP');
      await report(sibling, other, siblingAdmin, { key });
    });

    it('se rechaza una sola vez, con motivo, y deja su evento', async () => {
      const id = await report(agency, w, agencyAdmin);
      expect(
        await rule(
          pool.query(
            `UPDATE portfolio_deposit_reports SET status = 'rejected', resolved_by = $2 WHERE id = $1`,
            [id, consolidatorAdmin],
          ),
        ),
      ).toBe('23514/portfolio_deposit_reports_rejection_reason');

      // La fecha de la resolución la pone la base, aunque venga otra.
      await pool.query(
        `UPDATE portfolio_deposit_reports
            SET status = 'rejected', resolved_by = $2, resolution_reason = 'No aparece en el banco',
                resolved_at = '2020-01-01'
          WHERE id = $1`,
        [id, consolidatorAdmin],
      );
      const { rows } = await pool.query<{ status: string; fresh: boolean }>(
        `SELECT status, resolved_at > now() - interval '1 minute' AS fresh
           FROM portfolio_deposit_reports WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ status: 'rejected', fresh: true });

      expect(
        await rule(
          pool.query(
            `UPDATE portfolio_deposit_reports SET status = 'approved', resolved_by = $2 WHERE id = $1`,
            [id, consolidatorAdmin],
          ),
        ),
      ).toBe('STW01/deposit_report_not_pending');

      const ev = await pool.query<{ event_type: string; actor_user_id: string; reason: string }>(
        `SELECT event_type, actor_user_id, payload->>'reason' AS reason FROM domain_events
          WHERE aggregate_type = 'portfolio_deposit_report' AND aggregate_id = $1
          ORDER BY occurred_at, event_type DESC`,
        [id],
      );
      expect(ev.rows.map((e) => e.event_type)).toEqual([
        'portfolio.deposit_report.submitted',
        'portfolio.deposit_report.rejected',
      ]);
      expect(ev.rows[1]).toMatchObject({
        actor_user_id: consolidatorAdmin,
        reason: 'No aparece en el banco',
      });
    });

    it('se aprueba apuntando al DEPOSIT_PAYMENT de esa cartera por ese monto', async () => {
      const id = await report(agency, w, agencyAdmin, { amount: 70_000 });
      const approve = (entry: string | null) =>
        pool.query(
          `UPDATE portfolio_deposit_reports
              SET status = 'approved', resolved_by = $2, portfolio_transaction_id = $3
            WHERE id = $1`,
          [id, consolidatorAdmin, entry],
        );

      expect(await rule(approve(null))).toBe('STW01/deposit_report_ledger_entry');
      expect(await rule(approve(await deposit(w, 69_999, consolidatorAdmin)))).toBe(
        'STW01/deposit_report_ledger_entry',
      );
      const otherWallet = await wallet(sibling, 'USD');
      expect(await rule(approve(await deposit(otherWallet, 70_000, consolidatorAdmin)))).toBe(
        'STW01/deposit_report_ledger_entry',
      );
      // Un asiento de esa cartera y por ese monto que no es un depósito tampoco lo aprueba.
      for (const type of ['MANUAL_ADJUSTMENT', 'BOOKING_RELEASED']) {
        expect(await rule(approve(await ledgerEntry(w, 70_000, consolidatorAdmin, type)))).toBe(
          'STW01/deposit_report_ledger_entry',
        );
      }

      const entry = await deposit(w, 70_000, consolidatorAdmin);
      await approve(entry);
      const ev = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events
          WHERE aggregate_type = 'portfolio_deposit_report' AND aggregate_id = $1
            AND event_type = 'portfolio.deposit_report.approved'`,
        [id],
      );
      expect(ev.rows).toEqual([
        {
          payload: expect.objectContaining({
            status: 'approved',
            amountMinor: 70_000,
            portfolioTransactionId: entry,
          }) as unknown,
        },
      ]);

      // El mismo asiento no aprueba otro depósito.
      const twin = await report(agency, w, agencyAdmin, { amount: 70_000 });
      expect(
        await rule(
          pool.query(
            `UPDATE portfolio_deposit_reports
                SET status = 'approved', resolved_by = $2, portfolio_transaction_id = $3
              WHERE id = $1`,
            [twin, consolidatorAdmin, entry],
          ),
        ),
      ).toBe('23505/portfolio_deposit_reports_one_report_per_entry');
    });

    it('lo informado no se toca: ni editándolo pendiente ni al resolverlo', async () => {
      const id = await report(agency, w, agencyAdmin, { amount: 10_000 });
      expect(
        await rule(
          pool.query(`UPDATE portfolio_deposit_reports SET amount_minor = 99 WHERE id = $1`, [id]),
        ),
      ).toBe('STW01/deposit_report_transition');
      expect(
        await rule(
          pool.query(
            `UPDATE portfolio_deposit_reports
                SET status = 'rejected', resolved_by = $2, resolution_reason = 'x', reference = 'otra'
              WHERE id = $1`,
            [id, consolidatorAdmin],
          ),
        ),
      ).toBe('STW01/deposit_report_immutable');
    });

    it('borrar el nodo se lleva sus carteras, sus movimientos y sus depósitos aprobados', async () => {
      const t = await tenant('gone', 'agency', consolidator);
      const tw = await wallet(t, 'COP');
      const id = await report(t, tw, agencyAdmin, { amount: 5_000 });
      const entry = await deposit(tw, 5_000, consolidatorAdmin);
      await pool.query(
        `UPDATE portfolio_deposit_reports
            SET status = 'approved', resolved_by = $2, portfolio_transaction_id = $3
          WHERE id = $1`,
        [id, consolidatorAdmin, entry],
      );
      await pool.query('DELETE FROM tenants WHERE id = $1', [t]);
      const { rows } = await pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM portfolio_deposit_reports WHERE id = $1)
              + (SELECT count(*) FROM portfolio_transactions WHERE id = $2) AS n`,
        [id, entry],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  describe('el crédito interno pasa al cupo de la cartera (0053)', () => {
    const migracion = readFileSync(CREDITO_A_CARTERAS, 'utf8');

    it('lo pasa a la cartera de la moneda por defecto, deja su evento y no cambia al re-correrla', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const mk = async (slug: string, currency: string, credit: string): Promise<string> => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type,
                                  parent_tenant_id, credit_limit)
             VALUES ($1::text, $1::text, 'CO', $2, 'agency', $3, $4::numeric) RETURNING id`,
            [`wpc-0053-${slug}-${sfx}`, currency, platform, credit],
          );
          return rows[0]!.id;
        };
        const mkWallet = async (t: string, currency: string, limit: number): Promise<string> => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
             VALUES ($1, $2, $3, 0) RETURNING id`,
            [t, currency, limit],
          );
          return rows[0]!.id;
        };

        // Como producción: la cartera COP 0/0 de getOrCreatePortfolio, con crédito interno.
        const t1 = await mk('t1', 'COP', '1500.50');
        const w1 = await mkWallet(t1, 'COP', 0);
        // Crédito interno en USD y sólo la cartera COP que abría la API.
        const t2 = await mk('t2', 'USD', '200');
        const w2 = await mkWallet(t2, 'COP', 0);
        // Sin crédito interno y con un cupo que se puso la agencia: se conserva.
        const t3 = await mk('t3', 'COP', '0');
        const w3 = await mkWallet(t3, 'COP', 5_000);
        // Con los dos: manda el de la red.
        const t4 = await mk('t4', 'COP', '300');
        const w4 = await mkWallet(t4, 'COP', 90_000);
        // Sin crédito ni cartera: nada.
        const t5 = await mk('t5', 'COP', '0');
        const mine = [t1, t2, t3, t4, t5];

        await c.query(migracion);

        const { rows: carteras } = await c.query<{
          tenant_id: string;
          id: string;
          currency: string;
          limit: string;
          balance: string;
        }>(
          `SELECT tenant_id, id, currency, credit_limit_minor::text AS limit, balance_minor::text AS balance
             FROM agency_portfolios WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id, currency`,
          [mine],
        );
        const of = (t: string) =>
          carteras
            .filter((r) => r.tenant_id === t)
            .map(({ id, currency, limit, balance }) => ({ id, currency, limit, balance }));
        expect(of(t1)).toEqual([{ id: w1, currency: 'COP', limit: '150050', balance: '0' }]);
        expect(of(t2)).toEqual([
          { id: w2, currency: 'COP', limit: '0', balance: '0' },
          { id: expect.any(String) as unknown, currency: 'USD', limit: '20000', balance: '0' },
        ]);
        expect(of(t3)).toEqual([{ id: w3, currency: 'COP', limit: '5000', balance: '0' }]);
        expect(of(t4)).toEqual([{ id: w4, currency: 'COP', limit: '30000', balance: '0' }]);
        expect(of(t5)).toEqual([]);

        const eventos = async () =>
          (
            await c.query<{
              tenant_id: string;
              event_type: string;
              actor: string | null;
              payload: Record<string, unknown>;
            }>(
              `SELECT tenant_id, event_type, actor_user_id AS actor, payload FROM domain_events
                WHERE aggregate_type = 'agency_portfolio' AND tenant_id = ANY($1::uuid[])
                ORDER BY event_type, tenant_id`,
              [mine],
            )
          ).rows;
        const primera = await eventos();
        expect(primera).toHaveLength(3);
        expect(primera).toEqual(
          expect.arrayContaining([
            {
              tenant_id: t1,
              event_type: 'portfolio.credit_limit.changed',
              actor: null,
              payload: expect.objectContaining({
                fromMinor: 0,
                toMinor: 150_050,
                currency: 'COP',
              }) as unknown,
            },
            {
              tenant_id: t4,
              event_type: 'portfolio.credit_limit.changed',
              actor: null,
              payload: expect.objectContaining({ fromMinor: 90_000, toMinor: 30_000 }) as unknown,
            },
            {
              tenant_id: t2,
              event_type: 'portfolio.created',
              actor: null,
              payload: expect.objectContaining({
                creditLimitMinor: 20_000,
                currency: 'USD',
              }) as unknown,
            },
          ]),
        );

        // tenants.credit_limit se conserva.
        const { rows: creditos } = await c.query<{ credit_limit: string }>(
          'SELECT credit_limit::text AS credit_limit FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY slug',
          [[t1, t2, t4]],
        );
        expect(creditos.map((r) => r.credit_limit)).toEqual(['1500.50', '200.00', '300.00']);

        await c.query(migracion);
        expect(await eventos()).toHaveLength(3);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });
});
