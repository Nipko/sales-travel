import {
  ACTIVITY_MAX_DAYS,
  AGGREGATE_ID_MAX,
  AGGREGATE_TYPE,
  EMAIL_MAX,
  EVENT_TYPE,
  isActivityCategory,
  isCalendarDay,
  spanDays,
} from './platform-audit';
import type { TenantAdminProxyTarget } from './tenant-admin-proxy';
import { isUuid } from './wallets';

/**
 * A qué ruta del API va cada pedido de Plataforma → Actividad (`/api/admin/audit` →
 * `/admin/audit`, `/api/admin/audit/export` → `/admin/audit/export`). Sin I/O.
 *
 * Sólo leen. La query se rearma parámetro por parámetro desde una lista blanca y lo que no se conoce,
 * o viene repetido, es un 400, como en el API (estricto): un parámetro raro no viaja. Quién puede
 * (sólo el superadmin) lo decide el API.
 */

const FILTERS = [
  'from',
  'to',
  'category',
  'eventType',
  'actorEmail',
  'tenantId',
  'includePlatform',
  'aggregateType',
  'aggregateId',
] as const;
const PAGE = ['cursor', 'limit'] as const;

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_LIMIT = 200;

export type AuditProxyMode = 'list' | 'export';

const bad = (error: string): TenantAdminProxyTarget => ({ ok: false, error });

/** `GET /api/admin/audit?…` o `/api/admin/audit/export?…` → el API, con la query rearmada. */
export function adminAuditTarget(
  mode: AuditProxyMode,
  search: URLSearchParams,
): TenantAdminProxyTarget {
  const known = new Set<string>(mode === 'list' ? [...FILTERS, ...PAGE] : FILTERS);
  const seen = new Set<string>();
  for (const key of search.keys()) {
    if (!known.has(key)) return bad(`Filtro desconocido: ${key.slice(0, 40)}.`);
    if (seen.has(key)) return bad(`Filtro repetido: ${key}.`);
    seen.add(key);
  }
  const value = (key: string): string | undefined => {
    const v = search.get(key)?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const out = new URLSearchParams();

  const from = value('from');
  const to = value('to');
  if (from !== undefined && !isCalendarDay(from)) return bad('Fecha "desde" inválida.');
  if (to !== undefined && !isCalendarDay(to)) return bad('Fecha "hasta" inválida.');
  if (from !== undefined && to !== undefined) {
    if (from > to) return bad('La fecha "hasta" no puede ser anterior a "desde".');
    if (spanDays(from, to) > ACTIVITY_MAX_DAYS) {
      return bad(`El período puede tener hasta ${ACTIVITY_MAX_DAYS} días.`);
    }
  }
  if (from !== undefined) out.set('from', from);
  if (to !== undefined) out.set('to', to);

  const category = value('category');
  if (category !== undefined) {
    if (!isActivityCategory(category)) return bad('Categoría inválida.');
    out.set('category', category);
  }

  const eventType = value('eventType');
  if (eventType !== undefined) {
    if (!EVENT_TYPE.test(eventType)) return bad('Tipo de evento inválido.');
    out.set('eventType', eventType);
  }

  const actorEmail = value('actorEmail');
  if (actorEmail !== undefined) {
    if (
      actorEmail.length > EMAIL_MAX ||
      /[\s\p{Cc}]/u.test(actorEmail) ||
      !actorEmail.includes('@')
    ) {
      return bad('Escribe el correo completo de quien actuó.');
    }
    out.set('actorEmail', actorEmail.toLowerCase());
  }

  const tenantId = value('tenantId');
  if (tenantId !== undefined) {
    if (!isUuid(tenantId)) return bad('Nodo inválido.');
    out.set('tenantId', tenantId.toLowerCase());
  }

  const includePlatform = value('includePlatform');
  if (includePlatform !== undefined) {
    if (includePlatform !== 'true' && includePlatform !== 'false') {
      return bad('Valor inválido para los eventos de la plataforma.');
    }
    out.set('includePlatform', includePlatform);
  }

  const aggregateType = value('aggregateType');
  const aggregateId = value('aggregateId');
  if (aggregateType !== undefined) {
    if (!AGGREGATE_TYPE.test(aggregateType)) return bad('Entidad inválida.');
    out.set('aggregateType', aggregateType);
  }
  if (aggregateId !== undefined) {
    if (aggregateId.length > AGGREGATE_ID_MAX || /\p{Cc}/u.test(aggregateId)) {
      return bad('Id de la entidad inválido.');
    }
    out.set('aggregateId', aggregateId);
  }

  if (mode === 'list') {
    const cursor = value('cursor');
    if (cursor !== undefined) {
      if (!CURSOR.test(cursor)) return bad('Página inválida.');
      out.set('cursor', cursor);
    }
    const limit = value('limit');
    if (limit !== undefined) {
      const n = Number(limit);
      if (!/^\d{1,3}$/.test(limit) || n < 1 || n > MAX_LIMIT) return bad('Límite inválido.');
      out.set('limit', String(n));
    }
  }

  const base = mode === 'list' ? '/admin/audit' : '/admin/audit/export';
  const query = out.toString();
  return { ok: true, path: query === '' ? base : `${base}?${query}` };
}
