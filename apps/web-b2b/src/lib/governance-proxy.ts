import {
  DESCRIPTION_MAX,
  isGovernanceMethodCode,
  isGovernanceProviderCode,
  parseOptionalText,
  parseProfileItems,
  parseProfileName,
  REASON_MAX,
} from './governance';
import { isTenantId } from './provider-enablement';
import type { TenantAdminProxyPlan, TenantAdminProxyTarget } from './tenant-admin-proxy';

/**
 * A qué ruta del API va cada llamada del panel de gobierno, y con qué cuerpo. Sin I/O, para probar
 * el borde sin levantar Next: un id o un código mal formado se frena acá y el cuerpo se rearma
 * campo por campo (al API nunca le llega lo que el navegador haya querido agregar). Quién puede
 * hacerlo —sólo el superadmin— lo decide el API.
 */

const BASE = '/admin/governance';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const INVALID_PROFILE = { ok: false, error: 'Perfil inválido.' } as const;
const INVALID_TENANT = { ok: false, error: 'Nodo inválido.' } as const;
const NAME_ERROR = 'El nombre del perfil lleva entre 2 y 80 caracteres.';
const DESCRIPTION_ERROR = `La descripción no puede superar los ${DESCRIPTION_MAX} caracteres.`;
const ITEMS_ERROR =
  'La matriz del perfil no se pudo leer: cada elemento lleva proveedor, forma de pago y si queda encendido.';

export function catalogTarget(): TenantAdminProxyTarget {
  return { ok: true, path: `${BASE}/catalog` };
}

export function profilesTarget(): TenantAdminProxyTarget {
  return { ok: true, path: `${BASE}/profiles` };
}

export function globalRulesTarget(): TenantAdminProxyTarget {
  return { ok: true, path: `${BASE}/rules` };
}

export function tenantGovernanceTarget(tenantId: string): TenantAdminProxyTarget {
  if (!isTenantId(tenantId)) return INVALID_TENANT;
  return { ok: true, path: `${BASE}/tenants/${tenantId.toLowerCase()}` };
}

/** `POST /admin/governance/profiles/:id/archive`: sin cuerpo. */
export function archiveProfileTarget(profileId: string): TenantAdminProxyTarget {
  if (!isTenantId(profileId)) return INVALID_PROFILE;
  return { ok: true, path: `${BASE}/profiles/${profileId.toLowerCase()}/archive` };
}

/** `POST /admin/governance/profiles`: nombre, descripción opcional y la matriz completa. */
export function createProfilePlan(raw: unknown): TenantAdminProxyPlan {
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El perfil no se pudo leer.' };
  const name = parseProfileName(input['name']);
  if (name === undefined) return { ok: false, error: NAME_ERROR };
  const description = parseOptionalText(input['description'], DESCRIPTION_MAX);
  if (description === undefined) return { ok: false, error: DESCRIPTION_ERROR };
  const items = parseProfileItems(input['items']);
  if (items === undefined) return { ok: false, error: ITEMS_ERROR };
  return { ok: true, path: `${BASE}/profiles`, body: { name, description, items } };
}

/**
 * `PUT /admin/governance/profiles/:id`: sólo lo que viene. `items` reemplaza la matriz entera; el
 * perfil está enlazado, así que el cambio alcanza a todos los nodos que lo usan.
 */
export function updateProfilePlan(profileId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(profileId)) return INVALID_PROFILE;
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'El cambio no se pudo leer.' };
  const body: Record<string, unknown> = {};
  if (input['name'] !== undefined) {
    const name = parseProfileName(input['name']);
    if (name === undefined) return { ok: false, error: NAME_ERROR };
    body['name'] = name;
  }
  if (input['description'] !== undefined) {
    const description = parseOptionalText(input['description'], DESCRIPTION_MAX);
    if (description === undefined) return { ok: false, error: DESCRIPTION_ERROR };
    body['description'] = description;
  }
  if (input['items'] !== undefined) {
    const items = parseProfileItems(input['items']);
    if (items === undefined) return { ok: false, error: ITEMS_ERROR };
    body['items'] = items;
  }
  if (Object.keys(body).length === 0) return { ok: false, error: 'No hay nada que cambiar.' };
  return { ok: true, path: `${BASE}/profiles/${profileId.toLowerCase()}`, body };
}

export function duplicateProfilePlan(profileId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(profileId)) return INVALID_PROFILE;
  const name = parseProfileName(asRecord(raw)?.['name']);
  if (name === undefined) return { ok: false, error: NAME_ERROR };
  return {
    ok: true,
    path: `${BASE}/profiles/${profileId.toLowerCase()}/duplicate`,
    body: { name },
  };
}

export function setDefaultProfilePlan(profileId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(profileId)) return INVALID_PROFILE;
  const isDefault = asRecord(raw)?.['isDefault'];
  if (typeof isDefault !== 'boolean') {
    return { ok: false, error: 'Falta decir si el perfil queda como predeterminado.' };
  }
  return {
    ok: true,
    path: `${BASE}/profiles/${profileId.toLowerCase()}/default`,
    body: { isDefault },
  };
}

/** `PUT /admin/governance/tenants/:tenantId/profile`: `null` quita el perfil (vuelve a heredar). */
export function assignProfilePlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return INVALID_TENANT;
  const input = asRecord(raw);
  const profileId = input?.['profileId'];
  if (input === undefined || profileId === undefined) {
    return { ok: false, error: 'Elige un perfil o «Ninguno».' };
  }
  if (profileId !== null && (typeof profileId !== 'string' || !isTenantId(profileId))) {
    return INVALID_PROFILE;
  }
  return {
    ok: true,
    path: `${BASE}/tenants/${tenantId.toLowerCase()}/profile`,
    body: { profileId: profileId === null ? null : profileId.toLowerCase() },
  };
}

/**
 * `PUT /admin/governance/rules`: una regla a mano. `tenantId: null` = global; `enabled: null` =
 * quitar la regla.
 */
export function setRulePlan(raw: unknown): TenantAdminProxyPlan {
  const input = asRecord(raw);
  if (input === undefined) return { ok: false, error: 'La regla no se pudo leer.' };
  const { tenantId, provider, enabled, reason } = input;
  const method = input['method'] ?? '';
  if (tenantId !== null && (typeof tenantId !== 'string' || !isTenantId(tenantId))) {
    return INVALID_TENANT;
  }
  if (!isGovernanceProviderCode(provider)) {
    return { ok: false, error: 'Código de proveedor inválido.' };
  }
  if (!isGovernanceMethodCode(method)) {
    return { ok: false, error: 'Código de forma de pago inválido.' };
  }
  if (enabled !== null && typeof enabled !== 'boolean') {
    return { ok: false, error: 'La regla tiene que decir si queda encendida, apagada o se quita.' };
  }
  const normalizedReason = parseOptionalText(reason, REASON_MAX);
  if (normalizedReason === undefined) {
    return { ok: false, error: `El motivo no puede superar los ${REASON_MAX} caracteres.` };
  }
  return {
    ok: true,
    path: `${BASE}/rules`,
    body: {
      tenantId: tenantId === null ? null : tenantId.toLowerCase(),
      provider,
      method,
      enabled,
      ...(enabled === null ? {} : { reason: normalizedReason }),
    },
  };
}
