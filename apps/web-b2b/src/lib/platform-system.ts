import type { Route } from 'next';
import { providerMetaFor } from './provider-display';
import type { Tone } from './wallets';

/**
 * Plataforma → Sistema › Procesos (`GET /admin/system/jobs`): si lo que corre solo está corriendo —el
 * barrido de post-venta, la conciliación diaria, los catálogos de hoteles y los aeropuertos— y cuándo
 * corre cada cosa. La lectura de la respuesta y los textos de la pantalla. Sin I/O.
 *
 * Como en el Resumen, una respuesta cuyo barrido no se puede leer es ilegible entera: decir
 * "Corriendo" sobre un dato que no se leyó sería mentir. Una fila rota de una lista se descarta.
 */

export const PLATFORM_SISTEMA: Route = '/admin/plataforma/sistema';

export interface PostSaleSweep {
  /** ISO 8601: la última corrida, correcta o no. */
  readonly lastRunAt: string | null;
  readonly lastOk: boolean | null;
  /** ISO 8601: la última corrida correcta. */
  readonly lastOkAt: string | null;
  readonly durationMs: number | null;
  readonly tenantsFailed: number | null;
  readonly runs24h: number;
  readonly failures24h: number;
  readonly stale: boolean;
  readonly everyMinutes: number;
  readonly staleAfterMinutes: number;
}

export interface ReconciliationProvider {
  readonly providerCode: string;
  readonly runs: number;
  readonly failedRuns: number;
  /** ISO 8601, o `null` si nunca terminó una. */
  readonly lastFinishedAt: string | null;
  readonly lastStatus: string | null;
  readonly criticalItems: number;
  readonly warningItems: number;
  readonly stale: boolean;
}

export interface CatalogSync {
  readonly providerCode: string;
  readonly cities: number;
  readonly syncedLast48h: number;
  readonly failedCities: number;
  /** ISO 8601, o `null` si nunca se sincronizó. */
  readonly lastSyncedAt: string | null;
  readonly stale: boolean;
}

export type JobRunner = 'api' | 'github';

export interface JobSchedule {
  readonly id: string;
  readonly label: string;
  readonly runner: JobRunner;
  readonly workflow: string | null;
  readonly cron: string | null;
  readonly schedule: string;
}

export interface SystemJobs {
  /** ISO 8601: cuándo armó el API esta lectura. */
  readonly generatedAt: string;
  readonly postSaleSweep: PostSaleSweep;
  readonly reconciliation: {
    readonly sinceDays: number;
    readonly byProvider: readonly ReconciliationProvider[];
  };
  readonly catalogs: readonly CatalogSync[];
  readonly airports: { readonly count: number };
  readonly schedules: readonly JobSchedule[];
}

// ───────────────────────────── La respuesta ─────────────────────────────

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Un instante ISO, `null`, o `undefined` si no es ninguno de los dos. */
function instantOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function countOrNull(value: unknown): number | null | undefined {
  return value === null ? null : count(value);
}

/** Lee los conteos de `r` que pide `keys`; `undefined` si falta o se rompió alguno. */
function counts<K extends string>(
  r: Rec | undefined,
  keys: readonly K[],
): Record<K, number> | undefined {
  if (r === undefined) return undefined;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const n = count(r[key]);
    if (n === undefined) return undefined;
    out[key] = n;
  }
  return out;
}

function list<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === undefined ? [] : [parsed];
  });
}

function parseSweep(value: unknown): PostSaleSweep | undefined {
  const r = asRecord(value);
  const n = counts(r, ['runs24h', 'failures24h', 'everyMinutes', 'staleAfterMinutes']);
  const lastRunAt = instantOrNull(r?.['lastRunAt']);
  const lastOkAt = instantOrNull(r?.['lastOkAt']);
  const durationMs = countOrNull(r?.['durationMs']);
  const tenantsFailed = countOrNull(r?.['tenantsFailed']);
  const lastOk = r?.['lastOk'];
  const stale = r?.['stale'];
  if (
    n === undefined ||
    lastRunAt === undefined ||
    lastOkAt === undefined ||
    durationMs === undefined ||
    tenantsFailed === undefined ||
    (lastOk !== null && typeof lastOk !== 'boolean') ||
    typeof stale !== 'boolean' ||
    n.everyMinutes === 0
  ) {
    return undefined;
  }
  return { ...n, lastRunAt, lastOk, lastOkAt, durationMs, tenantsFailed, stale };
}

