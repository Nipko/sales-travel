import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { PlatformConsoleScopeNotFoundError } from '../admin-console/admin-console.errors.js';
import {
  PLATFORM_TIME_ZONE,
  type OverviewPeriod,
} from '../admin-console/admin-overview.schemas.js';
import { toCsv, type CsvValue } from '../admin-console/csv.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { rethrowAdminDbError } from '../network/superadmin.errors.js';
import {
  ADMIN_AUDIT_EXPORT_MAX_ROWS,
  auditExportFilename,
  resolveAuditPeriod,
  type AdminAuditExportQuery,
  type AdminAuditFilters,
  type AdminAuditQuery,
} from './admin-audit.schemas.js';
import { auditTypeFilter } from './audit-categories.js';
import { encodeAuditCursor, type AuditCursor } from './audit.schemas.js';
import { AuditService } from './audit.service.js';
import { redactPayload } from './redact-payload.js';

/** El rastro de cada exportación, en la raíz `platform`: quién, con qué filtros y cuántas filas. */
export const PLATFORM_AUDIT_EXPORTED_EVENT = 'platform.audit.exported';

/** De `meta`, sólo lo que sirve para investigar. Nunca el id de la sesión (no sale de la base). */
export interface AdminAuditMetaView {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** Un evento como sale en Plataforma → Actividad. */
export interface AdminAuditEventView {
  id: string;
  /** ISO 8601. */
  occurredAt: string;
  eventType: string;
  /** `null`: un evento sin nodo (de la plataforma). */
  tenantId: string | null;
  /** `null` si no tiene nodo o si el nodo ya no existe. */
  tenantName: string | null;
  actorEmail: string | null;
  /** La cuenta sobre la que se hizo, si no es la de quien lo hizo. */
  targetEmail: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  /** Sin claves sensibles (redactPayload), a cualquier profundidad. */
  payload: Record<string, unknown>;
  meta: AdminAuditMetaView;
}

export interface AdminAuditPage {
  events: AdminAuditEventView[];
  /** Lo que se manda como `cursor` para la página siguiente; `null` si no hay más. */
  nextCursor: string | null;
}

/** El CSV de la exportación, con lo que hace falta para las cabeceras. */
export interface AdminAuditExport {
  csv: string;
  filename: string;
  /** Filas exportadas (sin el encabezado). */
  rows: number;
  /** Había más de {@link ADMIN_AUDIT_EXPORT_MAX_ROWS}: se exportaron las más nuevas. */
  truncated: boolean;
}

/** Una fila de admin_audit_events (0078), con el instante del cursor en texto. */
export interface AdminAuditRow {
  id: string;
  occurred_at: Date | string;
  /** El instante con microsegundos, para el cursor: un `Date` los pierde. */
  cursor_at: string;
  event_type: string;
  tenant_id: string | null;
  tenant_name: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  target_email: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: unknown;
  meta: unknown;
}

// ─────────────────────────── Plegados (sin I/O) ───────────────────────────

/** Lo más largo que se devuelve de cada dato de `meta`. */
const META_MAX: Readonly<Record<keyof AdminAuditMetaView, number>> = {
  ip: 64,
  userAgent: 512,
  requestId: 128,
};

function metaText(meta: Record<string, unknown>, key: keyof AdminAuditMetaView): string | null {
  const value = meta[key];
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text.slice(0, META_MAX[key]);
}

/** La IP, el navegador y el id del pedido; nada más, aunque la base mandara otra cosa. */
export function auditMetaView(meta: unknown): AdminAuditMetaView {
  const record =
    meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  return {
    ip: metaText(record, 'ip'),
    userAgent: metaText(record, 'userAgent'),
    requestId: metaText(record, 'requestId'),
  };
}

function isoOf(value: Date | string): string {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? String(value) : at.toISOString();
}

export function adminAuditEvent(row: AdminAuditRow): AdminAuditEventView {
  return {
    id: row.id,
    occurredAt: isoOf(row.occurred_at),
    eventType: row.event_type,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    actorEmail: row.actor_email,
    targetEmail: row.target_email,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: redactPayload(row.payload),
    meta: auditMetaView(row.meta),
  };
}

/** La página: se pidió `limit + 1` filas y la de más sólo dice que hay otra. */
export function adminAuditPage(rows: readonly AdminAuditRow[], limit: number): AdminAuditPage {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    events: shown.map(adminAuditEvent),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeAuditCursor({ occurredAt: last.cursor_at, id: last.id })
        : null,
  };
}

