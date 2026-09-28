import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { runCli, type DbSession } from './cli.js';

const KEY = Buffer.alloc(32, 9).toString('base64');
const TBO_PASSWORD = 'tbo-secret-value';
const VENDEDOR_PASSWORD = 'vendedor-secret-value';

const ENV = {
  PGHOST: 'postgres',
  PGUSER: 'postgres',
  PGPASSWORD: 'pg-secret-value',
  PGDATABASE: 'sales_travel_cert',
  PROVIDER_CREDENTIALS_KEY: KEY,
  CERT_TBO_USERNAME: 'tbo-user-value',
  CERT_TBO_PASSWORD: TBO_PASSWORD,
  CERT_VENDEDOR_PASSWORD: VENDEDOR_PASSWORD,
};

/** Una sesión que contesta la primera consulta del seed (qué base es) y registra el resto. */
function fakeSession(database: string): DbSession & { readonly sql: string[]; ended: boolean } {
  const session = {
    sql: [] as string[],
    ended: false,
    query<R extends QueryResultRow>(text: string): Promise<QueryResult<R>> {
      session.sql.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
      const rows = text.includes('current_database()') ? [{ database, privileged: true }] : [];
      return Promise.resolve({ rows, rowCount: rows.length } as unknown as QueryResult<R>);
    },
    end(): Promise<void> {
      session.ended = true;
      return Promise.resolve();
    },
  };
  return session;
}

async function run(
  env: Record<string, string | undefined>,
  session?: ReturnType<typeof fakeSession>,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli({
    env,
    out: (line) => lines.push(line),
    ...(session === undefined ? {} : { connect: () => Promise.resolve(session) }),
  });
  return { code, lines };
}

describe('runCli', () => {
  it('con la configuración inválida sale 1, nombra las variables y no repite valores', async () => {
    const { code, lines } = await run({
      ...ENV,
      CERT_VENDEDOR_PASSWORD: 'corta',
      CERT_TBO_USERNAME: 'a:b',
    });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0] ?? '{}') as { ok: boolean; error: string; issues: string[] };
    expect(out).toMatchObject({ ok: false, error: 'SeedConfigError' });
    expect(out.issues).toContain('CERT_VENDEDOR_PASSWORD:too_small');
    for (const value of ['corta', TBO_PASSWORD, 'pg-secret-value'])
      expect(lines[0]).not.toContain(value);
  });

  it('contra una base que no es la del stack no escribe nada, sale 1 y cierra la sesión', async () => {
    const session = fakeSession('sales_travel');
    const { code, lines } = await run(ENV, session);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      ok: false,
      error: 'SeedRefusedError',
      reason: 'wrong_database',
    });
    expect(session.sql).toEqual(['BEGIN', 'SELECT current_database()', 'ROLLBACK']);
    expect(session.ended).toBe(true);
    for (const value of [TBO_PASSWORD, VENDEDOR_PASSWORD, KEY])
      expect(lines[0]).not.toContain(value);
  });
});
