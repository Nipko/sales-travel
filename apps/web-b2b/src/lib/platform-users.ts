import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import { lastAccessLabel, lockedUntilLabel } from './tenant-admin-format';
import { requiresMfa, type MfaState } from './tenant-admin-team';
import { treeOrder, type NetworkNode } from './tenant-network';

/**
 * Plataforma → Usuarios: el directorio de personas de toda la red para el superadmin. Qué trae el
 * API, cómo se dice cada dato y qué piden las confirmaciones; y las llamadas del navegador a las
 * rutas del panel, que nunca lanzan: devuelven datos validados o un mensaje para la pantalla.
 *
 * Quién puede qué lo decide el API en cada llamada (sólo el superadmin, nunca sobre sí mismo).
 */

/** Un nodo de la persona, con su rol y el estado de su acceso a él. */
export interface PlatformUserMembership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly role: string;
  readonly status: string;
}

/** Una persona del directorio (`GET /admin/users`). */
export interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  /** El de la cuenta en toda la plataforma. */
  readonly status: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly lockedUntil: string | null;
  readonly lastLoginAt: string | null;
  readonly lastSeenAt: string | null;
  readonly activeSessions: number;
  readonly createdAt: string;
  readonly memberships: readonly PlatformUserMembership[];
}

export interface PlatformUsersPage {
  readonly users: readonly PlatformUser[];
  readonly nextCursor: string | null;
}

/** Lo que arrastraría suspender la cuenta en toda la plataforma. */
export interface UserSuspensionImpact {
  readonly activeMemberships: number;
  readonly liveSessions: number;
  readonly invitationsToRevoke: number;
}

/** Lo que cortó una suspensión, según el API. */
export interface UserStatusResult {
  readonly status: 'active' | 'suspended';
  readonly revokedSessions: number;
  readonly revokedInvitations: number;
}

