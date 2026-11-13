/**
 * El estado de los proveedores que ve la AGENCIA (0096): si el proveedor está fallando y de quién
 * depende. Más simple que Salud (0095): sin cifras, sólo el estado y la frase.
 */

export interface ProviderStatusRow {
  provider_code: string;
  vertical: string;
  recent_searches: string | number;
  recent_with_results: string | number;
  provider_errors: string | number;
  internal_errors: string | number;
  last_result_at: Date | string | null;
}

/**
 * - `ok`: respondiendo.
 * - `provider`: falla del proveedor (no depende de nosotros).
 * - `paused`: pausado por la plataforma (decisión nuestra, a propósito).
 * - `internal`: falla nuestra.
 * - `idle`: sin búsquedas recientes en la red.
 */
export type ProviderStatusKind = 'ok' | 'provider' | 'paused' | 'internal' | 'idle';

export interface ProviderStatus {
  providerCode: string;
  vertical: string;
  status: ProviderStatusKind;
  message: string;
  lastResultAt: string | null;
}

const MIN_RECENT = 3;

function n(value: string | number): number {
  const v = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(v) ? v : 0;
}

export function foldProviderStatus(
  row: ProviderStatusRow,
  paused: { reason?: string } | undefined,
): ProviderStatus {
  const recent = n(row.recent_searches);
  const withResults = n(row.recent_with_results);
  const providerErrors = n(row.provider_errors);
  const internalErrors = n(row.internal_errors);
  const lastResultAt =
    row.last_result_at === null ? null : new Date(row.last_result_at).toISOString();

  const base = { providerCode: row.provider_code, vertical: row.vertical, lastResultAt };
  if (paused) {
    return {
      ...base,
      status: 'paused',
      message: 'Pausado por Planetour mientras se revisa. No depende de tu agencia.',
    };
  }
  if (recent >= MIN_RECENT && internalErrors / recent > 0.3) {
    return {
      ...base,
      status: 'internal',
      message: 'Falla de nuestra plataforma con este proveedor. Ya lo estamos revisando.',
    };
  }
  if (recent >= MIN_RECENT && withResults === 0) {
    return {
      ...base,
      status: 'provider',
      message: 'El proveedor no está devolviendo resultados. No depende de nosotros.',
    };
  }
  if (recent >= MIN_RECENT && (providerErrors / recent > 0.3 || withResults / recent < 0.3)) {
    return {
      ...base,
      status: 'provider',
      message: 'El proveedor está respondiendo con fallas. Puede que veas menos resultados.',
    };
  }
  if (recent === 0) {
    return { ...base, status: 'idle', message: 'Sin búsquedas recientes en la red.' };
  }
  return { ...base, status: 'ok', message: 'Respondiendo con normalidad.' };
}
