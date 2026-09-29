import { randomBytes, randomUUID } from 'node:crypto';
import { parseTboConfig, requireUsableTboConfig } from '@sales-travel/tbo-hotels';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blindIndex, derivePiiKeys, open } from './crypto.js';
import { FICTITIOUS_CUSTOMERS } from './customers.js';
import { resolveSeedEnv, SEED_DEFAULTS, SeedSecret, type SeedSettings } from './env.js';
import { SeedRefusedError } from './errors.js';
import {
  ENABLEMENT_REASON,
  runSeed,
  SEED_ACTOR_ID,
  TBO_PROVIDER_CODE,
  type PasswordHasher,
} from './seed.js';

/**
 * El seed contra Postgres con todas las migraciones, como corre en el stack.
 *
 * Se SALTA sin `PGHOST`/`PGUSER`/`PGPASSWORD`, como los demás `*.integration.test.ts`; en CI corre
 * contra la base migrada con el superusuario. Esa base la comparten los tests de `apps/api`: aquí
 * el slug, los correos y la clave son únicos por corrida, `database.expectedName` es el nombre
 * real y `dedicated` va apagado salvo en el test que lo prueba.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const SUFFIX = randomBytes(4).toString('hex');
const KEY = randomBytes(32);

/** bcrypt de verdad costaría ~250 ms por llamada; el hash del api se prueba en el contrato. */
const fakeHasher: PasswordHasher = {
  hash: (password) => Promise.resolve(`fake$${password}`),
  verify: (password, hash) => Promise.resolve(hash === `fake$${password}`),
};

let client: pg.Client;
let database: string;
const createdTenants: string[] = [];
const createdUsers: string[] = [];

function settings(
  overrides: {
    slug?: string;
    email?: string;
    vendedorPassword?: string;
    status?: 'active' | 'suspended';
    tboUsername?: string;
    tboPassword?: string;
    currency?: string;
    supportEmail?: string;
    supportPhone?: string;
    dedicated?: boolean;
    expectedName?: string;
  } = {},
): SeedSettings {
  const base = resolveSeedEnv({
    PGHOST: 'x',
    PGUSER: 'x',
    PGPASSWORD: 'x',
    PROVIDER_CREDENTIALS_KEY: KEY.toString('base64'),
    CERT_TBO_USERNAME: overrides.tboUsername ?? `tbo-it-${SUFFIX}`,
    CERT_TBO_PASSWORD: overrides.tboPassword ?? ' tbo pa$$ ',
    CERT_VENDEDOR_EMAIL: overrides.email ?? `vendedor-${SUFFIX}@example.com`,
    CERT_VENDEDOR_PASSWORD: overrides.vendedorPassword ?? 'vendedor-password-1',
    CERT_VENDEDOR_STATUS: overrides.status ?? 'active',
    CERT_CURRENCY: overrides.currency ?? 'USD',
    CERT_SUPPORT_EMAIL: overrides.supportEmail ?? '',
    CERT_SUPPORT_PHONE: overrides.supportPhone ?? '',
    CERT_WALLET_BALANCE: '1000',
    CERT_HOTEL_MARKUP_PERCENT: '4.5',
  });
  return {
    ...base,
    database: {
      expectedName: overrides.expectedName ?? database,
      dedicated: overrides.dedicated ?? false,
    },
    tenant: { ...base.tenant, slug: overrides.slug ?? `tbo-cert-it-${SUFFIX}` },
  };
}

async function q<R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
  return (await client.query<R>(text, values)).rows;
}

/** La raíz `platform` de la base (única desde 0050). */
async function platformId(): Promise<string> {
  const [row] = await q<{ id: string }>(`SELECT id FROM tenants WHERE tenant_type = 'platform'`);
  if (row === undefined) throw new Error('la base no tiene raíz platform');
  return row.id;
}

/**
 * Un consolidador raíz como el que sembraba el seed antes de 0050. La matriz D4 ya no deja crearlo,
 * así que se inserta con los triggers apagados sólo en esta transacción (`session_replication_role`,
 * superusuario) y con el `path` que le ponía 0011.
 */
