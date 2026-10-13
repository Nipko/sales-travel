import { parseDepositApprovals } from './deposit-approvals';
import {
  overviewErrorMessage,
  overviewSearch,
  parsePlatformOverview,
  type OverviewPeriodKey,
  type PlatformOverview,
} from './platform-overview';
import { readJson } from './read-json';

/**
 * Las llamadas del navegador a Plataforma → Resumen (`/api/admin/overview`). Devuelven datos ya
 * validados o un mensaje para la pantalla; nunca lanzan.
 */

export type OverviewResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

async function read<T>(
  url: string,
  parse: (value: unknown) => T | undefined,
): Promise<OverviewResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, message: OFFLINE };
  }
  const body = await readJson<unknown>(res);
  if (!body.ok) return { ok: false, status: res.status, message: body.message };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: overviewErrorMessage(res.status, errorOf(body.data)),
    };
  }
  const data = parse(body.data);
  return data === undefined
    ? { ok: false, status: res.status, message: UNREADABLE }
    : { ok: true, data };
}

/** El Resumen de este período, de toda la red o del subárbol de `tenantId`. */
export function loadPlatformOverview(
  period: OverviewPeriodKey,
  tenantId: string | null,
): Promise<OverviewResult<PlatformOverview>> {
  return read(`/api/admin/overview?${overviewSearch(period, tenantId)}`, parsePlatformOverview);
}

/**
 * Cuándo se informó el depósito más viejo que espera a Planetour: la cola de pendientes va del más
 * antiguo al más nuevo, así que basta el primero. `null` si no hay; `undefined` si no se pudo leer
 * (la tarjeta sale igual, sin la antigüedad).
 */
export async function loadOldestPlatformDeposit(
  tenantId: string | null,
): Promise<string | null | undefined> {
  const params = new URLSearchParams({ status: 'pending', financedBy: 'platform', limit: '1' });
  if (tenantId !== null) params.set('tenantId', tenantId);
  const res = await read(`/api/admin/deposit-reports?${params.toString()}`, parseDepositApprovals);
  if (!res.ok) return undefined;
  return res.data.reports[0]?.reportedAt ?? null;
}
