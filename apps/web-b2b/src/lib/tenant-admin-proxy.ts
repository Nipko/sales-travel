import type { ApiResponse } from './api';
import { isTenantId } from './provider-enablement';
import { IDLE_MAX, IDLE_MIN, SEATS_MAX, SEATS_MIN } from './tenant-admin-seats';
import { isUuid } from './wallets';

/**
 * A qué ruta del API va una corrección de la red desde el panel del superadmin, y con qué cuerpo.
 * Sin I/O, para probar el borde sin levantar Next.
 *
 * Valida lo que arma la URL (el id del nodo) y reconstruye el cuerpo campo por campo: el API
 * rechaza campos de más (`.strict()`), y un segmento raro no puede componer otra ruta. Quién puede
 * hacerlo (sólo el superadmin) y qué combinación de la red se admite lo decide el API y la base.
 */

export type TenantAdminProxyPlan =
  | { readonly ok: true; readonly path: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

const STATUSES: readonly string[] = ['active', 'suspended'];
const TYPES: readonly string[] = ['consolidator', 'agency', 'subagency'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Tope del motivo de un cambio de estado de un nodo (UpdateTenantSchema del API). */
const REASON_MAX = 500;

/**
 * `PATCH /admin/tenants/:id`: estado, sucursal y tipo. Al menos uno. Suspender lleva el motivo,
 * recortado (el API lo exige y decide su largo mínimo); reactivar lo admite. Un motivo vacío no
 * viaja.
 */
export function tenantUpdatePlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };

  const body: Record<string, unknown> = {};
  const { status, isBranch, tenantType, reason } = input;
  if (status !== undefined) {
    if (typeof status !== 'string' || !STATUSES.includes(status)) {
      return { ok: false, error: 'El estado tiene que ser activo o suspendido.' };
    }
    body['status'] = status;
  }
  if (isBranch !== undefined) {
    if (typeof isBranch !== 'boolean') {
      return { ok: false, error: 'La marca de sucursal tiene que ser sí o no.' };
    }
    body['isBranch'] = isBranch;
  }
  if (tenantType !== undefined) {
    if (typeof tenantType !== 'string' || !TYPES.includes(tenantType)) {
      return { ok: false, error: 'Tipo de nodo inválido.' };
    }
    body['tenantType'] = tenantType;
  }
  if (Object.keys(body).length === 0) {
    return { ok: false, error: 'Indica qué cambiar: estado, sucursal o tipo.' };
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return { ok: false, error: 'El motivo no se pudo leer.' };
  }
  const motivo = typeof reason === 'string' ? reason.trim() : '';
  if (motivo.length > REASON_MAX) {
    return { ok: false, error: `El motivo puede tener hasta ${REASON_MAX} caracteres.` };
  }
  if (motivo !== '') {
    body['reason'] = motivo;
  } else if (status === 'suspended') {
    return { ok: false, error: 'Indica el motivo de la suspensión.' };
  }
  return { ok: true, path: `/admin/tenants/${tenantId.toLowerCase()}`, body };
}

/** `GET /admin/tenants/stats`: los números de cada nodo de la red. */
export function tenantStatsTarget(): TenantAdminProxyTarget {
  return { ok: true, path: '/admin/tenants/stats' };
}

/** `GET /admin/tenants/:id/impact`: qué arrastraría suspender el nodo con su red. */
export function tenantImpactTarget(tenantId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  return { ok: true, path: `/admin/tenants/${tenantId.toLowerCase()}/impact` };
}

/** `GET /admin/tenants/:id/summary`: la pestaña Resumen del nodo. */
export function tenantSummaryTarget(tenantId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  return { ok: true, path: `/admin/tenants/${tenantId.toLowerCase()}/summary` };
}

/** `POST /admin/tenants/:id/move`: el nodo con su subárbol bajo otro padre (D6 A). */
export function tenantMovePlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const parentTenantId = asRecord(raw)?.['parentTenantId'];
  if (typeof parentTenantId !== 'string' || !isTenantId(parentTenantId)) {
    return { ok: false, error: 'Elige el nuevo padre del nodo.' };
  }
  return {
    ok: true,
    path: `/admin/tenants/${tenantId.toLowerCase()}/move`,
    body: { parentTenantId: parentTenantId.toLowerCase() },
  };
}

