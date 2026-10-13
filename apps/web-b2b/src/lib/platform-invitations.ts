import { invitationExpiry } from './invitation-expiry';
import { isTenantId } from './provider-enablement';
import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import { relativeTime } from './tenant-admin-format';
import type { TenantAdminProxyTarget } from './tenant-admin-proxy';

/**
 * Plataforma → Usuarios → Invitaciones: las invitaciones que nadie aceptó todavía, de todos los
 * nodos de la red (sólo superadmin). Qué trae el API, a qué ruta va el pedido, cómo se dice cada
 * dato y qué pasa con la lista después de reenviar o revocar; y las llamadas del navegador, que nunca
 * lanzan: devuelven datos validados o un mensaje para la pantalla.
 *
 * Reenviar y revocar van por las rutas de un nodo (lib/tenant-admin-seats-client.ts) con el nodo de
 * cada fila. Quién puede qué lo decide el API.
 */

/** Las que todavía sirven, las vencidas o las dos. Espejo de PLATFORM_INVITATION_STATES del API. */
export type InvitationStateFilter = 'pending' | 'expired' | 'all';

const STATES: readonly string[] = ['pending', 'expired', 'all'];

/** Una invitación sin aceptar (`GET /admin/invitations`). */
export interface PlatformInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly invitedByEmail: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
}

/** Pendientes y vencidas con la búsqueda y el nodo pedidos, sin importar el estado. */
export interface PlatformInvitationCounts {
  readonly pending: number;
  readonly expired: number;
}

export interface PlatformInvitationsPage {
  readonly invitations: readonly PlatformInvitation[];
  readonly nextCursor: string | null;
  /** `null` si el API no los mandó: la pantalla los omite en vez de inventarlos. */
  readonly counts: PlatformInvitationCounts | null;
}

/** Los filtros de la pantalla. Una búsqueda vacía es "sin búsqueda". */
export interface InvitationFilters {
  readonly state: InvitationStateFilter;
  readonly q: string;
  readonly tenantId?: string;
}

export const DEFAULT_INVITATION_FILTERS: InvitationFilters = { state: 'pending', q: '' };