/** Los filtros de la pantalla. Una búsqueda vacía es "sin búsqueda". */
export interface DirectoryFilters {
  readonly q: string;
  readonly status?: 'active' | 'suspended';
  readonly withoutMfa?: boolean;
  readonly locked?: boolean;
  readonly neverLoggedIn?: boolean;
  readonly role?: string;
  readonly tenantId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseMembership(value: unknown): PlatformUserMembership | undefined {
  const r = asRecord(value);
  const tenantId = str(r?.['tenantId']);
  const tenantName = str(r?.['tenantName']);
  const role = str(r?.['role']);
  const status = str(r?.['status']);
  if (r === undefined || tenantId === undefined || tenantName === undefined) return undefined;
  if (role === undefined || status === undefined) return undefined;
  return {
    tenantId,
    tenantName,
    tenantType: str(r['tenantType']) ?? '',
    isBranch: r['isBranch'] === true,
    role,
    status,
  };
}

/** Una persona; `undefined` si le falta lo mínimo para mostrarla y actuar sobre ella. */
export function parsePlatformUser(value: unknown): PlatformUser | undefined {
  const r = asRecord(value);
  const id = str(r?.['id']);
  const email = str(r?.['email']);
  const status = str(r?.['status']);
  if (r === undefined || id === undefined || email === undefined || status === undefined) {
    return undefined;
  }
  const memberships = Array.isArray(r['memberships']) ? r['memberships'] : [];
  return {
    id,
    email,
    name: nullableStr(r['name']) ?? null,
    status,
    emailVerified: r['emailVerified'] !== false,
    mfaEnabled: r['mfaEnabled'] === true,
    lockedUntil: nullableStr(r['lockedUntil']) ?? null,
    lastLoginAt: nullableStr(r['lastLoginAt']) ?? null,
    lastSeenAt: nullableStr(r['lastSeenAt']) ?? null,
    activeSessions: count(r['activeSessions']) ?? 0,
    createdAt: str(r['createdAt']) ?? '',
    memberships: memberships.flatMap((m) => {
      const parsed = parseMembership(m);
      return parsed === undefined ? [] : [parsed];
    }),
  };
}

/** `{ users, nextCursor }`. `undefined` si la forma no es la esperada (es un error, no un vacío). */
export function parsePlatformUsersPage(value: unknown): PlatformUsersPage | undefined {
  const r = asRecord(value);
  if (r === undefined || !Array.isArray(r['users'])) return undefined;
  const cursor = r['nextCursor'];
  if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') return undefined;
  return {
    users: r['users'].flatMap((u) => {
      const parsed = parsePlatformUser(u);
      return parsed === undefined ? [] : [parsed];
    }),
    nextCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null,
  };
}

export function parseSuspensionImpact(value: unknown): UserSuspensionImpact | undefined {
  const r = asRecord(value);
  const activeMemberships = count(r?.['activeMemberships']);
  const liveSessions = count(r?.['liveSessions']);
  const invitationsToRevoke = count(r?.['invitationsToRevoke']);
  if (
    activeMemberships === undefined ||
    liveSessions === undefined ||
    invitationsToRevoke === undefined
  ) {
    return undefined;
  }
  return { activeMemberships, liveSessions, invitationsToRevoke };
}

export function parseUserStatusResult(value: unknown): UserStatusResult | undefined {
  const r = asRecord(value);
  const status = r?.['status'];
  if (status !== 'active' && status !== 'suspended') return undefined;
  return {
    status,
    revokedSessions: count(r?.['revokedSessions']) ?? 0,
    revokedInvitations: count(r?.['revokedInvitations']) ?? 0,
  };
}

/** Los nodos de `/admin/tenants` para el selector, en el orden del árbol. */
export function parseDirectoryNodes(value: unknown): NetworkNode[] | undefined {
  const list = asRecord(value)?.['tenants'];
  if (!Array.isArray(list)) return undefined;
  const nodes = list.flatMap((item): NetworkNode[] => {
    const r = asRecord(item);
    const id = str(r?.['id']);
    const name = str(r?.['name']);
    if (r === undefined || id === undefined || name === undefined) return [];
    const depth = r['depth'];
    return [
      {
        id: id.toLowerCase(),
        slug: str(r['slug']) ?? '',
        name,
        tenantType: str(r['tenantType']) ?? '',
        isBranch: r['isBranch'] === true,
        parentTenantId: str(r['parentTenantId'])?.toLowerCase() ?? null,
        status: str(r['status']) ?? 'active',
        depth: typeof depth === 'number' && depth >= 1 ? depth : 1,
      },
    ];
  });
  return treeOrder(nodes);
}

/** La consulta del directorio para la ruta del panel. */
export function directorySearch(filters: DirectoryFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q !== '') params.set('q', q);
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.role) params.set('role', filters.role);
  if (filters.tenantId) params.set('tenantId', filters.tenantId);
  if (filters.withoutMfa) params.set('mfa', 'off');
  if (filters.locked) params.set('locked', 'true');
  if (filters.neverLoggedIn) params.set('neverLoggedIn', 'true');
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

/** ¿Hay algún filtro puesto, además de la búsqueda? */
export function hasFilters(filters: DirectoryFilters): boolean {
  return directorySearch({ ...filters, q: '' }) !== '';
}

export type DirectoryChip = 'active' | 'suspended' | 'withoutMfa' | 'locked' | 'neverLoggedIn';

export const DIRECTORY_CHIPS: readonly { readonly id: DirectoryChip; readonly label: string }[] = [
  { id: 'active', label: 'Activos' },
  { id: 'suspended', label: 'Suspendidos' },
  { id: 'withoutMfa', label: 'Sin 2FA' },
  { id: 'locked', label: 'Bloqueados' },
  { id: 'neverLoggedIn', label: 'Nunca ingresaron' },
];

/** Lo que prenden y apagan los filtros rápidos. */
type ChipFilters = Pick<DirectoryFilters, 'status' | 'withoutMfa' | 'locked' | 'neverLoggedIn'>;

export function chipPressed(filters: ChipFilters, chip: DirectoryChip): boolean {
  switch (chip) {
    case 'active':
    case 'suspended':
      return filters.status === chip;
    default:
      return filters[chip] === true;
  }
}

/** Prender o apagar un filtro. "Activos" y "Suspendidos" se excluyen entre sí. */
export function toggleChip<T extends ChipFilters>(filters: T, chip: DirectoryChip): T {
  switch (chip) {
    case 'active':
    case 'suspended':
      return { ...filters, status: filters.status === chip ? undefined : chip };
    default:
      return { ...filters, [chip]: filters[chip] !== true };
  }
}

/** El nombre con que se nombra a una persona: el suyo o, si no lo puso, su correo. */
export function platformUserName(user: Pick<PlatformUser, 'name' | 'email'>): string {
  return user.name?.trim() || user.email;
}

