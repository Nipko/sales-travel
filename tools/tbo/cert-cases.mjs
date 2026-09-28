/**
 * Arnés de certificación de TBO Hotels (docs/tbo/07-certificacion.md §6; 09 PR-1.6 y PR-7.1).
 *
 * Es el análogo de `tools/sabre/cert-probe.mjs`: un `.mjs` sin dependencias que lee credenciales de
 * `.env.tbo` (ignorado por Git) y graba evidencia en `.tbo-cert/<runId>/` (también ignorado). La
 * diferencia de fondo: aquí los requests NO los arma el script, los arma el ACL de producción
 * (`providers/tbo-hotels/dist`), al que sólo se le inyecta un `fetch` que graba los bytes.
 *
 *   node tools/tbo/cert-cases.mjs check
 *   node tools/tbo/cert-cases.mjs probe [--only PR-01,PR-04] [--skip-hotelcodelist] [--bookings]
 *   node tools/tbo/cert-cases.mjs run [--cases 1,2,4] [--resume <runId>]
 *   node tools/tbo/cert-cases.mjs verify <runId>
 *   node tools/tbo/cert-cases.mjs zip <runId>
 *   node tools/tbo/cert-cases.mjs all
 *
 * `run`, `all` y `probe --bookings` RESERVAN en el entorno de test de TBO. `verify` y `zip` no
 * tocan la red: pasan las guardas G-1 a G-13 sobre una corrida ya hecha.
 *
 * El usuario, la contraseña y el header `Authorization` nunca se imprimen ni se guardan: la
 * cabecera se graba como `Basic «REDACTADO»`, todo lo que sale a disco o a la consola pasa por la
 * redacción de secretos, al final se barre la corrida entera y el zip no se arma si G-1 falla.
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACL_BUILD_HINT, aclBuildInfo, loadAcl } from './lib/acl.mjs';
import { CASE_IDS, expandCaseSelection } from './lib/cases.mjs';
import { HarnessFatalError } from './lib/chain.mjs';
import { runCheck } from './lib/check.mjs';
import { verifyRun, zipRun } from './lib/deliverable.mjs';
import {
  HarnessUsageError,
  mergeEnv,
  readDotEnvFile,
  readSecrets,
  readSettings,
  readZipSettings,
  throwIssues,
} from './lib/env.mjs';
import {
  createEvidence,
  findSecretsOnDisk,
  isRunId,
  newRunId,
  openEvidence,
} from './lib/evidence.mjs';
import { Harness } from './lib/harness.mjs';
import { BOOKING_PROBES, PROBES, runProbes } from './lib/probes.mjs';
import { HarnessGuardError, createRecorder } from './lib/recorder.mjs';
import { cancelActive, runCases } from './lib/run-cases.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

export const DEFAULT_PATHS = Object.freeze({
  envFile: resolve(ROOT, '.env.tbo'),
  outRoot: resolve(ROOT, '.tbo-cert'),
  aclDist: resolve(ROOT, 'providers', 'tbo-hotels', 'dist', 'index.js'),
});

const BOOKING_IDS = BOOKING_PROBES.map((p) => p.id);

const USAGE = `Uso: node tools/tbo/cert-cases.mjs <comando> [opciones]

Comandos:
  check              Un Search del caso 1, sin reservar: Status.Code, moneda del perfil, latencia y opciones.
  probe              Sondas de contrato sin reserva (${PROBES.map((p) => p.id).join(', ')}).
  run                Los 8 casos de certificación: Search > PreBook > Book > BookingDetail > Cancel. RESERVA en test.
  verify <runId>     Guardas G-1 a G-13 sobre una corrida y selfcheck.md. Sin red.
  zip <runId>        Las guardas, README.txt, manifest.json y el zip para TBO. Sin red.
  all                check, run, verify y zip en una sola corrida. RESERVA en test.
  cancel <runId>     Cancela lo que la corrida dejó activo (TBO_CANCEL_AFTER=false o un Cancel sin confirmar).

Opciones:
  --only PR-01,PR-04       (probe) sólo esas sondas.
  --skip-hotelcodelist     (probe) PR-04 no descarga hotelcodelist (la lista completa de TBO).
  --bookings               (probe) suma ${BOOKING_IDS.join(', ')}, que reservan en test y cancelan.
  --cases 1,2,4            (run) sólo esos casos; el 4 y el 8 van siempre juntos.
  --resume <runId>         (run) corre en esa corrida y reemplaza los casos que vuelva a correr.
  --allow-non-test-host    corre contra una TBO_BASE_URL que no es el endpoint de test (G-12).
  --out <dir>              raíz de la evidencia; por defecto .tbo-cert/.

Credenciales y parámetros: .env.tbo (plantilla en .env.tbo.example). Ver tools/tbo/README.md.`;

const VALUE_FLAGS = new Set(['--only', '--out', '--cases', '--resume']);

export function parseArgs(argv) {
  const flags = {
    allowNonTestHost: false,
    skipHotelCodeList: false,
    bookings: false,
    help: false,
    only: undefined,
    out: undefined,
    cases: undefined,
    resume: undefined,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new HarnessUsageError(`${name} necesita un valor.\n\n${USAGE}`);
      }
      if (name === '--out') flags.out = value;
      else if (name === '--resume') flags.resume = value;
      else {
        const list = value
          .split(',')
          .map((id) => id.trim().toUpperCase())
          .filter((id) => id.length > 0);
        if (name === '--only') flags.only = list;
        else flags.cases = list;
      }
      continue;
    }
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
      default:
        if (arg.startsWith('-')) {
          throw new HarnessUsageError(`Opción desconocida: ${arg}\n\n${USAGE}`);
        }
        positionals.push(arg);
    }
  }
  const [command, ...rest] = positionals;
  return { command, rest, flags };
}

function probeIds(flags) {
  const known = PROBES.map((probe) => probe.id);
  const withBookings = flags.bookings ? [...known, ...BOOKING_IDS] : known;
  if (flags.only === undefined) return withBookings;
  const booking = flags.only.filter((id) => BOOKING_IDS.includes(id));
  if (booking.length > 0 && !flags.bookings) {
    throw new HarnessUsageError(
      `${booking.join(', ')} reservan en el entorno de test: agrega --bookings para correrlas.`,
    );
  }
  const unknown = flags.only.filter((id) => !withBookings.includes(id));
  if (unknown.length > 0 || flags.only.length === 0) {
    throw new HarnessUsageError(
      `Sonda desconocida: ${unknown.join(', ') || '(vacía)'}. Las de probe son ${withBookings.join(', ')}.`,
    );
  }
  return withBookings.filter((id) => flags.only.includes(id));
}

function caseIds(flags) {
  if (flags.cases === undefined) return [...CASE_IDS];
  const ids = flags.cases.map(Number);
  const bad = flags.cases.filter((_, i) => !CASE_IDS.includes(ids[i]));
  if (bad.length > 0 || ids.length === 0) {
    throw new HarnessUsageError(
      `Caso desconocido: ${bad.join(', ') || '(vacío)'}. Los casos son 1 a 8.`,
    );
  }
  return expandCaseSelection(ids);
}

/** Qué opciones admite cada comando: una que no aplica es un error, no algo que se ignora. */
const ALLOWED = {
  check: [],
  probe: ['only', 'skipHotelCodeList', 'bookings'],
  run: ['cases', 'resume'],
  verify: [],
  zip: [],
  all: [],
  cancel: [],
};

