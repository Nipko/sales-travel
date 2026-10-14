import 'reflect-metadata';
import { join } from 'node:path';
import type { INestApplicationContext, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { deriveSabreSecret, redactText, sabreDomain, type SabreConfig } from '@sales-travel/sabre';
import { ProviderCredentialsService } from '../../provider-credentials/provider-credentials.service.js';
import {
  SABRE_PROVIDER_CODE,
  SabreFlightProviderAdapter,
  SabreProviderFactory,
  sabreTicketingSettingsFromAccountConfig,
} from '../sabre.factory.js';
import { buildCertAcl } from './cert-acl.js';
import { SabreCertGuardError, assertCertTarget } from './cert-guard.js';
import { CertRunModule } from './cert-run.module.js';
import {
  CertEvidenceRecorder,
  CertEvidenceWriter,
  SecretScrubber,
  createCertTransport,
  stepFileName,
  type CertStepRecord,
} from './captures.js';
import {
  CERT_RUN_USAGE,
  CertRunArgsError,
  parseCertRunArgs,
  type CertRunArgs,
} from './cli-args.js';
import { CertPlanError, buildCertPlan, describeCertPlan, type CertPlan } from './plan.js';
import { describeCertError, runCertPlan, type CertRunReport } from './scenarios.js';
import {
  CERT_EXIT,
  buildCertSummary,
  renderCertSummaryMarkdown,
  type CertExitCode,
  type CertRunAccountView,
} from './summary.js';

/**
 * Arnés de certificación contra Sabre CERT (SAB-11). Corre DENTRO del contenedor de la API, con la
 * cuenta CERT de la bóveda (`provider_accounts`, descifrada con `PROVIDER_CREDENTIALS_KEY`), sin
 * sacar la credencial de ahí y sin crear órdenes:
 *
 *   docker compose --env-file .env exec -T api \
 *     node dist/providers-sabre/cert-run/sabre-cert-run.js --owner-tenant <uuid> --scenarios sab-12
 *
 * Se niega a correr si la cuenta no es CERT por el host resuelto (no sólo por lo que declara), y
 * además el `fetch` de este proceso bloquea cualquier URL que no sea de CERT. Ver
 * `docs/sabre/evidence/README.md` para el paso a paso y `docs/sabre/12-hallazgos-sandbox.md` para
 * volcar lo encontrado.
 */

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * El logger de Nest del proceso: lo del ACL va a la evidencia del paso abierto; avisos y errores,
 * además, al stderr del operador. Todo pasa por el scrubber: un secreto conocido no se imprime.
 */
class CertRunLogger implements LoggerService {
  constructor(
    private readonly recorder: CertEvidenceRecorder,
    private readonly scrubber: SecretScrubber,
  ) {}

  private line(level: string, message: unknown, params: unknown[]): string {
    const context = typeof params[params.length - 1] === 'string' ? params[params.length - 1] : '';
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    return this.scrubber.scrub(redactText(`${level} [${String(context)}] ${text}`)).text;
  }

  log(message: unknown, ...params: unknown[]): void {
    this.recorder.recordLog(this.line('log', message, params));
  }
  warn(message: unknown, ...params: unknown[]): void {
    const line = this.line('warn', message, params);
    this.recorder.recordLog(line);
    err(line);
  }
  error(message: unknown, ...params: unknown[]): void {
    const line = this.line('error', message, params);
    this.recorder.recordLog(line);
    err(line);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.recorder.recordLog(this.line('debug', message, params));
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.recorder.recordLog(this.line('verbose', message, params));
  }
}

/** Todo lo que no puede aparecer en ningún archivo ni en la consola. */
function registerSecrets(scrubber: SecretScrubber, cfg: SabreConfig, credentials: object): void {
  for (const value of Object.values(credentials)) scrubber.add(value);
  for (const value of [
    cfg.epr,
    cfg.password,
    cfg.homePcc,
    cfg.ticketingPcc,
    cfg.sabreGroup,
    cfg.sabreCurrentCity,
  ]) {
    scrubber.add(value);
  }
  if (cfg.epr !== undefined && cfg.password !== undefined && cfg.homePcc !== undefined) {
    scrubber.add(
      deriveSabreSecret({
        epr: cfg.epr,
        homePcc: cfg.homePcc,
        password: cfg.password,
        domain: sabreDomain(cfg),
      }),
    );
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runHarness(args: CertRunArgs, plan: CertPlan): Promise<CertExitCode> {
  const ownerTenant = args.ownerTenant ?? '';
  const runId = args.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const scrubber = new SecretScrubber();
  const recorder = new CertEvidenceRecorder();
  const writer = new CertEvidenceWriter(join(args.out, runId), scrubber);
  const stepFiles = new Map<CertStepRecord, string>();
  const startedAt = new Date();
  const abort = { requested: false };

  // Las operaciones de ESTE proceso, exactamente las del plan. No toca a la API que está corriendo:
  // es otro proceso, con su propio `SABRE_OPERATIONS`.
  process.env['SABRE_OPERATIONS'] = plan.operations.join(',');

  // Segunda puerta: el `fetch` de este proceso sólo sale a CERT, y graba lo que cruza.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createCertTransport({ inner: originalFetch, recorder, scrubber });

  process.once('SIGINT', () => {
    abort.requested = true;
    err('Interrupción pedida: termina el paso en curso, limpia y sale. Otra vez Ctrl+C corta ya.');
    process.once('SIGINT', () => process.exit(130));
  });

  let app: INestApplicationContext | undefined;
  let account: CertRunAccountView | undefined;
  let report: CertRunReport = { scenarios: [], pnrs: [], leftovers: [] };
  let fatal: { error: Record<string, unknown>; refused: boolean } | undefined;

  try {
    await writer.prepare();
    // : sin él, un fallo al armar el contexto termina el proceso ahí mismo y el
    // resumen no se escribe.
    app = await NestFactory.createApplicationContext(CertRunModule, {
      logger: new CertRunLogger(recorder, scrubber),
      abortOnError: false,
    });
    const creds = app.get(ProviderCredentialsService);
    const factory = app.get(SabreProviderFactory);

    const resolved = await creds.resolve(ownerTenant, SABRE_PROVIDER_CODE);
    if (args.account !== undefined && resolved.id !== args.account) {
      throw new SabreCertGuardError(['la cuenta resuelta no es la que pide --account']);
    }
    const cfg = factory.configFor(resolved);
    registerSecrets(scrubber, cfg, resolved.credentials);
    const ticketing = sabreTicketingSettingsFromAccountConfig(resolved.config).settings;
    // La cuenta entra al resumen ANTES de la guarda: si se niega, el resumen dice a cuál y por qué.
    account = {
      accountId: resolved.id,
      ownerTenantId: resolved.ownerTenantId,
      credentialSource: resolved.inherited ? 'inherited' : 'own',
      host: cfg.host,
      ...(cfg.soapHost === undefined ? {} : { soapHost: cfg.soapHost }),
      ...(cfg.environment === undefined ? {} : { environment: cfg.environment }),
      ticketingPolicy: ticketing.policy,
      formOfPayment: ticketing.formOfPayment,
    };
    const declaredEnvironment = resolved.config['environment'];
    assertCertTarget({ declaredEnvironment, cfg });

    const tenantAdapter = await factory.resolveForTenant(ownerTenant);
    if (tenantAdapter.accountId !== resolved.id) {
      throw new SabreCertGuardError(['el factory resolvió otra cuenta que la comprobada']);
    }
    if (tenantAdapter.providerEnvironment !== undefined) {
      account = { ...account, providerEnvironment: tenantAdapter.providerEnvironment };
    }
    assertCertTarget({
      declaredEnvironment,
      cfg,
      providerEnvironment: tenantAdapter.providerEnvironment,
    });
    const flights = tenantAdapter.adapter;
    if (!(flights instanceof SabreFlightProviderAdapter)) {
      throw new SabreCertGuardError(['el factory no devolvió el adapter de Sabre']);
    }

    out(
      `Cuenta ${account.accountId} (${account.credentialSource}) · ${account.host} · CERT comprobado · emisión ${account.ticketingPolicy} con ${account.formOfPayment}`,
    );
    out(`Evidencia: ${writer.dir}`);

    report = await runCertPlan(plan, {
      flights,
      acl: buildCertAcl(cfg, resolved.config, recorder),
      recorder,
      ctx: { tenantId: ownerTenant, requestId: `sabre-cert-run-${runId}` },
      formOfPayment: ticketing.formOfPayment,
      announce: out,
      today: today(),
      abort,
      onStepEnd: async (record) => {
        const name = stepFileName(stepFiles.size + 1, record);
        stepFiles.set(record, name);
        await writer.writeJson(name, record);
      },
    });
  } catch (error) {
    fatal = { error: describeCertError(error), refused: error instanceof SabreCertGuardError };
    err(
      error instanceof SabreCertGuardError
        ? `NO SE CORRE: ${error.reasons.join('; ')}`
        : `Corte: ${JSON.stringify(fatal.error)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app?.close().catch(() => undefined);
  }

  const summary = buildCertSummary({
    runId,
    startedAt,
    finishedAt: new Date(),
    plan,
    ...(account === undefined ? {} : { account }),
    scenarios: report.scenarios,
    steps: recorder.steps,
    stepFiles,
    pnrs: report.pnrs,
    leftovers: report.leftovers,
    ...(fatal === undefined ? {} : { fatal }),
    secretsScrubbed: writer.secretsScrubbed,
    callsOutsideSteps: recorder.orphanExchanges.length,
    ...(process.env['APP_VERSION'] === undefined ? {} : { build: process.env['APP_VERSION'] }),
  });
  try {
    await writer.writeJson('summary.json', summary);
    await writer.writeText('summary.md', renderCertSummaryMarkdown(summary));
  } catch (error) {
    err(`No se pudo escribir el resumen: ${error instanceof Error ? error.name : 'error'}`);
  }

  out('');
  out(`Desenlace: ${summary.outcome} · salida ${String(summary.exitCode)}`);
  for (const pnr of summary.pnrs) out(`  PNR ${pnr.pnr} (${pnr.scenario}): ${pnr.state}`);
  for (const left of summary.leftovers) {
    err(`  SIN LIMPIAR ${left.pnr ?? '(sin localizador)'} (${left.scenario}): ${left.reason}`);
  }
  for (const warning of summary.warnings) err(`  AVISO ${warning}`);
  out(`EVIDENCE_DIR=${writer.dir}`);
  return summary.exitCode;
}

export async function main(argv: readonly string[]): Promise<CertExitCode> {
  let args: CertRunArgs;
  try {
    args = parseCertRunArgs(argv);
  } catch (error) {
    if (!(error instanceof CertRunArgsError)) throw error;
    err(error.problems.map((p) => `  ${p}`).join('\n'));
    err(CERT_RUN_USAGE);
    return CERT_EXIT.REFUSED;
  }
  if (args.help) {
    out(CERT_RUN_USAGE);
    return CERT_EXIT.OK;
  }

  let plan: CertPlan;
  try {
    plan = buildCertPlan(args);
  } catch (error) {
    if (!(error instanceof CertPlanError)) throw error;
    err('La corrida no se puede armar:');
    err(error.problems.map((p) => `  ${p}`).join('\n'));
    return CERT_EXIT.REFUSED;
  }
  describeCertPlan(plan).forEach(out);
  if (args.planOnly) return CERT_EXIT.OK;
  return runHarness(args, plan);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      err(`Error inesperado: ${error instanceof Error ? error.name : 'desconocido'}`);
      process.exit(CERT_EXIT.FAILED);
    },
  );
}
