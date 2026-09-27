import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HarnessUsageError } from './env.mjs';

/**
 * El ACL de producción, compilado. Los RQ los arma la aplicación, no el arnés (docs/tbo/07 §6.1):
 * el arnés sólo le inyecta el `fetch` grabador y un logger que no imprime nada.
 */

export const ACL_BUILD_HINT = 'pnpm --filter @sales-travel/tbo-hotels build';

/** Nombres que el arnés usa del ACL: si falta alguno, el `dist` es de otra versión. */
const REQUIRED_EXPORTS = [
  'TBO_BASE_URLS',
  'TBO_TEST_HOST',
  'TboConfigError',
  'TboError',
  'TboApiError',
  'TboHotelsAdapter',
  'TboHttpClient',
  'TboStaticContentClient',
  'classifyTboBookOutcome',
  'generateTboBookingReference',
  'parseTboConfig',
];

export async function loadAcl(distIndexPath) {
  if (!existsSync(distIndexPath)) {
    throw new HarnessUsageError(
      `No encuentro el ACL compilado en ${distIndexPath}.\nCorre \`${ACL_BUILD_HINT}\` y vuelve a intentar.`,
    );
  }
  const namespace = await import(pathToFileURL(distIndexPath).href);
  // El ACL es CommonJS: `default` es su `module.exports` completo, sin depender de qué nombres
  // detecte el análisis estático de Node al importarlo desde ESM.
  const acl =
    namespace.default && typeof namespace.default === 'object' ? namespace.default : namespace;
  const missing = REQUIRED_EXPORTS.filter((name) => acl[name] === undefined);
  if (missing.length > 0) {
    throw new HarnessUsageError(
      `El ACL compilado no exporta ${missing.join(', ')}: el dist es de otra versión.\n` +
        `Corre \`${ACL_BUILD_HINT}\` y vuelve a intentar.`,
    );
  }
  return acl;
}

/** Versión del paquete y fecha del `dist`: con qué build salieron los RQ de la corrida. */
export function aclBuildInfo(distIndexPath) {
  const info = { distBuiltAt: statSync(distIndexPath).mtime.toISOString() };
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(dirname(distIndexPath), '..', 'package.json'), 'utf8'),
    );
    return { name: pkg.name, version: pkg.version, ...info };
  } catch {
    return info;
  }
}

/**
 * `LoggerPort` que no imprime: guarda los eventos del ACL para escribirlos en `acl-events.jsonl`
 * de la carpeta del paso. El ACL ya filtra su meta por lista blanca (RNF-05); igual se pasa por
 * la redacción de secretos al escribir.
 */
export function createCapturingLogger() {
  const events = [];
  const logger = {
    events,
    child: () => logger,
  };
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (message, meta) => {
      events.push({ level, message, ...(meta === undefined ? {} : { meta }) });
    };
  }
  return logger;
}
