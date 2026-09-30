import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import { tenantAdminErrorMessage } from './tenant-admin-client';
import {
  parseSeatsView,
  seatReleaseError,
  type SeatPolicyPayload,
  type SeatsView,
} from './tenant-admin-seats';
import {
  memberActionError,
  parseInvitations,
  parseMemberActionResult,
  parseMembers,
  parseMembershipImpact,
  teamLoadError,
  type MemberAction,
  type MemberActionResult,
  type MembershipImpact,
  type NetworkMember,
  type PendingInvitation,
} from './tenant-admin-team';

/**
 * Las llamadas del navegador para Equipo y para "Puestos y sesión" del nodo. Cada una devuelve
 * datos ya validados o un mensaje para la pantalla; nunca lanza. Un error NUNCA vuelve como lista
 * vacía: esa confusión es la que hacía decir "Esta agencia no tiene usuarios" ante un 403.
 */

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recargá la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorOf(body: unknown): string | undefined {
  const e = asRecord(body)?.['error'];
  return typeof e === 'string' ? e : undefined;
}

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
  errorMessage: (status: number, message: string | undefined) => string,
): Promise<Loaded<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!res.ok) {
    return {
      ok: false,
      message: errorMessage(res.status, read.ok ? errorOf(read.data) : undefined),
    };
  }
  if (!read.ok) return { ok: false, message: read.message };
  const data = parse(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

function seg(id: string): string {
  return encodeURIComponent(id);
}

/** El 403 de la vista de puestos es de permiso sobre el nodo, no de superadmin. */
function seatsReadError(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  if (status === 403) return 'No administrás este nodo: no podés ver sus puestos.';
  // El texto de un 404 puede ser el "Cannot GET …" de la ruta: no se muestra.
  if (status === 404) return 'No encontramos los puestos de este nodo.';
  return message?.trim() || 'No pudimos cargar los puestos. Probá de nuevo.';
}

export function loadSeats(tenantId: string): Promise<Loaded<SeatsView>> {
  return call(`/api/tenants/${seg(tenantId)}/seats`, {}, parseSeatsView, seatsReadError);
}

const accepted = (): true => true;

export function releaseSeat(tenantId: string, sessionId: string): Promise<Loaded<true>> {
  return call(
    `/api/tenants/${seg(tenantId)}/seats/sessions/${seg(sessionId)}/release`,
    { method: 'POST' },
    accepted,
    seatReleaseError,
  );
}

export function saveSeatPolicy(
  tenantId: string,
  payload: SeatPolicyPayload,
): Promise<Loaded<true>> {
  return call(
    `/api/admin/tenants/${seg(tenantId)}/seats`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    accepted,
    (status, message) => tenantAdminErrorMessage(status, message, 'write'),
  );
}

export function runMemberAction(
  tenantId: string,
  userId: string,
  action: MemberAction,
): Promise<Loaded<MemberActionResult>> {
  return call(
    `/api/tenants/${seg(tenantId)}/members/${seg(userId)}/${action}`,
    { method: 'POST' },
    parseMemberActionResult,
    memberActionError,
  );
}

/** El cambio sobre una membership que la confirmación está por aplicar. */
export type MembershipChange = { readonly status: 'suspended' } | { readonly role: string };

/**
 * Qué arrastraría el cambio (las invitaciones que se revocarían). Se pregunta antes de abrir la
 * confirmación; si falla, la pantalla confirma igual, sin el número.
 */
export function loadMembershipImpact(
  tenantId: string,
  userId: string,
  change: MembershipChange,
): Promise<Loaded<MembershipImpact>> {
  const params = new URLSearchParams({
    tenantId,
    userId,
    ...('status' in change ? { status: change.status } : { role: change.role }),
  });
  return call(
    `/api/admin/memberships/impact?${params.toString()}`,
    {},
    parseMembershipImpact,
    memberActionError,
  );
}

export function loadMembers(tenantId: string): Promise<Loaded<NetworkMember[]>> {
  return call(`/api/tenants/network/users?tenantId=${seg(tenantId)}`, {}, parseMembers, (status) =>
    teamLoadError(status),
  );
}

export function loadInvitations(tenantId: string): Promise<Loaded<PendingInvitation[]>> {
  return call(`/api/invitations?tenantId=${seg(tenantId)}`, {}, parseInvitations, (status) =>
    status === 403
      ? 'No tenés permiso para ver las invitaciones de este nodo.'
      : 'No pudimos cargar las invitaciones pendientes.',
  );
}

/** Revocar una invitación: el mensaje del API tal cual (ya viene en castellano). */
export function revokeInvitation(tenantId: string, invitationId: string): Promise<Loaded<true>> {
  return call(
    `/api/invitations/${seg(invitationId)}/revoke?tenantId=${seg(tenantId)}`,
    { method: 'POST' },
    accepted,
    (status, message) =>
      status === 401
        ? 'Tu sesión venció. Volvé a iniciar sesión.'
        : message?.trim() || 'No pudimos revocar la invitación. Probá de nuevo.',
  );
}
