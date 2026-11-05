import type { TenantAdminProxyPlan, TenantAdminProxyTarget } from './tenant-admin-proxy';
import { isUuid } from './wallets';

/**
 * Plataforma → Superadmins (docs/platform/16): quién es superadmin, pleno o supervisado, y las
 * solicitudes de cambio de los supervisados. Tipos, lectura de las respuestas, los pedidos al API que
 * arma el BFF y los textos. Sin I/O.
 */

export type PlatformStanding = 'full' | 'supervised' | null;

export interface PlatformAdmin {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly supervised: boolean;
  readonly membershipStatus: string;
  readonly userStatus: string;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly since: string;
}

export const CHANGE_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'failed',
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

export interface ChangeRequest {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly status: ChangeRequestStatus;
  readonly requestedBy: { readonly id: string; readonly email: string | null };
  readonly decidedBy: { readonly id: string; readonly email: string | null } | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly error: string | null;
  readonly createdAt: string;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown, max = 300): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : null;
}

function parseAdmin(value: unknown): PlatformAdmin | undefined {
  const r = rec(value);
  const userId = str(r?.['userId'], 64);
  const email = str(r?.['email'], 254);
  if (r === null || userId === null || email === null) return undefined;
  return {
    userId,
    email,
    name: str(r['name'], 120),
    supervised: r['supervised'] === true,
    membershipStatus: str(r['membershipStatus'], 20) ?? 'active',
    userStatus: str(r['userStatus'], 20) ?? 'active',
    mfaEnabled: r['mfaEnabled'] === true,
    lastLoginAt: str(r['lastLoginAt'], 40),
    since: str(r['since'], 40) ?? '',
  };
}

export function parsePlatformAdmins(raw: unknown): PlatformAdmin[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(parseAdmin).filter((a): a is PlatformAdmin => a !== undefined);
}

export interface PlatformViewer {
  readonly userId: string;
  readonly standing: PlatformStanding;
}

export function parseViewer(raw: unknown): PlatformViewer | undefined {
  const r = rec(raw);
  const userId = str(r?.['userId'], 64);
  if (r === null || userId === null) return undefined;
  const s = r['standing'];
  if (s !== 'full' && s !== 'supervised' && s !== null) return undefined;
  return { userId, standing: s };
}

function person(value: unknown): { id: string; email: string | null } | null {
  const r = rec(value);
  const id = str(r?.['id'], 64);
  return id === null ? null : { id, email: str(r?.['email'], 254) };
}

function parseRequest(value: unknown): ChangeRequest | undefined {
  const r = rec(value);
  const id = str(r?.['id'], 64);
  const kind = str(r?.['kind'], 80);
  const summary = str(r?.['summary'], 300);
  const status = r?.['status'];
  const requestedBy = person(r?.['requestedBy']);
  if (
    r === null ||
    id === null ||
    kind === null ||
    summary === null ||
    requestedBy === null ||
    !(CHANGE_REQUEST_STATUSES as readonly unknown[]).includes(status)
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    summary,
    status: status as ChangeRequestStatus,
    requestedBy,
    decidedBy: person(r['decidedBy']),
    decidedAt: str(r['decidedAt'], 40),
    decisionNote: str(r['decisionNote'], 500),
    error: str(r['error'], 500),
    createdAt: str(r['createdAt'], 40) ?? '',
  };
}

export function parseChangeRequests(raw: unknown): ChangeRequest[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(parseRequest).filter((r): r is ChangeRequest => r !== undefined);
}

export function parseChangeRequest(raw: unknown): ChangeRequest | undefined {
  return parseRequest(raw);
}

// ───────────────────────────── El BFF ─────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASON_MAX = 500;

/** El motivo opcional: recortado; vacío es `null`. */
export function reasonValue(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text === '') return null;
  return text.length >= 3 && text.length <= REASON_MAX ? text : undefined;
}

const REASON_ERROR = 'El motivo tiene que tener entre 3 y 500 caracteres.';