function parseReconciliation(value: unknown): ReconciliationProvider | undefined {
  const r = asRecord(value);
  const providerCode = text(r?.['providerCode']);
  const n = counts(r, ['runs', 'failedRuns', 'criticalItems', 'warningItems']);
  const lastFinishedAt = instantOrNull(r?.['lastFinishedAt']);
  const stale = r?.['stale'];
  if (
    providerCode === undefined ||
    n === undefined ||
    lastFinishedAt === undefined ||
    typeof stale !== 'boolean'
  ) {
    return undefined;
  }
  return { providerCode, ...n, lastFinishedAt, lastStatus: text(r?.['lastStatus']) ?? null, stale };
}

function parseCatalog(value: unknown): CatalogSync | undefined {
  const r = asRecord(value);
  const providerCode = text(r?.['providerCode']);
  const n = counts(r, ['cities', 'syncedLast48h', 'failedCities']);
  const lastSyncedAt = instantOrNull(r?.['lastSyncedAt']);
  const stale = r?.['stale'];
  if (
    providerCode === undefined ||
    n === undefined ||
    lastSyncedAt === undefined ||
    typeof stale !== 'boolean'
  ) {
    return undefined;
  }
  return { providerCode, ...n, lastSyncedAt, stale };
}

function parseSchedule(value: unknown): JobSchedule | undefined {
  const r = asRecord(value);
  const id = text(r?.['id']);
  const label = text(r?.['label']);
  const schedule = text(r?.['schedule']);
  const runner = r?.['runner'];
  if (id === undefined || label === undefined || schedule === undefined) return undefined;
  if (runner !== 'api' && runner !== 'github') return undefined;
  return {
    id,
    label,
    runner,
    workflow: text(r?.['workflow']) ?? null,
    cron: text(r?.['cron']) ?? null,
    schedule,
  };
}

export function parseSystemJobs(value: unknown): SystemJobs | undefined {
  const r = asRecord(value);
  const generatedAt = text(r?.['generatedAt']);
  const postSaleSweep = parseSweep(r?.['postSaleSweep']);
  const reconciliationRec = asRecord(r?.['reconciliation']);
  const sinceDays = count(reconciliationRec?.['sinceDays']);
  const byProvider = list(reconciliationRec?.['byProvider'], parseReconciliation);
  const catalogs = list(r?.['catalogs'], parseCatalog);
  const airports = counts(asRecord(r?.['airports']), ['count']);
  const schedules = list(r?.['schedules'], parseSchedule);
  if (
    generatedAt === undefined ||
    Number.isNaN(Date.parse(generatedAt)) ||
    postSaleSweep === undefined ||
    sinceDays === undefined ||
    byProvider === undefined ||
    catalogs === undefined ||
    airports === undefined ||
    schedules === undefined
  ) {
    return undefined;
  }
  return {
    generatedAt,
    postSaleSweep,
    reconciliation: { sinceDays, byProvider },
    catalogs,
    airports,
    schedules,
  };
}

// ───────────────────────────── Textos ─────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n.toLocaleString('es-CO')} ${many}`;
}

/** Cuánto pasó desde `iso`: "menos de un minuto", "3 minutos", "2 horas", "4 días". */
export function elapsedText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return 'menos de un minuto';
  if (elapsed < HOUR_MS) return plural(Math.floor(elapsed / MINUTE_MS), 'minuto', 'minutos');
  if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), 'hora', 'horas');
  return plural(Math.floor(elapsed / DAY_MS), 'día', 'días');
}

/** "hace 3 minutos"; una fecha ilegible, "hace un rato". */
function agoText(iso: string, now: number): string {
  const elapsed = elapsedText(iso, now);
  return elapsed === '' ? 'hace un rato' : `hace ${elapsed}`;
}

/** "8 s", "2 min 5 s". */
export function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return 'menos de un segundo';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export interface SweepStatus {
  readonly tone: Tone;
  readonly badge: string;
  readonly headline: string;
  readonly details: readonly string[];
}

