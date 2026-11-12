/**
 * Plataforma → Salud (0095): el estado de cada proveedor según cómo respondió a las búsquedas.
 *
 * Es la pantalla que habría visto el corte de TBO el primer día: desde el 29 oct devolvía «No
 * Available rooms» a todo y sólo se notó leyendo la base a mano (docs/platform/18).
 */

export interface ProviderSearchHealthRow {
  provider_code: string;
  vertical: string;
  searches: string | number;
  with_results: string | number;
  empty_searches: string | number;
  error_searches: string | number;
  recent_searches: string | number;
  recent_with_results: string | number;
  avg_duration_ms: string | number | null;
  p95_duration_ms: string | number | null;
  last_search_at: Date | string | null;
  last_result_at: Date | string | null;
  last_error_code: string | null;
}

export type ProviderHealthStatus = 'down' | 'degraded' | 'ok' | 'idle';

export interface ProviderHealth {
  providerCode: string;
  vertical: string;
  status: ProviderHealthStatus;
  /** Por qué ese estado, en una frase para el superadmin. */
  reason: string;
  searches: number;
  withResults: number;
  empty: number;
  errors: number;
  recentSearches: number;
  recentWithResults: number;
  /** Porcentaje de búsquedas con resultados en el período (0-100), o null sin búsquedas. */
  hitRate: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  lastSearchAt: string | null;
  lastResultAt: string | null;
  lastErrorCode: string | null;
}

/** Con al menos esto de búsquedas recientes sin un solo resultado, el proveedor está caído. */
export const HEALTH_DOWN_MIN_RECENT = 3;
/** Debajo de este porcentaje de búsquedas con resultados, degradado. */
export const HEALTH_DEGRADED_HIT_RATE = 30;
/** Por encima de este porcentaje de errores, degradado. */
export const HEALTH_DEGRADED_ERROR_RATE = 20;

function num(value: string | number | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function daysAgo(at: string | null, now: Date): string {
  if (at === null) return 'nunca';
  const days = Math.floor((now.getTime() - Date.parse(at)) / 86_400_000);
  if (days <= 0) return 'hoy';
  return days === 1 ? 'hace 1 día' : `hace ${String(days)} días`;
}

export function foldProviderHealth(
  row: ProviderSearchHealthRow,
  recentHours: number,
  now: Date,
): ProviderHealth {
  const searches = num(row.searches);
  const withResults = num(row.with_results);
  const errors = num(row.error_searches);
  const recentSearches = num(row.recent_searches);
  const recentWithResults = num(row.recent_with_results);
  const lastResultAt = iso(row.last_result_at);
  const hitRate = searches > 0 ? Math.round((withResults / searches) * 100) : null;
  const errorRate = searches > 0 ? Math.round((errors / searches) * 100) : 0;

  let status: ProviderHealthStatus;
  let reason: string;
  if (recentSearches === 0) {
    status = 'idle';
    reason = `Sin búsquedas en las últimas ${String(recentHours)} h.`;
  } else if (recentSearches >= HEALTH_DOWN_MIN_RECENT && recentWithResults === 0) {
    status = 'down';
    reason = `${String(recentSearches)} búsquedas en las últimas ${String(recentHours)} h y ninguna trajo resultados. Último resultado: ${daysAgo(lastResultAt, now)}.`;
  } else if (errorRate > HEALTH_DEGRADED_ERROR_RATE) {
    status = 'degraded';
    reason = `${String(errorRate)}% de las búsquedas terminan en error${row.last_error_code ? ` (último: ${row.last_error_code})` : ''}.`;
  } else if (hitRate !== null && hitRate < HEALTH_DEGRADED_HIT_RATE) {
    status = 'degraded';
    reason = `Sólo ${String(hitRate)}% de las búsquedas traen resultados.`;
  } else {
    status = 'ok';
    reason = `${String(hitRate ?? 0)}% de las búsquedas traen resultados.`;
  }

  const avg = row.avg_duration_ms === null ? null : num(row.avg_duration_ms);
  const p95 = row.p95_duration_ms === null ? null : num(row.p95_duration_ms);
  return {
    providerCode: row.provider_code,
    vertical: row.vertical,
    status,
    reason,
    searches,
    withResults,
    empty: num(row.empty_searches),
    errors,
    recentSearches,
    recentWithResults,
    hitRate,
    avgDurationMs: avg,
    p95DurationMs: p95,
    lastSearchAt: iso(row.last_search_at),
    lastResultAt,
    lastErrorCode: row.last_error_code,
  };
}

const ORDER: Record<ProviderHealthStatus, number> = { down: 0, degraded: 1, ok: 2, idle: 3 };

/** Lo que necesita atención primero. */
export function sortProviderHealth(rows: readonly ProviderHealth[]): ProviderHealth[] {
  return [...rows].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      a.vertical.localeCompare(b.vertical) ||
      a.providerCode.localeCompare(b.providerCode),
  );
}
