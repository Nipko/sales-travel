import type { CertStepRecord } from './captures.js';
import type { CertPlan } from './plan.js';
import type { CertLeftover, CertPnrRecord, CertScenarioReport } from './scenarios.js';

/**
 * El resumen de una corrida del arnés (`summary.json` y `summary.md`): qué cuenta se usó —sin un
 * solo dato de credencial—, qué pasó en cada escenario y paso, con su Conversation-ID para pedirle
 * a Sabre la traza, qué PNR se crearon y en qué quedaron, y lo que no se pudo limpiar.
 */

/** Códigos de salida del CLI. `LEFTOVERS` gana a `FAILED`: un PNR colgado es lo urgente. */
export const CERT_EXIT = { OK: 0, FAILED: 1, LEFTOVERS: 2, REFUSED: 3 } as const;
export type CertExitCode = (typeof CERT_EXIT)[keyof typeof CERT_EXIT];

/** La cuenta como la ve el resumen: hosts y políticas, nunca EPR, PCC ni contraseña. */
export interface CertRunAccountView {
  readonly accountId: string;
  readonly ownerTenantId: string;
  readonly credentialSource: string;
  readonly host: string;
  readonly soapHost?: string;
  readonly environment?: string;
  readonly providerEnvironment?: string;
  readonly ticketingPolicy: string;
  readonly formOfPayment: string;
}

export interface CertStepSummary {
  readonly scenario: string;
  readonly step: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly calls: number;
  readonly conversationIds: readonly string[];
  readonly httpStatuses: readonly number[];
  readonly file?: string;
}

export interface CertRunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'ok' | 'failed' | 'leftovers' | 'refused';
  readonly exitCode: CertExitCode;
  readonly build?: string;
  readonly account?: CertRunAccountView;
  readonly plan: {
    readonly scenarios: readonly string[];
    readonly routes: readonly string[];
    readonly bookRoute: string;
    readonly pax: string;
    readonly days: number;
    readonly returnDays?: number;
    readonly allowMoney: boolean;
    readonly operations: readonly string[];
  };
  readonly scenarios: readonly CertScenarioReport[];
  readonly steps: readonly CertStepSummary[];
  readonly pnrs: readonly CertPnrRecord[];
  readonly leftovers: readonly CertLeftover[];
  readonly fatal?: Record<string, unknown>;
  readonly evidence: {
    readonly secretsScrubbed: number;
    readonly callsOutsideSteps: number;
  };
  readonly warnings: readonly string[];
}

export interface CertSummaryInput {
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly plan: CertPlan;
  readonly account?: CertRunAccountView;
  readonly scenarios: readonly CertScenarioReport[];
  readonly steps: readonly CertStepRecord[];
  readonly stepFiles: ReadonlyMap<CertStepRecord, string>;
  readonly pnrs: readonly CertPnrRecord[];
  readonly leftovers: readonly CertLeftover[];
  readonly fatal?: { readonly error: Record<string, unknown>; readonly refused: boolean };
  readonly secretsScrubbed: number;
  readonly callsOutsideSteps: number;
  readonly build?: string;
}

function paxLabel(plan: CertPlan): string {
  const { adults, children, infants } = plan.pax;
  return `${String(adults)}ADT${children > 0 ? `${String(children)}CHD` : ''}${infants > 0 ? `${String(infants)}INF` : ''}`;
}

/** El desenlace de la corrida y su código de salida. */
export function certRunOutcome(input: {
  readonly fatal?: { readonly refused: boolean };
  readonly scenarios: readonly Pick<CertScenarioReport, 'outcome'>[];
  readonly leftovers: readonly unknown[];
}): { outcome: CertRunSummary['outcome']; exitCode: CertExitCode } {
  if (input.leftovers.length > 0) return { outcome: 'leftovers', exitCode: CERT_EXIT.LEFTOVERS };
  if (input.fatal?.refused === true) return { outcome: 'refused', exitCode: CERT_EXIT.REFUSED };
  if (input.fatal !== undefined || input.scenarios.some((s) => s.outcome !== 'ok')) {
    return { outcome: 'failed', exitCode: CERT_EXIT.FAILED };
  }
  return { outcome: 'ok', exitCode: CERT_EXIT.OK };
}

