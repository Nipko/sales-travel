import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import { isTenantType, type NetworkNode } from './tenant-network';

/**
 * Las llamadas del navegador para armar y corregir la red desde "Gestión de Agencias"
 * (`/api/admin/tenants`). Cada una devuelve datos ya validados o un mensaje para la pantalla;
 * nunca lanza.
 */

/** Un nodo de la red en el panel del superadmin (`GET /admin/tenants`). */
export interface AdminNetworkNode extends NetworkNode {
  readonly isBranch: boolean;
  readonly parentName: string | null;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly userCount: number;
  readonly createdAt: string;
}

/** Lo que devuelven el PATCH y el movimiento: el nodo como quedó. */
export interface TenantStateView {
  readonly id: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly parentTenantId: string | null;
  readonly status: string;
  readonly depth: number;
}

export interface NewNodeInput {
  readonly name: string;
  readonly slug: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly defaultLanguage: 'es' | 'pt' | 'en';
  readonly parentTenantId: string;
  readonly tenantType: 'consolidator' | 'agency' | 'subagency';
  readonly isBranch?: true;
  readonly adminEmail?: string;
  readonly adminName?: string;
  readonly adminPassword?: string;
  /** Puestos simultáneos propios (1-10000). Ausente = comparte el cupo del padre. Sólo superadmin. */
  readonly concurrentSeats?: number;
  /** Minutos de inactividad (5-480). Ausente = hereda. Sólo superadmin. */
  readonly idleTimeoutMinutes?: number;
}

/** Qué pasó con el admin inicial (TenantsService.create). */
export type InitialAdminOutcome = 'created' | 'invited' | 'invite_failed';

export interface CreatedNode {
  readonly tenant: TenantStateView;
  readonly admin?: { readonly email: string; readonly status: InitialAdminOutcome };
}

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recargá la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.';

/** Los mensajes del API que todavía salen en inglés, dichos para el superadmin. */
const KNOWN_MESSAGES: Readonly<Record<string, string>> = {
  'superadmin access required':
    'Sólo el superadmin de la plataforma puede armar y corregir la red.',
};

/** El mensaje de una llamada fallida, para la pantalla. */
export function tenantAdminErrorMessage(
  status: number,
  message: string | undefined,
  kind: 'read' | 'write',
): string {
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  const text = message?.trim() ?? '';
  if (text !== '') return KNOWN_MESSAGES[text] ?? text;
  if (status === 403) return 'Sólo el superadmin de la plataforma puede armar y corregir la red.';
  return kind === 'write'
    ? 'No se pudo guardar el cambio. Probá de nuevo.'
    : 'No se pudo cargar la red. Probá de nuevo.';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseState(value: unknown): TenantStateView | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const id = str(r['id']);
  const tenantType = str(r['tenantType']);
  const status = str(r['status']);
  const depth = r['depth'];
  const parent = r['parentTenantId'];
  if (id === undefined || tenantType === undefined || status === undefined) return undefined;
  if (typeof depth !== 'number' || (parent !== null && typeof parent !== 'string')) {
    return undefined;
  }
  return {
    id: id.toLowerCase(),
    tenantType,
    isBranch: r['isBranch'] === true,
    parentTenantId: parent === null ? null : parent.toLowerCase(),
    status,
    depth,
  };
}

function parseNode(value: unknown): AdminNetworkNode | undefined {
  const r = asRecord(value);
  const state = parseState(value);
  if (r === undefined || state === undefined) return undefined;
  const slug = str(r['slug']);
  const name = str(r['name']);
  if (slug === undefined || name === undefined) return undefined;
  const userCount = r['userCount'];
  return {
    ...state,
    slug,
    name,
    parentName: str(r['parentName']) ?? null,
    countryCode: str(r['countryCode']) ?? '',
    defaultCurrency: str(r['defaultCurrency']) ?? '',
    userCount: typeof userCount === 'number' ? userCount : 0,
    createdAt: str(r['createdAt']) ?? '',
  };
}

/**
 * La red de `GET /admin/tenants`. Un nodo con un tipo que el panel no conoce se descarta: no hay
 * cómo ofrecerle acciones correctas. `undefined` si la forma no es la esperada.
 */
export function parseAdminNodes(value: unknown): AdminNetworkNode[] | undefined {
  const list = asRecord(value)?.['tenants'];
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((item) => {
    const node = parseNode(item);
    return node !== undefined && isTenantType(node.tenantType) ? [node] : [];
  });
}

export function parseCreatedNode(value: unknown): CreatedNode | undefined {
  const r = asRecord(value);
  const tenant = parseState(r?.['tenant']);
  if (tenant === undefined) return undefined;
  const admin = asRecord(r?.['admin']);
  const email = str(admin?.['email']);
  const status = str(admin?.['status']);
  const outcome =
    status === 'created' || status === 'invited' || status === 'invite_failed' ? status : undefined;
  return email !== undefined && outcome !== undefined
    ? { tenant, admin: { email, status: outcome } }
    : { tenant };
}

function parseUpdated(value: unknown): TenantStateView | undefined {
  return parseState(asRecord(value)?.['tenant']);
}

function errorOf(body: unknown): string | undefined {
  return str(asRecord(body)?.['error']);
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
    return { ok: false, message: tenantAdminErrorMessage(res.status, errorOf(read.data), kind) };
  }
  const data = parse(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function loadAdminNetwork(): Promise<Loaded<AdminNetworkNode[]>> {
  return call('/api/admin/tenants', {}, parseAdminNodes);
}

export function createNode(input: NewNodeInput): Promise<Loaded<CreatedNode>> {
  return call('/api/admin/tenants', json('POST', input), parseCreatedNode);
}

export function updateNode(
  tenantId: string,
  patch: { readonly status?: 'active' | 'suspended'; readonly isBranch?: boolean },
): Promise<Loaded<TenantStateView>> {
  return call(
    `/api/admin/tenants/${encodeURIComponent(tenantId)}`,
    json('PATCH', patch),
    parseUpdated,
  );
}

export function moveNode(
  tenantId: string,
  parentTenantId: string,
): Promise<Loaded<{ readonly moved: number; readonly tenant: TenantStateView }>> {
  return call(
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/move`,
    json('POST', { parentTenantId }),
    (value) => {
      const tenant = parseUpdated(value);
      const moved = asRecord(value)?.['moved'];
      return tenant !== undefined && typeof moved === 'number' ? { moved, tenant } : undefined;
    },
  );
}
