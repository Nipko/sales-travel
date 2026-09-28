import {
  isProviderCode,
  isTenantId,
  parseEnablementBody,
  type EnablementBody,
} from './provider-enablement';

/**
 * A qué ruta del API va una escritura del panel de proveedores, y con qué cuerpo. Sin I/O, para
 * probar el borde sin levantar Next: es acá donde un código o un tenant mal formado se frena.
 */

export type EnablementProxyTarget =
  | { readonly scope: 'global'; readonly code: string }
  | { readonly scope: 'tenant'; readonly code: string; readonly tenantId: string };

export type EnablementProxyPlan =
  | { readonly ok: true; readonly path: string; readonly body?: EnablementBody }
  | { readonly ok: false; readonly error: string };

/** La lectura de un tenant: su ruta del API, o `undefined` si el id no es un UUID. */
export function tenantProvidersPath(tenantId: string): string | undefined {
  return isTenantId(tenantId) ? `/admin/providers/tenants/${tenantId.toLowerCase()}` : undefined;
}

export function enablementProxyPlan(
  method: 'PUT' | 'DELETE',
  target: EnablementProxyTarget,
  rawBody: unknown,
): EnablementProxyPlan {
  if (!isProviderCode(target.code)) return { ok: false, error: 'Código de proveedor inválido.' };
  let path = `/admin/providers/${target.code}/global`;
  if (target.scope === 'tenant') {
    if (!isTenantId(target.tenantId)) return { ok: false, error: 'Tenant inválido.' };
    path = `/admin/providers/${target.code}/tenants/${target.tenantId.toLowerCase()}`;
  }
  if (method === 'DELETE') return { ok: true, path };

  const body = parseEnablementBody(rawBody);
  if (body === undefined) {
    return {
      ok: false,
      error: 'El cambio tiene que decir si el proveedor queda habilitado, con un motivo opcional.',
    };
  }
  return { ok: true, path, body };
}
