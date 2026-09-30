/**
 * Las agencias del usuario y cuál es la activa, sin I/O: lo usan el layout del panel, las guardas
 * de las secciones de administración y el selector de agencia.
 *
 * El criterio de la agencia por defecto es UNO y lo decide la API (`isDefault` en /me/memberships,
 * el mismo que usa el login): la última con la que operó si sigue operando, si no la más antigua
 * que opera. Antes el panel caía a `memberships[0]`, la primera por orden alfabético y sin mirar el
 * estado, mientras la API abría la sesión en la más antigua.
 */

/** Por qué no se puede operar con una agencia (lo manda la API, ver apps/api/src/me). */
export type UnavailableReason = 'tenant_suspended' | 'tenant_archived' | 'ancestor_suspended';

export interface MembershipSummary {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantType: string | null;
  logoUrl: string | null;
  /** Membership activa y el nodo y sus ancestros activos. */
  operable: boolean;
  unavailableReason: UnavailableReason | null;
  blockedByName: string | null;
  isDefault: boolean;
}

const UNAVAILABLE_REASONS: readonly UnavailableReason[] = [
  'tenant_suspended',
  'tenant_archived',
  'ancestor_suspended',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseMembership(value: unknown): MembershipSummary | null {
  const obj = asRecord(value);
  const tenantId = text(obj?.['tenantId']);
  const role = text(obj?.['role']);
  const status = text(obj?.['status']);
  if (!obj || !tenantId || !role || !status) return null;

  const rawReason = obj['unavailableReason'];
  const unavailableReason = UNAVAILABLE_REASONS.includes(rawReason as UnavailableReason)
    ? (rawReason as UnavailableReason)
    : null;
  // Una API anterior a estos campos no dice nada de la operabilidad: se asume la del estado.
  const operable =
    typeof obj['operable'] === 'boolean'
      ? obj['operable'] && status === 'active'
      : status === 'active' && unavailableReason === null;

  return {
    id: text(obj['id']) ?? tenantId,
    role,
    status,
    tenantId,
    tenantSlug: text(obj['tenantSlug']) ?? '',
    tenantName: text(obj['tenantName']) ?? 'Agencia sin nombre',
    tenantType: text(obj['tenantType']),
    logoUrl: text(obj['logoUrl']),
    operable,
    unavailableReason,
    blockedByName: text(obj['blockedByName']),
    isDefault: obj['isDefault'] === true && status === 'active',
  };
}

/** GET /me/memberships, validado: una fila rota se descarta en vez de romper el panel. */
export function parseMemberships(data: unknown): MembershipSummary[] {
  if (!Array.isArray(data)) return [];
  return data.map(parseMembership).filter((m): m is MembershipSummary => m !== null);
}

/**
 * La membership con la que opera el panel: la del tenant activo (la cookie `st_tenant`, que el
 * middleware mantiene igual al `tid` de la sesión) si sigue activa; si no, la por defecto de la
 * API; si no, la primera activa. Nunca una membership suspendida o sólo invitada.
 */
export function resolveActiveMembership<
  T extends Pick<MembershipSummary, 'tenantId' | 'status' | 'isDefault'>,
>(memberships: readonly T[], activeTenantId: string | null | undefined): T | undefined {
  const active = memberships.filter((m) => m.status === 'active');
  return (
    (activeTenantId ? active.find((m) => m.tenantId === activeTenantId) : undefined) ??
    active.find((m) => m.isDefault) ??
    active[0]
  );
}

/** Una opción del selector de agencia. */
export interface AgencyOption {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
  logoUrl: string | null;
  /** Es la agencia con la que opera ahora. */
  current: boolean;
  /** Por qué no se puede elegir, para mostrarlo junto a la opción. `null` si se puede. */
  disabledReason: string | null;
}

/** El motivo, dicho para quien lo lee en el selector. */
export function unavailableLabel(
  reason: UnavailableReason | null,
  blockedByName: string | null,
): string | null {
  switch (reason) {
    case 'tenant_suspended':
      return 'Agencia suspendida';
    case 'tenant_archived':
      return 'Agencia archivada';
    case 'ancestor_suspended':
      return blockedByName
        ? `Suspendida: ${blockedByName} está suspendida`
        : 'Su red está suspendida';
    case null:
      return null;
  }
}

/** La actual arriba (dónde estoy parado), después las que se pueden elegir, al final las que no. */
function optionRank(option: AgencyOption): number {
  if (option.current) return 0;
  return option.disabledReason === null ? 1 : 2;
}

/**
 * Las agencias que ofrece el selector: las memberships ACTIVAS (una invitación pendiente o una
 * membership suspendida no son agencias con las que opere). Las que no operan quedan, deshabilitadas
 * y con su motivo, pero al final: por orden alfabético una "Agencia Cerrada" tapaba a las elegibles.
 * Dentro de cada grupo, el orden de la API (alfabético).
 */
export function agencyOptions(
  memberships: readonly MembershipSummary[],
  currentTenantId: string | null | undefined,
): AgencyOption[] {
  return memberships
    .filter((m) => m.status === 'active')
    .map<AgencyOption>((m) => ({
      tenantId: m.tenantId,
      name: m.tenantName,
      slug: m.tenantSlug,
      role: m.role,
      logoUrl: m.logoUrl,
      current: m.tenantId === currentTenantId,
      disabledReason: m.operable
        ? null
        : (unavailableLabel(m.unavailableReason, m.blockedByName) ?? 'No disponible'),
    }))
    .map((option, index) => ({ option, index }))
    .sort((x, y) => optionRank(x.option) - optionRank(y.option) || x.index - y.index)
    .map(({ option }) => option);
}

/** Hay otra agencia además de la actual: tiene sentido ofrecer el cambio. */
export function hasOtherAgencies(options: readonly AgencyOption[]): boolean {
  return options.some((o) => !o.current);
}

export function isSelectable(option: AgencyOption): boolean {
  return !option.current && option.disabledReason === null;
}

/** Con cuántas agencias aparece el buscador del selector. Con menos, la lista entra entera. */
export const AGENCY_SEARCH_THRESHOLD = 5;

export function showsAgencySearch(count: number): boolean {
  return count >= AGENCY_SEARCH_THRESHOLD;
}

/** Minúsculas y sin tildes: "Peru" encuentra "Perú". */
export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Cada palabra de la búsqueda tiene que aparecer en el nombre o el identificador. */
export function matchesSearch(haystack: readonly string[], query: string): boolean {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const target = normalizeSearch(haystack.join(' '));
  return words.every((w) => target.includes(w));
}

export function filterAgencies(options: readonly AgencyOption[], query: string): AgencyOption[] {
  return options.filter((o) => matchesSearch([o.name, o.slug], query));
}

export function switchedMessage(agencyName: string): string {
  return `Ahora operás como ${agencyName}`;
}
