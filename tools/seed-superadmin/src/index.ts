import bcrypt from 'bcrypt';
import { Client } from 'pg';

interface Config {
  databaseUrl: string;
  email: string;
  password: string;
  name: string;
  tenantSlug: string;
  tenantName: string;
  tenantCountry: string;
  tenantCurrency: string;
}

function readConfig(): Config {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v || !v.trim()) {
      throw new Error(`missing required env: ${key}`);
    }
    return v.trim();
  };

  return {
    databaseUrl: required('DATABASE_URL_ADMIN'),
    email: required('SUPERADMIN_EMAIL').toLowerCase(),
    password: required('SUPERADMIN_PASSWORD'),
    name: required('SUPERADMIN_NAME'),
    tenantSlug: process.env.SUPERADMIN_TENANT_SLUG?.trim() ?? 'platform',
    tenantName: process.env.SUPERADMIN_TENANT_NAME?.trim() ?? 'Platform',
    tenantCountry: process.env.SUPERADMIN_TENANT_COUNTRY?.trim() ?? 'CO',
    tenantCurrency: process.env.SUPERADMIN_TENANT_CURRENCY?.trim() ?? 'USD',
  };
}

async function run(cfg: Config): Promise<void> {
  if (cfg.password.length < 12) {
    throw new Error('SUPERADMIN_PASSWORD debe tener al menos 12 caracteres');
  }

  const client = new Client({ connectionString: cfg.databaseUrl });
  await client.connect();

  try {
    await client.query('BEGIN');

    const tenantRes = await client.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, default_language)
       VALUES ($1, $2, $3, $4, 'es')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [cfg.tenantSlug, cfg.tenantName, cfg.tenantCountry, cfg.tenantCurrency],
    );
    const tenantId = tenantRes.rows[0]!.id;

    const passwordHash = await bcrypt.hash(cfg.password, 12);

    const userRes = await client.query<{ id: string; existed: boolean }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name
       RETURNING id, (xmax <> 0) AS existed`,
      [cfg.email, passwordHash, cfg.name],
    );
    const userId = userRes.rows[0]!.id;
    const userExisted = userRes.rows[0]!.existed;

    // GUC para que el INSERT en memberships pase la policy WITH CHECK (RLS forzada).
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status)
       VALUES ($1, $2, 'superadmin', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'superadmin', status = 'active'`,
      [tenantId, userId],
    );

    await client.query('COMMIT');

    console.warn(
      JSON.stringify({
        ok: true,
        action: userExisted ? 'updated' : 'created',
        userId,
        tenantId,
        tenantSlug: cfg.tenantSlug,
        email: cfg.email,
      }),
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

run(readConfig()).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
