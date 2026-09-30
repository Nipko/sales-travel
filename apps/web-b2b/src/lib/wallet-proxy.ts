import type { ApiResponse } from './api';
import { isCurrencyCode, isUuid } from './wallets';

/**
 * A qué ruta del API va cada pedido de carteras del navegador, y con qué cuerpo. Sin I/O, para
 * probar el borde sin levantar Next.
 *
 * Dos proxies: el de quien financia a un nodo (`/api/tenants/:id/portfolios/...` →
 * `/tenants/:id/portfolios/...`) y el de la agencia sobre sus propias carteras (`/api/portfolios/...`
 * → `/portfolios/...`). Sólo pasan las rutas que existen: un segmento raro no compone otra ruta
 * del API. El cuerpo se rearma campo por campo (el API rechaza campos de más con `.strict()`), y la
 * `Idempotency-Key` viaja en los movimientos que la exigen. Quién puede qué lo decide el API.
 */

export type WalletProxyPlan =
  | {
      readonly ok: true;
      readonly path: string;
      readonly method: 'GET' | 'POST' | 'PATCH';
      readonly body?: Readonly<Record<string, unknown>>;
      readonly idempotencyKey?: string;
    }
  | { readonly ok: false; readonly status: 400 | 404 | 405; readonly error: string };

export interface WalletProxyRequest {
  readonly method: string;
  readonly segments: readonly string[];
  readonly search: URLSearchParams;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
}