export const AUDIT_CSV_HEADER = [
  'fecha',
  'evento',
  'nodo',
  'actor',
  'entidad',
  'id_entidad',
  'ip',
] as const;

/** El nodo de un evento en el CSV: el nombre, "Plataforma" si no tiene, o que ya no existe. */
function csvNode(row: Pick<AdminAuditRow, 'tenant_id' | 'tenant_name'>): string {
  if (row.tenant_id === null) return 'Plataforma';
  return row.tenant_name ?? 'Nodo eliminado';
}

const BOGOTA_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PLATFORM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

/**
 * El instante en hora de Bogotá, ISO 8601 con su desfase (`2026-10-13T09:41:12-05:00`): lo lee una
 * persona y lo ordena cualquier planilla sin confundir la zona.
 */
export function csvInstant(value: Date | string): string {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  const parts = BOGOTA_PARTS.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  // "GMT-05:00" → "-05:00"; "GMT" (UTC) → "Z".
  const offset = part('timeZoneName').replace(/^GMT/, '') || 'Z';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

/**
 * El CSV de la exportación: fecha, evento (el código), nodo, quién lo hizo, la entidad y su id, y la
 * IP. El payload y el navegador quedan fuera: lo que sale del sistema en un archivo es lo mínimo para
 * investigar; el detalle de cada evento se mira en la consola.
 */
export function auditCsv(rows: readonly AdminAuditRow[]): string {
  const lines: CsvValue[][] = rows.map((row) => [
    csvInstant(row.occurred_at),
    row.event_type,
    csvNode(row),
    row.actor_email,
    row.aggregate_type,
    row.aggregate_id,
    auditMetaView(row.meta).ip,
  ]);
  return toCsv(AUDIT_CSV_HEADER, lines);
}

// ─────────────────────────── Filtros resueltos ───────────────────────────

/** Los filtros listos para admin_audit_events. */
export interface ResolvedAuditFilters {
  readonly period: OverviewPeriod;
  readonly include: string[] | null;
  readonly exclude: string[] | null;
  readonly eventType: string | null;
  readonly actorUserId: string | null;
  readonly root: string | null;
  readonly includePlatform: boolean;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
}

/**
 * Lo que queda en el rastro de una exportación: los filtros como se aplicaron. Quién actuó va por su
 * id, no por el correo que se escribió: si no era de nadie, sólo consta eso.
 */
export function exportedFilters(
  filters: AdminAuditFilters,
  period: OverviewPeriod,
  actorUserId: string | null,
): Record<string, unknown> {
  return {
    from: period.from,
    to: period.to,
    category: filters.category ?? null,
    eventType: filters.eventType ?? null,
    actorUserId,
    ...(filters.actorEmail !== undefined && actorUserId === null ? { actorNotFound: true } : {}),
    tenantId: filters.tenantId ?? null,
    includePlatform: filters.includePlatform ?? filters.tenantId === undefined,
    aggregateType: filters.aggregateType ?? null,
    aggregateId: filters.aggregateId ?? null,
  };
}

// ─────────────────────────── El servicio ───────────────────────────

/**
 * Plataforma → Actividad: quién hizo qué, dónde y cuándo, en toda la plataforma, con los eventos sin
 * nodo. Sólo el superadmin: la ruta pasa por SuperadminGuard y admin_audit_events (0078) lo vuelve a
 * exigir en la base (`app.current_user_id`, por eso `withRequestContext({ userId })`).
 *
 * La lista sólo lee. La exportación deja `platform.audit.exported` en la raíz `platform` en la MISMA
 * transacción que la lectura y sin tragarse el fallo (`emitWithin`): si el rastro no se escribe, no
 * sale el archivo.
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(
    actorUserId: string,
    query: AdminAuditQuery,
    now: Date = new Date(),
  ): Promise<AdminAuditPage> {
    const period = resolveAuditPeriod(query, now);
    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const resolved = await this.resolve(trx, query, period);
        // Un correo que no es de nadie no hizo nada: lista vacía, sin leer el audit log.
        if (resolved === null) return { events: [], nextCursor: null };
        const rows = await readAuditEvents(trx, resolved, query.cursor ?? null, query.limit + 1);
        return adminAuditPage(rows, query.limit);
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }

  async exportCsv(
    actorUserId: string,
    query: AdminAuditExportQuery,
    now: Date = new Date(),
  ): Promise<AdminAuditExport> {
    const period = resolveAuditPeriod(query, now);
    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const resolved = await this.resolve(trx, query, period);
        const read =
          resolved === null
            ? []
            : await readAuditEvents(trx, resolved, null, ADMIN_AUDIT_EXPORT_MAX_ROWS + 1);
        const rows = read.slice(0, ADMIN_AUDIT_EXPORT_MAX_ROWS);
        const truncated = read.length > ADMIN_AUDIT_EXPORT_MAX_ROWS;

        await this.audit.emitWithin(trx, {
          eventType: PLATFORM_AUDIT_EXPORTED_EVENT,
          tenantId: await platformTenantId(trx),
          actorUserId,
          payload: {
            filters: exportedFilters(query, period, resolved?.actorUserId ?? null),
            rows: rows.length,
            truncated,
          },
        });

        return {
          csv: auditCsv(rows),
          filename: auditExportFilename(period),
          rows: rows.length,
          truncated,
        };
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }

  /**
   * Los filtros de la query, listos: el nodo existe (404 si no), el correo es de alguien (`null` si
   * no: no hay nada que leer) y las categorías como prefijos.
   */
  private async resolve(
    trx: Transaction<DB>,
    query: AdminAuditFilters,
    period: OverviewPeriod,
  ): Promise<ResolvedAuditFilters | null> {
    const root = query.tenantId ?? null;
    if (root !== null) {
      // `tenants` no tiene RLS.
      const node = await trx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', root)
        .executeTakeFirst();
      if (node === undefined) throw new PlatformConsoleScopeNotFoundError();
    }

    let actorUserId: string | null = null;
    if (query.actorEmail !== undefined) {
      // `users` no tiene RLS; `email` es CITEXT único: exacto, sin distinguir mayúsculas.
      const actor = await trx
        .selectFrom('users')
        .select('id')
        .where('email', '=', query.actorEmail)
        .executeTakeFirst();
      if (actor === undefined) return null;
      actorUserId = actor.id;
    }

    const types = auditTypeFilter(query.category, query.eventType);
    return {
      period,
      include: types.include,
      exclude: types.exclude,
      eventType: query.eventType ?? null,
      actorUserId,
      root,
      includePlatform: query.includePlatform ?? root === null,
      aggregateType: query.aggregateType ?? null,
      aggregateId: query.aggregateId ?? null,
    };
  }
}

