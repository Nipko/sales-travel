import {
  accessSuspended,
  isLocked,
  mfaState,
  roleRank,
  type NetworkMember,
} from './tenant-admin-team';

/**
 * Los filtros de Equipo: quién necesita atención (2FA pendiente, bloqueado, nunca ingresó, cambio
 * de contraseña pendiente), por rol, sin los suspendidos y en qué orden. Sin I/O y con `now`
 * explícito.
 *
 * Corren en el navegador sobre la lista que ya trajo el API: el equipo de un nodo llega entero y es
 * chico, así que no hace falta otra consulta. Quedan en la URL (`?filtro=…`) para que sobrevivan a
 * una recarga y viajen en un enlace.
 */

/** Los filtros rápidos. Uno a la vez: "Todos" es ninguno. */
export type TeamChip = 'mfa-pending' | 'locked' | 'never-logged-in' | 'reset-pending';

/** El orden de la lista. `default` es el del API: por fecha de alta en el nodo. */
export type TeamSort = 'default' | 'last-access-desc' | 'last-access-asc';

export interface TeamFilters {
  readonly chip: TeamChip | null;
  readonly role: string | null;
  readonly hideSuspended: boolean;
  readonly sort: TeamSort;
}

export const DEFAULT_TEAM_FILTERS: TeamFilters = {
  chip: null,
  role: null,
  hideSuspended: false,
  sort: 'default',
};

export const TEAM_CHIPS: readonly {
  readonly id: TeamChip;
  readonly label: string;
  /** Cómo va en `?filtro=`. */
  readonly param: string;
}[] = [
  { id: 'mfa-pending', label: '2FA pendiente', param: '2fa-pendiente' },
  { id: 'locked', label: 'Bloqueados', param: 'bloqueados' },
  { id: 'never-logged-in', label: 'Nunca ingresaron', param: 'nunca-ingresaron' },
  { id: 'reset-pending', label: 'Cambio de contraseña pendiente', param: 'cambio-de-contrasena' },
];

export const TEAM_SORTS: readonly {
  readonly id: TeamSort;
  readonly label: string;
  /** Cómo va en `?orden=`; el de por defecto no se escribe. */
  readonly param: string | null;
}[] = [
  { id: 'default', label: 'Fecha de alta', param: null },
  {
    id: 'last-access-desc',
    label: 'Último acceso: más reciente primero',
    param: 'acceso-reciente',
  },
  { id: 'last-access-asc', label: 'Último acceso: más antiguo primero', param: 'acceso-antiguo' },
];

// ───────────────────────── Predicados ─────────────────────────

/** Su rol en este nodo exige 2FA y no lo activó: el próximo ingreso lo obliga a enrolarse. */
export function pendingMfa(member: Pick<NetworkMember, 'mfaEnabled' | 'role'>): boolean {
  return mfaState(member) === 'pending';
}

/** Tiene un bloqueo por intentos fallidos vigente. */
export function locked(member: Pick<NetworkMember, 'lockedUntil'>, now: number): boolean {
  return isLocked(member, now);
}

/**
 * Nunca completó un ingreso. `null` y no `undefined`: si el API no manda el dato, no sabemos, y
 * no se lo cuenta como alguien que nunca entró.
 */
export function neverLoggedIn(member: Pick<NetworkMember, 'lastLoginAt'>): boolean {
  return member.lastLoginAt === null;
}

/** Su acceso está suspendido, en este nodo o en toda la plataforma. */
export function suspended(member: Pick<NetworkMember, 'userStatus' | 'membershipStatus'>): boolean {
  return accessSuspended(member);
}

/** Un admin le pidió elegir una contraseña nueva y todavía no lo hizo. */
export function resetPending(member: Pick<NetworkMember, 'passwordResetRequired'>): boolean {
  return member.passwordResetRequired === true;
}

export function byRole(member: Pick<NetworkMember, 'role'>, role: string | null): boolean {
  return role === null || member.role === role;
}

