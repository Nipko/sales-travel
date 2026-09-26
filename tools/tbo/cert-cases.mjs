/**
 * Arnés de certificación de TBO Hotels (docs/tbo/07-certificacion.md §6; 09 PR-1.6).
 *
 * Es el análogo de `tools/sabre/cert-probe.mjs`: un `.mjs` sin dependencias que lee credenciales de
 * `.env.tbo` (ignorado por Git) y graba evidencia en `.tbo-cert/<runId>/` (también ignorado). La
 * diferencia de fondo: aquí los requests NO los arma el script, los arma el ACL de producción
 * (`providers/tbo-hotels/dist`), al que sólo se le inyecta un `fetch` que graba los bytes.
 *
 *   node tools/tbo/cert-cases.mjs check
 *   node tools/tbo/cert-cases.mjs probe [--only PR-01,PR-04] [--skip-hotelcodelist]
 *
 * Opciones de los dos: `--allow-non-test-host` (G-12) y `--out <dir>` (por defecto `.tbo-cert`).
 * `run`, `verify`, `zip`, `all` y `probe --bookings` crean reservas o arman el entregable: llegan
 * con PR-7.1.
 *
 * El usuario, la contraseña y el header `Authorization` nunca se imprimen ni se guardan: la
 * cabecera se graba como `Basic «REDACTADO»`, todo lo que sale a disco o a la consola pasa por la
 * redacción de secretos, y al final se barre la corrida entera (G-1).
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACL_BUILD_HINT, aclBuildInfo, loadAcl } from './lib/acl.mjs';
import { runCheck } from './lib/check.mjs';
import { HarnessUsageError, mergeEnv, readDotEnvFile, readSettings } from './lib/env.mjs';
import { createEvidence, findSecretsOnDisk, newRunId } from './lib/evidence.mjs';
import { Harness } from './lib/harness.mjs';
import { BOOKING_PROBES, PROBES, runProbes } from './lib/probes.mjs';
import { HarnessGuardError, createRecorder } from './lib/recorder.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

export const DEFAULT_PATHS = Object.freeze({
  envFile: resolve(ROOT, '.env.tbo'),
  outRoot: resolve(ROOT, '.tbo-cert'),
  aclDist: resolve(ROOT, 'providers', 'tbo-hotels', 'dist', 'index.js'),
});

const LATER = 'llega con PR-7.1 (docs/tbo/09-plan-implementacion.md)';

const USAGE = `Uso: node tools/tbo/cert-cases.mjs <comando> [opciones]

Comandos:
  check    Un Search del caso 1, sin reservar: Status.Code, moneda del perfil, latencia y opciones.
  probe    Sondas de contrato sin reserva (${PROBES.map((p) => p.id).join(', ')}).

Opciones:
  --only PR-01,PR-04       (probe) sólo esas sondas.
  --skip-hotelcodelist     (probe) PR-04 no descarga hotelcodelist (la lista completa de TBO).
  --allow-non-test-host    corre contra una TBO_BASE_URL que no es el endpoint de test (G-12).
  --out <dir>              raíz de la evidencia; por defecto .tbo-cert/.

Credenciales y parámetros: .env.tbo (plantilla en .env.tbo.example). Ver tools/tbo/README.md.`;

export function parseArgs(argv) {
  const flags = {
    allowNonTestHost: false,
    skipHotelCodeList: false,
    bookings: false,
    help: false,
    only: undefined,
    out: undefined,
  };
  let command;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    switch (name) {
      case '--allow-non-test-host':
        flags.allowNonTestHost = true;
        break;
      case '--skip-hotelcodelist':
        flags.skipHotelCodeList = true;
        break;
      case '--bookings':
        flags.bookings = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--only':
      case '--out': {
        const value = inline ?? argv[++index];
        if (value === undefined || value === '' || value.startsWith('--')) {
          throw new HarnessUsageError(`${name} necesita un valor.\n\n${USAGE}`);
        }
        if (name === '--out') flags.out = value;
        else {
          flags.only = value
            .split(',')
            .map((id) => id.trim().toUpperCase())
            .filter((id) => id.length > 0);
        }
        break;
      }
      default:
        if (arg.startsWith('-'))
          throw new HarnessUsageError(`Opción desconocida: ${arg}\n\n${USAGE}`);
        if (command !== undefined)
          throw new HarnessUsageError(`Sobra el argumento ${arg}\n\n${USAGE}`);
        command = arg;
    }
  }
  return { command, flags };
}

function probeIds(flags) {
  const known = PROBES.map((probe) => probe.id);
  if (flags.bookings) {
    throw new HarnessUsageError(`Las sondas con reserva (${BOOKING_PROBES.join(', ')}) ${LATER}.`);
  }
  if (flags.only === undefined) return known;
  const later = flags.only.filter((id) => BOOKING_PROBES.includes(id));
  if (later.length > 0) {
    throw new HarnessUsageError(`${later.join(', ')} crean reservas de test: ${LATER}.`);
  }
  const unknown = flags.only.filter((id) => !known.includes(id));
  if (unknown.length > 0 || flags.only.length === 0) {
    throw new HarnessUsageError(
      `Sonda desconocida: ${unknown.join(', ') || '(vacía)'}. Las de probe son ${known.join(', ')}.`,
    );
  }
  return known.filter((id) => flags.only.includes(id));
}

function validateCommand(command, flags) {
  if (command === 'check') {
    if (flags.only !== undefined || flags.skipHotelCodeList || flags.bookings) {
      throw new HarnessUsageError(
        '--only, --skip-hotelcodelist y --bookings son opciones de probe.',
      );
    }
    return { command };
  }
  if (command === 'probe') return { command, probes: probeIds(flags) };
  if (['run', 'verify', 'zip', 'all'].includes(command)) {
    throw new HarnessUsageError(`\`${command}\` ${LATER}.`);
  }
  throw new HarnessUsageError(`Comando desconocido: ${command}\n\n${USAGE}`);
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function displayPath(path) {
  const rel = relative(ROOT, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] Para los tests: `env`, `envFile`, `fetch`, `now`, `sleep`, `outRoot`,
 *   `aclDist`, `gitSha`, `stdout`, `stderr`. En la CLI, los del proceso.
 * @returns {Promise<number>} 0 bien; 1 el check o el control no pasó, o una guarda del arnés
 *   saltó; 2 error de uso o de configuración.
 */