/** A qué ruta va un pedido sin cuerpo (lectura o acción): sólo ids que no puedan componer otra. */
export type TenantAdminProxyTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** `GET /tenants/:id/seats`: el cupo del nodo y quiénes lo ocupan. */
export function seatsViewTarget(tenantId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  return { ok: true, path: `/tenants/${tenantId.toLowerCase()}/seats` };
}

/** `GET /tenants/:id/members-export`: el equipo del nodo en CSV (USR-16). */
export function teamExportTarget(tenantId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  return { ok: true, path: `/tenants/${tenantId.toLowerCase()}/members-export` };
}

/** `POST /tenants/:id/seats/sessions/:sessionId/release`: un admin libera un puesto. */
export function seatReleaseTarget(tenantId: string, sessionId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  if (!isUuid(sessionId)) return { ok: false, error: 'Sesión inválida.' };
  return {
    ok: true,
    path: `/tenants/${tenantId.toLowerCase()}/seats/sessions/${sessionId.toLowerCase()}/release`,
  };
}

export type MemberActionPath =
  | 'reset-mfa'
  | 'revoke-sessions'
  | 'send-password-reset'
  | 'require-password-reset'
  | 'unlock';

/**
 * `POST /tenants/:id/members/:userId/<acción>`: restablecer su 2FA, cerrar sus sesiones, enviarle el
 * enlace para restablecer su contraseña, obligarlo a elegir una nueva o desbloquearle la cuenta.
 * Ninguna lleva cuerpo.
 */
export function memberActionTarget(
  tenantId: string,
  userId: string,
  action: MemberActionPath,
): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  if (!isUuid(userId)) return { ok: false, error: 'Miembro inválido.' };
  return {
    ok: true,
    path: `/tenants/${tenantId.toLowerCase()}/members/${userId.toLowerCase()}/${action}`,
  };
}

/** El `nextBefore` que emite el API: base64url, opaco. Si es uno suyo lo decide él. */
const AUDIT_CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const AUDIT_LIMIT = /^\d{1,3}$/;

/** `GET /tenants/:id/members/:userId`: la ficha de una persona del equipo del nodo. */
export function memberDetailTarget(tenantId: string, userId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  if (!isUuid(userId)) return { ok: false, error: 'Miembro inválido.' };
  return { ok: true, path: `/tenants/${tenantId.toLowerCase()}/members/${userId.toLowerCase()}` };
}

/**
 * `POST /tenants/:id/members/:userId/sessions/:sessionId/revoke`: cerrar UNA sesión de la persona.
 * Desde el directorio de la plataforma también va por acá, con el nodo de esa sesión.
 */
export function memberSessionRevokeTarget(
  tenantId: string,
  userId: string,
  sessionId: string,
): TenantAdminProxyTarget {
  const member = memberDetailTarget(tenantId, userId);
  if (!member.ok) return member;
  if (!isUuid(sessionId)) return { ok: false, error: 'Sesión inválida.' };
  return { ok: true, path: `${member.path}/sessions/${sessionId.toLowerCase()}/revoke` };
}

const USER_AUDIT_PARAMS: readonly string[] = ['before', 'limit'];
const USER_AUDIT_INVALID = 'La consulta del historial no es válida. Recarga la página.';

/**
 * La consulta del historial de una persona (`?before=&limit=`), reconstruida: el cursor con la forma
 * de los que emite el API y el tamaño entre 1 y 100. Lo que no sea eso, `undefined`. La comparten la
 * ficha de Equipo y la del directorio de la plataforma.
 */
export function userAuditQuery(query: URLSearchParams): string | undefined {
  for (const name of query.keys()) {
    if (!USER_AUDIT_PARAMS.includes(name)) return undefined;
  }
  const out = new URLSearchParams();
  const before = query.getAll('before');
  const limit = query.getAll('limit');
  if (before.length > 1 || limit.length > 1) return undefined;
  if (before[0] !== undefined) {
    if (!AUDIT_CURSOR.test(before[0])) return undefined;
    out.set('before', before[0]);
  }
  if (limit[0] !== undefined) {
    const n = AUDIT_LIMIT.test(limit[0]) ? Number(limit[0]) : NaN;
    if (!(n >= 1 && n <= 100)) return undefined;
    out.set('limit', String(n));
  }
  return out.toString();
}

