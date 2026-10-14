import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { rethrowAdminDbError } from '../network/superadmin.errors.js';
import { POST_SALE_SWEEP_EVENTS } from '../orders/post-sale-sweep-events.js';
import {
  POST_SALE_SWEEP_EVERY_MS,
  RECONCILIATION_DAILY_CRON,
} from '../queue/post-sale-queue.service.js';
import {
  foldCatalogs,
  foldReconciliationRuns,
  type CatalogView,
  type OverviewCatalogRow,
  type OverviewReconciliationHealthRow,
  type ReconciliationRunsView,
} from './admin-overview.fold.js';

/**
 * Plataforma → Sistema › Procesos: si las tareas automáticas están corriendo, sin leer los logs. El
 * barrido de post-venta (su rastro en `domain_events`), la conciliación diaria por proveedor
 * (`admin_reconciliation_health`, 0075), la frescura de los catálogos de hoteles
 * (`hotel_provider_city`), los aeropuertos y la programación de cada tarea.
 *
 * Sólo lee y sólo el superadmin: la ruta pasa por SuperadminGuard, `admin_reconciliation_health`
 * vuelve a exigirlo en la base y los eventos del barrido se leen con la RLS de `domain_events`
 * (están en la raíz `platform`, que sólo administra la plataforma).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * El barrido corre cada 15 minutos: sin una corrida correcta en 45 (tres turnos seguidos) dejó de
 * correr. Uno solo perdido puede ser un despliegue.
 */
export const POST_SALE_SWEEP_STALE_MS = 3 * POST_SALE_SWEEP_EVERY_MS;

/** La ventana de los contadores de corridas del barrido. */
export const POST_SALE_SWEEP_WINDOW_MS = DAY_MS;

/** Las corridas de conciliación que se miran: es diaria, una semana alcanza (como el Resumen). */
export const SYSTEM_RECONCILIATION_DAYS = 7;

/** Una conciliación sin terminar una corrida en 36 horas se saltó al menos un día. */
export const RECONCILIATION_STALE_HOURS = 36;

/** El barrido de post-venta, de su rastro en `domain_events`. */
export interface PostSaleSweepView {
  /** ISO 8601: la última corrida, correcta o no; `null` si no hay rastro de ninguna. */
  lastRunAt: string | null;
  /** ¿La última corrida terminó bien? `null` sin corridas. */
  lastOk: boolean | null;
  /** ISO 8601: la última corrida correcta. */
  lastOkAt: string | null;
  /** De la última corrida correcta. */
  durationMs: number | null;
  /** Nodos que la última corrida correcta no pudo revisar. */
  tenantsFailed: number | null;
  /** Corridas (correctas y con error) de las últimas 24 horas. */
  runs24h: number;
  failures24h: number;
  /** Sin una corrida correcta en {@link POST_SALE_SWEEP_STALE_MS} (o sin ninguna). */
  stale: boolean;
  everyMinutes: number;
  staleAfterMinutes: number;
}

export type SystemReconciliationProviderView = ReconciliationRunsView['byProvider'][number] & {
  /** La última corrida terminada tiene más de {@link RECONCILIATION_STALE_HOURS} horas (o no hay). */
  stale: boolean;
};

export interface SystemReconciliationView {
  sinceDays: number;
  byProvider: SystemReconciliationProviderView[];
}

export type ScheduleRunner = 'api' | 'github';

/** Cuándo corre cada tarea automática. */
export interface SystemScheduleView {
  id: string;
  label: string;
  /** Dónde corre: dentro del api (BullMQ o su temporizador) o como un cron de GitHub Actions. */
  runner: ScheduleRunner;
  /** El archivo de `.github/workflows`, si es de GitHub. */
  workflow: string | null;
  /** La expresión cron (UTC), si la tiene. */
  cron: string | null;
  /** Cuándo, en palabras. */
  schedule: string;
}

export interface AdminSystemJobsView {
  /** ISO 8601. */
  generatedAt: string;
  postSaleSweep: PostSaleSweepView;
  reconciliation: SystemReconciliationView;
  catalogs: CatalogView[];
  airports: { count: number };
  schedules: readonly SystemScheduleView[];
}

/**
 * Las tareas automáticas y cuándo corren. Las de GitHub, con el cron de su workflow: un test los
 * compara con `.github/workflows`, así que cambiar uno sin el otro rompe CI.
 */
