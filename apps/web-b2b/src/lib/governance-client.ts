import {
  parseCatalog,
  parseProfile,
  parseProfiles,
  parseRules,
  parseTenantGovernance,
  type GovernanceProfile,
  type GovernanceRule,
  type GovernedProvider,
  type ProfileItem,
  type TenantGovernance,
} from './governance';
import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';

/**
 * Las llamadas del navegador al proxy del gobierno de proveedores y formas de pago
 * (`/api/admin/governance`). Cada una devuelve datos ya validados o un mensaje para la pantalla;
 * nunca lanza.
 */

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const e = (body as Record<string, unknown>)['error'];
  return typeof e === 'string' ? e : undefined;
}

/** El mensaje de una lectura o escritura fallida, para el superadmin. */
export function governanceErrorMessage(
  status: number,
  message: string | undefined,
  kind: 'read' | 'write',
): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403 && !(message && message.includes('panel'))) {
    return 'Sólo el superadmin de la plataforma puede ver y cambiar el gobierno de proveedores.';
  }
  if (message && message.trim() !== '') return message;
  return kind === 'write'
    ? 'No se pudo guardar el cambio. Inténtalo de nuevo.'
    : 'No se pudo cargar el gobierno de proveedores. Inténtalo de nuevo.';
}

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
): Promise<Loaded<T>> {
  const kind = init.method === undefined ? 'read' : 'write';
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!read.ok) return { ok: false, message: read.message };
  if (!res.ok) {
    return { ok: false, message: governanceErrorMessage(res.status, errorOf(read.data), kind) };
  }
  const data = parse(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

function jsonInit(method: 'PUT' | 'POST', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const BASE = '/api/admin/governance';

function profileUrl(id: string, action?: string): string {
  return `${BASE}/profiles/${encodeURIComponent(id)}${action === undefined ? '' : `/${action}`}`;
}

export function loadCatalog(): Promise<Loaded<GovernedProvider[]>> {
  return call(`${BASE}/catalog`, {}, parseCatalog);
}

export function loadProfiles(): Promise<Loaded<GovernanceProfile[]>> {
  return call(`${BASE}/profiles`, {}, parseProfiles);
}

export interface ProfileDraft {
  readonly name: string;
  readonly description: string;
  readonly items: readonly ProfileItem[];
}

function profileBody(draft: ProfileDraft) {
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    description: description === '' ? null : description,
    items: draft.items.map((i) => ({ provider: i.provider, method: i.method, enabled: i.enabled })),
  };
}

export function createProfile(draft: ProfileDraft): Promise<Loaded<GovernanceProfile>> {
  return call(`${BASE}/profiles`, jsonInit('POST', profileBody(draft)), parseProfile);
}

/** Reemplaza nombre, descripción y la matriz entera del perfil. */
export function updateProfile(id: string, draft: ProfileDraft): Promise<Loaded<GovernanceProfile>> {
  return call(profileUrl(id), jsonInit('PUT', profileBody(draft)), parseProfile);
}

export function duplicateProfile(id: string, name: string): Promise<Loaded<GovernanceProfile>> {
  return call(profileUrl(id, 'duplicate'), jsonInit('POST', { name: name.trim() }), parseProfile);
}

export function archiveProfile(id: string): Promise<Loaded<GovernanceProfile>> {
  return call(profileUrl(id, 'archive'), { method: 'POST' }, parseProfile);
}

export function setDefaultProfile(
  id: string,
  isDefault: boolean,
): Promise<Loaded<GovernanceProfile>> {
  return call(profileUrl(id, 'default'), jsonInit('PUT', { isDefault }), parseProfile);
}

export function loadGlobalRules(): Promise<Loaded<GovernanceRule[]>> {
  return call(`${BASE}/rules`, {}, parseRules);
}

export interface RuleChange {
  /** `null` = global. */
  readonly tenantId: string | null;
  readonly provider: string;
  /** `''` = el proveedor mismo. */
  readonly method: string;
  /** `null` = quitar la regla. */
  readonly enabled: boolean | null;
  readonly reason: string;
}

/** Fija o quita una regla a mano. Devuelve las reglas del alcance como quedaron. */
export function saveRule(change: RuleChange): Promise<Loaded<GovernanceRule[]>> {
  const reason = change.reason.trim();
  return call(
    `${BASE}/rules`,
    jsonInit('PUT', {
      tenantId: change.tenantId,
      provider: change.provider,
      method: change.method,
      enabled: change.enabled,
      ...(change.enabled === null ? {} : { reason: reason === '' ? null : reason }),
    }),
    parseRules,
  );
}

export function loadTenantGovernance(tenantId: string): Promise<Loaded<TenantGovernance>> {
  return call(`${BASE}/tenants/${encodeURIComponent(tenantId)}`, {}, parseTenantGovernance);
}

/** Asigna un perfil al nodo, o lo quita (`null`) para que vuelva a heredar. */
export function assignTenantProfile(
  tenantId: string,
  profileId: string | null,
): Promise<Loaded<TenantGovernance>> {
  return call(
    `${BASE}/tenants/${encodeURIComponent(tenantId)}/profile`,
    jsonInit('PUT', { profileId }),
    parseTenantGovernance,
  );
}