export const INVITATION_STATE_FILTERS: readonly {
  readonly id: InvitationStateFilter;
  readonly label: string;
}[] = [
  { id: 'pending', label: 'Pendientes' },
  { id: 'expired', label: 'Vencidas' },
  { id: 'all', label: 'Todas' },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Una invitación; `undefined` si le falta lo mínimo para mostrarla y actuar sobre ella. */
export function parsePlatformInvitation(value: unknown): PlatformInvitation | undefined {
  const r = asRecord(value);
  const id = str(r?.['id']);
  const email = str(r?.['email']);
  const role = str(r?.['role']);
  const tenantId = str(r?.['tenantId']);
  const expiresAt = str(r?.['expiresAt']);
  if (r === undefined || id === undefined || email === undefined || role === undefined) {
    return undefined;
  }
  // Sin el nodo no se puede reenviar ni revocar: las dos rutas lo piden.
  if (tenantId === undefined || expiresAt === undefined) return undefined;
  return {
    id,
    email,
    role,
    tenantId: tenantId.toLowerCase(),
    tenantName: str(r['tenantName']) ?? '',
    invitedByEmail: str(r['invitedByEmail']) ?? null,
    createdAt: str(r['createdAt']) ?? '',
    expiresAt,
    expired: r['expired'] === true,
  };
}

function parseCounts(value: unknown): PlatformInvitationCounts | null {
  const r = asRecord(value);
  const pending = count(r?.['pending']);
  const expired = count(r?.['expired']);
  return pending === undefined || expired === undefined ? null : { pending, expired };
}

/**
 * `{ invitations, nextCursor, counts }`. `undefined` si la forma no es la esperada (es un error, no
 * un vacío).
 */
export function parsePlatformInvitationsPage(value: unknown): PlatformInvitationsPage | undefined {
  const r = asRecord(value);
  if (r === undefined || !Array.isArray(r['invitations'])) return undefined;
  const cursor = r['nextCursor'];
  if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') return undefined;
  return {
    invitations: r['invitations'].flatMap((i) => {
      const parsed = parsePlatformInvitation(i);
      return parsed === undefined ? [] : [parsed];
    }),
    nextCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null,
    counts: parseCounts(r['counts']),
  };
}

// ─────────────────────────── El borde (la ruta del panel) ───────────────────────────

const QUERY_MAX = 100;
const CURSOR_FORMAT = /^[A-Za-z0-9_-]{1,200}$/;
const LIMIT_FORMAT = /^\d{1,3}$/;
const PARAMS: readonly string[] = ['state', 'q', 'tenantId', 'cursor', 'limit'];
const INVALID = 'Los filtros de las invitaciones no son válidos. Recarga la página.';

/**
 * `GET /admin/invitations?…`: la consulta se reconstruye parámetro por parámetro, porque el API
 * rechaza lo que sobra (`.strict()`) y un parámetro raro no tiene que llegar hasta él. Un parámetro
 * repetido o desconocido es un pedido que no armó el panel. Una búsqueda vacía (sólo espacios) es
 * "sin búsqueda".
 */
export function platformInvitationsListTarget(query: URLSearchParams): TenantAdminProxyTarget {
  const values = new Map<string, string>();
  for (const name of query.keys()) {
    if (!PARAMS.includes(name) || query.getAll(name).length > 1) {
      return { ok: false, error: INVALID };
    }
    values.set(name, query.get(name) ?? '');
  }

  const out = new URLSearchParams();
  const state = values.get('state');
  if (state !== undefined) {
    if (!STATES.includes(state)) return { ok: false, error: INVALID };
    out.set('state', state);
  }
  const q = values.get('q')?.trim() ?? '';
  if (q.length > QUERY_MAX) {
    return { ok: false, error: `La búsqueda puede tener hasta ${QUERY_MAX} caracteres.` };
  }
  if (q !== '') out.set('q', q);
  const tenantId = values.get('tenantId');
  if (tenantId !== undefined) {
    if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
    out.set('tenantId', tenantId.toLowerCase());
  }
  const cursor = values.get('cursor');
  if (cursor !== undefined) {
    if (!CURSOR_FORMAT.test(cursor)) return { ok: false, error: INVALID };
    out.set('cursor', cursor);
  }
  const limit = values.get('limit');
  if (limit !== undefined) {
    const n = LIMIT_FORMAT.test(limit) ? Number(limit) : NaN;
    if (!(n >= 1 && n <= 100)) return { ok: false, error: INVALID };
    out.set('limit', String(n));
  }

  const qs = out.toString();
  return { ok: true, path: qs === '' ? '/admin/invitations' : `/admin/invitations?${qs}` };
}

// ─────────────────────────── Cómo se dice cada dato ───────────────────────────

/** La consulta de la lista para la ruta del panel. Las pendientes no se nombran: son el defecto. */
export function invitationsSearch(filters: InvitationFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (filters.state !== 'pending') params.set('state', filters.state);
  const q = filters.q.trim();
  if (q !== '') params.set('q', q);
  if (filters.tenantId) params.set('tenantId', filters.tenantId);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

/** ¿Hay algo que "Limpiar filtros" pueda devolver al defecto? */
export function hasInvitationFilters(filters: InvitationFilters): boolean {
  return invitationsSearch(filters) !== '';
}

/** ¿La acota la búsqueda o el nodo? Entonces una lista vacía es "con esos filtros". */
export function narrowsInvitations(filters: InvitationFilters): boolean {
  return filters.q.trim() !== '' || Boolean(filters.tenantId);
}

/** ¿Ya venció? Con el reloj de quien mira; si la fecha no se lee, lo que dijo el API. */
export function isInvitationExpired(
  invitation: Pick<PlatformInvitation, 'expiresAt' | 'expired'>,
  now: number,
): boolean {
  const end = Date.parse(invitation.expiresAt);
  return Number.isNaN(end) ? invitation.expired : end <= now;
}

/** "Vence en 5 días", "Vence hoy" o "Venció hace 3 días". */
export function invitationExpiryLabel(
  invitation: Pick<PlatformInvitation, 'expiresAt' | 'expired'>,
  now: number,
): string {
  if (isInvitationExpired(invitation, now)) {
    const when = relativeTime(invitation.expiresAt, now);
    return when === undefined ? 'Venció' : `Venció ${when}`;
  }
  const label = invitationExpiry(invitation.expiresAt, new Date(now))?.label;
  return label === undefined ? 'Vigente' : label.charAt(0).toUpperCase() + label.slice(1);
}

/** El número junto a cada filtro de estado; `undefined` si el API no mandó los contadores. */
export function stateFilterCount(
  counts: PlatformInvitationCounts | null,
  state: InvitationStateFilter,
): number | undefined {
  if (counts === null) return undefined;
  if (state === 'all') return counts.pending + counts.expired;
  return counts[state];
}

/** Lo que dice la lista vacía. */
export function emptyInvitationsMessage(filters: InvitationFilters): string {
  if (narrowsInvitations(filters)) return 'No encontramos invitaciones con esos filtros.';
  if (filters.state === 'expired') return 'No hay invitaciones vencidas.';
  if (filters.state === 'all') return 'No hay invitaciones sin aceptar.';
  return 'No hay invitaciones pendientes.';
}

/** "3 invitaciones (hay más)". */
export function invitationsCountLabel(shown: number, more: boolean): string {
  return `${shown} ${shown === 1 ? 'invitación' : 'invitaciones'}${more ? ' (hay más)' : ''}`;
}

// ─────────────────────────── La lista después de una acción ───────────────────────────

/** Lo que muestra la lista: las filas cargadas, el cursor y los contadores. */
export type InvitationsView = PlatformInvitationsPage;

function bump(
  counts: PlatformInvitationCounts | null,
  delta: { readonly pending: number; readonly expired: number },
): PlatformInvitationCounts | null {
  if (counts === null) return null;
  return {
    pending: Math.max(0, counts.pending + delta.pending),
    expired: Math.max(0, counts.expired + delta.expired),
  };
}

/**
 * Después de reenviar: el enlace nuevo vence en `expiresAt` y la respalda quien la reenvió. Una que
 * había vencido pasa a pendiente (y sale de "Vencidas"). Se cambia en el lugar, sin recargar: las
 * páginas que se trajeron con "Cargar más" siguen ahí.
 */
export function afterResend(
  view: InvitationsView,
  invitationId: string,
  issued: { readonly expiresAt: string; readonly invitedByEmail: string | null },
  state: InvitationStateFilter,
  now: number,
): InvitationsView {
  const row = view.invitations.find((i) => i.id === invitationId);
  if (row === undefined) return view;
  const wasExpired = isInvitationExpired(row, now);
  const updated: PlatformInvitation = {
    ...row,
    expiresAt: issued.expiresAt,
    expired: false,
    invitedByEmail: issued.invitedByEmail ?? row.invitedByEmail,
  };
  return {
    ...view,
    invitations:
      state === 'expired'
        ? view.invitations.filter((i) => i.id !== invitationId)
        : view.invitations.map((i) => (i.id === invitationId ? updated : i)),
    counts: wasExpired ? bump(view.counts, { pending: 1, expired: -1 }) : view.counts,
  };
}

/**
 * Después de revocarla, o de saber que ya no estaba pendiente (la aceptaron o la revocaron desde otra
 * sesión): sale de la lista y de su contador.
 */
export function afterRemoval(
  view: InvitationsView,
  invitationId: string,
  now: number,
): InvitationsView {
  const row = view.invitations.find((i) => i.id === invitationId);
  if (row === undefined) return view;
  const expired = isInvitationExpired(row, now);
  return {
    ...view,
    invitations: view.invitations.filter((i) => i.id !== invitationId),
    counts: bump(view.counts, expired ? { pending: 0, expired: -1 } : { pending: -1, expired: 0 }),
  };
}

/** Suma una página a la lista sin repetir las que ya están (una pudo moverse entre pedidos). */
export function appendInvitations(
  view: InvitationsView,
  next: PlatformInvitationsPage,
): InvitationsView {
  const seen = new Set(view.invitations.map((i) => i.id));
  return {
    invitations: [...view.invitations, ...next.invitations.filter((i) => !seen.has(i.id))],
    nextCursor: next.nextCursor,
    counts: next.counts ?? view.counts,
  };
}

// ─────────────────────────── Las llamadas del navegador ───────────────────────────

/** Por qué no cargó la lista, según el estado: sesión, permiso o servidor. */
export function invitationsLoadError(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'Esta pantalla es sólo para el superadmin.';
  if (status >= 500) {
    return 'No pudimos cargar las invitaciones: el servidor no respondió. Inténtalo de nuevo en unos minutos.';
  }
  return message?.trim() || 'No pudimos cargar las invitaciones. Inténtalo de nuevo.';
}

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

async function read<T>(url: string, parse: (value: unknown) => T | undefined): Promise<Loaded<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const body = await readJson<unknown>(res);
  if (!res.ok) {
    const error = body.ok ? str(asRecord(body.data)?.['error']) : undefined;
    return { ok: false, message: invitationsLoadError(res.status, error) };
  }
  if (!body.ok) return { ok: false, message: body.message };
  const data = parse(body.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

/** Una página de la lista con estos filtros (`cursor` = la siguiente). */
export function loadPlatformInvitations(
  filters: InvitationFilters,
  cursor?: string | null,
): Promise<Loaded<PlatformInvitationsPage>> {
  const search = invitationsSearch(filters, cursor);
  return read(
    search === '' ? '/api/admin/invitations' : `/api/admin/invitations?${search}`,
    parsePlatformInvitationsPage,
  );
}

/**
 * Cuántas invitaciones pendientes hay en toda la red, para la pestaña. Pide una sola fila: lo que
 * sirve son los contadores, que no dependen del tamaño de la página.
 */
export function loadPendingInvitationCount(): Promise<Loaded<number>> {
  return read('/api/admin/invitations?limit=1', (value) => {
    return parsePlatformInvitationsPage(value)?.counts?.pending;
  });
}
