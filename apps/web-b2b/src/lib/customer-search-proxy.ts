import type { ApiResponse } from './api';
import type { CustomerUpsertBody } from './billing-crm';
import { CUSTOMER_SEARCH_MAX_CHARS, CUSTOMER_SEARCH_MIN_CHARS } from './customer-search';

/*
 * Proxies del panel para el CRM desde el checkout de vuelos:
 * - `GET  /api/customers/search?q=&limit=` → `GET  /customers/search`
 * - `POST /api/customers/upsert`           → `POST /customers/upsert`
 *
 * La consulta y el cuerpo se rearman campo por campo: al API sólo llega lo que se espera. El
 * estado y el cuerpo de la respuesta pasan completos, para que un 400 llegue con su texto.
 */

export interface CustomerProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

export const CUSTOMER_SEARCH_INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message: `Escribe al menos ${CUSTOMER_SEARCH_MIN_CHARS} letras para buscar.`,
} as const;

export const CUSTOMER_UPSERT_INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'Faltan datos para guardar el cliente.',
} as const;

export const CUSTOMER_PROXY_UNREADABLE =
  'No pudimos consultar Clientes. Vuelve a intentarlo en unos minutos.';

function unreadable(res: ApiResponse): CustomerProxyReply {
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: CUSTOMER_PROXY_UNREADABLE } };
}

/** `q` y `limit` de la URL del panel → la consulta del API, o `null` si no alcanza. */
export function customerSearchQuery(params: URLSearchParams): string | null {
  const q = (params.get('q') ?? '').trim().replace(/\s+/g, ' ');
  if (q.length < CUSTOMER_SEARCH_MIN_CHARS || q.length > CUSTOMER_SEARCH_MAX_CHARS) return null;
  const rawLimit = Number(params.get('limit') ?? '10');
  const limit = Number.isInteger(rawLimit) ? Math.min(25, Math.max(1, rawLimit)) : 10;
  return new URLSearchParams({ q, limit: String(limit) }).toString();
}

export async function proxyCustomerSearch(
  params: URLSearchParams,
  call: ApiCall,
): Promise<CustomerProxyReply> {
  const query = customerSearchQuery(params);
  if (query === null) return { status: 400, body: CUSTOMER_SEARCH_INVALID };
  const res = await call(`/customers/search?${query}`, { method: 'GET' });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  return unreadable(res);
}

const LIMITS = {
  firstName: 120,
  lastName: 120,
  documentType: 30,
  documentNumber: 60,
  documentIssuingCountry: 60,
  email: 200,
  phone: 40,
  birthdate: 40,
  gender: 20,
  nationality: 60,
  passportExpiry: 40,
  address: 300,
  city: 120,
  countryCode: 2,
} as const;

type TextField = keyof typeof LIMITS;

const REQUIRED: readonly TextField[] = [
  'firstName',
  'documentType',
  'documentNumber',
  'documentIssuingCountry',
];
const OPTIONAL: readonly TextField[] = [
  'email',
  'phone',
  'birthdate',
  'gender',
  'nationality',
  'passportExpiry',
  'address',
  'city',
  'countryCode',
];

/**
 * El cuerpo del navegador → el del API, sólo con los campos de un cliente. `null` si falta algo
 * indispensable o un campo no es texto. El API valida el resto (correo, fechas, persona).
 */
export function customerUpsertBody(raw: unknown): CustomerUpsertBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const read = (field: TextField): string | null | undefined => {
    const v = r[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length <= LIMITS[field] ? t : null;
  };
  const customerType =
    r['customerType'] === 'company'
      ? 'company'
      : r['customerType'] === undefined || r['customerType'] === 'person'
        ? 'person'
        : null;
  if (customerType === null) return null;
  const out: Record<string, string> = {};
  for (const field of REQUIRED) {
    const v = read(field);
    if (!v) return null;
    out[field] = v;
  }
  const lastName = read('lastName');
  if (lastName === null) return null;
  for (const field of OPTIONAL) {
    const v = read(field);
    if (v === null) return null;
    if (v) out[field] = v;
  }
  return {
    customerType,
    firstName: out['firstName']!,
    lastName: customerType === 'company' ? '' : (lastName ?? ''),
    documentType: out['documentType']!,
    documentNumber: out['documentNumber']!,
    documentIssuingCountry: out['documentIssuingCountry']!,
    ...Object.fromEntries(OPTIONAL.filter((f) => out[f] !== undefined).map((f) => [f, out[f]])),
  };
}

export async function proxyCustomerUpsert(
  req: Request,
  call: ApiCall,
): Promise<CustomerProxyReply> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: CUSTOMER_UPSERT_INVALID };
  }
  const body = customerUpsertBody(raw);
  if (body === null) return { status: 400, body: CUSTOMER_UPSERT_INVALID };
  const res = await call('/customers/upsert', { method: 'POST', body: JSON.stringify(body) });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  return unreadable(res);
}
