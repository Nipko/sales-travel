import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { clearWalletHoldsOfTenants, seedOrder } from './__fixtures__/wallet-hold-seed.js';

/**
 * Quién escribe en las carteras y en los depósitos informados (0052), como `app_user`: el rol con
 * que corre la API en producción (NOSUPERUSER, NOBYPASSRLS). Como superusuario la RLS y las guardas
 * no se evalúan; acá sí.
 *
 * Cada caso corre en su propia transacción con los GUC que pone DatabaseService:
 * `withTenant(tenantId)` (sólo el tenant, como las retenciones) o
 * `withRequestContext({ userId, tenantId })` (el usuario que actúa y el nodo dueño de la cartera).
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD), como tenant-isolation.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

interface PgFailure {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
}

/** `código/regla` del error con que falla `p` (`?` si no nombra regla, como la RLS). */
async function rule(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as PgFailure;
    return `${e.code ?? '?'}/${e.constraint ?? '?'}`;
  }
  throw new Error('esperaba un error de Postgres');
}

d('carteras y depósitos informados bajo RLS (como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');

  /** SUPERUSUARIO: sólo para montar, mirar y desmontar. */
  const admin = new pg.Pool();
  /** La APLICACIÓN: sujeta a la RLS y a las guardas. */
  const app = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });

  const tenants: string[] = [];
  const users: string[] = [];

  /** Como DatabaseService: una transacción con los GUC del request. Confirma si `fn` no falla. */
  async function as<T>(
    ctx: { tenantId?: string; userId?: string },
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      if (ctx.userId !== undefined) {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.userId]);
      }
      if (ctx.tenantId !== undefined) {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
      }
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`wrls-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`wrls-${label}-${sfx}@test.local`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function wallet(tenantId: string, currency = 'COP'): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
       VALUES ($1, $2, 0, 0) RETURNING id`,
      [tenantId, currency],
    );
    return rows[0]!.id;
  }

  async function walletRow(
    id: string,
  ): Promise<{ limit: string; balance: string; status: string }> {
    const { rows } = await admin.query<{ limit: string; balance: string; status: string }>(
      `SELECT credit_limit_minor::text AS limit, balance_minor::text AS balance, status
         FROM agency_portfolios WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  /** El depósito que informa `userId` desde su agencia `tenantId`. */
  function submit(
    tenantId: string,
    userId: string,
    walletId: string,
    opts: { reportedBy?: string; walletTenant?: string; amount?: number } = {},
  ): Promise<string> {
    return as({ tenantId, userId }, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO portfolio_deposit_reports
           (tenant_id, portfolio_id, amount_minor, currency, reference, reported_by)
         VALUES ($1, $2, $3, 'COP', $4, $5) RETURNING id`,
        [
          opts.walletTenant ?? tenantId,
          walletId,
          opts.amount ?? 25_000,
          `TRX-${randomBytes(3).toString('hex')}`,
          opts.reportedBy ?? userId,
        ],
      );
      return rows[0]!.id;
    });
  }

  async function reportStatus(id: string): Promise<string> {
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM portfolio_deposit_reports WHERE id = $1',
      [id],
    );
    return rows[0]!.status;
  }

  /** Rechaza el depósito como `userId` actuando sobre la agencia; devuelve las filas tocadas. */
  function reject(userId: string, tenantId: string, id: string, resolvedBy = userId) {
    return as({ userId, tenantId }, async (c) => {
      const r = await c.query(
        `UPDATE portfolio_deposit_reports
            SET status = 'rejected', resolved_by = $2, resolution_reason = 'Sin soporte bancario'
          WHERE id = $1`,
        [id, resolvedBy],
      );
      return r.rowCount;
    });
  }

  // Raíz común → consolidador → agencia → sub-agencia; otra agencia del consolidador; una agencia
  // directa de Planetour.
  let consolidator: string;
  let agency: string;
  let subagency: string;
  let sibling: string;
  let direct: string;
  let wAgency: string;
  let wSub: string;
  let wSibling: string;
  let wDirect: string;

  let superadmin: string;
  let platformAdmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;
  let agencySeller: string;
  let siblingAdmin: string;
  let directAdmin: string;

  beforeAll(async () => {
    const platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    subagency = await tenant('s', 'subagency', agency);
    sibling = await tenant('b', 'agency', consolidator);
    direct = await tenant('d', 'agency', platform);
    wAgency = await wallet(agency);
    wSub = await wallet(subagency);
    wSibling = await wallet(sibling);
    wDirect = await wallet(direct);

    superadmin = await user('sa', platform, 'superadmin');
    platformAdmin = await user('pa', platform, 'platform_admin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    agencySeller = await user('av', agency, 'vendedor');
    siblingAdmin = await user('ba', sibling, 'tenant_admin');
    directAdmin = await user('da', direct, 'tenant_admin');
  });

  afterAll(async () => {
    await clearWalletHoldsOfTenants(admin, tenants);
    await admin.query('DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])', [tenants]);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await admin.end();
    await app.end();
  });

  it('app_user no se salta la RLS (si no, lo demás no prueba nada)', async () => {
    const { rows } = await app.query<{ bypass: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.bypass).toBe(false);
  });

  describe('la agencia no se financia a sí misma (brecha del 2026-09-28)', () => {
    const setLimit = (userId: string | undefined, tenantId: string, walletId: string, v: number) =>
      as({ tenantId, ...(userId === undefined ? {} : { userId }) }, (c) =>
        c.query('UPDATE agency_portfolios SET credit_limit_minor = $2 WHERE id = $1', [
          walletId,
          v,
        ]),
      );
    const entry = (userId: string | undefined, tenantId: string, walletId: string, type: string) =>
      as({ tenantId, ...(userId === undefined ? {} : { userId }) }, (c) =>
        c.query(
          `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, created_by)
           VALUES ($1, $2, $3, $4)`,
          [walletId, type === 'DEPOSIT_PAYMENT' ? 1_000_000 : -1_000, type, userId ?? randomUUID()],
        ),
      );

    it('su admin no se fija el cupo ni se cambia el estado', async () => {
      expect(await rule(setLimit(agencyAdmin, agency, wAgency, 9_000_000))).toBe(
        '42501/portfolio_financier_required',
      );
      expect(await rule(setLimit(undefined, agency, wAgency, 9_000_000))).toBe(
        '42501/portfolio_financier_required',
      );
      expect(
        await rule(
          as({ tenantId: agency, userId: agencyAdmin }, (c) =>
            c.query(`UPDATE agency_portfolios SET status = 'suspended' WHERE id = $1`, [wAgency]),
          ),
        ),
      ).toBe('42501/portfolio_financier_required');
      expect(await walletRow(wAgency)).toMatchObject({ limit: '0', status: 'active' });
    });

    it('su admin no se registra depósitos ni ajustes', async () => {
      for (const type of ['DEPOSIT_PAYMENT', 'MANUAL_ADJUSTMENT']) {
        expect(await rule(entry(agencyAdmin, agency, wAgency, type))).toBe(
          '42501/portfolio_financier_required',
        );
        expect(await rule(entry(undefined, agency, wAgency, type))).toBe(
          '42501/portfolio_financier_required',
        );
      }
    });

    it('puede abrir una cartera vacía, pero no una con cupo o saldo', async () => {
      const open = (limit: number, balance: number, currency: string) =>
        as({ tenantId: agency, userId: agencyAdmin }, (c) =>
          c.query(
            `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
             VALUES ($1, $2, $3, $4)`,
            [agency, currency, limit, balance],
          ),
        );
      expect(await rule(open(100_000, 0, 'EUR'))).toBe('42501/portfolio_financier_required');
      expect(await rule(open(0, 100_000, 'EUR'))).toBe('42501/portfolio_financier_required');
      await open(0, 0, 'EUR');
    });

    it('no borra su cartera para llevarse la deuda y el libro, ni se sube el cupo con un upsert', async () => {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
         VALUES ($1, 'PEN', 10000, -5000) RETURNING id`,
        [agency],
      );
      const debt = rows[0]!.id;
      await admin.query(
        `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
         VALUES ($1, -5000, 'BOOKING_HOLD', $2, $3)`,
        [debt, randomUUID(), agencySeller],
      );

      for (const userId of [agencyAdmin, consolidatorAdmin]) {
        expect(
          await rule(
            as({ tenantId: agency, userId }, (c) =>
              c.query('DELETE FROM agency_portfolios WHERE id = $1', [debt]),
            ),
          ),
        ).toBe('42501/?');
      }
      expect(
        await rule(
          as({ tenantId: agency, userId: agencyAdmin }, (c) =>
            c.query(
              `INSERT INTO agency_portfolios (tenant_id, currency) VALUES ($1, 'PEN')
               ON CONFLICT (tenant_id, currency) DO UPDATE SET credit_limit_minor = 999999999`,
              [agency],
            ),
          ),
        ),
      ).toBe('42501/portfolio_financier_required');

      expect(await walletRow(debt)).toEqual({ limit: '10000', balance: '-5000', status: 'active' });
      const { rows: ledger } = await admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM portfolio_transactions WHERE portfolio_id = $1',
        [debt],
      );
      expect(ledger[0]!.n).toBe('1');
    });

    it('sus reservas retienen y liberan saldo sin usuario (withTenant), sólo por las funciones de 0060', async () => {
      // A mano, ni el asiento de retención ni el saldo: desde 0060 son de wallet_hold_*.
      expect(
        await rule(
          as({ tenantId: agency }, (c) =>
            c.query(
              `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
               VALUES ($1, -5000, 'BOOKING_HOLD', $2, $3)`,
              [wAgency, randomUUID(), agencySeller],
            ),
          ),
        ),
      ).toBe('42501/hold_entry_reserved');
      expect(
        await rule(
          as({ tenantId: agency }, (c) =>
            c.query(
              'UPDATE agency_portfolios SET balance_minor = balance_minor - 5000 WHERE id = $1',
              [wAgency],
            ),
          ),
        ),
      ).toBe('42501/portfolio_balance_reserved');

      // Con su propia cuenta de proveedor la cadena de la red es vacía: retiene sólo la agencia.
      const provider = `wrls-prov-${sfx}`;
      const { rows: acc } = await admin.query<{ id: string }>(
        `INSERT INTO provider_accounts (tenant_id, provider_code, credentials_enc, status)
         VALUES ($1, $2, '\\x00'::bytea, 'active') RETURNING id`,
        [agency, provider],
      );
      await admin.query('UPDATE agency_portfolios SET credit_limit_minor = 5000 WHERE id = $1', [
        wAgency,
      ]);
      const orderId = await seedOrder(admin, {
        tenantId: agency,
        userId: agencySeller,
        provider,
        totalMinor: 5000,
        currency: 'COP',
        accountId: acc[0]!.id,
        pricing: null,
      });
      await admin.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', 'active')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [agency, agencySeller],
      );

      await as({ tenantId: agency }, (c) =>
        c.query('SELECT * FROM wallet_hold_retain($1::uuid, $2::uuid)', [orderId, agencySeller]),
      );
      expect((await walletRow(wAgency)).balance).toBe('-5000');

      await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [orderId]);
      const outcome = await as({ tenantId: agency }, async (c) => {
        const { rows } = await c.query<{ o: string }>(
          `SELECT wallet_hold_settle($1::uuid, $2::uuid, 'failed') AS o`,
          [orderId, agencySeller],
        );
        return rows[0]!.o;
      });
      expect(outcome).toBe('released');
      expect((await walletRow(wAgency)).balance).toBe('0');
      await admin.query('UPDATE agency_portfolios SET credit_limit_minor = 0 WHERE id = $1', [
        wAgency,
      ]);
    });

    it('el libro no se reescribe ni se borra desde la aplicación', async () => {
      expect(
        await rule(
          as({ tenantId: agency }, (c) =>
            c.query(`UPDATE portfolio_transactions SET amount_minor = 1 WHERE portfolio_id = $1`, [
              wAgency,
            ]),
          ),
        ),
      ).toBe('42501/?');
      expect(
        await rule(
          as({ tenantId: agency }, (c) =>
            c.query(`DELETE FROM portfolio_transactions WHERE portfolio_id = $1`, [wAgency]),
          ),
        ),
      ).toBe('42501/?');
    });
  });

  describe('quien financia gestiona la cartera', () => {
    it('el consolidador fija el cupo, suspende, reactiva y deposita en su agencia', async () => {
      await as({ userId: consolidatorAdmin, tenantId: agency }, async (c) => {
        await c.query('UPDATE agency_portfolios SET credit_limit_minor = 300000 WHERE id = $1', [
          wAgency,
        ]);
        await c.query(`UPDATE agency_portfolios SET status = 'suspended' WHERE id = $1`, [wAgency]);
        await c.query(`UPDATE agency_portfolios SET status = 'active' WHERE id = $1`, [wAgency]);
        await c.query(
          `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, created_by)
           VALUES ($1, 40000, 'DEPOSIT_PAYMENT', $2)`,
          [wAgency, consolidatorAdmin],
        );
        await c.query(
          'UPDATE agency_portfolios SET balance_minor = balance_minor + 40000 WHERE id = $1',
          [wAgency],
        );
      });
      expect(await walletRow(wAgency)).toEqual({
        limit: '300000',
        balance: '40000',
        status: 'active',
      });
    });

    it('la sub-agencia la financia su agencia, no el consolidador', async () => {
      const set = (userId: string) =>
        as({ userId, tenantId: subagency }, (c) =>
          c.query('UPDATE agency_portfolios SET credit_limit_minor = 1000 WHERE id = $1', [wSub]),
        );
      expect(await rule(set(consolidatorAdmin))).toBe('42501/portfolio_financier_required');
      await set(agencyAdmin);
      expect((await walletRow(wSub)).limit).toBe('1000');
    });

    it('lo que cuelga de Planetour lo financia su superadmin; ni el propio nodo ni el platform_admin', async () => {
      const set = (userId: string, v: number) =>
        as({ userId, tenantId: direct }, (c) =>
          c.query('UPDATE agency_portfolios SET credit_limit_minor = $2 WHERE id = $1', [
            wDirect,
            v,
          ]),
        );
      expect(await rule(set(directAdmin, 1))).toBe('42501/portfolio_financier_required');
      expect(await rule(set(platformAdmin, 2))).toBe('42501/portfolio_financier_required');
      await set(superadmin, 3);
      expect((await walletRow(wDirect)).limit).toBe('3');
    });

    it('el depósito o el ajuste lo firma quien actúa, con la hora de la base', async () => {
      expect(
        await rule(
          as({ userId: consolidatorAdmin, tenantId: agency }, (c) =>
            c.query(
              `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, created_by)
               VALUES ($1, 1000, 'DEPOSIT_PAYMENT', $2)`,
              [wAgency, agencyAdmin],
            ),
          ),
        ),
      ).toBe('42501/portfolio_entry_author');

      const signed = await as({ userId: consolidatorAdmin, tenantId: agency }, async (c) => {
        const { rows } = await c.query<{ by: string; fresh: boolean }>(
          `INSERT INTO portfolio_transactions
             (portfolio_id, amount_minor, transaction_type, created_by, created_at, notes)
           VALUES ($1, 0, 'MANUAL_ADJUSTMENT', $2, '2020-01-01', 'Prueba de firma')
           RETURNING created_by AS by, created_at > now() - interval '1 minute' AS fresh`,
          [wAgency, consolidatorAdmin],
        );
        return rows[0]!;
      });
      expect(signed).toEqual({ by: consolidatorAdmin, fresh: true });
    });

    it('la moneda de una cartera no cambia, ni para quien la financia', async () => {
      expect(
        await rule(
          as({ userId: consolidatorAdmin, tenantId: agency }, (c) =>
            c.query(`UPDATE agency_portfolios SET currency = 'USD' WHERE id = $1`, [wAgency]),
          ),
        ),
      ).toBe('STW01/portfolio_identity_immutable');
    });
  });

  describe('depósitos informados', () => {
    it('la agencia informa a su nombre, en su tenant y pendiente', async () => {
      const id = await submit(agency, agencySeller, wAgency);
      expect(await reportStatus(id)).toBe('pending');

      // A nombre de otro usuario, o sobre la cartera de otra agencia: la RLS no lo deja.
      expect(await rule(submit(agency, agencySeller, wAgency, { reportedBy: agencyAdmin }))).toBe(
        '42501/?',
      );
      expect(await rule(submit(agency, agencySeller, wSibling, { walletTenant: sibling }))).toBe(
        '42501/?',
      );
      // Sin usuario en el request (withTenant) tampoco.
      expect(
        await rule(
          as({ tenantId: agency }, (c) =>
            c.query(
              `INSERT INTO portfolio_deposit_reports
                 (tenant_id, portfolio_id, amount_minor, currency, reference, reported_by)
               VALUES ($1, $2, 100, 'COP', 'X', $3)`,
              [agency, wAgency, agencySeller],
            ),
          ),
        ),
      ).toBe('42501/?');
    });

    it('cada uno ve lo suyo y quien administra un ancestro, lo de su red', async () => {
      const deA = await submit(agency, agencySeller, wAgency);
      const deS = await submit(subagency, agencyAdmin, wSub);
      const deB = await submit(sibling, siblingAdmin, wSibling);
      const seen = (ctx: { tenantId?: string; userId?: string }) =>
        as(ctx, async (c) => {
          const { rows } = await c.query<{ id: string }>(
            'SELECT id FROM portfolio_deposit_reports WHERE id = ANY($1::uuid[])',
            [[deA, deS, deB]],
          );
          return rows.map((r) => r.id).sort();
        });

      expect(await seen({ tenantId: agency, userId: agencySeller })).toEqual([deA]);
      expect(await seen({ tenantId: sibling, userId: siblingAdmin })).toEqual([deB]);
      expect(await seen({ userId: consolidatorAdmin })).toEqual([deA, deS, deB].sort());
      expect(await seen({ userId: agencyAdmin })).toEqual([deA, deS].sort());
      expect(await seen({ userId: siblingAdmin })).toEqual([deB]);
      expect(await seen({ userId: directAdmin })).toEqual([]);
    });

    it('la agencia no resuelve sus propios depósitos; quien la financia, sí', async () => {
      const id = await submit(agency, agencySeller, wAgency);
      expect(await reject(agencyAdmin, agency, id)).toBe(0);
      expect(await reject(siblingAdmin, agency, id)).toBe(0);
      expect(await reportStatus(id)).toBe('pending');

      // Quien resuelve es el usuario que actúa, no otro.
      expect(await rule(reject(consolidatorAdmin, agency, id, superadmin))).toBe(
        '42501/deposit_report_resolver',
      );

      expect(await reject(consolidatorAdmin, agency, id)).toBe(1);
      expect(await reportStatus(id)).toBe('rejected');
      expect(await rule(reject(consolidatorAdmin, agency, id))).toBe(
        'STW01/deposit_report_not_pending',
      );

      const { rows } = await admin.query<{ actor: string; reason: string }>(
        `SELECT actor_user_id AS actor, payload->>'reason' AS reason FROM domain_events
          WHERE aggregate_id = $1 AND event_type = 'portfolio.deposit_report.rejected'`,
        [id],
      );
      expect(rows).toEqual([{ actor: consolidatorAdmin, reason: 'Sin soporte bancario' }]);
    });

    it('al aprobar, quien financia acredita el monto y enlaza el asiento, todo en una transacción', async () => {
      const id = await submit(agency, agencySeller, wAgency, { amount: 12_345 });
      const before = Number((await walletRow(wAgency)).balance);

      await as({ userId: consolidatorAdmin, tenantId: agency }, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
           VALUES ($1, 12345, 'DEPOSIT_PAYMENT', $2, $3) RETURNING id`,
          [wAgency, id, consolidatorAdmin],
        );
        await c.query(
          'UPDATE agency_portfolios SET balance_minor = balance_minor + 12345 WHERE id = $1',
          [wAgency],
        );
        await c.query(
          `UPDATE portfolio_deposit_reports
              SET status = 'approved', resolved_by = $2, portfolio_transaction_id = $3
            WHERE id = $1`,
          [id, consolidatorAdmin, rows[0]!.id],
        );
      });

      expect(await reportStatus(id)).toBe('approved');
      expect(Number((await walletRow(wAgency)).balance)).toBe(before + 12_345);
    });

    it('la agencia resuelve los de su sub-agencia y el superadmin, los de cualquiera', async () => {
      const deS = await submit(subagency, agencyAdmin, wSub);
      expect(await reject(consolidatorAdmin, subagency, deS)).toBe(0);
      expect(await reject(agencyAdmin, subagency, deS)).toBe(1);

      const deD = await submit(direct, directAdmin, wDirect);
      expect(await reject(directAdmin, direct, deD)).toBe(0);
      expect(await reject(superadmin, direct, deD)).toBe(1);
    });

    it('nadie los borra desde la aplicación', async () => {
      const id = await submit(agency, agencySeller, wAgency);
      expect(
        await rule(
          as({ userId: consolidatorAdmin, tenantId: agency }, (c) =>
            c.query('DELETE FROM portfolio_deposit_reports WHERE id = $1', [id]),
          ),
        ),
      ).toBe('42501/?');
      expect(await reportStatus(id)).toBe('pending');
    });
  });
});
