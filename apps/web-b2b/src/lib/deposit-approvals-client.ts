import {
  PENDING_DEPOSITS_CHANGED,
  approvalsErrorMessage,
  approvalsSearch,
  parseDepositApprovals,
  parsePendingDeposits,
  type ApprovalsFilters,
  type DepositApprovals,
  type PendingDeposits,
} from './deposit-approvals';
import { readJson } from './read-json';

/**
 * Las llamadas del navegador a Plataforma → Carteras (`/api/admin/deposit-reports`). Devuelven
 * datos ya validados o un mensaje para la pantalla; nunca lanzan.
 */

export type ApprovalsResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';

async function read<T>(
  url: string,
  parse: (value: unknown) => T | undefined,
): Promise<ApprovalsResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, message: OFFLINE };
  }
  const body = await readJson<unknown>(res);
  if (!body.ok) return { ok: false, status: res.status, message: body.message };
  if (!res.ok) {
    const error =
      typeof body.data === 'object' && body.data !== null
        ? (body.data as Record<string, unknown>)['error']
        : undefined;
    return {
      ok: false,
      status: res.status,
      message:
        typeof error === 'string' && error.trim() !== ''
          ? error
          : approvalsErrorMessage(res.status),
    };
  }
  const data = parse(body.data);
  return data === undefined
    ? { ok: false, status: res.status, message: UNREADABLE }
    : { ok: true, data };
}

/** Una página de la cola con estos filtros; `cursor` para la siguiente. */
export function loadDepositApprovals(
  filters: ApprovalsFilters,
  cursor?: string | null,
): Promise<ApprovalsResult<DepositApprovals>> {
  return read(
    `/api/admin/deposit-reports?${approvalsSearch(filters, cursor)}`,
    parseDepositApprovals,
  );
}

/** Cuántos esperan aprobación: lo de Planetour y lo del resto de la red. */
export function loadPendingDeposits(): Promise<ApprovalsResult<PendingDeposits>> {
  return read('/api/admin/deposit-reports/pending-count', parsePendingDeposits);
}

/** Avisa al contador del menú que algo se resolvió. */
export function notifyPendingDepositsChanged(): void {
  window.dispatchEvent(new Event(PENDING_DEPOSITS_CHANGED));
}