export function matchesChip(member: NetworkMember, chip: TeamChip | null, now: number): boolean {
  switch (chip) {
    case null:
      return true;
    case 'mfa-pending':
      return pendingMfa(member);
    case 'locked':
      return locked(member, now);
    case 'never-logged-in':
      return neverLoggedIn(member);
    case 'reset-pending':
      return resetPending(member);
  }
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** La búsqueda por nombre o correo, sin mayúsculas ni tildes. */
export function matchesSearch(
  member: Pick<NetworkMember, 'name' | 'email'>,
  query: string,
): boolean {
  const q = fold(query.trim());
  if (q === '') return true;
  return fold(member.email).includes(q) || fold(member.name ?? '').includes(q);
}

// ───────────────────────── La lista ─────────────────────────

/** Lo que filtra antes de los filtros rápidos: búsqueda, rol y suspendidos. */
function baseOf(
  members: readonly NetworkMember[],
  filters: TeamFilters,
  search: string,
): NetworkMember[] {
  return members.filter(
    (m) =>
      matchesSearch(m, search) &&
      byRole(m, filters.role) &&
      !(filters.hideSuspended && suspended(m)),
  );
}

/**
 * Cuántos hay en cada filtro rápido con lo demás que está puesto (búsqueda, rol, suspendidos): el
 * número de la chip es el de filas que deja al elegirla.
 */
export function chipCounts(
  members: readonly NetworkMember[],
  filters: TeamFilters,
  search: string,
  now: number,
): Readonly<Record<TeamChip, number>> {
  const base = baseOf(members, filters, search);
  const count = (chip: TeamChip) => base.filter((m) => matchesChip(m, chip, now)).length;
  return {
    'mfa-pending': count('mfa-pending'),
    locked: count('locked'),
    'never-logged-in': count('never-logged-in'),
    'reset-pending': count('reset-pending'),
  };
}

/**
 * Cuántas filas esconde "Ocultar suspendidos" con lo demás puesto (búsqueda, rol y filtro rápido):
 * sin el filtro rápido, con "Bloqueados" elegido prometía esconder a suspendidos que no estaban en
 * la lista y al marcarla no cambiaba nada.
 */
export function suspendedCount(
  members: readonly NetworkMember[],
  filters: TeamFilters,
  search: string,
  now: number,
): number {
  return baseOf(members, { ...filters, hideSuspended: false }, search).filter(
    (m) => suspended(m) && matchesChip(m, filters.chip, now),
  ).length;
}

/** El último ingreso como número; sin ingreso (o ilegible) es el más antiguo de todos. */
function accessTime(member: Pick<NetworkMember, 'lastLoginAt'>): number {
  const t = typeof member.lastLoginAt === 'string' ? Date.parse(member.lastLoginAt) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * La lista en el orden pedido. Quien nunca ingresó cuenta como el acceso más antiguo: primero en
 * "más antiguo primero", último en "más reciente primero". Los empates conservan el orden del API.
 */
export function sortMembers<T extends Pick<NetworkMember, 'lastLoginAt'>>(
  members: readonly T[],
  sort: TeamSort,
): T[] {
  if (sort === 'default') return [...members];
  const dir = sort === 'last-access-desc' ? -1 : 1;
  return [...members].sort((a, b) => {
    const x = accessTime(a);
    const y = accessTime(b);
    if (x === y) return 0;
    return x < y ? -dir : dir;
  });
}

/** Los miembros que se ven, en orden: búsqueda, rol, suspendidos, filtro rápido y orden. */
export function applyTeamFilters(
  members: readonly NetworkMember[],
  filters: TeamFilters,
  search: string,
  now: number,
): NetworkMember[] {
  const shown = baseOf(members, filters, search).filter((m) => matchesChip(m, filters.chip, now));
  return sortMembers(shown, filters.sort);
}

/** Lo que se anuncia al lector de pantalla cuando un filtro o la búsqueda cambian la lista. */
export function shownMembersText(shown: number, total: number): string {
  if (shown === total) {
    return total === 1 ? 'Se muestra el único miembro.' : `Se muestran los ${total} miembros.`;
  }
  if (shown === 0) return 'Ningún miembro coincide.';
  return `Se ${shown === 1 ? 'muestra' : 'muestran'} ${shown} de ${total} miembros.`;
}

/** ¿Hay algún filtro puesto? La búsqueda y el orden no cuentan: no esconden a nadie por sí. */
export function hasActiveFilters(filters: TeamFilters): boolean {
  return filters.chip !== null || filters.role !== null || filters.hideSuspended;
}

/** "Quitar filtros": vuelve a mostrar a todos y conserva el orden elegido. */
export function clearTeamFilters(filters: TeamFilters): TeamFilters {
  return { ...DEFAULT_TEAM_FILTERS, sort: filters.sort };
}

/** El encabezado "Último acceso" alterna: sin ordenar → más reciente → más antiguo → sin ordenar. */
export function nextSort(sort: TeamSort): TeamSort {
  if (sort === 'default') return 'last-access-desc';
  if (sort === 'last-access-desc') return 'last-access-asc';
  return 'default';
}

/**
 * Los roles del selector: los que hay en el nodo, del más alto al más bajo. El elegido entra aunque
 * nadie lo tenga (vino en un enlace o es de otro nodo), para que el selector lo muestre y se pueda
 * quitar.
 */
export function roleOptions(
  members: readonly Pick<NetworkMember, 'role'>[],
  selected: string | null,
): string[] {
  const roles = new Set(members.map((m) => m.role));
  if (selected !== null) roles.add(selected);
  return [...roles].sort((a, b) => roleRank(b) - roleRank(a) || a.localeCompare(b));
}

// ───────────────────────── La URL ─────────────────────────

const PARAMS = { chip: 'filtro', role: 'rol', suspended: 'suspendidos', sort: 'orden' } as const;

const HIDDEN = 'ocultos';

/** Un rol tal como lo guarda la base: minúsculas y guion bajo. Lo demás no llega al selector. */
const ROLE_RE = /^[a-z][a-z_]{0,39}$/;

/** Los filtros de la URL. Un valor desconocido se ignora y queda el de por defecto. */
export function parseTeamFilters(search: string): TeamFilters {
  const params = new URLSearchParams(search);
  const chipParam = params.get(PARAMS.chip);
  const sortParam = params.get(PARAMS.sort);
  const role = params.get(PARAMS.role) ?? '';
  return {
    chip: TEAM_CHIPS.find((c) => c.param === chipParam)?.id ?? null,
    role: ROLE_RE.test(role) ? role : null,
    hideSuspended: params.get(PARAMS.suspended) === HIDDEN,
    sort: TEAM_SORTS.find((s) => s.param !== null && s.param === sortParam)?.id ?? 'default',
  };
}

function withParam(params: URLSearchParams, name: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value === '') params.delete(name);
  else params.set(name, value);
}

function queryOf(params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * La URL con los filtros, sin tocar los demás parámetros (`?tenant=`). Lo que está en su valor por
 * defecto no se escribe.
 */
export function queryWithTeamFilters(search: string, filters: TeamFilters): string {
  const params = new URLSearchParams(search);
  withParam(params, PARAMS.chip, TEAM_CHIPS.find((c) => c.id === filters.chip)?.param);
  withParam(
    params,
    PARAMS.role,
    filters.role !== null && ROLE_RE.test(filters.role) ? filters.role : null,
  );
  withParam(params, PARAMS.suspended, filters.hideSuspended ? HIDDEN : null);
  withParam(params, PARAMS.sort, TEAM_SORTS.find((s) => s.id === filters.sort)?.param);
  return queryOf(params);
}

/**
 * La URL con el nodo elegido en Equipo, sin tocar los filtros: una recarga o un enlace abren el
 * mismo nodo con los mismos filtros.
 */
export function queryWithTeamTenant(search: string, tenantId: string): string {
  const params = new URLSearchParams(search);
  withParam(params, 'tenant', tenantId);
  return queryOf(params);
}