/** `GET /tenants/:id/members/:userId/audit?…`: el historial de una persona del equipo del nodo. */
export function memberAuditTarget(
  tenantId: string,
  userId: string,
  query: URLSearchParams,
): TenantAdminProxyTarget {
  const member = memberDetailTarget(tenantId, userId);
  if (!member.ok) return member;
  const qs = userAuditQuery(query);
  if (qs === undefined) return { ok: false, error: USER_AUDIT_INVALID };
  return { ok: true, path: qs === '' ? `${member.path}/audit` : `${member.path}/audit?${qs}` };
}

/** Los filtros de la Actividad de la red. Espejo de AUDIT_CATEGORIES del API. */
const AUDIT_CATEGORIES: readonly string[] = ['users', 'credentials', 'pricing', 'network'];
const AUDIT_PARAMS: readonly string[] = ['tenantId', 'limit', 'before', 'category', 'actorUserId'];
const AUDIT_INVALID = 'Los filtros de la actividad no son válidos. Recarga la página.';

/**
 * `GET /tenants/network/audit?…`: la Actividad de la red bajo un nodo, de a páginas y con filtros.
 * La consulta se reconstruye parámetro por parámetro: el API rechaza los de más, y uno repetido o
 * desconocido no lo armó el panel. Quién puede verla (administrar el nodo) lo decide el API.
 */
export function networkAuditTarget(query: URLSearchParams): TenantAdminProxyTarget {
  for (const name of query.keys()) {
    if (!AUDIT_PARAMS.includes(name)) return { ok: false, error: AUDIT_INVALID };
  }
  const values = new Map<string, string | null>();
  for (const name of AUDIT_PARAMS) {
    const all = query.getAll(name);
    if (all.length > 1) return { ok: false, error: AUDIT_INVALID };
    values.set(name, all[0] ?? null);
  }

  const tenantId = values.get('tenantId') ?? '';
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const out = new URLSearchParams({ tenantId: tenantId.toLowerCase() });

  const limit = values.get('limit');
  if (limit != null) {
    const n = AUDIT_LIMIT.test(limit) ? Number(limit) : NaN;
    if (!(n >= 1 && n <= 200)) return { ok: false, error: AUDIT_INVALID };
    out.set('limit', String(n));
  }
  const before = values.get('before');
  if (before != null) {
    if (!AUDIT_CURSOR.test(before)) return { ok: false, error: AUDIT_INVALID };
    out.set('before', before);
  }
  const category = values.get('category');
  if (category != null) {
    if (!AUDIT_CATEGORIES.includes(category)) return { ok: false, error: AUDIT_INVALID };
    out.set('category', category);
  }
  const actorUserId = values.get('actorUserId');
  if (actorUserId != null) {
    if (!isUuid(actorUserId)) return { ok: false, error: 'Persona inválida.' };
    out.set('actorUserId', actorUserId.toLowerCase());
  }
  return { ok: true, path: `/tenants/network/audit?${out.toString()}` };
}

/** Forma de un rol (`tenant_admin`). Cuáles se pueden dar lo decide el API. */
const ROLE_FORMAT = /^[a-z][a-z_]{0,31}$/;

/** Los cambios de estado cuyo impacto se pregunta: reactivar, suspender o quitar del nodo. */
const IMPACT_STATUSES: readonly string[] = ['active', 'suspended', 'removed'];

/**
 * `GET /admin/memberships/impact`: qué arrastraría suspender una membership, quitarla del nodo o
 * cambiarle el rol (las invitaciones que se revocarían), para decirlo en la confirmación. La consulta
 * se reconstruye parámetro por parámetro: el API rechaza los de más, y pide el estado o el rol, uno
 * solo.
 */
export function membershipImpactTarget(query: {
  get(name: string): string | null;
}): TenantAdminProxyTarget {
  const tenantId = query.get('tenantId') ?? '';
  const userId = query.get('userId') ?? '';
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  if (!isUuid(userId)) return { ok: false, error: 'Miembro inválido.' };

  const params = new URLSearchParams({
    userId: userId.toLowerCase(),
    tenantId: tenantId.toLowerCase(),
  });
  const status = query.get('status');
  const role = query.get('role');
  if (status !== null && role === null && IMPACT_STATUSES.includes(status)) {
    params.set('status', status);
  } else if (role !== null && status === null && ROLE_FORMAT.test(role)) {
    params.set('role', role);
  } else {
    return { ok: false, error: 'Indica qué cambio simular: suspender, quitar del nodo o un rol.' };
  }
  return { ok: true, path: `/admin/memberships/impact?${params.toString()}` };
}

