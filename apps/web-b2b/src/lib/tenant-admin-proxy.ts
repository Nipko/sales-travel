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

/** `PATCH /admin/tenants/:id`: estado, sucursal y tipo. Al menos uno. */
export function tenantUpdatePlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };

  const body: Record<string, unknown> = {};
  const { status, isBranch, tenantType } = input;
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
    return { ok: false, error: 'Indicá qué cambiar: estado, sucursal o tipo.' };
  }
  return { ok: true, path: `/admin/tenants/${tenantId.toLowerCase()}`, body };
}

/** `POST /admin/tenants/:id/move`: el nodo con su subárbol bajo otro padre (D6 A). */
export function tenantMovePlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const parentTenantId = asRecord(raw)?.['parentTenantId'];
  if (typeof parentTenantId !== 'string' || !isTenantId(parentTenantId)) {
    return { ok: false, error: 'Elegí el nuevo padre del nodo.' };
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

/** `POST /tenants/:id/seats/sessions/:sessionId/release`: un admin libera un puesto. */
export function seatReleaseTarget(tenantId: string, sessionId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  if (!isUuid(sessionId)) return { ok: false, error: 'Sesión inválida.' };
  return {
    ok: true,
    path: `/tenants/${tenantId.toLowerCase()}/seats/sessions/${sessionId.toLowerCase()}/release`,
  };
}

export type MemberActionPath = 'reset-mfa' | 'revoke-sessions';

/** `POST /tenants/:id/members/:userId/(reset-mfa|revoke-sessions)`. */
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

/** Forma de un rol (`tenant_admin`). Cuáles se pueden dar lo decide el API. */
const ROLE_FORMAT = /^[a-z][a-z_]{0,31}$/;

/**
 * `GET /admin/memberships/impact`: qué arrastraría suspender una membership o cambiarle el rol (las
 * invitaciones que se revocarían), para decirlo en la confirmación. La consulta se reconstruye
 * parámetro por parámetro: el API rechaza los de más, y pide el estado o el rol, uno solo.
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
  if (status !== null && role === null && STATUSES.includes(status)) {
    params.set('status', status);
  } else if (role !== null && status === null && ROLE_FORMAT.test(role)) {
    params.set('role', role);
  } else {
    return { ok: false, error: 'Indica qué cambio simular: suspender o un rol.' };
  }
  return { ok: true, path: `/admin/memberships/impact?${params.toString()}` };
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
 * Lo que la ruta del panel le devuelve al navegador. En éxito, el cuerpo del API tal cual; en
 * error, `{ error, reason? }`: el mensaje (ya en castellano) para mostrar y el motivo máquina para
 * decidir, nunca el cuerpo crudo.
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