async function legacyRootConsolidator(slug: string): Promise<string> {
  const id = randomUUID();
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `INSERT INTO tenants (id, slug, name, country_code, default_currency, tenant_type, path)
       VALUES ($1::uuid, $2, 'Legado', 'CO', 'USD', 'consolidator', replace($1::text, '-', '')::ltree)`,
      [id, slug],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  createdTenants.push(id);
  return id;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SeedRefusedError) return err.reason;
    throw err;
  }
  throw new Error('esperaba SeedRefusedError');
}

d('runSeed contra Postgres', () => {
  beforeAll(async () => {
    client = new pg.Client();
    await client.connect();
    database = (await q<{ db: string }>('SELECT current_database() AS db'))[0]?.db ?? '';
  });

  afterAll(async () => {
    if (client === undefined) return;
    for (const id of createdTenants) {
      await client.query('DELETE FROM orders WHERE tenant_id = $1', [id]).catch(() => undefined);
      await client.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await client.query('DELETE FROM users WHERE id = $1', [id]).catch(() => undefined);
    }
    await client.end();
  });

  it('siembra el tenant, el vendedor, la cuenta, la cartera, el markup y los clientes', async () => {
    const s = settings();
    const report = await runSeed(client, s, fakeHasher);
    createdTenants.push(report.tenantId);
    createdUsers.push(report.userId);

    expect(report).toMatchObject({
      tenant: 'created',
      vendedor: 'created',
      providerAccount: 'created',
      providerEnablement: 'created',
      markupRule: 'created',
      walletCurrency: 'USD',
      walletBalanceMinor: 100_000,
      walletToppedUpMinor: 100_000,
      customersCreated: FICTITIOUS_CUSTOMERS.length,
      customersExisting: 0,
    });

    const [tenant] = await q<{
      tenant_type: string;
      parent_tenant_id: string | null;
      default_currency: string;
    }>('SELECT tenant_type, parent_tenant_id, default_currency FROM tenants WHERE id = $1', [
      report.tenantId,
    ]);
    // Consolidador hijo de la raíz platform de la base (D4 A): la que ya hubiera o una del stack.
    expect(tenant).toEqual({
      tenant_type: 'consolidator',
      parent_tenant_id: report.platformTenantId,
      default_currency: 'USD',
    });
    expect(report.platformTenantId).toBe(await platformId());
    expect(['created', 'unchanged']).toContain(report.platform);

    // El contacto que el Book lee (BrandingService.resolveSupportContact): sin él, la reserva se
    // rechaza con "Falta el contacto de soporte de la agencia."
    const [support] = await q<{ support_email: string | null; support_phone: string | null }>(
      'SELECT support_email, support_phone FROM resolve_tenant_branding($1::uuid)',
      [report.tenantId],
    );
    expect(support).toEqual({
      support_email: SEED_DEFAULTS.supportEmail,
      support_phone: SEED_DEFAULTS.supportPhone,
    });

    const [member] = await q<{
      role: string;
      status: string;
      user_status: string;
      verified: boolean;
    }>(
      `SELECT m.role, m.status, u.status AS user_status, u.email_verified_at IS NOT NULL AS verified
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.user_id = $2`,
      [report.tenantId, report.userId],
    );
    expect(member).toEqual({
      role: 'vendedor',
      status: 'active',
      user_status: 'active',
      verified: true,
    });

    // La cuenta la resuelve la misma función que usa el api, y el ACL la acepta.
    const [account] = await q<{
      id: string;
      status: string;
      is_inheritable: boolean;
      credentials_enc: Uint8Array;
      config: Record<string, unknown>;
    }>(
      `SELECT id, status, is_inheritable, credentials_enc, config
         FROM resolve_provider_account($1::uuid, $2)`,
      [report.tenantId, TBO_PROVIDER_CODE],
    );
    expect(account?.id).toBe(report.providerAccountId);
    expect(account?.status).toBe('active');
    expect(account?.is_inheritable).toBe(false);
    const credentials = JSON.parse(open(Buffer.from(account!.credentials_enc), KEY)) as Record<
      string,
      string
    >;
    expect(credentials).toEqual({ username: `tbo-it-${SUFFIX}`, password: ' tbo pa$$ ' });
    expect(() =>
      requireUsableTboConfig(parseTboConfig({ ...account!.config, ...credentials })),
    ).not.toThrow();
    expect(account?.config).toEqual({ environment: 'test', baseUrl: s.tboAccount.baseUrl });

    // TBO encendido para el tenant como lo lee el api: por la cadena de `provider_enablement`
    // (0048), con el ajuste del propio tenant y su evento de auditoría.
    const chain = await q<{ tenant_id: string | null; enabled: boolean }>(
      `SELECT tenant_id, enabled FROM provider_enablement_chain($1::uuid) WHERE provider_code = $2`,
      [report.tenantId, TBO_PROVIDER_CODE],
    );
    expect(chain).toContainEqual({ tenant_id: report.tenantId, enabled: true });
    const [ajuste] = await q<{ reason: string; updated_by: string | null }>(
      `SELECT reason, updated_by FROM provider_enablement WHERE provider_code = $1 AND tenant_id = $2`,
      [TBO_PROVIDER_CODE, report.tenantId],
    );
    expect(ajuste).toEqual({ reason: ENABLEMENT_REASON, updated_by: null });
    const eventos = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE aggregate_type = 'provider_enablement' AND aggregate_id = $1`,
      [`${TBO_PROVIDER_CODE}@${report.tenantId}`],
    );
    expect(eventos.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        before: null,
        after: { enabled: true, reason: ENABLEMENT_REASON },
        source: 'seed-tbo-cert-tenant',
      }),
    ]);

    const [wallet] = await q<{ balance_minor: string; currency: string; status: string }>(
      'SELECT balance_minor::text, currency, status FROM agency_portfolios WHERE tenant_id = $1',
      [report.tenantId],
    );
    expect(wallet).toEqual({ balance_minor: '100000', currency: 'USD', status: 'active' });
    const ledger = await q<{ amount_minor: string; transaction_type: string; created_by: string }>(
      `SELECT pt.amount_minor::text, pt.transaction_type, pt.created_by::text
         FROM portfolio_transactions pt JOIN agency_portfolios ap ON ap.id = pt.portfolio_id
        WHERE ap.tenant_id = $1`,
      [report.tenantId],
    );
    expect(ledger).toEqual([
      { amount_minor: '100000', transaction_type: 'DEPOSIT_PAYMENT', created_by: SEED_ACTOR_ID },
    ]);

    const rules = await q<{ applied: string }>(
      `SELECT value_minor::text AS applied FROM applicable_markup_rules($1::uuid, 'hotels')`,
      [report.tenantId],
    );
    expect(rules).toEqual([{ applied: '450' }]);

    // Documento cifrado como lo lee el api: sin valor en claro, descifrable y con su índice ciego.
    const keys = derivePiiKeys(KEY);
    const customers = await q<{
      document_number: string | null;
      document_number_enc: Uint8Array;
      document_number_hash: string;
      nationality: string;
    }>(
      `SELECT document_number, document_number_enc, document_number_hash, nationality
         FROM customers WHERE tenant_id = $1 ORDER BY nationality`,
      [report.tenantId],
    );
    expect(customers.map((c) => c.nationality)).toEqual(['BRA', 'COL', 'PER', 'USA']);
    for (const c of customers) {
      expect(c.document_number).toBeNull();
      const plain = open(Buffer.from(c.document_number_enc), keys.encryption);
      expect(c.document_number_hash).toBe(blindIndex(plain, keys.index));
    }
  });

  it('una segunda corrida no duplica nada ni rota la contraseña', async () => {
    const report = await runSeed(client, settings(), fakeHasher);
    expect(report).toMatchObject({
      platform: 'unchanged',
      tenant: 'unchanged',
      vendedor: 'unchanged',
      passwordRotated: false,
      providerAccount: 'unchanged',
      providerEnablement: 'unchanged',
      markupRule: 'unchanged',
      walletToppedUpMinor: 0,
      customersCreated: 0,
      customersExisting: FICTITIOUS_CUSTOMERS.length,
    });
    const [{ n } = { n: 0 }] = await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1',
      [report.tenantId],
    );
    expect(n).toBe(FICTITIOUS_CUSTOMERS.length);
  });

  it('TBO apagado desde el panel del stack vuelve a quedar encendido en el despliegue siguiente', async () => {
    const s = settings();
    const [tenant] = await q<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [
      s.tenant.slug,
    ]);
    await client.query(
      `UPDATE provider_enablement SET enabled = false, reason = 'apagado a mano'
        WHERE provider_code = $1 AND tenant_id = $2`,
      [TBO_PROVIDER_CODE, tenant!.id],
    );

    const report = await runSeed(client, s, fakeHasher);

    expect(report.providerEnablement).toBe('updated');
    const [ajuste] = await q<{ enabled: boolean; reason: string }>(
      `SELECT enabled, reason FROM provider_enablement WHERE provider_code = $1 AND tenant_id = $2`,
      [TBO_PROVIDER_CODE, tenant!.id],
    );
    expect(ajuste).toEqual({ enabled: true, reason: ENABLEMENT_REASON });
  });

  it('recarga la cartera hasta el objetivo después de que una reserva retuvo saldo', async () => {
    const s = settings();
    const [wallet] = await q<{ id: string }>(
      `SELECT ap.id FROM agency_portfolios ap JOIN tenants t ON t.id = ap.tenant_id WHERE t.slug = $1`,
      [s.tenant.slug],
    );
    await client.query(
      'UPDATE agency_portfolios SET balance_minor = balance_minor - 30000 WHERE id = $1',
      [wallet!.id],
    );
    const report = await runSeed(client, s, fakeHasher);
    expect(report.walletToppedUpMinor).toBe(30_000);
    expect(report.walletBalanceMinor).toBe(100_000);
  });

  it('otra CERT_CURRENCY abre la cartera de esa moneda y la anterior queda como estaba (0052)', async () => {
    const slug = `tbo-cert-it-cur-${SUFFIX}`;
    const email = `vendedor-cur-${SUFFIX}@example.com`;
    const usd = await runSeed(client, settings({ slug, email }), fakeHasher);
    createdTenants.push(usd.tenantId);
    createdUsers.push(usd.userId);
    const [held] = await q<{ id: string }>(
      `SELECT id FROM agency_portfolios WHERE tenant_id = $1 AND currency = 'USD'`,
      [usd.tenantId],
    );
    await client.query(
      'UPDATE agency_portfolios SET balance_minor = balance_minor - 30000 WHERE id = $1',
      [held!.id],
    );

    const eur = await runSeed(client, settings({ slug, email, currency: 'EUR' }), fakeHasher);
    expect(eur).toMatchObject({ walletCurrency: 'EUR', walletToppedUpMinor: 100_000 });
    const wallets = await q<{ currency: string; balance_minor: string }>(
      `SELECT currency, balance_minor::text FROM agency_portfolios WHERE tenant_id = $1
        ORDER BY currency`,
      [usd.tenantId],
    );
    expect(wallets).toEqual([
      { currency: 'EUR', balance_minor: '100000' },
      { currency: 'USD', balance_minor: '70000' },
    ]);
  });

  it('cambia el contacto de soporte con sus variables, y no lo reescribe si no cambió', async () => {
    const s = settings({
      supportEmail: `reservas-${SUFFIX}@example.com`,
      supportPhone: '+57 (601) 000-0000',
    });
    expect((await runSeed(client, s, fakeHasher)).tenant).toBe('updated');
    const again = await runSeed(client, s, fakeHasher);
    expect(again.tenant).toBe('unchanged');
    const [support] = await q<{ support_email: string | null; support_phone: string | null }>(
      'SELECT support_email, support_phone FROM resolve_tenant_branding($1::uuid)',
      [again.tenantId],
    );
    expect(support).toEqual({
      support_email: `reservas-${SUFFIX}@example.com`,
      support_phone: '+57 (601) 000-0000',
    });
  });

  it('rota la contraseña y la cuenta de TBO cuando cambian, e invalida las sesiones', async () => {
    const report = await runSeed(
      client,
      settings({ vendedorPassword: 'otra-password-2', tboPassword: 'rotada' }),
      fakeHasher,
    );
    expect(report).toMatchObject({
      vendedor: 'updated',
      passwordRotated: true,
      providerAccount: 'updated',
    });
    const [user] = await q<{ password_hash: string; changed: boolean }>(
      'SELECT password_hash, password_changed_at IS NOT NULL AS changed FROM users WHERE id = $1',
      [report.userId],
    );
    expect(user).toEqual({ password_hash: 'fake$otra-password-2', changed: true });
  });

  it('suspender al vendedor tras el sign-off corta el acceso', async () => {
    const report = await runSeed(
      client,
      settings({ vendedorPassword: 'otra-password-2', tboPassword: 'rotada', status: 'suspended' }),
      fakeHasher,
    );
    const [row] = await q<{ user_status: string; member_status: string }>(
      `SELECT u.status AS user_status, m.status AS member_status
         FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 WHERE u.id = $1`,
      [report.userId, report.tenantId],
    );
    expect(row).toEqual({ user_status: 'suspended', member_status: 'suspended' });
  });

  it('se niega a sembrar otra base que la del stack', async () => {
    expect(
      await refusal(runSeed(client, settings({ expectedName: 'sales_travel_cert_x' }), fakeHasher)),
    ).toBe('wrong_database');
  });

  it('en la base dedicada, se niega si hay cuentas de otros proveedores (RC-07)', async () => {
    const s = settings({
      slug: `tbo-cert-it-foreign-${SUFFIX}`,
      email: `vendedor-foreign-${SUFFIX}@example.com`,
    });
    const report = await runSeed(client, s, fakeHasher);
    createdTenants.push(report.tenantId);
    createdUsers.push(report.userId);
    await client.query(
      `INSERT INTO provider_accounts (tenant_id, provider_code, credentials_enc, status)
       VALUES ($1, 'despegar-hotels', '\\x00'::bytea, 'active')`,
      [report.tenantId],
    );
    expect(
      await refusal(
        runSeed(
          client,
          { ...s, database: { expectedName: database, dedicated: true } },
          fakeHasher,
        ),
      ),
    ).toBe('foreign_provider_accounts');
  });

  it('no le cambia la contraseña a un usuario de otra red', async () => {
    const [other] = await q<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1, 'Otra red', 'CO', 'USD', 'agency', $2) RETURNING id`,
      [`otra-red-${SUFFIX}`, await platformId()],
    );
    createdTenants.push(other!.id);
    const email = `ajeno-${SUFFIX}@example.com`;
    const [user] = await q<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'hash-ajeno', 'Ajeno') RETURNING id`,
      [email],
    );
    createdUsers.push(user!.id);
    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'tenant_admin', 'active')`,
      [other!.id, user!.id],
    );

    expect(await refusal(runSeed(client, settings({ email }), fakeHasher))).toBe(
      'user_in_other_network',
    );
    const [after] = await q<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user!.id],
    );
    expect(after?.password_hash).toBe('hash-ajeno');
  });

  it('no cambia usuario de la cuenta de TBO si ya tiene órdenes (post-venta)', async () => {
    const s = settings({ vendedorPassword: 'otra-password-2', tboPassword: 'rotada' });
    const [row] = await q<{ tenant_id: string; user_id: string; account_id: string }>(
      `SELECT t.id AS tenant_id, m.user_id, pa.id AS account_id
         FROM tenants t
         JOIN memberships m ON m.tenant_id = t.id
         JOIN provider_accounts pa ON pa.tenant_id = t.id AND pa.provider_code = $2
        WHERE t.slug = $1`,
      [s.tenant.slug, TBO_PROVIDER_CODE],
    );
    await client.query(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, order_number, provider_account_id)
       VALUES ($1, $2, 'tbo-hotels', '{}', '{}', '[]', '{}', 100, 999001, $3)`,
      [row!.tenant_id, row!.user_id, row!.account_id],
    );
    expect(
      await refusal(runSeed(client, settings({ tboUsername: `otro-${SUFFIX}` }), fakeHasher)),
    ).toBe('account_in_use');
  });

  it('no siembra sobre un tenant con ese slug que no sea un consolidador de la plataforma', async () => {
    const slug = `tbo-cert-it-agency-${SUFFIX}`;
    const [agency] = await q<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1, 'Agencia', 'CO', 'USD', 'agency', $2) RETURNING id`,
      [slug, await platformId()],
    );
    createdTenants.push(agency!.id);
    expect(await refusal(runSeed(client, settings({ slug }), fakeHasher))).toBe('tenant_shape');
  });

  it('el consolidador raíz de una versión anterior del seed pasa a colgar de la plataforma', async () => {
    const slug = `tbo-cert-it-legacy-${SUFFIX}`;
    const legacy = await legacyRootConsolidator(slug);

    const report = await runSeed(
      client,
      settings({ slug, email: `vendedor-legacy-${SUFFIX}@example.com` }),
      fakeHasher,
    );
    createdUsers.push(report.userId);

    expect(report).toMatchObject({
      tenantId: legacy,
      tenant: 'updated',
      platform: 'unchanged',
      placement: 'platform',
    });
    const [row] = await q<{ parent_tenant_id: string; depth: number }>(
      'SELECT parent_tenant_id, nlevel(path) AS depth FROM tenants WHERE id = $1',
      [legacy],
    );
    expect(row).toEqual({ parent_tenant_id: await platformId(), depth: 2 });
    const moved = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE event_type = 'tenant.moved' AND aggregate_id = $1`,
      [legacy],
    );
    expect(moved.map((e) => e.payload)).toEqual([
      expect.objectContaining({ fromParentId: null, toParentId: await platformId() }),
    ]);

    // La corrida siguiente ya lo encuentra en su lugar.
    const again = await runSeed(
      client,
      settings({ slug, email: `vendedor-legacy-${SUFFIX}@example.com` }),
      fakeHasher,
    );
    expect(again).toMatchObject({ tenant: 'unchanged', placement: 'platform' });
  });

  it('con reservas abiertas pagadas con cartera no lo mueve, siembra igual y lo reintenta en la corrida siguiente', async () => {
    const slug = `tbo-cert-it-legacy-held-${SUFFIX}`;
    const legacy = await legacyRootConsolidator(slug);
    const [user] = await q<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
      `legacy-held-${SUFFIX}@example.com`,
    ]);
    createdUsers.push(user!.id);
    const [wallet] = await q<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency) VALUES ($1, 'USD') RETURNING id`,
      [legacy],
    );
    const [order] = await q<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, order_number, status)
       VALUES ($1, $2, 'tbo-hotels', '{}', '{}', '[]', '{}', 100, 999101, 'confirmed')
       RETURNING id`,
      [legacy, user!.id],
    );
    await client.query(
      `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
       VALUES ($1, -100, 'BOOKING_HOLD', $2, $3)`,
      [wallet!.id, order!.id, user!.id],
    );

    const heldSettings = settings({ slug, email: `vendedor-legacy-held-${SUFFIX}@example.com` });
    const blocked = await runSeed(client, heldSettings, fakeHasher);
    createdUsers.push(blocked.userId);

    // La base no lo deja mover (D6 A) y el seed no lo fuerza, pero el resto queda sembrado: el
    // despliegue del stack no se pone en rojo por las reservas de prueba de TBO.
    expect(blocked).toMatchObject({ tenantId: legacy, placement: 'legacy-root' });
    const [row] = await q<{ parent_tenant_id: string | null }>(
      'SELECT parent_tenant_id FROM tenants WHERE id = $1',
      [legacy],
    );
    expect(row?.parent_tenant_id).toBeNull();
    const [account] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_accounts WHERE tenant_id = $1 AND status = 'active'`,
      [legacy],
    );
    expect(account?.n).toBe(1);
    const noMove = await q(
      `SELECT 1 FROM domain_events WHERE event_type = 'tenant.moved' AND aggregate_id = $1`,
      [legacy],
    );
    expect(noMove).toHaveLength(0);

    // Liberada la retención, la corrida siguiente lo cuelga de la plataforma.
    await client.query(
      `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
       VALUES ($1, 100, 'BOOKING_RELEASED', $2, $3)`,
      [wallet!.id, order!.id, user!.id],
    );
    const retried = await runSeed(client, heldSettings, fakeHasher);
    expect(retried).toMatchObject({ tenantId: legacy, tenant: 'updated', placement: 'platform' });
    const [after] = await q<{ parent_tenant_id: string | null }>(
      'SELECT parent_tenant_id FROM tenants WHERE id = $1',
      [legacy],
    );
    expect(after?.parent_tenant_id).toBe(await platformId());
  });

  it('la clave del stack cambió: no sobrescribe una cuenta que ya no puede leer', async () => {
    const s = settings({ vendedorPassword: 'otra-password-2', tboPassword: 'rotada' });
    expect(
      await refusal(runSeed(client, { ...s, credentialsKey: randomBytes(32) }, fakeHasher)),
    ).toBe('undecryptable_account');
  });

  it('el reporte no lleva ninguna contraseña', async () => {
    const report = await runSeed(
      client,
      settings({ vendedorPassword: 'otra-password-2', tboPassword: 'rotada', status: 'suspended' }),
      fakeHasher,
    );
    const dump = JSON.stringify(report);
    expect(dump).not.toContain('otra-password-2');
    expect(dump).not.toContain('rotada');
    expect(new SeedSecret('x').toJSON()).toBe('[redacted]');
  });
});
