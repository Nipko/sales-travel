import { isTenantId } from './provider-enablement';

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