/**
 * Lee admin_audit_events en la transacción de quien llama, que ya puso `app.current_user_id`. Los
 * días son de Bogotá: desde el comienzo de `from` hasta el comienzo del día siguiente a `to`; los
 * instantes los calcula Postgres.
 */
export async function readAuditEvents(
  trx: Transaction<DB>,
  f: ResolvedAuditFilters,
  before: AuditCursor | null,
  limit: number,
): Promise<AdminAuditRow[]> {
  const { rows } = await sql<AdminAuditRow>`
    SELECT a.*,
           to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM admin_audit_events(
             (${f.period.from}::date::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}),
             ((${f.period.to}::date + 1)::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}),
             ${f.include}::text[],
             ${f.exclude}::text[],
             ${f.eventType}::text,
             ${f.actorUserId}::uuid,
             ${f.root}::uuid,
             ${f.includePlatform}::boolean,
             ${f.aggregateType}::text,
             ${f.aggregateId}::text,
             ${before?.occurredAt ?? null}::timestamptz,
             ${before?.id ?? null}::uuid,
             ${limit}::int
           ) a
     ORDER BY a.occurred_at DESC, a.id DESC
  `.execute(trx);
  return rows;
}

/** La raíz `platform` (0050: hay una sola), donde queda el rastro. Sin ella, sin tenant. */
async function platformTenantId(trx: Transaction<DB>): Promise<string | null> {
  const row = await trx
    .selectFrom('tenants')
    .select('id')
    .where('tenant_type', '=', 'platform')
    .executeTakeFirst();
  return row?.id ?? null;
}