export const SYSTEM_SCHEDULES: readonly SystemScheduleView[] = [
  {
    id: 'post-sale-sweep',
    label: 'Barrido de post-venta',
    runner: 'api',
    workflow: null,
    cron: null,
    schedule: `Cada ${POST_SALE_SWEEP_EVERY_MS / MINUTE_MS} minutos, dentro del api: verifica reservas y cancelaciones de hotel, sigue el número de confirmación y recupera la conciliación del día.`,
  },
  {
    id: 'reconciliation',
    label: 'Conciliación diaria',
    runner: 'api',
    workflow: null,
    cron: RECONCILIATION_DAILY_CRON,
    schedule:
      'Todos los días a las 04:30 UTC (23:30 de la noche anterior en Bogotá), dentro del api.',
  },
  {
    id: 'sync-airports',
    label: 'Aeropuertos',
    runner: 'github',
    workflow: 'sync-airports.yml',
    cron: '0 3 * * *',
    schedule: 'Todos los días a las 03:00 UTC (22:00 en Bogotá).',
  },
  {
    id: 'sync-hotel-inventory',
    label: 'Catálogo de hoteles de Despegar',
    runner: 'github',
    workflow: 'sync-hotel-inventory.yml',
    cron: '30 3 * * *',
    schedule:
      'Todos los días a las 03:30 UTC (22:30 en Bogotá). Si el servidor no tiene la clave de Despegar, no hace nada.',
  },
  {
    id: 'sync-tbo-hotel-inventory',
    label: 'Catálogo de hoteles de TBO',
    runner: 'github',
    workflow: 'sync-tbo-hotel-inventory.yml',
    cron: '17 6-9 * * *',
    schedule:
      'Cada hora de 06:17 a 09:17 UTC (01:17 a 04:17 en Bogotá). Cada corrida sigue donde quedó la anterior.',
  },
];

// ─────────────────────────── Filas ───────────────────────────

type DbNumber = string | number | bigint | null | undefined;

/** La última corrida de un tipo: cuándo y lo que dejó. */
export interface SweepEventRow {
  occurred_at: Date | string;
  payload: unknown;
}

export interface SweepCountsRow {
  completed: DbNumber;
  failed: DbNumber;
}

export interface SweepRows {
  lastCompleted?: SweepEventRow | undefined;
  lastFailed?: SweepEventRow | undefined;
  counts?: SweepCountsRow | undefined;
}

// ─────────────────────────── Plegados (sin I/O) ───────────────────────────