const NOT_FOUND: WalletProxyPlan = { ok: false, status: 404, error: 'Ruta de carteras inválida.' };
const BAD_METHOD: WalletProxyPlan = {
  ok: false,
  status: 405,
  error: 'Operación no admitida en esta ruta.',
};
const UNREADABLE: WalletProxyPlan = {
  ok: false,
  status: 400,
  error: 'El pedido no se pudo leer. Recargá la página e intentá de nuevo.',
};
const MISSING_KEY: WalletProxyPlan = {
  ok: false,
  status: 400,
  error: 'No pudimos identificar este movimiento. Cerrá el formulario y volvé a cargarlo.',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Copia sólo los campos conocidos y con el tipo que el API espera; el resto lo valida el API. */
function pick(
  raw: unknown,
  fields: Readonly<Record<string, 'string' | 'integer' | 'nullable-string'>>,
): Record<string, unknown> | undefined {
  const input = asRecord(raw);
  if (input === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(fields)) {
    const value = input[name];
    if (value === undefined) continue;
    if (kind === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) {
      out[name] = value;
    } else if (kind === 'string' && typeof value === 'string') {
      out[name] = value;
    } else if (kind === 'nullable-string' && (value === null || typeof value === 'string')) {
      out[name] = value;
    } else {
      return undefined;
    }
  }
  return out;
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s === '' ? path : `${path}?${s}`;
}

/** `?currency=USD`: sólo un código de tres letras; otra cosa es un pedido roto. */
function currencyQuery(search: URLSearchParams): string | undefined | null {
  const c = search.get('currency');
  if (c === null || c === '') return undefined;
  return isCurrencyCode(c) ? c : null;
}

function statusQuery(search: URLSearchParams): string | undefined | null {
  const s = search.get('status');
  if (s === null || s === '') return undefined;
  return s === 'pending' || s === 'approved' || s === 'rejected' ? s : null;
}

/** `?status=held`: los estados de una retención de la red (0060). */
function networkStatusQuery(search: URLSearchParams): string | undefined | null {
  const s = search.get('status');
  if (s === null || s === '') return undefined;
  return s === 'held' || s === 'captured' || s === 'released' || s === 'conflict' ? s : null;
}

type ListKind = 'transactions' | 'deposit-reports' | 'network-holds';

function isListKind(value: string | undefined): value is ListKind {
  return value === 'transactions' || value === 'deposit-reports' || value === 'network-holds';
}

function listPlan(base: string, kind: ListKind, search: URLSearchParams): WalletProxyPlan {
  if (kind === 'transactions') {
    const currency = currencyQuery(search);
    if (currency === null) return { ok: false, status: 400, error: 'Moneda inválida.' };
    return { ok: true, method: 'GET', path: withQuery(`${base}/transactions`, { currency }) };
  }
  if (kind === 'network-holds') {
    const currency = currencyQuery(search);
    if (currency === null) return { ok: false, status: 400, error: 'Moneda inválida.' };
    const status = networkStatusQuery(search);
    if (status === null) return { ok: false, status: 400, error: 'Estado inválido.' };
    return {
      ok: true,
      method: 'GET',
      path: withQuery(`${base}/network-holds`, { currency, status }),
    };
  }
  const status = statusQuery(search);
  if (status === null) return { ok: false, status: 400, error: 'Estado inválido.' };
  return { ok: true, method: 'GET', path: withQuery(`${base}/deposit-reports`, { status }) };
}

function keyOf(raw: string | null): string | undefined {
  const k = raw?.trim();
  return isUuid(k) ? k.toLowerCase() : undefined;
}

const REASON = { reason: 'string' } as const;

/** Lo que manda quien financia a un nodo. */
export function walletFinancingPlan(tenantId: string, req: WalletProxyRequest): WalletProxyPlan {
  if (!isUuid(tenantId)) return NOT_FOUND;
  const base = `/tenants/${tenantId.toLowerCase()}/portfolios`;
  const [first, second, third, ...rest] = req.segments;
  if (rest.length > 0) return NOT_FOUND;

  // /tenants/:id/portfolios
  if (first === undefined) {
    if (req.method === 'GET') return { ok: true, method: 'GET', path: base };
    if (req.method !== 'POST') return BAD_METHOD;
    const body = pick(req.body, { currency: 'string', creditLimitMinor: 'integer', ...REASON });
    return body === undefined ? UNREADABLE : { ok: true, method: 'POST', path: base, body };
  }

  // Listados
  if (isListKind(first) && second === undefined) {
    return req.method === 'GET' ? listPlan(base, first, req.search) : BAD_METHOD;
  }

  // /deposit-reports/:reportId/approve|reject
  if (first === 'deposit-reports') {
    if (!isUuid(second) || (third !== 'approve' && third !== 'reject')) return NOT_FOUND;
    if (req.method !== 'POST') return BAD_METHOD;
    const body =
      third === 'approve'
        ? pick(req.body ?? {}, { reason: 'nullable-string' })
        : pick(req.body, REASON);
    if (body === undefined) return UNREADABLE;
    return {
      ok: true,
      method: 'POST',
      path: `${base}/deposit-reports/${second.toLowerCase()}/${third}`,
      body,
    };
  }

  // /:portfolioId y /:portfolioId/deposits|adjustments
  if (!isUuid(first)) return NOT_FOUND;
  const walletPath = `${base}/${first.toLowerCase()}`;
  if (second === undefined) {
    if (req.method !== 'PATCH') return BAD_METHOD;
    const body = pick(req.body, { creditLimitMinor: 'integer', status: 'string', ...REASON });
    return body === undefined ? UNREADABLE : { ok: true, method: 'PATCH', path: walletPath, body };
  }
  if ((second !== 'deposits' && second !== 'adjustments') || third !== undefined) return NOT_FOUND;
  if (req.method !== 'POST') return BAD_METHOD;
  const idempotencyKey = keyOf(req.idempotencyKey);
  if (idempotencyKey === undefined) return MISSING_KEY;
  const body = pick(req.body, { amountMinor: 'integer', ...REASON });
  if (body === undefined) return UNREADABLE;
  return { ok: true, method: 'POST', path: `${walletPath}/${second}`, body, idempotencyKey };
}

/**
 * Lo que manda la agencia sobre sus propias carteras: leer (también las reservas de su red, 0060) e
 * informar depósitos.
 */
export function agencyWalletPlan(req: WalletProxyRequest): WalletProxyPlan {
  const [first, second] = req.segments;
  if (second !== undefined) return NOT_FOUND;
  if (first === undefined) {
    return req.method === 'GET' ? { ok: true, method: 'GET', path: '/portfolios' } : BAD_METHOD;
  }
  if (first === 'transactions' || first === 'network-holds') {
    return req.method === 'GET' ? listPlan('/portfolios', first, req.search) : BAD_METHOD;
  }
  if (first !== 'deposit-reports') return NOT_FOUND;
  if (req.method === 'GET') return listPlan('/portfolios', first, req.search);
  if (req.method !== 'POST') return BAD_METHOD;
  const idempotencyKey = keyOf(req.idempotencyKey);
  if (idempotencyKey === undefined) return MISSING_KEY;
  const body = pick(req.body, {
    currency: 'string',
    amountMinor: 'integer',
    reference: 'string',
    depositedOn: 'nullable-string',
    notes: 'nullable-string',
  });
  if (body === undefined) return UNREADABLE;
  return { ok: true, method: 'POST', path: '/portfolios/deposit-reports', body, idempotencyKey };
}

export interface WalletProxyReply {
  readonly status: number;
  readonly body: unknown;
}

const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_MESSAGE = 500;

/**
 * Lo que vuelve al navegador. En éxito, el cuerpo del API tal cual. En error, sólo el mensaje (ya
 * en castellano, lo escribe el API) y el motivo máquina: la pantalla decide con el motivo y no
 * interpretando el texto.
 */
export function walletProxyReply(res: ApiResponse): WalletProxyReply {
  if (res.kind !== 'json') return { status: res.status, body: { error: res.message } };
  if (res.status < 400) return { status: res.status, body: res.body };
  const r = asRecord(res.body);
  const message = r?.['message'];
  const reason = r?.['reason'];
  const text = Array.isArray(message)
    ? message.filter((m): m is string => typeof m === 'string').join('. ')
    : typeof message === 'string'
      ? message
      : '';
  return {
    status: res.status,
    body: {
      error: text.trim() === '' || text.length > MAX_MESSAGE ? '' : text.trim(),
      ...(typeof reason === 'string' && MACHINE_REASON.test(reason) ? { reason } : {}),
    },
  };
}

export function planFailureReply(plan: Extract<WalletProxyPlan, { ok: false }>): WalletProxyReply {
  return { status: plan.status, body: { error: plan.error } };
}
