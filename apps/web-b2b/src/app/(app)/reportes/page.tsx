import { api } from '../../../lib/api';
import { parseSalesMetrics } from '../../../lib/sales-reports';
import { ReportesClient } from './ReportesClient';

/**
 * Reportes de ventas de la agencia activa. Sólo datos reales: si el API no responde, o responde algo
 * que no se entiende, se dice, y no se dibujan ceros (un cero es un dato, y sería falso).
 */
export default async function ReportesPage() {
  const res = await api<unknown>('/reports/sales-metrics');
  const metrics = res.ok ? (parseSalesMetrics(res.data) ?? null) : null;
  return <ReportesClient metrics={metrics} error={metrics === null ? loadError(res) : null} />;
}

function loadError(res: { ok: true } | { ok: false; error: { status: number } }): string {
  if (!res.ok && res.error.status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (!res.ok && res.error.status === 403) {
    return 'Tu rol en esta agencia no puede ver los reportes.';
  }
  return 'No pudimos cargar tus reportes. Reintenta en unos segundos.';
}
