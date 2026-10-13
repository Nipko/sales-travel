import { isTenantId } from './provider-enablement';
import type { TenantAdminProxyPlan, TenantAdminProxyTarget } from './tenant-admin-proxy';
import { isUuid } from './wallets';

/**
 * A qué ruta del API va cada pedido de Plataforma → Usuarios (sólo superadmin), y con qué. Sin I/O,
 * para probar el borde sin levantar Next.
 *
 * La consulta del directorio y el cuerpo de la suspensión se reconstruyen campo por campo: el API
 * rechaza lo que sobra (`.strict()`), y un parámetro raro no tiene que llegar hasta él ni componer
 * otra ruta. Quién puede (sólo el superadmin) lo decide el API.
 */

/** Los roles por los que se filtra el directorio. Espejo de DIRECTORY_ROLES del API. */
export const DIRECTORY_ROLES: readonly string[] = [
  'superadmin',
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
  'vendedor',
  'cliente_final',
];

const STATUSES: readonly string[] = ['active', 'suspended'];
const MFA: readonly string[] = ['on', 'off'];
const QUERY_MAX = 100;
const CURSOR_FORMAT = /^[A-Za-z0-9_-]{1,200}$/;
const LIMIT_FORMAT = /^\d{1,3}$/;

/** Los parámetros que entiende el directorio. Cualquier otro es un pedido que no armó el panel. */
const PARAMS: readonly string[] = [
  'q',
  'status',
  'role',
  'tenantId',
  'mfa',
  'locked',
  'neverLoggedIn',
  'cursor',
  'limit',
];

const INVALID = 'Los filtros del directorio no son válidos. Recarga la página.';

/** Un parámetro que puede venir una sola vez: si se repite, el pedido no lo armó el panel. */
function single(query: URLSearchParams, name: string): string | null | undefined {
  const all = query.getAll(name);
  if (all.length > 1) return undefined;
  return all[0] ?? null;
}

/**
 * `GET /admin/users?…`: el directorio de usuarios de toda la red. Una búsqueda vacía (sólo espacios)
 * es "sin búsqueda"; el resto se valida contra lo que acepta el API.
 */
export function platformUsersListTarget(query: URLSearchParams): TenantAdminProxyTarget {
  for (const name of query.keys()) {
    if (!PARAMS.includes(name)) return { ok: false, error: INVALID };
  }
  const values = new Map<string, string | null>();
  for (const name of PARAMS) {
    const value = single(query, name);
    if (value === undefined) return { ok: false, error: INVALID };
    values.set(name, value);
  }

  const out = new URLSearchParams();
  const q = values.get('q')?.trim() ?? '';
  if (q.length > QUERY_MAX) {
    return { ok: false, error: `La búsqueda puede tener hasta ${QUERY_MAX} caracteres.` };
  }
  if (q !== '') out.set('q', q);

  const status = values.get('status');
  if (status != null) {
    if (!STATUSES.includes(status)) return { ok: false, error: INVALID };
    out.set('status', status);
  }
  const role = values.get('role');
  if (role != null) {
    if (!DIRECTORY_ROLES.includes(role)) return { ok: false, error: INVALID };
    out.set('role', role);
  }
  const tenantId = values.get('tenantId');
  if (tenantId != null) {
    if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
    out.set('tenantId', tenantId.toLowerCase());
  }
  const mfa = values.get('mfa');
  if (mfa != null) {
    if (!MFA.includes(mfa)) return { ok: false, error: INVALID };
    out.set('mfa', mfa);
  }
  for (const flag of ['locked', 'neverLoggedIn'] as const) {
    const value = values.get(flag);
    if (value == null) continue;
    if (value !== 'true') return { ok: false, error: INVALID };
    out.set(flag, 'true');
  }
  const cursor = values.get('cursor');
  if (cursor != null) {
    if (!CURSOR_FORMAT.test(cursor)) return { ok: false, error: INVALID };
    out.set('cursor', cursor);
  }
  const limit = values.get('limit');
  if (limit != null) {
    const n = LIMIT_FORMAT.test(limit) ? Number(limit) : NaN;
    if (!(n >= 1 && n <= 100)) return { ok: false, error: INVALID };
    out.set('limit', String(n));
  }

  const qs = out.toString();
  return { ok: true, path: qs === '' ? '/admin/users' : `/admin/users?${qs}` };
}

/** `GET /admin/users/:userId/impact`: qué arrastraría suspender la cuenta en toda la plataforma. */
export function platformUserImpactTarget(userId: string): TenantAdminProxyTarget {
  if (!isUuid(userId)) return { ok: false, error: 'Usuario inválido.' };
  return { ok: true, path: `/admin/users/${userId.toLowerCase()}/impact` };
}

/** `PATCH /admin/users/status`: suspender o reactivar la cuenta en toda la plataforma. */
export function platformUserStatusPlan(raw: unknown): TenantAdminProxyPlan {
  const input =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };
  const { userId, status } = input;
  if (!isUuid(userId)) return { ok: false, error: 'Usuario inválido.' };
  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    return { ok: false, error: 'El estado tiene que ser activo o suspendido.' };
  }
  return {
    ok: true,
    path: '/admin/users/status',
    body: { userId: userId.toLowerCase(), status },
  };
}
