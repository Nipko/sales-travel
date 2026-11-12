import type { Tone } from './wallets';

/**
 * Plataforma → Salud (0095): cómo respondieron los proveedores a las búsquedas. La regla del estado
 * vive en el API (`provider-health.fold.ts`); aquí sólo se valida y se rotula.
 */

export type ProviderHealthStatus = 'down' | 'degraded' | 'ok' | 'idle';

export interface ProviderHealth {
  readonly providerCode: string;
  readonly vertical: string;
  readonly status: ProviderHealthStatus;
  readonly reason: string;
  readonly searches: number;
  readonly withResults: number;
  readonly empty: number;
  readonly errors: number;
  readonly recentSearches: number;
  readonly recentWithResults: number;
  readonly hitRate: number | null;
  readonly avgDurationMs: number | null;
  readonly p95DurationMs: number | null;
  readonly lastSearchAt: string | null;
  readonly lastResultAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface ProviderHealthView {
  readonly generatedAt: string;
  readonly periodDays: number;
  readonly recentHours: number;
  readonly providers: readonly ProviderHealth[];
}

const STATUSES: readonly ProviderHealthStatus[] = ['down', 'degraded', 'ok', 'idle'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Valida lo que llega del API; `undefined` si no tiene la forma esperada. */
export function parseProviderHealth(body: unknown): ProviderHealthView | undefined {
  if (!isRecord(body) || !Array.isArray(body['providers'])) return undefined;
  const providers: ProviderHealth[] = [];
  for (const raw of body['providers'] as unknown[]) {
    if (!isRecord(raw)) return undefined;
    const status = raw['status'];
    if (typeof raw['providerCode'] !== 'string' || typeof raw['vertical'] !== 'string') {
      return undefined;
    }
    if (typeof status !== 'string' || !STATUSES.includes(status as ProviderHealthStatus)) {
      return undefined;
    }
    providers.push({
      providerCode: raw['providerCode'],
      vertical: raw['vertical'],
      status: status as ProviderHealthStatus,
      reason: typeof raw['reason'] === 'string' ? raw['reason'] : '',
      searches: numOrNull(raw['searches']) ?? 0,
      withResults: numOrNull(raw['withResults']) ?? 0,
      empty: numOrNull(raw['empty']) ?? 0,
      errors: numOrNull(raw['errors']) ?? 0,
      recentSearches: numOrNull(raw['recentSearches']) ?? 0,
      recentWithResults: numOrNull(raw['recentWithResults']) ?? 0,
      hitRate: numOrNull(raw['hitRate']),
      avgDurationMs: numOrNull(raw['avgDurationMs']),
      p95DurationMs: numOrNull(raw['p95DurationMs']),
      lastSearchAt: strOrNull(raw['lastSearchAt']),
      lastResultAt: strOrNull(raw['lastResultAt']),
      lastErrorCode: strOrNull(raw['lastErrorCode']),
    });
  }
  return {
    generatedAt: typeof body['generatedAt'] === 'string' ? body['generatedAt'] : '',
    periodDays: numOrNull(body['periodDays']) ?? 7,
    recentHours: numOrNull(body['recentHours']) ?? 24,
    providers,
  };
}

export const HEALTH_TONE: Readonly<Record<ProviderHealthStatus, Tone>> = {
  down: 'danger',
  degraded: 'warning',
  ok: 'success',
  idle: 'neutral',
};

export const HEALTH_LABEL: Readonly<Record<ProviderHealthStatus, string>> = {
  down: 'Sin resultados',
  degraded: 'Degradado',
  ok: 'Funcionando',
  idle: 'Sin uso',
};

export function verticalLabel(vertical: string): string {
  if (vertical === 'flights') return 'Vuelos';
  if (vertical === 'hotels') return 'Hoteles';
  if (vertical === 'cars') return 'Autos';
  return vertical;
}

/** «9,5 s», «850 ms». */
export function durationLabel(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000
    ? `${(ms / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} s`
    : `${String(Math.round(ms))} ms`;
}

/** «hace 3 h», «hace 20 días», «nunca». */
export function agoLabel(at: string | null, now: number): string {
  if (at === null) return 'nunca';
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 60) return minutes <= 1 ? 'hace un momento' : `hace ${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `hace ${String(hours)} h`;
  return `hace ${String(Math.round(hours / 24))} días`;
}
