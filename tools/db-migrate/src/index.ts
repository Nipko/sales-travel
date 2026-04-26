import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = process.env['MIGRATIONS_DIR'] ?? '/migrations';
const DATABASE_URL = process.env['DATABASE_URL_ADMIN'];
const APP_USER_PASSWORD = process.env['APP_USER_PASSWORD'];

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL_ADMIN is required');
  process.exit(1);
}

if (!APP_USER_PASSWORD) {
  console.error('FATAL: APP_USER_PASSWORD is required');
  process.exit(1);
}

async function ensureAppRole(client: pg.Client, password: string): Promise<void> {
  const passwordLiteral = client.escapeLiteral(password);
  await client.query(`
    DO $$
    DECLARE
      pwd TEXT := ${passwordLiteral};
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        EXECUTE format('CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', pwd);
      ELSE
        EXECUTE format('ALTER ROLE app_user WITH PASSWORD %L', pwd);
      END IF;
    END $$;
  `);
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listApplied(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations',
  );
  return new Set(rows.map((r) => r.version));
}

async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function applyMigration(client: pg.Client, file: string): Promise<void> {
  const version = file.replace(/\.sql$/, '');
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

  console.warn(`▶ applying ${version}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    await client.query('COMMIT');
    console.warn(`✓ ${version}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`✗ ${version} — rolled back`);
    throw err;
  }
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureAppRole(client, APP_USER_PASSWORD!);
    await ensureMigrationsTable(client);

    const applied = await listApplied(client);
    const files = await listMigrationFiles();

    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.warn(`= ${version} (skipped, already applied)`);
        continue;
      }
      await applyMigration(client, file);
      appliedCount += 1;
    }

    console.warn(`\nDone. Applied ${appliedCount} new migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