/** Tope de un correo (RFC 5321) y su forma mínima. Si es una dirección válida lo decide el API. */
const EMAIL_MAX = 254;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/;

/** `GET /invitations?tenantId=`: las invitaciones pendientes del nodo. */
export function invitationsListTarget(tenantId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const params = new URLSearchParams({ tenantId: tenantId.toLowerCase() });
  return { ok: true, path: `/invitations?${params.toString()}` };
}

/**
 * `POST /invitations`: a quién, a qué nodo y con qué rol. El correo va recortado; el API lo pasa a
 * minúsculas y decide qué roles se pueden dar.
 */
export function invitePlan(raw: unknown): TenantAdminProxyPlan {
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'La invitación no se pudo leer.' };
  const { email, tenantId, role } = input;
  const address = typeof email === 'string' ? email.trim() : '';
  if (address.length > EMAIL_MAX || !EMAIL_FORMAT.test(address)) {
    return { ok: false, error: 'Escribe un correo válido.' };
  }
  if (typeof tenantId !== 'string' || !isTenantId(tenantId)) {
    return { ok: false, error: 'Nodo inválido.' };
  }
  if (typeof role !== 'string' || !ROLE_FORMAT.test(role)) {
    return { ok: false, error: 'Elige el rol de la invitación.' };
  }
  return {
    ok: true,
    path: '/invitations',
    body: { email: address, tenantId: tenantId.toLowerCase(), role },
  };
}

export type InvitationActionPath = 'resend' | 'revoke';

/** `POST /invitations/:id/<acción>?tenantId=`: reenviar o revocar una invitación pendiente. */
export function invitationActionTarget(
  invitationId: string,
  tenantId: string,
  action: InvitationActionPath,
): TenantAdminProxyTarget {
  if (!isUuid(invitationId)) return { ok: false, error: 'Invitación inválida.' };
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const params = new URLSearchParams({ tenantId: tenantId.toLowerCase() });
  return {
    ok: true,
    path: `/invitations/${invitationId.toLowerCase()}/${action}?${params.toString()}`,
  };
}

/** El miembro y el nodo de un cambio sobre una membership. */
function membershipTarget(
  input: Record<string, unknown>,
): { userId: string; tenantId: string } | { error: string } {
  const { userId, tenantId } = input;
  if (typeof tenantId !== 'string' || !isTenantId(tenantId)) return { error: 'Nodo inválido.' };
  if (!isUuid(userId)) return { error: 'Miembro inválido.' };
  return { userId: userId.toLowerCase(), tenantId: tenantId.toLowerCase() };
}

/** `PATCH /admin/memberships/role`: el rol nuevo de un miembro en un nodo. */
export function membershipRolePlan(raw: unknown): TenantAdminProxyPlan {
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };
  const target = membershipTarget(input);
  if ('error' in target) return { ok: false, error: target.error };
  const role = input['role'];
  if (typeof role !== 'string' || !ROLE_FORMAT.test(role)) {
    return { ok: false, error: 'Elige el rol nuevo.' };
  }
  return { ok: true, path: '/admin/memberships/role', body: { ...target, role } };
}

/**
 * `POST /admin/memberships/remove`: quitar a un miembro de un nodo (baja blanda, USR-11). Sólo el
 * miembro y el nodo; quién puede y si pide el 2FA reciente lo decide el API.
 */
export function membershipRemovePlan(raw: unknown): TenantAdminProxyPlan {
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };
  const target = membershipTarget(input);
  if ('error' in target) return { ok: false, error: target.error };
  return { ok: true, path: '/admin/memberships/remove', body: target };
}

/** `PATCH /admin/memberships/status`: suspender o reactivar el acceso de un miembro a un nodo. */
export function membershipStatusPlan(raw: unknown): TenantAdminProxyPlan {
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };
  const target = membershipTarget(input);
  if ('error' in target) return { ok: false, error: target.error };
  const status = input['status'];
  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    return { ok: false, error: 'El estado tiene que ser activo o suspendido.' };
  }
  return { ok: true, path: '/admin/memberships/status', body: { ...target, status } };
}