const FLAG_NAMES = {
  only: '--only',
  skipHotelCodeList: '--skip-hotelcodelist',
  bookings: '--bookings',
  cases: '--cases',
  resume: '--resume',
};

function validateCommand(command, rest, flags) {
  if (!(command in ALLOWED)) {
    throw new HarnessUsageError(`Comando desconocido: ${command}\n\n${USAGE}`);
  }
  const misplaced = Object.keys(FLAG_NAMES).filter(
    (key) => !ALLOWED[command].includes(key) && flags[key] !== undefined && flags[key] !== false,
  );
  if (misplaced.length > 0) {
    throw new HarnessUsageError(
      `${misplaced.map((key) => FLAG_NAMES[key]).join(', ')} no aplica a ${command}.\n\n${USAGE}`,
    );
  }
  const takesRunId = command === 'verify' || command === 'zip' || command === 'cancel';
  if (rest.length > (takesRunId ? 1 : 0)) {
    throw new HarnessUsageError(`Sobra el argumento ${rest.at(-1)}\n\n${USAGE}`);
  }
  if (takesRunId) {
    const [runId] = rest;
    if (runId === undefined) {
      throw new HarnessUsageError(
        `\`${command}\` necesita el id de la corrida (la carpeta de .tbo-cert/).`,
      );
    }
    if (!isRunId(runId)) throw new HarnessUsageError(`Id de corrida inválido: ${runId}`);
    // `cancel` vuelve a hablar con TBO sobre una corrida existente, como `run --resume`.
    return command === 'cancel' ? { command, resume: runId } : { command, runId };
  }
  if (flags.resume !== undefined && !isRunId(flags.resume)) {
    throw new HarnessUsageError(`Id de corrida inválido: ${flags.resume}`);
  }
  if (command === 'probe') return { command, probes: probeIds(flags) };
  if (command === 'run') return { command, cases: caseIds(flags), resume: flags.resume };
  if (command === 'all') return { command, cases: [...CASE_IDS] };
  return { command };
}