export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  // Hasta tener las credenciales no hay nada que tapar; después, todo pasa por aquí.
  let scrub = (text) => String(text);

  try {
    const { command, flags } = parseArgs(argv);
    if (flags.help) {
      out(USAGE);
      return 0;
    }
    if (command === undefined) {
      err(USAGE);
      return 2;
    }
    const plan = validateCommand(command, flags);

    const aclDist = deps.aclDist ?? DEFAULT_PATHS.aclDist;
    const acl = await loadAcl(aclDist);
    const env = mergeEnv(
      await readDotEnvFile(deps.envFile ?? DEFAULT_PATHS.envFile),
      deps.env ?? process.env,
    );
    const now = deps.now ?? (() => Date.now());
    const startedAt = now();
    const settings = readSettings(env, flags, acl, startedAt);
    const { secrets } = settings;
    scrub = (text) => secrets.scrubText(String(text)).text;
    const say = (line) => out(scrub(line));

    const outRoot =
      flags.out !== undefined ? resolve(flags.out) : (deps.outRoot ?? DEFAULT_PATHS.outRoot);
    const evidence = await createEvidence(outRoot, newRunId(startedAt));
    const recorder = createRecorder({
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      secrets,
      now,
      allowedHostnames: [new URL(settings.baseUrl).hostname],
    });
    const harness = new Harness({
      acl,
      settings,
      recorder,
      evidence,
      deps: { now, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
    });

    // Sin credenciales: sólo lo que hace falta para reproducir la corrida (07 §6.3).
    const runInfo = {
      runId: evidence.runId,
      command,
      ...(plan.probes === undefined ? {} : { probes: plan.probes }),
      startedAt: new Date(startedAt).toISOString(),
      gitSha: deps.gitSha !== undefined ? deps.gitSha : readGitSha(),
      acl: aclBuildInfo(aclDist),
      node: process.version,
      platform: process.platform,
      baseUrl: settings.baseUrl,
      testEndpoint: settings.testEndpoint,
      allowNonTestHost: flags.allowNonTestHost,
      checkIn: settings.checkIn,
      checkOut: settings.checkOut,
      nights: settings.nights,
      checkInOffsetDays: settings.offsetDays,
      hotelCodes: settings.hotelCodes,
      cityCode: settings.cityCode ?? null,
    };
    await evidence.writeJson('run.json', runInfo);

    let ok = false;
    let failure;
    try {
      ok =
        plan.command === 'check'
          ? await runCheck(harness, say)
          : await runProbes(harness, say, {
              ids: plan.probes,
              skipHotelCodeList: flags.skipHotelCodeList,
            });
    } catch (error) {
      failure = error;
    }
    await evidence.writeJson('run.json', {
      ...runInfo,
      finishedAt: new Date(now()).toISOString(),
      ok: failure === undefined && ok,
      calls: recorder.calls.length,
    });

    // G-1 sobre el disco: la red detrás de la redacción al escribir.
    const leaks = await findSecretsOnDisk(evidence.dir, secrets);
    if (leaks.length > 0) {
      err(
        `G-1: la corrida contiene credenciales en ${leaks.map((l) => `${l.file} (${l.secrets.join(', ')})`).join('; ')}.\n` +
          `Borra ${displayPath(evidence.dir)} y reporta el bug del arnés.`,
      );
      return 1;
    }
    say(`\nEvidencia en ${displayPath(evidence.dir)}`);
    if (failure !== undefined) throw failure;
    return ok ? 0 : 1;
  } catch (error) {
    if (error instanceof HarnessUsageError) {
      err(scrub(error.message));
      return 2;
    }
    if (error instanceof HarnessGuardError) {
      err(scrub(`La corrida se cortó: ${error.message}. Nada con esa forma salió hacia TBO.`));
      return 1;
    }
    // Un bug del arnés o un error del ACL que no es un `TboError`: nombre y mensaje, tapados.
    err(scrub(`Falló el arnés: ${error?.name ?? 'Error'}: ${error?.message ?? error}`));
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
      err(`¿El ACL está compilado? Corre \`${ACL_BUILD_HINT}\`.`);
    }
    return 1;
  }
}

function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = resolve(process.argv[1]);
  return process.platform === 'win32'
    ? self.toLowerCase() === invoked.toLowerCase()
    : self === invoked;
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