export type AccountTone = 'ok' | 'danger' | 'warn';

/**
 * El estado de la cuenta: suspendida en toda la plataforma pesa más que un bloqueo, y el bloqueo
 * sólo mientras siga vigente.
 */
export function accountStatus(
  user: Pick<PlatformUser, 'status' | 'lockedUntil'>,
  now: number,
): { readonly label: string; readonly tone: AccountTone } {
  if (user.status === 'suspended') {
    return { label: 'Suspendido en toda la plataforma', tone: 'danger' };
  }
  const locked = lockedUntilLabel(user.lockedUntil, now);
  if (locked !== undefined) return { label: locked, tone: 'warn' };
  return { label: 'Activo', tone: 'ok' };
}

/** El último acceso: su actividad más reciente o, sin sesiones, su último ingreso. */
export function lastAccess(
  user: Pick<PlatformUser, 'lastSeenAt' | 'lastLoginAt' | 'activeSessions'>,
  now: number,
): { readonly label: string; readonly at: string | null; readonly online: boolean } {
  const at = user.lastSeenAt ?? user.lastLoginAt;
  return { label: lastAccessLabel(at, now), at, online: user.activeSessions > 0 };
}

/**
 * El 2FA de la persona. "Pendiente" si alguno de sus accesos activos tiene un rol que lo exige: el
 * próximo ingreso la obliga a activarlo.
 */
export function directoryMfaState(
  user: Pick<PlatformUser, 'mfaEnabled' | 'memberships'>,
): Exclude<MfaState, 'unknown'> {
  if (user.mfaEnabled) return 'active';
  return user.memberships.some((m) => m.status === 'active' && requiresMfa(m.role))
    ? 'pending'
    : 'not-required';
}

/** Las chips "Nodo · Rol": las primeras `max` y cuántas quedan para "+N". */
export function membershipChips(
  user: Pick<PlatformUser, 'memberships'>,
  max = 2,
): { readonly shown: readonly PlatformUserMembership[]; readonly more: number } {
  return {
    shown: user.memberships.slice(0, max),
    more: Math.max(0, user.memberships.length - max),
  };
}

export function membershipChipLabel(
  membership: Pick<PlatformUserMembership, 'tenantName' | 'role'>,
  roleLabel: (role: string) => string,
): string {
  return `${membership.tenantName} · ${roleLabel(membership.role)}`;
}

/** "Ver en Equipo": el equipo del primer nodo de la persona (el activo más alto). */
export function teamHref(user: Pick<PlatformUser, 'memberships'>): string | undefined {
  const first = user.memberships[0];
  if (first === undefined) return undefined;
  return `/admin/usuarios?${new URLSearchParams({ tenant: first.tenantId }).toString()}`;
}

export interface ConfirmCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

function nodesClause(n: number): string {
  if (n === 0) return 'Pierde el acceso a la plataforma de inmediato';
  if (n === 1) return 'Pierde el acceso a su nodo de inmediato';
  return `Pierde el acceso a sus ${n} nodos de inmediato`;
}

/**
 * La confirmación de suspender una cuenta en toda la plataforma. Con `impact` en `null` (no
 * pudimos saberlo) lo dice sin números.
 */
export function suspendCopy(
  user: Pick<PlatformUser, 'name' | 'email'>,
  impact: UserSuspensionImpact | null,
): ConfirmCopy {
  const title = `Suspender a ${platformUserName(user)} en toda la plataforma`;
  const confirmLabel = 'Suspender en toda la plataforma';
  if (impact === null) {
    return {
      title,
      confirmLabel,
      description:
        'Pierde el acceso a todos sus nodos de inmediato: se cierran sus sesiones y se revocan las invitaciones que envió. Puedes reactivarlo después; sus sesiones e invitaciones no vuelven.',
    };
  }
  const lost: string[] = [];
  if (impact.liveSessions === 1) lost.push('se cierra su sesión abierta');
  if (impact.liveSessions > 1) lost.push(`se cierran sus ${impact.liveSessions} sesiones`);
  if (impact.invitationsToRevoke === 1) lost.push('se revoca 1 invitación que envió');
  if (impact.invitationsToRevoke > 1) {
    lost.push(`se revocan ${impact.invitationsToRevoke} invitaciones que envió`);
  }
  const description =
    lost.length === 0
      ? `${nodesClause(impact.activeMemberships)}. Puedes reactivarlo después.`
      : `${nodesClause(impact.activeMemberships)}: ${lost.join(' y ')}. Puedes reactivarlo después; sus sesiones e invitaciones no vuelven.`;
  return { title, confirmLabel, description };
}