function toCount(value: DbNumber): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function isoOf(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Un conteo del payload de un evento; `null` si no está o no es un entero no negativo. */
function payloadCount(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * El barrido, de su rastro. "Atrasado" se mide desde la última corrida CORRECTA: una que se cae
 * entera cada 15 minutos también es un barrido que no barre.
 */
export function foldPostSaleSweep(rows: SweepRows, now: Date): PostSaleSweepView {
  const lastOkAt = isoOf(rows.lastCompleted?.occurred_at);
  const lastFailedAt = isoOf(rows.lastFailed?.occurred_at);
  const lastRunAt =
    lastOkAt === null
      ? lastFailedAt
      : lastFailedAt === null || lastOkAt >= lastFailedAt
        ? lastOkAt
        : lastFailedAt;
  const completed = toCount(rows.counts?.completed);
  const failed = toCount(rows.counts?.failed);
  return {
    lastRunAt,
    lastOk: lastRunAt === null ? null : lastRunAt === lastOkAt,
    lastOkAt,
    durationMs: payloadCount(rows.lastCompleted?.payload, 'durationMs'),
    tenantsFailed: payloadCount(rows.lastCompleted?.payload, 'tenantsFailed'),
    runs24h: completed + failed,
    failures24h: failed,
    stale: lastOkAt === null || now.getTime() - Date.parse(lastOkAt) > POST_SALE_SWEEP_STALE_MS,
    everyMinutes: POST_SALE_SWEEP_EVERY_MS / MINUTE_MS,
    staleAfterMinutes: POST_SALE_SWEEP_STALE_MS / MINUTE_MS,
  };
}

/** La conciliación por proveedor, con cuál dejó de correr. */
export function foldSystemReconciliation(
  rows: readonly OverviewReconciliationHealthRow[],
  sinceDays: number,
  now: Date,
): SystemReconciliationView {
  const staleBefore = now.getTime() - RECONCILIATION_STALE_HOURS * HOUR_MS;
  const runs = foldReconciliationRuns(rows, sinceDays);
  return {
    sinceDays: runs.sinceDays,
    byProvider: runs.byProvider.map((p) => ({
      ...p,
      stale: p.lastFinishedAt === null || Date.parse(p.lastFinishedAt) < staleBefore,
    })),
  };
}

// ─────────────────────────── Lecturas (dentro de la transacción de quien llama) ───────────────────────────

/**
 * El rastro del barrido, en la transacción de quien llama, que ya puso `app.current_user_id`: la RLS
 * de `domain_events` (domain_events_subtree_read, 0029) sólo deja ver la raíz `platform` a quien la
 * administra. Se mira sólo la raíz: el barrido no deja rastro en ningún otro nodo.
 *
 * Las dos "últimas" usan idx_domain_events_type_time; los contadores, sólo las últimas 24 h.
 */
export async function readPostSaleSweep(
  trx: Transaction<DB>,
  now: Date,
): Promise<PostSaleSweepView> {
  const root = await trx
    .selectFrom('tenants')
    .select('id')
    .where('tenant_type', '=', 'platform')
    .executeTakeFirst();
  if (root === undefined) return foldPostSaleSweep({}, now);

  const last = (eventType: string): Promise<SweepEventRow | undefined> =>
    trx
      .selectFrom('domain_events')
      // `Generated<Timestamp>` no se desenvuelve al leer: `pg` devuelve un Date.
      .select([sql<Date>`occurred_at`.as('occurred_at'), 'payload'])
      .where('tenant_id', '=', root.id)
      .where('event_type', '=', eventType)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();

  const lastCompleted = await last(POST_SALE_SWEEP_EVENTS.completed);
  const lastFailed = await last(POST_SALE_SWEEP_EVENTS.failed);
  const since = new Date(now.getTime() - POST_SALE_SWEEP_WINDOW_MS);
  const counts = await trx
    .selectFrom('domain_events')
    .select([
      sql<string>`count(*) FILTER (WHERE event_type = ${POST_SALE_SWEEP_EVENTS.completed})`.as(
        'completed',
      ),
      sql<string>`count(*) FILTER (WHERE event_type = ${POST_SALE_SWEEP_EVENTS.failed})`.as(
        'failed',
      ),
    ])
    .where('tenant_id', '=', root.id)
    .where('event_type', 'in', [POST_SALE_SWEEP_EVENTS.completed, POST_SALE_SWEEP_EVENTS.failed])
    .where(sql<boolean>`occurred_at >= ${since}`)
    .executeTakeFirst();

  return foldPostSaleSweep({ lastCompleted, lastFailed, counts }, now);
}

/**
 * La frescura del catálogo de hoteles de cada proveedor que lo sincroniza por ciudad
 * (`hotel_provider_city`, catálogo de plataforma sin tenant ni RLS, 0041). Hoy sólo TBO: el sync de
 * Despegar reemplaza `hotel_inventory` entero y no escribe ciudades.
 */
export async function readCatalogFreshness(
  trx: Transaction<DB>,
  now: Date,
): Promise<CatalogView[]> {
  const synced48h = new Date(now.getTime() - 2 * DAY_MS);
  const { rows } = await sql<OverviewCatalogRow>`
    SELECT c.provider_code,
           count(*) AS cities,
           count(*) FILTER (WHERE c.synced_at > ${synced48h}::timestamptz) AS synced_last_48h,
           count(*) FILTER (WHERE c.last_status_code >= 400) AS failed_cities,
           max(c.synced_at) AS last_synced_at
      FROM hotel_provider_city c
     GROUP BY c.provider_code
  `.execute(trx);
  return foldCatalogs(rows, now);
}

// ─────────────────────────── El servicio ───────────────────────────

@Injectable()
export class AdminSystemService {
  constructor(private readonly db: DatabaseService) {}

  async jobs(actorUserId: string, now: Date = new Date()): Promise<AdminSystemJobsView> {
    const runsSince = new Date(now.getTime() - SYSTEM_RECONCILIATION_DAYS * DAY_MS);
    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const postSaleSweep = await readPostSaleSweep(trx, now);
        const runs = await sql<OverviewReconciliationHealthRow>`
          SELECT * FROM admin_reconciliation_health(${runsSince}::timestamptz)
        `.execute(trx);
        const catalogs = await readCatalogFreshness(trx, now);
        // Catálogo global de lectura abierta (0003).
        const airports = await trx
          .selectFrom('airports')
          .select(sql<string>`count(*)`.as('count'))
          .executeTakeFirst();

        return {
          generatedAt: now.toISOString(),
          postSaleSweep,
          reconciliation: foldSystemReconciliation(runs.rows, SYSTEM_RECONCILIATION_DAYS, now),
          catalogs,
          airports: { count: toCount(airports?.count) },
          schedules: SYSTEM_SCHEDULES,
        };
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }
}
