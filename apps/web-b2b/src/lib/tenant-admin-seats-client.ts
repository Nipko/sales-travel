import { parseIssuedInvitation, type IssuedInvitation } from './invitation-notice';
import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import { reasonOf, withStepUp, type StepUpAware, type StepUpCancelled } from './step-up';
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

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorOf(body: unknown): string | undefined {
  const e = asRecord(body)?.['error'];
  return typeof e === 'string' ? e : undefined;
}

/** El fallo lleva el `reason` del API cuando vino: con él `withStepUp` sabe si pedir el código. */
async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
  errorMessage: (status: number, message: string | undefined) => string,
): Promise<StepUpAware<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!res.ok) {
    const reason = read.ok ? reasonOf(read.data) : undefined;
    return {
      ok: false,
      message: errorMessage(res.status, read.ok ? errorOf(read.data) : undefined),
      ...(reason ? { reason } : {}),
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
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'No administras este nodo: no puedes ver sus puestos.';
  // El texto de un 404 puede ser el "Cannot GET …" de la ruta: no se muestra.
  if (status === 404) return 'No encontramos los puestos de este nodo.';
  return message?.trim() || 'No pudimos cargar los puestos. Inténtalo de nuevo.';
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

/**
 * Una acción de soporte sobre un miembro. Restablecer su 2FA, forzar el cambio de contraseña y
 * enviarle el enlace a un admin pueden pedir el código del 2FA (USR-13): `withStepUp` abre el
 * diálogo y la repite una vez. Si se cierra el diálogo, vuelve `StepUpCancelled`.
 */
export function runMemberAction(
  tenantId: string,
  userId: string,
  action: MemberAction,
): Promise<StepUpAware<MemberActionResult> | StepUpCancelled> {
  return withStepUp(() =>
    call(
      `/api/tenants/${seg(tenantId)}/members/${seg(userId)}/${action}`,
      { method: 'POST' },
      parseMemberActionResult,
      memberActionError,
    ),
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
      ? 'No tienes permiso para ver las invitaciones de este nodo.'
      : 'No pudimos cargar las invitaciones pendientes.',
  );
}

/**
 * Lo que devuelven reenviar y revocar. `gone`: la invitación ya no está pendiente (la aceptaron o la
 * revocaron desde otra sesión), así que la fila de la lista quedó vieja y hay que recargarla.
 */
export type InvitationActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string; readonly gone?: true };

/** Reenviar o revocar una invitación: el error, con el mensaje del API tal cual. Nunca lanza. */
async function invitationAction<T>(
  url: string,
  parse: (value: unknown) => T | undefined,
  fallback: string,
): Promise<InvitationActionResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', cache: 'no-store' });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!res.ok) {
    const body = read.ok ? asRecord(read.data) : undefined;
    const message =
      res.status === 401
        ? 'Tu sesión venció. Vuelve a iniciar sesión.'
        : errorOf(body)?.trim() || fallback;
    return body?.['reason'] === 'INVITATION_NOT_PENDING'
      ? { ok: false, message, gone: true }
      : { ok: false, message };
  }
  if (!read.ok) return { ok: false, message: read.message };
  const data = parse(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

/** Revocar una invitación: el mensaje del API tal cual (ya viene en castellano). */
export function revokeInvitation(
  tenantId: string,
  invitationId: string,
): Promise<InvitationActionResult<true>> {
  return invitationAction(
    `/api/invitations/${seg(invitationId)}/revoke?tenantId=${seg(tenantId)}`,
    accepted,
    'No pudimos revocar la invitación. Inténtalo de nuevo.',
  );
}

/**
 * Reenviar una invitación: enlace nuevo (el anterior deja de valer) y 7 días más. Devuelve el nuevo
 * vencimiento y si el correo salió; el error, el mensaje del API tal cual.
 */
export function resendInvitation(
  tenantId: string,
  invitationId: string,
): Promise<InvitationActionResult<IssuedInvitation>> {
  return invitationAction(
    `/api/invitations/${seg(invitationId)}/resend?tenantId=${seg(tenantId)}`,
    parseIssuedInvitation,
    'No pudimos reenviar la invitación. Inténtalo de nuevo.',
  );
}

/** Lo que pide el formulario de "Invitar usuario". */
export interface InvitationRequest {
  readonly email: string;
  readonly tenantId: string;
  readonly role: string;
}

/**
 * El resultado de invitar. Si ya había una pendiente para ese correo en el nodo, el error trae su id
 * (`pendingInvitationId`), para ofrecer reenviarla en vez de crear otra.
 */
export type InvitationResult =
  | { readonly ok: true; readonly data: IssuedInvitation }
  | { readonly ok: false; readonly message: string; readonly pendingInvitationId?: string };

/** Invitar a alguien a un nodo. Nunca lanza. */
export async function sendInvitation(input: InvitationRequest): Promise<InvitationResult> {
  let res: Response;
  try {
    res = await fetch('/api/invitations', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!res.ok) {
    const body = read.ok ? asRecord(read.data) : undefined;
    const message =
      res.status === 401
        ? 'Tu sesión venció. Vuelve a iniciar sesión.'
        : errorOf(body)?.trim() || 'No pudimos enviar la invitación. Inténtalo de nuevo.';
    const pendingInvitationId = asRecord(body?.['details'])?.['invitationId'];
    return body?.['reason'] === 'INVITATION_ALREADY_PENDING' &&
      typeof pendingInvitationId === 'string'
      ? { ok: false, message, pendingInvitationId }
      : { ok: false, message };
  }
  if (!read.ok) return { ok: false, message: read.message };
  const data = parseIssuedInvitation(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}
