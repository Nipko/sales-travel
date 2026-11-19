import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { QuotationsService } from './quotations.service.js';

/**
 * V5 (auditoría de flujos de venta): `quote_number` era MAX + 1 sin candado ni índice único, y dos
 * cotizaciones creadas a la vez en la misma agencia salían con el mismo número. El servicio corre
 * como `app_user` (el rol de producción, con RLS), igual que en la API.
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD); corre en el harness de CI.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

d('quote_number: único por agencia aunque se cotice a la vez', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar, mirar y desmontar. */
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
        max: 12,
      }),
    }),
  });
  const quotations = new QuotationsService(database);

  const tenants: string[] = [];
  let userId: string;

  async function tenant(slug: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2) RETURNING id`,
      [`qn-${slug}-${sfx}`, await platformRootId(admin)],
    );
    const id = rows[0]!.id;
    tenants.push(id);
    return id;
  }

  function create(tenantId: string) {
    return quotations.create(tenantId, userId, {
      searchCriteria: {},
      selectedOffer: {},
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  }

  beforeAll(async () => {
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`qn-${sfx}@test.local`],
    );
    userId = u.rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of tenants) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    await admin.end();
    await database.db.destroy();
  });

  it('diez cotizaciones simultáneas salen con 1..10, sin repetir', async () => {
    const t = await tenant('carrera');
    const rows = await Promise.all(Array.from({ length: 10 }, () => create(t)));
    const numbers = rows.map((r) => r.quote_number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('cada agencia cuenta desde 1: el candado y el índice son por agencia', async () => {
    const a = await tenant('a');
    const b = await tenant('b');
    const [ra, rb] = await Promise.all([create(a), create(b)]);
    expect(ra.quote_number).toBe(1);
    expect(rb.quote_number).toBe(1);
  });

  it('la base rechaza un número repetido en la misma agencia (23505)', async () => {
    const t = await tenant('indice');
    await create(t);
    await expect(
      admin.query(
        `INSERT INTO quotations (tenant_id, user_id, search_criteria, selected_offer, quote_number, expires_at)
         VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 1, now() + interval '1 day')`,
        [t, userId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_quotations_tenant_quote_number' });
  });

  it('un repetido anterior a 0097, marcado, se conserva y no frena al siguiente número', async () => {
    const t = await tenant('legado');
    await create(t);
    await admin.query(
      `INSERT INTO quotations (tenant_id, user_id, search_criteria, selected_offer, quote_number, expires_at, quote_number_duplicate)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 1, now() + interval '1 day', true)`,
      [t, userId],
    );
    const next = await create(t);
    expect(next.quote_number).toBe(2);
  });
});
