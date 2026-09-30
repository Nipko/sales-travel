import { readJson } from './read-json';
import { walletProxyReply, type WalletProxyReply } from './wallet-proxy';
import type { ApiResponse } from './api';

/*
 * "Puede reservar tarifas no reembolsables", que fija quien financia a cada nodo (pedido del founder
 * del 2026-09-29, punto e; db/migrations/0055): el contrato de `GET/PUT
 * /tenants/:tenantId/booking-permissions`, lo que la ruta proxy reenvía y las llamadas del panel.
 */

export type NonRefundableRatesSetting = 'allowed' | 'blocked';

export interface BookingPermissionsView {
  readonly tenant: { readonly id: string; readonly name: string };
  readonly nonRefundableRates: {
    /** Lo que se fijó para ESTE nodo (sin fijar, `allowed`). */
    readonly setting: NonRefundableRatesSetting;
    /** Lo que rige: `blocked` también si lo bloquea un nivel de arriba. */
    readonly effective: NonRefundableRatesSetting;
    readonly inheritedBlock: boolean;
    readonly updatedAt: string | null;
    readonly updatedByName: string | null;
  };
}

export interface UpdateBookingPermissionsBody {
  readonly nonRefundableRates: NonRefundableRatesSetting;
  readonly reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REASON_MIN = 3;
export const REASON_MAX = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingOf(value: unknown): NonRefundableRatesSetting | undefined {
  return value === 'allowed' || value === 'blocked' ? value : undefined;
}

/** La respuesta del API, o `undefined` si no se entiende: sin ella no se ofrece cambiar nada. */
export function parseBookingPermissions(value: unknown): BookingPermissionsView | undefined {
  if (!isRecord(value) || !isRecord(value['tenant']) || !isRecord(value['nonRefundableRates'])) {
    return undefined;
  }
  const { id, name } = value['tenant'];
  const nr = value['nonRefundableRates'];
  const setting = settingOf(nr['setting']);
  const effective = settingOf(nr['effective']);
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  if (setting === undefined || effective === undefined) return undefined;
  const at = nr['updatedAt'];
  const by = nr['updatedByName'];
  return {
    tenant: { id, name },
    nonRefundableRates: {
      setting,
      effective,
      inheritedBlock: nr['inheritedBlock'] === true,
      updatedAt: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null,
      updatedByName: typeof by === 'string' && by.trim() !== '' ? by : null,
    },
  };
}

/** El motivo del cambio: obligatorio, como en las carteras, y con los topes del API. */
export function reasonProblem(reason: string): string | undefined {
  const text = reason.trim();
  if (text.length < REASON_MIN)
    return 'Contá por qué (al menos 3 caracteres): queda en la auditoría.';
  if (text.length > REASON_MAX) return `El motivo admite hasta ${REASON_MAX} caracteres.`;
  return undefined;
}

// ───────────────────────── La ruta proxy ─────────────────────────

export type BookingPermissionsPlan =
  | {
      readonly ok: true;
      readonly path: string;
      readonly method: 'GET' | 'PUT';
      readonly body?: UpdateBookingPermissionsBody;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Qué reenviar al API: sólo el nodo (UUID) y, al cambiarlo, los dos campos que el API acepta,
 * rearmados. Lo que el navegador mande de más no viaja.
 */
export function bookingPermissionsPlan(
  tenantId: string,
  method: string,
  body: unknown,
): BookingPermissionsPlan {
  if (!UUID_RE.test(tenantId)) return { ok: false, status: 404, error: 'Nodo inválido.' };
  const path = `/tenants/${tenantId.toLowerCase()}/booking-permissions`;
  if (method === 'GET') return { ok: true, path, method: 'GET' };
  if (method !== 'PUT') return { ok: false, status: 405, error: 'Método no permitido.' };
  const setting = isRecord(body) ? settingOf(body['nonRefundableRates']) : undefined;
  const reason = isRecord(body) && typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (setting === undefined || reasonProblem(reason) !== undefined) {
    return { ok: false, status: 400, error: 'Elegí si puede reservarlas y contá por qué.' };
  }
  return { ok: true, path, method: 'PUT', body: { nonRefundableRates: setting, reason } };
}

/** La respuesta del API para el navegador: el cuerpo en éxito, `{ error, reason }` en error. */
export function bookingPermissionsReply(res: ApiResponse): WalletProxyReply {
  return walletProxyReply(res);
}

// ───────────────────────── Las llamadas del panel ─────────────────────────

export type BookingPermissionsResult =
  | { readonly ok: true; readonly data: BookingPermissionsView }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly reason?: string;
    };

const OFFLINE = 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.';
const FORBIDDEN =
  'Sólo quien financia a este nodo decide qué tarifas puede reservar: su consolidador, su agencia o el superadmin de Planetour.';

async function call(url: string, init: RequestInit): Promise<BookingPermissionsResult> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, status: 0, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!read.ok) return { ok: false, status: res.status, message: read.message };
  if (!res.ok) {
    const body = isRecord(read.data) ? read.data : {};
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
    const error = typeof body['error'] === 'string' ? body['error'].trim() : '';
    const message =
      error !== ''
        ? error
        : res.status === 403
          ? FORBIDDEN
          : 'No se pudo completar. Probá de nuevo.';
    return { ok: false, status: res.status, message, ...(reason === undefined ? {} : { reason }) };
  }
  const data = parseBookingPermissions(read.data);
  return data === undefined
    ? {
        ok: false,
        status: res.status,
        message: 'La respuesta llegó incompleta. Recargá la página.',
      }
    : { ok: true, data };
}

function urlOf(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/booking-permissions`;
}

export function loadBookingPermissions(tenantId: string): Promise<BookingPermissionsResult> {
  return call(urlOf(tenantId), { method: 'GET' });
}

export function updateBookingPermissions(
  tenantId: string,
  body: UpdateBookingPermissionsBody,
): Promise<BookingPermissionsResult> {
  return call(urlOf(tenantId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