/** `POST /admin/platform-admins` con el cuerpo reconstruido: `{ email, supervised, reason }`. */
export function grantPlan(raw: unknown): TenantAdminProxyPlan {
  const r = rec(raw);
  const email = typeof r?.['email'] === 'string' ? r['email'].trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) {
    return { ok: false, error: 'Escribe el correo completo de la cuenta.' };
  }
  if (typeof r?.['supervised'] !== 'boolean') {
    return { ok: false, error: 'Elige si es pleno o supervisado.' };
  }
  const reason = reasonValue(r['reason']);
  if (reason === undefined) return { ok: false, error: REASON_ERROR };
  return {
    ok: true,
    path: '/admin/platform-admins',
    body: { email, supervised: r['supervised'], reason },
  };
}

export function supervisionPlan(userId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isUuid(userId)) return { ok: false, error: 'Cuenta inválida.' };
  const r = rec(raw);
  if (typeof r?.['supervised'] !== 'boolean') {
    return { ok: false, error: 'Elige si es pleno o supervisado.' };
  }
  const reason = reasonValue(r['reason']);
  if (reason === undefined) return { ok: false, error: REASON_ERROR };
  return {
    ok: true,
    path: `/admin/platform-admins/${userId.toLowerCase()}/supervision`,
    body: { supervised: r['supervised'], reason },
  };
}

export function revokePlan(userId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isUuid(userId)) return { ok: false, error: 'Cuenta inválida.' };
  const reason = reasonValue(rec(raw)?.['reason']);
  if (reason === undefined) return { ok: false, error: REASON_ERROR };
  return {
    ok: true,
    path: `/admin/platform-admins/${userId.toLowerCase()}/revoke`,
    body: { reason },
  };
}

export const CHANGE_REQUEST_ACTIONS = ['approve', 'reject', 'cancel'] as const;
export type ChangeRequestAction = (typeof CHANGE_REQUEST_ACTIONS)[number];

export function isChangeRequestAction(value: string): value is ChangeRequestAction {
  return (CHANGE_REQUEST_ACTIONS as readonly string[]).includes(value);
}

export function decisionPlan(id: string, action: string, raw: unknown): TenantAdminProxyPlan {
  if (!isUuid(id)) return { ok: false, error: 'Solicitud inválida.' };
  if (!isChangeRequestAction(action)) return { ok: false, error: 'Acción desconocida.' };
  const path = `/admin/change-requests/${id.toLowerCase()}/${action}`;
  if (action === 'cancel') return { ok: true, path, body: {} };
  const note = reasonValue(rec(raw)?.['note']);
  if (note === undefined) return { ok: false, error: 'La nota puede tener hasta 500 caracteres.' };
  return { ok: true, path, body: { note } };
}

export function changeRequestsTarget(search: URLSearchParams): TenantAdminProxyTarget {
  const status = search.get('status');
  if (status === null || status === '') return { ok: true, path: '/admin/change-requests' };
  if (!(CHANGE_REQUEST_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'Estado inválido.' };
  }
  return { ok: true, path: `/admin/change-requests?status=${status}` };
}

// ───────────────────────────── Textos ─────────────────────────────

export function standingLabel(supervised: boolean): string {
  return supervised ? 'Supervisado' : 'Pleno';
}

export const CHANGE_REQUEST_STATUS_LABELS: Readonly<Record<ChangeRequestStatus, string>> = {
  pending: 'Pendiente',
  approved: 'Aprobada y aplicada',
  rejected: 'Rechazada',
  cancelled: 'Cancelada',
  failed: 'Aprobada, no se pudo aplicar',
};

export const PLATFORM_ADMINS_COPY = {
  title: 'Superadmins',
  intro:
    'Quién administra la plataforma. Un superadmin pleno aplica sus cambios al instante; uno supervisado ve y opera todo, pero sus cambios sensibles (gobierno, proveedores, superadmins, suspender cuentas) esperan la aprobación de un pleno.',
  supervisedViewer:
    'Eres superadmin supervisado: lo que pidas acá queda como solicitud hasta que un superadmin pleno lo apruebe.',
  noMfa: 'Sin 2FA: se le pedirá al entrar.',
  empty: 'No hay solicitudes en este estado.',
} as const;
