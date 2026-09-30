import {
  TboInMemoryRateLimiter,
  TboStaticContentClient,
  type TboFetch,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import pg from 'pg';
import type { CatalogStore } from './catalog-store.js';
import { readLogLevel, resolveSyncEnv, type SyncClientSettings, type SyncEnv } from './env.js';
import { SyncConfigError, SyncError } from './errors.js';
import { JsonLogger, stderrSink, type LogSink } from './log.js';
import { runSync } from './sync.js';
import { PgCatalogVault, resolveCatalogCredentials, type CatalogVault } from './vault.js';
import { PgCatalogStore, type Queryable } from './writer.js';

/**
 * El proceso del contenedor, sin `process` global: todo lo que toca el mundo llega por `CliIo`
 * para que los tests prueben las salidas (skip, ok, ok parcial, error) con el mismo código que corre
 * en el VPS.
 *
 * Códigos de salida, como el sync de Despegar: 0 cuando no hay nada que hacer (sin credenciales ni
 * en el entorno ni en la bóveda, kill-switch, otra corrida con el lock) y cuando la corrida termina,
 * completa o "ok parcial" (presupuesto, `429`, SIGTERM); 1 cuando la configuración o la cuenta no
 * sirven (también la de la bóveda), la base falla o la corrida se cortó por una racha de errores,
 * para que el workflow quede en rojo.
 *
 * La credencial nunca se escribe: el log dice sólo de dónde salió (`credentialSource`: `env` o
 * `vault:<slug>/<etiqueta>`), el entorno y la huella de la cuenta.
 */

export interface DbSession extends Queryable {
  end(): Promise<void>;
}

export interface CliIo {
  readonly env: SyncEnv;
  readonly sink?: LogSink;
  readonly fetch?: TboFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly limiter?: TboRateLimiter;
  readonly now?: () => number;
  readonly connect?: (env: SyncEnv) => Promise<DbSession>;
  /** Sólo tests: un almacén ya armado en lugar de Postgres. */
  readonly store?: CatalogStore;
  /** Sólo tests: una bóveda ya armada en lugar de la de Postgres. */
  readonly vault?: CatalogVault;
  readonly interrupt?: AbortSignal;
}

/** Las `PG*` que el workflow pasa con `-e`, como al sync de Despegar (usuario `postgres`). */
export const DB_ENV_VARIABLES: readonly string[] = Object.freeze([
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
]);

export async function connectFromEnv(env: SyncEnv): Promise<DbSession> {
  const missing = ['PGHOST', 'PGUSER', 'PGPASSWORD'].filter((name) => !env[name]);
  if (missing.length > 0) throw new SyncConfigError(missing.map((name) => `${name}:required`));
  const port = Number(env['PGPORT'] ?? 5432);
  if (!Number.isInteger(port) || port <= 0) throw new SyncConfigError(['PGPORT:invalid']);
  const client = new pg.Client({
    host: env['PGHOST'],
    port,
    user: env['PGUSER'],
    password: env['PGPASSWORD'],
    ...(env['PGDATABASE'] === undefined ? {} : { database: env['PGDATABASE'] }),
    application_name: 'sync-tbo-hotel-inventory',
  });
  await client.connect();
  return client;
}

function buildLimiter(client: SyncClientSettings): TboRateLimiter {
  // Una sola conexión y `requestsPerSecond` en el cupo de fondo (05 §10). El limitador es de este
  // proceso: con la cuenta `default` de la bóveda, que es la de la venta, el cupo de TBO se comparte
  // con las búsquedas del api, y por eso el sync corre de madrugada y a 1 req/s (D-TBO-04, D-TBO-12).
  return new TboInMemoryRateLimiter({
    background: { qps: client.requestsPerSecond, concurrent: 1 },
  });
}

function errorMeta(err: unknown): Record<string, unknown> {
  if (err instanceof SyncError) return { error: err.message, ...err.toLogMeta() };
  // Los errores del ACL ya traen sólo vocabulario propio; los de `pg` traen el mensaje del
  // servidor, que no incluye valores de parámetros.
  if (err instanceof Error) return { error: err.message, errorClass: err.name };
  return { error: 'unknown', errorClass: typeof err };
}

export async function runCli(io: CliIo): Promise<number> {
  const logger = new JsonLogger({
    level: readLogLevel(io.env),
    sink: io.sink ?? stderrSink,
    bindings: { job: 'sync-tbo-hotel-inventory' },
  });

  let session: DbSession | undefined;
  // Una sola conexión para la bóveda y el catálogo, abierta la primera vez que hace falta: con el
  // override y un almacén de test no se abre ninguna.
  const openSession = async (): Promise<DbSession> => {
    session ??= await (io.connect ?? connectFromEnv)(io.env);
    return session;
  };
  try {
    const resolution = resolveSyncEnv(io.env);
    if (resolution.kind === 'skip') {
      logger.warn('tbo.sync.result', { ok: true, action: 'skip', reason: resolution.reason });
      return 0;
    }
    const { settings, client, override } = resolution;
    if (override.kind === 'absent' && override.ignored.length > 0) {
      // Un override a medias no se completa con la bóveda: se ignora entero y se dice qué quedó sin
      // usar, para que nadie crea que la corrida salió con la cuenta del entorno.
      logger.warn('tbo.sync.override_ignored', {
        variables: override.ignored,
        missing: override.missing,
      });
    }

    const account = await resolveCatalogCredentials({
      override,
      env: io.env,
      providerCode: settings.providerCode,
      vault: async () => io.vault ?? new PgCatalogVault(await openSession()),
    });
    if (account.kind === 'none') {
      logger.warn('tbo.sync.result', { ok: true, action: 'skip', reason: account.reason });
      return 0;
    }

    const source = new TboStaticContentClient(
      account.tbo,
      {
        ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
        ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
        logger: logger.child({ component: 'tbo-http' }),
        limiter: io.limiter ?? buildLimiter(client),
      },
      account.context,
      {
        detailedCityHotels: client.detailedCityHotels,
        ...(client.codelistTimeoutMs === undefined
          ? {}
          : { timeoutsMs: { hotelCodeList: client.codelistTimeoutMs } }),
      },
    );
    logger.info('tbo.sync.credentials', {
      credentialSource: account.source,
      environment: account.tbo.environment,
      accountRef: source.accountRef,
    });

    let store = io.store;
    if (store === undefined) {
      store = new PgCatalogStore(await openSession(), {
        providerCode: settings.providerCode,
        destinationSourceProvider: settings.destinationSourceProvider,
      });
    }
    const report = await runSync(settings, {
      source,
      store,
      logger,
      ...(io.now === undefined ? {} : { now: io.now }),
      ...(io.interrupt === undefined ? {} : { interrupt: io.interrupt }),
    });

    if (report.action === 'skip') {
      logger.warn('tbo.sync.result', { ok: true, action: 'skip', reason: report.reason });
      return 0;
    }
    // Presupuesto, `429` o SIGTERM son cortes previstos: lo escrito queda y la próxima corrida
    // sigue. Una racha de errores no: TBO está caído o algo nuestro se rompió, y el workflow tiene
    // que ponerse en rojo aunque las ciudades anteriores hayan quedado bien escritas.
    const ok = report.stopReason !== 'errors';
    const { e1, e2, e2a, e3, e4, e5, e6, ...totals } = report;
    const summary = {
      ok,
      credentialSource: account.source,
      ...totals,
      countries: e1.countries,
      cities: e3.cities,
      citiesEmpty: e3.citiesEmpty,
      citiesFailed: e3.citiesFailed,
      hotelsUpserted: e3.hotelsUpserted,
      hotelsDeactivated: e3.hotelsDeactivated + (e5.status === 'done' ? e5.deactivated : 0),
      sweepAnomalies: e3.sweepAnomalies,
      citiesUpserted: e2.citiesUpserted,
      worldCitiesUpserted: e2a.citiesUpserted,
      worldCountriesPending: e2a.countriesPending,
      listingContentsWritten: e3.listingContentsWritten,
      contentsWritten: e4.contentsWritten,
      contentsUnchanged: e4.contentsUnchanged,
      contentTasksDue: e4.tasksDue,
      contentHotelsFailed: e4.hotelsFailed,
      hotelMatchesAccepted: e6.hotelMatch.acceptedPairs,
      hotelMatchesReview: e6.hotelMatch.reviewHotels,
      destinationsAccepted: e6.destinationMap.acceptedOverlap + e6.destinationMap.acceptedCentroid,
      destinationsAmbiguous: e6.destinationMap.ambiguous,
      e2a: e2a.status,
      e4: e4.status,
      e5: e5.status,
      e6: e6.destinationMap.status === 'held' ? 'held' : e6.hotelMatch.status,
    };
    if (ok) logger.info('tbo.sync.result', summary);
    else logger.error('tbo.sync.result', summary);
    return ok ? 0 : 1;
  } catch (err) {
    logger.error('tbo.sync.result', { ok: false, ...errorMeta(err) });
    return 1;
  } finally {
    await session?.end().catch(() => undefined);
  }
}