/** El barrido de post-venta en palabras: si corre, desde cuándo no, y lo que falló en 24 h. */
export function sweepStatus(sweep: PostSaleSweep, now: number): SweepStatus {
  const every = `corre cada ${plural(sweep.everyMinutes, 'minuto', 'minutos')}`;
  const details: string[] = [];
  if (sweep.failures24h > 0) {
    details.push(
      sweep.failures24h === 1
        ? '1 ejecución con error en 24 h'
        : `${sweep.failures24h.toLocaleString('es-CO')} ejecuciones con error en 24 h`,
    );
  }
  if (sweep.lastOk === false && !sweep.stale) {
    details.push('La última ejecución terminó con error; la anterior terminó bien.');
  }
  if (sweep.tenantsFailed !== null && sweep.tenantsFailed > 0) {
    details.push(
      sweep.tenantsFailed === 1
        ? 'En la última ejecución correcta, 1 nodo no se pudo revisar.'
        : `En la última ejecución correcta, ${sweep.tenantsFailed} nodos no se pudieron revisar.`,
    );
  }
  if (sweep.runs24h > 0) {
    const duration =
      sweep.durationMs === null ? '' : ` · la última tardó ${durationLabel(sweep.durationMs)}`;
    details.push(`${plural(sweep.runs24h, 'ejecución', 'ejecuciones')} en 24 h${duration}`);
  }

  if (sweep.lastOkAt === null) {
    return {
      // Sin ninguna corrida que haya terminado bien. Si al menos intentó, está fallando.
      tone: sweep.lastRunAt === null ? 'warning' : 'danger',
      badge: sweep.lastRunAt === null ? 'Sin registro' : 'Detenido',
      headline:
        sweep.lastRunAt === null
          ? 'No hay registro de ninguna ejecución: revisa el contenedor del api.'
          : 'Ninguna ejecución terminó bien: revisa el contenedor del api.',
      details,
    };
  }
  if (sweep.stale) {
    return {
      tone: 'danger',
      badge: 'Detenido',
      headline: `No corre hace ${elapsedText(sweep.lastOkAt, now)}: revisa el contenedor del api.`,
      details,
    };
  }
  return {
    tone: sweep.failures24h > 0 ? 'warning' : 'success',
    badge: 'Corriendo',
    headline: `Última ejecución correcta ${agoText(sweep.lastOkAt, now)} · ${every}`,
    details,
  };
}

const RECONCILIATION_STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  completed: { label: 'Correcta', tone: 'success' },
  running: { label: 'En curso', tone: 'neutral' },
  failed: { label: 'Falló', tone: 'danger' },
  invalid: { label: 'Respuesta inválida', tone: 'warning' },
  abandoned: { label: 'Se interrumpió', tone: 'warning' },
};

/** El estado de la última corrida de conciliación; uno que no se conoce, por su código. */
export function reconciliationStatus(lastStatus: string | null): {
  readonly label: string;
  readonly tone: Tone;
} {
  if (lastStatus === null) return { label: 'Sin corridas', tone: 'neutral' };
  return RECONCILIATION_STATUS[lastStatus] ?? { label: lastStatus, tone: 'neutral' };
}

/** "hace 5 horas", o "Nunca terminó una". */
export function lastRunLabel(lastFinishedAt: string | null, now: number): string {
  return lastFinishedAt === null ? 'Nunca terminó una' : agoText(lastFinishedAt, now);
}

/** El nombre legible de un proveedor; uno sin ficha, por su código. */
export function providerLabel(code: string): string {
  return providerMetaFor(code).name;
}

export function catalogTitle(providerCode: string): string {
  return `Catálogo de hoteles · ${providerLabel(providerCode)}`;
}

/** "1.200 ciudades · sincronizadas en 48 h: 1.180 · con error: 3 · última hace 2 horas". */
export function catalogLine(catalog: CatalogSync, now: number): string {
  return [
    plural(catalog.cities, 'ciudad', 'ciudades'),
    `sincronizadas en 48 h: ${catalog.syncedLast48h.toLocaleString('es-CO')}`,
    `con error: ${catalog.failedCities.toLocaleString('es-CO')}`,
    catalog.lastSyncedAt === null
      ? 'nunca se sincronizó'
      : `última ${agoText(catalog.lastSyncedAt, now)}`,
  ].join(' · ');
}

export function catalogBadge(catalog: Pick<CatalogSync, 'stale'>): {
  readonly label: string;
  readonly tone: Tone;
} {
  return catalog.stale
    ? { label: 'Atrasado', tone: 'warning' }
    : { label: 'Al día', tone: 'success' };
}

/** "8.214 aeropuertos". */
export function airportsLine(airports: { readonly count: number }): string {
  return airports.count === 0
    ? 'No hay aeropuertos cargados: la búsqueda de vuelos no los puede sugerir.'
    : plural(airports.count, 'aeropuerto', 'aeropuertos');
}

/** Dónde corre una tarea. */
export function runnerLabel(schedule: Pick<JobSchedule, 'runner' | 'workflow'>): string {
  if (schedule.runner === 'api') return 'En el api';
  return schedule.workflow === null ? 'GitHub Actions' : `GitHub Actions · ${schedule.workflow}`;
}

/** "Actualizado hace 3 minutos". */
export function systemUpdatedLabel(generatedAt: string, now: number): string {
  return `Actualizado ${agoText(generatedAt, now)}`;
}

/** El mensaje de una lectura que no se pudo hacer. */
export function systemErrorMessage(status: number, apiMessage?: string): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  const fromApi = apiMessage?.trim();
  if (status === 403) return fromApi || 'Sólo el superadmin de la plataforma ve los procesos.';
  return 'No pudimos leer el estado de los procesos. Reintenta en unos segundos.';
}