function nullableIntIn(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * `PATCH /admin/tenants/:id/seats`: puestos e inactividad propios del nodo (`null` = heredar).
 * Los dos campos viajan siempre: el API los reemplaza juntos y un campo ausente no es "heredar".
 */
export function seatPolicyPlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };
  const concurrentSeats = nullableIntIn(input['concurrentSeats'], SEATS_MIN, SEATS_MAX);
  if (concurrentSeats === undefined) {
    return {
      ok: false,
      error: `Los puestos tienen que ser un entero entre ${SEATS_MIN} y ${SEATS_MAX}, o heredar.`,
    };
  }
  const idleTimeoutMinutes = nullableIntIn(input['idleTimeoutMinutes'], IDLE_MIN, IDLE_MAX);
  if (idleTimeoutMinutes === undefined) {
    return {
      ok: false,
      error: `La inactividad tiene que estar entre ${IDLE_MIN} y ${IDLE_MAX} minutos, o heredar.`,
    };
  }
  return {
    ok: true,
    path: `/admin/tenants/${tenantId.toLowerCase()}/seats`,
    body: { concurrentSeats, idleTimeoutMinutes },
  };
}

const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_MESSAGE = 500;

export interface TenantAdminProxyReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * De los `details` de un error del API, sólo los que usa el panel, uno por uno: hoy el id de la
 * invitación pendiente (409 INVITATION_ALREADY_PENDING), para ofrecer reenviarla. Lo demás no pasa,
 * aunque el API lo declare publicable: un campo nuevo tiene que sumarse acá a propósito.
 */
function panelDetails(value: unknown): { invitationId: string } | undefined {
  const invitationId = asRecord(value)?.['invitationId'];
  return isUuid(invitationId) ? { invitationId: invitationId.toLowerCase() } : undefined;
}

/**
 * Lo que la ruta del panel le devuelve al navegador. En éxito, el cuerpo del API tal cual; en
 * error, `{ error, reason?, details? }`: el mensaje (ya en castellano) para mostrar, el motivo
 * máquina para decidir y los detalles que usa el panel ({@link panelDetails}), nunca el cuerpo crudo.
 */
export function tenantAdminProxyReply(res: ApiResponse): TenantAdminProxyReply {
  if (res.kind !== 'json') {
    // Una acción que respondió 2xx sin cuerpo (un 201 vacío o un 204) salió bien: se contesta
    // con un 200 y un cuerpo, porque `NextResponse.json` no admite cuerpo con 204.
    return res.status < 400
      ? { status: 200, body: { ok: true } }
      : { status: res.status, body: { error: res.message } };
  }
  if (res.status < 400) return { status: res.status, body: res.body };
  const r = asRecord(res.body);
  const message = r?.['message'];
  const reason = r?.['reason'];
  const details = panelDetails(r?.['details']);
  const text = (
    Array.isArray(message)
      ? message.filter((m): m is string => typeof m === 'string').join('. ')
      : typeof message === 'string'
        ? message
        : ''
  ).trim();
  return {
    status: res.status,
    body: {
      error: text.length > MAX_MESSAGE ? '' : text,
      ...(typeof reason === 'string' && MACHINE_REASON.test(reason) ? { reason } : {}),
      ...(details === undefined ? {} : { details }),
    },
  };
}

/**
 * Marca la sesión de quien mira dentro de la vista de puestos, para que la pantalla no le ofrezca
 * "Desconectar" sobre sí mismo (el API lo rechaza igual). Sin id de sesión, la deja como vino.
 */
export function markCurrentSession(body: unknown, currentSessionId: string | undefined): unknown {
  const r = asRecord(body);
  const sessions = r?.['sessions'];
  if (r === undefined || !Array.isArray(sessions) || currentSessionId === undefined) return body;
  const current = currentSessionId.toLowerCase();
  return {
    ...r,
    sessions: sessions.map((s) => {
      const session = asRecord(s);
      if (session === undefined) return s;
      const id = session['sessionId'];
      return { ...session, current: typeof id === 'string' && id.toLowerCase() === current };
    }),
  };
}

/** El `sessionId` de `GET /auth/session`, si vino. */
export function currentSessionIdOf(res: ApiResponse): string | undefined {
  if (res.kind !== 'json' || res.status >= 400) return undefined;
  const id = asRecord(res.body)?.['sessionId'];
  return typeof id === 'string' && isUuid(id) ? id : undefined;
}