function git(args) {
  try {
    return execFileSync('git', args, {
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

async function offline(plan, { acl, env, secrets, flags, now, outRoot, say }) {
  const issues = [];
  const zip = plan.command === 'zip' ? readZipSettings(env, issues) : undefined;
  throwIssues(issues);
  const evidence = openEvidence(outRoot, plan.runId);
  if (evidence === undefined) {
    throw new HarnessUsageError(`No existe la corrida ${plan.runId} en ${displayPath(outRoot)}.`);
  }
  const ctx = { secrets, acl, allowNonTestHost: flags.allowNonTestHost };
  return plan.command === 'verify'
    ? verifyRun(evidence, ctx, { now, say })
    : (await zipRun(evidence, ctx, { now, say, companySlug: zip.companySlug })).ok;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] Para los tests: `env`, `envFile`, `fetch`, `now`, `sleep`, `outRoot`,
 *   `aclDist`, `gitSha`, `gitDirty`, `stdout`, `stderr`. En la CLI, los del proceso.
 * @returns {Promise<number>} 0 bien; 1 el comando no llegó a su resultado (check o control que no
 *   pasa, caso sin cadena, guarda que aborta); 2 error de uso o de configuración.
 */
export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  // Hasta tener las credenciales no hay nada que tapar; después, todo pasa por aquí.
  let scrub = (text) => String(text);

  try {
    const { command, rest, flags } = parseArgs(argv);
    if (flags.help) {
      out(USAGE);
      return 0;
    }
    if (command === undefined) {
      err(USAGE);
      return 2;
    }
    const plan = validateCommand(command, rest, flags);

    const aclDist = deps.aclDist ?? DEFAULT_PATHS.aclDist;
    const acl = await loadAcl(aclDist);
    const env = mergeEnv(
      await readDotEnvFile(deps.envFile ?? DEFAULT_PATHS.envFile),
      deps.env ?? process.env,
    );
    const now = deps.now ?? (() => Date.now());
    const outRoot =
      flags.out !== undefined ? resolve(flags.out) : (deps.outRoot ?? DEFAULT_PATHS.outRoot);

    if (plan.command === 'verify' || plan.command === 'zip') {
      const secrets = readSecrets(env);
      scrub = (text) => secrets.scrubText(String(text)).text;
      const say = (line) => out(scrub(line));
      const ok = await offline(plan, { acl, env, secrets, flags, now, outRoot, say });
      return ok ? 0 : 1;
    }

    const startedAt = now();
    const books = plan.command === 'run' || plan.command === 'all' || flags.bookings;
    const settings = readSettings(env, flags, acl, startedAt, {
      booking: books,
      zip: plan.command === 'all',
    });
    const { secrets } = settings;
    scrub = (text) => secrets.scrubText(String(text)).text;
    const say = (line) => out(scrub(line));

    let evidence;
    if (plan.resume !== undefined) {
      evidence = openEvidence(outRoot, plan.resume);
      if (evidence === undefined) {
        throw new HarnessUsageError(
          `No existe la corrida ${plan.resume} en ${displayPath(outRoot)}.`,
        );
      }
      const previous = await evidence.readJson('run.json');
      if (previous?.baseUrl !== settings.baseUrl) {
        throw new HarnessUsageError(
          `La corrida ${plan.resume} es contra ${previous?.baseUrl ?? '(sin run.json)'}; ` +
            `TBO_BASE_URL apunta a ${settings.baseUrl}. Un zip no puede mezclar endpoints.`,
        );
      }
    } else {
      evidence = await createEvidence(outRoot, newRunId(startedAt));
    }
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

    const gitSha = deps.gitSha !== undefined ? deps.gitSha : git(['rev-parse', 'HEAD']);
    const gitDirty =
      deps.gitDirty !== undefined
        ? deps.gitDirty
        : (git(['status', '--porcelain', '--untracked-files=no']) ?? '') !== '';
    const aclInfo = aclBuildInfo(aclDist);
    // Sin credenciales: sólo lo que hace falta para reproducir la corrida (07 §6.3).
    const runInfo = {
      runId: evidence.runId,
      command,
      ...(plan.probes === undefined ? {} : { probes: plan.probes }),
      ...(plan.cases === undefined ? {} : { cases: plan.cases }),
      startedAt: new Date(startedAt).toISOString(),
      gitSha,
      gitDirty,
      acl: aclInfo,
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
      hotelCodesSource: settings.hotelCodesSource,
      cityCode: settings.cityCode ?? null,
      ...(settings.booking === undefined ? {} : { cancelAfter: settings.booking.cancelAfter }),
    };
    // Una corrida retomada conserva su `run.json`: cada invocación queda en `invocations.jsonl`.
    const writeRunInfo = (info) =>
      plan.resume === undefined
        ? evidence.writeJson('run.json', info)
        : evidence.folder('.').appendJsonl('invocations.jsonl', info);
    if (plan.resume === undefined) await writeRunInfo(runInfo);

    const build = { gitSha, gitDirty, acl: { name: aclInfo.name, version: aclInfo.version } };
    const cases = { cases: plan.cases, build, stamp: newRunId(startedAt) };
    const offlineCtx = { secrets, acl, allowNonTestHost: flags.allowNonTestHost };

    let ok = false;
    let failure;
    try {
      if (plan.command === 'check') ok = await runCheck(harness, say);
      else if (plan.command === 'probe') {
        ok = await runProbes(harness, say, {
          ids: plan.probes,
          skipHotelCodeList: flags.skipHotelCodeList,
        });
      } else if (plan.command === 'run') {
        ok = await runCases(harness, say, cases);
      } else if (plan.command === 'cancel') {
        ok = await cancelActive(harness, say);
      } else {
        ok = await runCheck(harness, say);
        if (!ok) say('\nEl check no pasó: no se reserva nada.');
        else {
          const complete = await runCases(harness, say, cases);
          say('');
          const verified = await verifyRun(evidence, offlineCtx, { now, say });
          const zipped =
            complete && verified
              ? (
                  await zipRun(evidence, offlineCtx, {
                    now,
                    say,
                    companySlug: settings.zip.companySlug,
                  })
                ).ok
              : false;
          ok = complete && verified && zipped;
        }
      }
    } catch (error) {
      failure = error;
    }
    await writeRunInfo({
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
    if (error instanceof HarnessFatalError) {
      err(scrub(`La corrida se cortó: ${error.message}`));
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