export function reactivateCopy(user: Pick<PlatformUser, 'name' | 'email'>): ConfirmCopy {
  return {
    title: `Reactivar la cuenta de ${platformUserName(user)}`,
    description:
      'Vuelve a poder ingresar a los nodos donde su acceso esté activo. Los accesos suspendidos por nodo siguen suspendidos.',
    confirmLabel: 'Reactivar',
  };
}

/** El aviso de éxito, con lo que cortó la suspensión según el API. */
export function statusDoneMessage(
  user: Pick<PlatformUser, 'name' | 'email'>,
  result: UserStatusResult,
): string {
  const name = platformUserName(user);
  if (result.status === 'active') return `Reactivamos la cuenta de ${name}.`;
  const cut: string[] = [];
  if (result.revokedSessions === 1) cut.push('se cerró 1 sesión');
  if (result.revokedSessions > 1) cut.push(`se cerraron ${result.revokedSessions} sesiones`);
  if (result.revokedInvitations === 1) cut.push('se revocó 1 invitación');
  if (result.revokedInvitations > 1) {
    cut.push(`se revocaron ${result.revokedInvitations} invitaciones`);
  }
  const tail = cut.length === 0 ? '' : ` ${cut.join(' y ').replace(/^s/, 'S')}.`;
  return `${name} quedó suspendido en toda la plataforma.${tail}`;
}

/** Por qué no cargó el directorio, según el estado: sesión, permiso o servidor. */
export function directoryLoadError(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'Esta pantalla es sólo para el superadmin.';
  if (status >= 500) {
    return 'No pudimos cargar los usuarios: el servidor no respondió. Inténtalo de nuevo en unos minutos.';
  }
  return message?.trim() || 'No pudimos cargar los usuarios. Inténtalo de nuevo.';
}

/** Por qué no se aplicó una suspensión o reactivación. Los 4xx traen su motivo en castellano. */
export function statusChangeError(
  status: number,
  message: string | undefined,
  suspending: boolean,
): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status >= 500) {
    return `No pudimos ${suspending ? 'suspender' : 'reactivar'} la cuenta: el servidor no respondió. Inténtalo de nuevo.`;
  }
  return (
    message?.trim() ||
    (status === 403
      ? 'Esta acción es sólo para el superadmin.'
      : `No pudimos ${suspending ? 'suspender' : 'reactivar'} la cuenta.`)
  );
}

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

function errorOf(body: unknown): string | undefined {
  return str(asRecord(body)?.['error']);
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

/** Una página del directorio con estos filtros (`cursor` = la siguiente). */
export function loadPlatformUsers(
  filters: DirectoryFilters,
  cursor?: string | null,
): Promise<Loaded<PlatformUsersPage>> {
  const search = directorySearch(filters, cursor);
  return call(
    search === '' ? '/api/admin/users' : `/api/admin/users?${search}`,
    {},
    parsePlatformUsersPage,
    directoryLoadError,
  );
}

/** Los nodos de la red para el filtro "Nodo". */
export function loadDirectoryNodes(): Promise<Loaded<NetworkNode[]>> {
  return call('/api/admin/tenants', {}, parseDirectoryNodes, (status) =>
    status === 403
      ? 'Esta pantalla es sólo para el superadmin.'
      : 'No pudimos cargar los nodos de la red.',
  );
}

export function loadSuspensionImpact(userId: string): Promise<Loaded<UserSuspensionImpact>> {
  return call(
    `/api/admin/users/${encodeURIComponent(userId)}/impact`,
    {},
    parseSuspensionImpact,
    (status, message) => statusChangeError(status, message, true),
  );
}

export function setPlatformUserStatus(
  userId: string,
  status: 'active' | 'suspended',
): Promise<Loaded<UserStatusResult>> {
  return call(
    '/api/admin/users/status',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, status }),
    },
    parseUserStatusResult,
    (code, message) => statusChangeError(code, message, status === 'suspended'),
  );
}
