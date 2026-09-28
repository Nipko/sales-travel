import bcrypt from 'bcrypt';
import pg from 'pg';
import { resolveSeedEnv, type SeedEnv, type SeedSettings } from './env.js';
import { SeedConfigError, SeedRefusedError } from './errors.js';
import { runSeed, type PasswordHasher, type Queryable, type SeedReport } from './seed.js';

/** Mismas rondas que `PasswordService` del api: el login compara con ese costo. */
const BCRYPT_ROUNDS = 12;

export const bcryptHasher: PasswordHasher = {
  hash: (password) => bcrypt.hash(password, BCRYPT_ROUNDS),
  verify: (password, hash) => bcrypt.compare(password, hash),
};

export interface DbSession extends Queryable {
  end(): Promise<void>;
}

/**
 * Todo lo que toca el mundo llega por aquí, para que los tests prueben las salidas con el mismo
 * código que corre en el contenedor.
 */
export interface CliIo {
  readonly env: SeedEnv;
  readonly out?: (line: string) => void;
  readonly connect?: (settings: SeedSettings, env: SeedEnv) => Promise<DbSession>;
  readonly hasher?: PasswordHasher;
}

async function connectFromEnv(settings: SeedSettings, env: SeedEnv): Promise<DbSession> {
  const port = Number(env['PGPORT'] || 5432);
  if (!Number.isInteger(port) || port <= 0) throw new SeedConfigError(['PGPORT:invalid']);
  // Las tres obligatorias ya las validó `resolveSeedEnv`. Sin PGDATABASE, `pg` iría a la base con
  // el nombre del usuario y el seed se negaría; la del stack es la única que puede sembrar.
  const client = new pg.Client({
    host: env['PGHOST'],
    port,
    user: env['PGUSER'],
    password: env['PGPASSWORD'],
    database: env['PGDATABASE'] || settings.database.expectedName,
    application_name: 'seed-tbo-cert-tenant',
  });
  await client.connect();
  return client;
}

function failure(err: unknown): Record<string, unknown> {
  if (err instanceof SeedConfigError) return { error: err.name, issues: err.issues };
  if (err instanceof SeedRefusedError) {
    return { error: err.name, reason: err.reason, message: err.message };
  }
  // Los errores de `pg` traen el mensaje del servidor, que no repite valores de parámetros.
  if (err instanceof Error) return { error: err.name, message: err.message };
  return { error: typeof err };
}

/**
 * Una línea JSON con el resultado y el código de salida: 0 sembrado (o ya estaba), 1 cualquier
 * otra cosa, para que el job de despliegue quede en rojo.
 */
export async function runCli(io: CliIo): Promise<number> {
  const out = io.out ?? ((line: string) => process.stderr.write(`${line}\n`));
  let session: DbSession | undefined;
  try {
    const settings = resolveSeedEnv(io.env);
    session = await (io.connect ?? connectFromEnv)(settings, io.env);
    const report: SeedReport = await runSeed(session, settings, io.hasher ?? bcryptHasher);
    out(JSON.stringify({ ok: true, ...report }));
    return 0;
  } catch (err) {
    out(JSON.stringify({ ok: false, ...failure(err) }));
    return 1;
  } finally {
    await session?.end().catch(() => undefined);
  }
}
