import { SEARCH_MAX_LENGTH } from './deposit-approvals';
import { isCurrencyCode, isUuid } from './wallets';
import type { WalletProxyPlan } from './wallet-proxy';

/**
 * A qué ruta del API va cada pedido de Plataforma → Aprobaciones (`/api/admin/deposit-reports/...`
 * → `/admin/deposit-reports/...`). Sin I/O.
 *
 * Sólo lectura: la cola y su contador. La query se rearma parámetro por parámetro y lo que no se
 * conoce es un 400, como en el API (estricto): un parámetro raro no viaja. Quién puede verla (sólo el
 * superadmin) lo decide el API.
 */

const NOT_FOUND: WalletProxyPlan = {
  ok: false,
  status: 404,
  error: 'Ruta de aprobaciones inválida.',
};
const BAD_FILTER = (error: string): WalletProxyPlan => ({ ok: false, status: 400, error });

const STATUSES = ['pending', 'approved', 'rejected'];
const FINANCED_BY = ['platform', 'network'];
const KNOWN = new Set(['status', 'financedBy', 'currency', 'tenantId', 'q', 'cursor', 'limit']);
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

function listPlan(search: URLSearchParams): WalletProxyPlan {
  for (const key of search.keys()) {
    if (!KNOWN.has(key)) return BAD_FILTER(`Filtro desconocido: ${key.slice(0, 40)}.`);
  }
  const out = new URLSearchParams();

  const status = search.get('status');
  if (status !== null && status !== '') {
    if (!STATUSES.includes(status)) return BAD_FILTER('Estado inválido.');
    out.set('status', status);
  }

  const financedBy = search.get('financedBy');
  if (financedBy !== null && financedBy !== '') {
    if (!FINANCED_BY.includes(financedBy)) return BAD_FILTER('Alcance inválido.');
    out.set('financedBy', financedBy);
  }

  const currency = search.get('currency')?.trim().toUpperCase();
  if (currency !== undefined && currency !== '') {
    if (!isCurrencyCode(currency)) return BAD_FILTER('Moneda inválida.');
    out.set('currency', currency);
  }

  const tenantId = search.get('tenantId');
  if (tenantId !== null && tenantId !== '') {
    if (!isUuid(tenantId)) return BAD_FILTER('Nodo inválido.');
    out.set('tenantId', tenantId.toLowerCase());
  }

  const q = search.get('q')?.trim();
  if (q !== undefined && q !== '') {
    if (q.length > SEARCH_MAX_LENGTH) return BAD_FILTER('La búsqueda es demasiado larga.');
    if (/\p{Cc}/u.test(q)) return BAD_FILTER('La búsqueda tiene caracteres no válidos.');
    out.set('q', q);
  }

  const cursor = search.get('cursor');
  if (cursor !== null && cursor !== '') {
    if (!CURSOR.test(cursor)) return BAD_FILTER('Página inválida: vuelve a cargar la lista.');
    out.set('cursor', cursor);
  }

  const limit = search.get('limit');
  if (limit !== null && limit !== '') {
    const n = Number(limit);
    if (!/^\d{1,3}$/.test(limit) || n < 1 || n > 100) {
      return BAD_FILTER('Tamaño de página inválido.');
    }
    out.set('limit', String(n));
  }

  const query = out.toString();
  return {
    ok: true,
    method: 'GET',
    path: query === '' ? '/admin/deposit-reports' : `/admin/deposit-reports?${query}`,
  };
}

/** `[]`: la cola. `['pending-count']`: el contador del menú. Nada más. */
export function depositApprovalsPlan(
  method: string,
  segments: readonly string[],
  search: URLSearchParams,
): WalletProxyPlan {
  if (method !== 'GET') {
    return { ok: false, status: 405, error: 'Operación no admitida en esta ruta.' };
  }
  if (segments.length === 0) return listPlan(search);
  if (segments.length === 1 && segments[0] === 'pending-count') {
    if ([...search.keys()].length > 0) return BAD_FILTER('El contador no lleva filtros.');
    return { ok: true, method: 'GET', path: '/admin/deposit-reports/pending-count' };
  }
  return NOT_FOUND;
}
