import { isOverviewPeriod, periodDates, DEFAULT_OVERVIEW_PERIOD } from './platform-overview';
import type { WalletProxyPlan } from './wallet-proxy';
import { isUuid } from './wallets';

/**
 * A qué ruta del API va el pedido de Plataforma → Resumen (`/api/admin/overview` →
 * `/admin/overview`). Sin I/O.
 *
 * La pantalla pide un período con nombre (hoy, 7 días, 30 días, este mes) y aquí se traduce a los días
 * de Bogotá que entiende el API: así "hoy" es el de la plataforma y no el del reloj del navegador.
 * La query se rearma parámetro por parámetro y lo que no se conoce es un 400, como en el API
 * (estricto). Quién puede verlo (sólo el superadmin) lo decide el API.
 */

const BAD_REQUEST = (error: string): WalletProxyPlan => ({ ok: false, status: 400, error });

const KNOWN = new Set(['period', 'tenantId']);

export function overviewPlan(method: string, search: URLSearchParams, now: Date): WalletProxyPlan {
  if (method !== 'GET') {
    return { ok: false, status: 405, error: 'Operación no admitida en esta ruta.' };
  }
  for (const key of search.keys()) {
    if (!KNOWN.has(key)) return BAD_REQUEST(`Filtro desconocido: ${key.slice(0, 40)}.`);
  }

  const rawPeriod = search.get('period');
  const period = rawPeriod === null || rawPeriod === '' ? DEFAULT_OVERVIEW_PERIOD : rawPeriod;
  if (!isOverviewPeriod(period)) {
    return BAD_REQUEST('Período inválido: elige hoy, 7 días, 30 días o este mes.');
  }
  const { from, to } = periodDates(period, now);
  const out = new URLSearchParams({ from, to });

  const tenantId = search.get('tenantId');
  if (tenantId !== null && tenantId !== '') {
    if (!isUuid(tenantId)) return BAD_REQUEST('Nodo inválido.');
    out.set('tenantId', tenantId.toLowerCase());
  }

  return { ok: true, method: 'GET', path: `/admin/overview?${out.toString()}` };
}