export function buildCertSummary(input: CertSummaryInput): CertRunSummary {
  const { outcome, exitCode } = certRunOutcome(input);
  const warnings: string[] = [];
  if (input.secretsScrubbed > 0) {
    warnings.push(
      `se taparon ${String(input.secretsScrubbed)} apariciones de un secreto conocido que la redacción por clave no vio: revisar la redacción del ACL antes de versionar fixtures`,
    );
  }
  if (input.callsOutsideSteps > 0) {
    warnings.push(
      `${String(input.callsOutsideSteps)} llamadas a Sabre fuera de un paso: no quedaron en ningún archivo de paso`,
    );
  }
  const route = (r: { origin: string; destination: string }) => `${r.origin}-${r.destination}`;
  return {
    runId: input.runId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    outcome,
    exitCode,
    ...(input.build === undefined ? {} : { build: input.build }),
    ...(input.account === undefined ? {} : { account: input.account }),
    plan: {
      scenarios: input.plan.scenarios.map((s) => s.id),
      routes: input.plan.routes.map(route),
      bookRoute: route(input.plan.bookRoute),
      pax: paxLabel(input.plan),
      days: input.plan.days,
      ...(input.plan.returnDays === undefined ? {} : { returnDays: input.plan.returnDays }),
      allowMoney: input.plan.allowMoney,
      operations: input.plan.operations,
    },
    scenarios: input.scenarios,
    steps: input.steps.map((record) => {
      const file = input.stepFiles.get(record);
      return {
        scenario: record.scenario,
        step: record.step,
        outcome: record.outcome,
        durationMs: record.durationMs,
        calls: record.exchanges.length,
        conversationIds: [
          ...new Set(
            record.exchanges
              .map((e) => e.conversationId)
              .filter((id): id is string => id !== undefined),
          ),
        ],
        httpStatuses: record.exchanges
          .map((e) => e.response?.status)
          .filter((status): status is number => status !== undefined),
        ...(file === undefined ? {} : { file }),
      };
    }),
    pnrs: input.pnrs,
    leftovers: input.leftovers,
    ...(input.fatal === undefined ? {} : { fatal: input.fatal.error }),
    evidence: {
      secretsScrubbed: input.secretsScrubbed,
      callsOutsideSteps: input.callsOutsideSteps,
    },
    warnings,
  };
}

/** `summary.md`: las filas que se copian a `docs/sabre/12-hallazgos-sandbox.md`. */
export function renderCertSummaryMarkdown(summary: CertRunSummary): string {
  const lines: string[] = [
    `# Corrida ${summary.runId} contra Sabre CERT`,
    '',
    `- Desenlace: **${summary.outcome}** (salida ${String(summary.exitCode)})`,
    `- Inicio y fin: ${summary.startedAt} → ${summary.finishedAt}`,
    ...(summary.build === undefined ? [] : [`- Build: ${summary.build}`]),
    ...(summary.account === undefined
      ? []
      : [
          `- Cuenta: ${summary.account.accountId} (${summary.account.credentialSource}) · host ${summary.account.host} · emisión ${summary.account.ticketingPolicy} con ${summary.account.formOfPayment}`,
        ]),
    `- Plan: ${summary.plan.scenarios.join(', ')} · rutas ${summary.plan.routes.join(', ')} · reservas en ${summary.plan.bookRoute} · ${summary.plan.pax} · ${String(summary.plan.days)} días · dinero ${summary.plan.allowMoney ? 'sí' : 'no'}`,
    '',
    '| Escenario | Paquete | Desenlace | PNR | Notas |',
    '| --- | --- | --- | --- | --- |',
    ...summary.scenarios.map(
      (s) =>
        `| ${s.id} | ${s.forPackage} | ${s.outcome} | ${s.pnr ?? '—'} | ${[...s.notes, ...(s.error === undefined ? [] : [`error ${String(s.error['name'])}`])].join('; ') || '—'} |`,
    ),
    '',
    '| Paso | Desenlace | ms | HTTP | Conversation-ID |',
    '| --- | --- | --- | --- | --- |',
    ...summary.steps.map(
      (s) =>
        `| ${s.scenario} · ${s.step} | ${s.outcome} | ${String(s.durationMs)} | ${s.httpStatuses.join(', ') || '—'} | ${s.conversationIds.join(', ') || '—'} |`,
    ),
  ];
  if (summary.pnrs.length > 0) {
    lines.push('', '| PNR | Escenario | Estado final |', '| --- | --- | --- |');
    lines.push(...summary.pnrs.map((p) => `| ${p.pnr} | ${p.scenario} | ${p.state} |`));
  }
  lines.push('', '## Sin limpiar', '');
  lines.push(
    ...(summary.leftovers.length === 0
      ? ['Nada: ningún PNR de esta corrida quedó vivo.']
      : summary.leftovers.map(
          (l) => `- **${l.pnr ?? 'sin localizador'}** (${l.scenario}, ${l.state}): ${l.reason}`,
        )),
  );
  if (summary.fatal !== undefined) {
    lines.push('', '## Corte', '', `\`${JSON.stringify(summary.fatal)}\``);
  }
  if (summary.warnings.length > 0) {
    lines.push('', '## Avisos', '', ...summary.warnings.map((w) => `- ${w}`));
  }
  return `${lines.join('\n')}\n`;
}
