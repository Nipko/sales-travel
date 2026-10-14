import { roleLabel } from '../app/(app)/admin/usuarios/_components/roles';
import { auditLoadError, parseAuditPage, type AuditPageView } from './audit-format';
import { invitationExpiry } from './invitation-expiry';
import type { PlatformUser } from './platform-users';
import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import { deviceLabel, lockedUntilLabel, relativeTime } from './tenant-admin-format';
import { PASSWORD_RESET_PENDING_LABEL, requiresMfa, type NetworkMember } from './tenant-admin-team';

/**
 * La ficha de una persona, desde Equipo (`/tenants/:id/members/:userId`) o desde Plataforma →
 * Usuarios (`/admin/users/:userId`): qué trae el API, cómo se dice cada dato y las llamadas del
 * navegador a las rutas del panel. Sin React; las llamadas nunca lanzan.
 *
 * La lectura es tolerante: lo que falta o viene raro queda "sin dato" y esa línea no se muestra, en
 * vez de inventar un "0 códigos" o un "Sin 2FA". Sólo sin `user.id` o `user.email` la ficha no se
 * puede mostrar, y eso es un error, no una ficha vacía.
 */

/** De dónde se mira: el equipo de un nodo, o el directorio de toda la plataforma (superadmin). */
export type MemberDetailSource =
  | { readonly kind: 'team'; readonly tenantId: string; readonly userId: string }
  | { readonly kind: 'platform'; readonly userId: string };

export interface MemberDetailUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  /** El de la cuenta en toda la plataforma. */
  readonly status: string;
  readonly createdAt: string | null;
  /** `null` = el API no lo dijo. */
  readonly emailVerified: boolean | null;
  readonly lastLoginAt: string | null;
  readonly passwordChangedAt: string | null;
  readonly passwordResetRequired: boolean;
}

export interface MemberDetailSecurity {
  /** `null` = el API no lo dijo. */
  readonly mfaEnabled: boolean | null;
  readonly mfaEnabledAt: string | null;
  readonly recoveryCodesLeft: number | null;
  readonly trustedDevices: number | null;
  readonly lockedUntil: string | null;
  readonly failedLoginAttempts: number;
}

export interface MemberDetailMembership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantType: string;
  readonly role: string;
  readonly status: string;
}

export interface MemberDetailSession {
  readonly id: string;
  /** `null` sólo en la ficha del superadmin: una sesión de plataforma, sin nodo. */
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly lastSeenAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Es la sesión de quien mira (su propia ficha). */
  readonly current: boolean;
}

export interface MemberDetailInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly tenantName: string;
  readonly expiresAt: string;
}

export interface MemberDetailView {
  readonly user: MemberDetailUser;
  readonly security: MemberDetailSecurity;
  readonly memberships: readonly MemberDetailMembership[];
  readonly sessions: readonly MemberDetailSession[];
  readonly invitedBy: { readonly email: string | null; readonly at: string } | null;
  readonly invitationsSent: {
    readonly pending: number;
    readonly items: readonly MemberDetailInvitation[];
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Un instante legible; si no se puede leer, como si no hubiera venido. */
function instant(value: unknown): string | null {
  const t = text(value);
  return t !== undefined && !Number.isNaN(Date.parse(t)) ? t : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function list<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === undefined ? [] : [parsed];
  });
}

function parseMembership(value: unknown): MemberDetailMembership | undefined {
  const r = asRecord(value);
  const tenantId = text(r?.['tenantId']);
  const tenantName = text(r?.['tenantName']);
  const role = text(r?.['role']);
  const status = text(r?.['status']);
  if (r === undefined || tenantId === undefined || tenantName === undefined) return undefined;
  if (role === undefined || status === undefined) return undefined;
  return { tenantId, tenantName, tenantType: text(r['tenantType']) ?? '', role, status };
}

function parseSession(value: unknown): MemberDetailSession | undefined {
  const r = asRecord(value);
  const id = text(r?.['id']);
  const lastSeenAt = instant(r?.['lastSeenAt']);
  if (r === undefined || id === undefined || lastSeenAt === null) return undefined;
  return {
    id,
    tenantId: text(r['tenantId']) ?? null,
    tenantName: text(r['tenantName']) ?? null,
    lastSeenAt,
    ip: text(r['ip']) ?? null,
    userAgent: text(r['userAgent']) ?? null,
    current: r['current'] === true,
  };
}

function parseInvitation(value: unknown): MemberDetailInvitation | undefined {
  const r = asRecord(value);
  const id = text(r?.['id']);
  const email = text(r?.['email']);
  const role = text(r?.['role']);
  if (r === undefined || id === undefined || email === undefined || role === undefined) {
    return undefined;
  }
  return {
    id,
    email,
    role,
    tenantName: text(r['tenantName']) ?? '',
    expiresAt: text(r['expiresAt']) ?? '',
  };
}

/**
 * La ficha que mandó el API. Nunca lanza: `undefined` si no trae a quién (`user.id` y `user.email`);
 * con eso, cada dato que falte o venga raro queda sin dato y cada fila incompleta se descarta.
 */
export function parseMemberDetail(raw: unknown): MemberDetailView | undefined {
  const body = asRecord(raw);
  const u = asRecord(body?.['user']);
  const id = text(u?.['id']);
  const email = text(u?.['email']);
  if (body === undefined || u === undefined || id === undefined || email === undefined) {
    return undefined;
  }
  const s = asRecord(body['security']);
  const invitedBy = asRecord(body['invitedBy']);
  const invitedAt = instant(invitedBy?.['at']);
  const sent = asRecord(body['invitationsSent']);
  const items = list(sent?.['items'], parseInvitation);

  return {
    user: {
      id,
      email,
      name: text(u['name']) ?? null,
      status: text(u['status']) ?? 'active',
      createdAt: instant(u['createdAt']),
      emailVerified: bool(u['emailVerified']),
      lastLoginAt: instant(u['lastLoginAt']),
      passwordChangedAt: instant(u['passwordChangedAt']),
      passwordResetRequired: u['passwordResetRequired'] === true,
    },
    security: {
      mfaEnabled: bool(s?.['mfaEnabled']),
      mfaEnabledAt: instant(s?.['mfaEnabledAt']),
      recoveryCodesLeft: count(s?.['recoveryCodesLeft']),
      trustedDevices: count(s?.['trustedDevices']),
      lockedUntil: instant(s?.['lockedUntil']),
      failedLoginAttempts: count(s?.['failedLoginAttempts']) ?? 0,
    },
    memberships: list(body['memberships'], parseMembership),
    sessions: list(body['sessions'], parseSession),
    invitedBy:
      invitedBy === undefined || invitedAt === null
        ? null
        : { email: text(invitedBy['email']) ?? null, at: invitedAt },
    invitationsSent: {
      // Nunca menos de las que vinieron: un total raro no dice "0 pendientes" con la lista llena.
      pending: Math.max(count(sent?.['pending']) ?? 0, items.length),
      items,
    },
  };
}

/** El nombre con que se nombra a la persona: el suyo o, si no lo puso, su correo. */
export function detailName(user: Pick<MemberDetailUser, 'name' | 'email'>): string {
  return user.name?.trim() || user.email;
}

// ── Cómo se dice cada dato ─────────────────────────────────────────────────────────────────────

export type BadgeTone = 'ok' | 'danger' | 'warn';

export interface DetailBadge {
  readonly label: string;
  readonly tone: BadgeTone;
}

/**
 * ¿Alguno de sus accesos activos tiene un rol que exige 2FA? Entonces "Sin 2FA" es "pendiente": el
 * próximo ingreso lo obliga a activarlo.
 */
export function mfaRequired(detail: Pick<MemberDetailView, 'memberships'>): boolean {
  return detail.memberships.some((m) => m.status === 'active' && requiresMfa(m.role));
}

/**
 * Las marcas de la cabecera: lo que le impide entrar o lo que tiene pendiente, de lo más grave a lo
 * menos. Sin nada de eso, "Activo". Desde Equipo, `tenantId` es el nodo que se mira: su acceso
 * suspendido ahí también se marca.
 */
export function detailBadges(
  detail: MemberDetailView,
  now: number,
  tenantId?: string,
): DetailBadge[] {
  const badges: DetailBadge[] = [];
  if (detail.user.status === 'suspended') {
    badges.push({ label: 'Cuenta suspendida', tone: 'danger' });
  }
  const here =
    tenantId === undefined
      ? undefined
      : detail.memberships.find((m) => m.tenantId.toLowerCase() === tenantId.toLowerCase());
  if (here?.status === 'suspended') {
    badges.push({ label: 'Suspendido en este nodo', tone: 'danger' });
  }
  if (lockedUntilLabel(detail.security.lockedUntil, now) !== undefined) {
    badges.push({ label: 'Bloqueado', tone: 'warn' });
  }
  if (detail.user.passwordResetRequired) {
    badges.push({ label: PASSWORD_RESET_PENDING_LABEL, tone: 'warn' });
  }
  if (detail.security.mfaEnabled === false && mfaRequired(detail)) {
    badges.push({ label: '2FA pendiente', tone: 'warn' });
  }
  return badges.length === 0 ? [{ label: 'Activo', tone: 'ok' }] : badges;
}

/** El "Correo" del perfil: "Verificado" o "Sin verificar"; `undefined` si el API no lo dijo. */
export function emailStatus(verified: boolean | null): string | undefined {
  if (verified === null) return undefined;
  return verified ? 'Verificado' : 'Sin verificar';
}

/** El "Invitado por" del perfil: "ana@agencia.co · hace 2 días". */
export function invitedByText(
  invitedBy: NonNullable<MemberDetailView['invitedBy']>,
  now: number,
): string {
  const who = invitedBy.email ?? 'un usuario eliminado';
  const when = relativeTime(invitedBy.at, now);
  return when === undefined ? who : `${who} · ${when}`;
}

const MEMBERSHIP_STATUS: Readonly<Record<string, string>> = {
  active: 'Activo',
  suspended: 'Suspendido',
  invited: 'Invitado',
};

export function membershipStatusLabel(status: string): string {
  return MEMBERSHIP_STATUS[status] ?? status;
}

/** "Agencia Norte · Vendedor · Activo". */
export function membershipLine(m: MemberDetailMembership): string {
  return `${m.tenantName} · ${roleLabel(m.role)} · ${membershipStatusLabel(m.status)}`;
}

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "12 oct 2026"; `undefined` si la fecha no se puede leer. */
export function calendarDate(iso: string | null | undefined): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : DAY_MONTH_YEAR.format(t);
}

/**
 * "2FA activo desde el 12 oct 2026" o "Sin 2FA" (con "su rol lo exige" si alguno de sus accesos
 * activos lo pide). `undefined` si el API no lo dijo.
 */
export function mfaLine(detail: MemberDetailView): string | undefined {
  const { mfaEnabled, mfaEnabledAt } = detail.security;
  if (mfaEnabled === null) return undefined;
  if (!mfaEnabled) {
    return mfaRequired(detail)
      ? 'Sin 2FA: su rol lo exige y tiene que activarlo al próximo ingreso'
      : 'Sin 2FA';
  }
  const since = calendarDate(mfaEnabledAt);
  return since === undefined ? '2FA activo' : `2FA activo desde el ${since}`;
}

export function recoveryCodesLine(n: number): string {
  return `Códigos de recuperación: ${n}`;
}

export function trustedDevicesLine(n: number): string {
  return `Equipos de confianza: ${n}`;
}

/** "Contraseña cambiada hace 3 días"; `undefined` sin fecha. */
export function passwordChangedLine(at: string | null, now: number): string | undefined {
  const when = relativeTime(at, now);
  return when === undefined ? undefined : `Contraseña cambiada ${when}`;
}

/** Intentos fallidos sin bloqueo vigente: avisan de alguien probando contraseñas. */
export function failedAttemptsLine(n: number): string | undefined {
  if (n <= 0) return undefined;
  return n === 1 ? '1 intento fallido de ingreso' : `${n} intentos fallidos de ingreso`;
}

/** "Chrome en Windows", con el mismo resumen del user-agent que Puestos. */
export function sessionDevice(session: Pick<MemberDetailSession, 'userAgent'>): string {
  return deviceLabel(session.userAgent);
}

/** "Activa hace 3 min". */
export function sessionActivity(
  session: Pick<MemberDetailSession, 'lastSeenAt'>,
  now: number,
): string {
  const when = relativeTime(session.lastSeenAt, now);
  return when === undefined ? 'Activa' : `Activa ${when}`;
}

/** Las sesiones en el orden en que se leen: la propia primero y después la más reciente. */
export function orderedDetailSessions(
  sessions: readonly MemberDetailSession[],
): MemberDetailSession[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  });
}

export function sessionsHeading(n: number): string {
  return `Sesiones abiertas (${n})`;
}

/** Sin sesiones: desde Equipo, sólo se ven las de los nodos que administra quien mira. */
export function noSessionsText(kind: MemberDetailSource['kind']): string {
  return kind === 'team'
    ? 'No tiene sesiones abiertas en los nodos que administras.'
    : 'No tiene sesiones abiertas.';
}

/**
 * El nodo por el que se cierra una sesión puntual: desde Equipo, el de la ruta (la sesión es de su
 * subárbol); desde el directorio, el de la sesión. `null` = no se cierra de a una (una sesión de
 * plataforma, sin nodo: va con "Cerrar sus sesiones").
 */
export function revokeTenantOf(
  source: MemberDetailSource,
  session: Pick<MemberDetailSession, 'tenantId'>,
): string | null {
  return source.kind === 'team' ? source.tenantId : session.tenantId;
}

export function revokeSessionCopy(name: string): {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
} {
  return {
    title: `Cerrar esta sesión de ${name}`,
    description:
      'Se cierra la sesión en ese equipo. Si estaba trabajando, pierde lo que no haya guardado.',
    confirmLabel: 'Cerrar sesión',
  };
}

export function revokeSessionDone(name: string): string {
  return `Cerramos esa sesión de ${name}.`;
}

/** "Vendedor · Agencia Norte · vence en 5 días" (o "venció"). */
export function sentInvitationLine(invitation: MemberDetailInvitation, now: number): string {
  const expiry = invitationExpiry(invitation.expiresAt, new Date(now));
  return [roleLabel(invitation.role), invitation.tenantName || undefined, expiry?.label]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

export function pendingInvitationsText(pending: number): string {
  if (pending === 0) return 'No tiene invitaciones pendientes.';
  return pending === 1 ? '1 pendiente' : `${pending} pendientes`;
}

/**
 * Qué decir cuando la ficha no carga, según el estado del BFF: sesión, permiso, que ya no está o el
 * servidor. El mensaje del API de un 403 ya viene en castellano y dice el motivo.
 */
export function memberDetailLoadError(
  status: number,
  message: string | undefined,
  kind: MemberDetailSource['kind'],
): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  const said = message?.trim() ?? '';
  if (status === 403) {
    if (kind === 'platform') return 'Esta ficha es sólo para el superadmin.';
    return said !== ''
      ? `No puedes ver esta ficha: ${said}`
      : 'No administras este nodo: no puedes ver la ficha de esta persona.';
  }
  if (status === 404) {
    return kind === 'team'
      ? 'Esta persona ya no está en este nodo. Cierra la ficha y recarga la lista.'
      : 'No encontramos esta cuenta.';
  }
  if (status === 400) return said || 'No pudimos abrir esta ficha. Recarga la página.';
  return 'No pudimos cargar la ficha. Inténtalo de nuevo.';
}

/**
 * El mensaje de un "Cerrar esta sesión" rechazado. El 403 trae el motivo del API (es tuya, o tiene
 * tu rango sobre ese nodo); el 404, que ya no estaba abierta.
 */
export function revokeSessionError(status: number, message: string | undefined): string {
  const said = message?.trim() ?? '';
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 404) return said || 'Esa sesión ya no está abierta.';
  if (status === 403) {
    return said !== ''
      ? `No lo pudimos hacer: ${said}`
      : 'No puedes cerrar esa sesión. Pídeselo a quien administra ese nodo.';
  }
  if (said !== '') return said;
  return 'No pudimos cerrar esa sesión. Inténtalo de nuevo.';
}

// ── Para actuar desde la ficha del directorio ──────────────────────────────────────────────────

/**
 * El nodo por el que el superadmin le da soporte (enviar el enlace, cerrar sesiones…) desde el
 * directorio: el primero de sus nodos, que el API ordena con los accesos activos arriba. `undefined`
 * sin nodos: esas acciones van por un nodo donde tenga membership.
 */
export function supportMembership(
  detail: Pick<MemberDetailView, 'memberships'>,
): MemberDetailMembership | undefined {
  return detail.memberships.find((m) => m.status === 'active') ?? detail.memberships[0];
}

/**
 * La persona como miembro de ese nodo, para reusar el menú y los textos de Equipo. Sin el conteo de
 * sesiones del nodo: la ficha trae las de toda la plataforma, y "Cerrar sus sesiones" se ofrece
 * siempre.
 */
export function memberFromDetail(
  detail: MemberDetailView,
  membership: MemberDetailMembership,
): NetworkMember {
  return {
    userId: detail.user.id,
    email: detail.user.email,
    name: detail.user.name,
    userStatus: detail.user.status,
    role: membership.role,
    membershipStatus: membership.status,
    createdAt: detail.user.createdAt ?? '',
    lastLoginAt: detail.user.lastLoginAt,
    mfaEnabled: detail.security.mfaEnabled ?? undefined,
    lockedUntil: detail.security.lockedUntil,
    activeSessions: detail.sessions.length,
    passwordResetRequired: detail.user.passwordResetRequired,
  };
}

/**
 * La fila del directorio puesta al día con la ficha recién leída: tras desbloquear, cerrar una sesión
 * o suspender desde la ficha, la lista de atrás no tiene que seguir diciendo lo de antes.
 */
export function syncPlatformUser(user: PlatformUser, detail: MemberDetailView): PlatformUser {
  if (user.id.toLowerCase() !== detail.user.id.toLowerCase()) return user;
  return {
    ...user,
    name: detail.user.name,
    status: detail.user.status,
    emailVerified: detail.user.emailVerified ?? user.emailVerified,
    mfaEnabled: detail.security.mfaEnabled ?? user.mfaEnabled,
    lockedUntil: detail.security.lockedUntil,
    lastLoginAt: detail.user.lastLoginAt ?? user.lastLoginAt,
    activeSessions: detail.sessions.length,
  };
}

/** Lo que pasó con una acción pedida desde la ficha. */
export type SheetActionOutcome =
  | { readonly status: 'done' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

export const ACTION_DONE: SheetActionOutcome = { status: 'done' };
export const ACTION_CANCELLED: SheetActionOutcome = { status: 'cancelled' };

// ── Las llamadas del navegador ─────────────────────────────────────────────────────────────────

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

function seg(id: string): string {
  return encodeURIComponent(id);
}

export function memberDetailUrl(source: MemberDetailSource): string {
  return source.kind === 'team'
    ? `/api/tenants/${seg(source.tenantId)}/members/${seg(source.userId)}`
    : `/api/admin/users/${seg(source.userId)}`;
}

export function memberAuditUrl(source: MemberDetailSource, before?: string): string {
  const base = `${memberDetailUrl(source)}/audit`;
  return before === undefined ? base : `${base}?${new URLSearchParams({ before }).toString()}`;
}

function errorOf(body: unknown): string | undefined {
  return text(asRecord(body)?.['error']);
}

/** Un 2xx cuyo cuerpo no es JSON: salió bien, pero no hay nada que leer. */
const UNREADABLE_BODY = Symbol('unreadable');

async function request(
  url: string,
  init: RequestInit = {},
): Promise<{ readonly res: Response; readonly body: unknown } | { readonly offline: true }> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { offline: true };
  }
  const read = await readJson<unknown>(res);
  if (read.ok) return { res, body: read.data };
  // Un 2xx que no es JSON no se puede leer; un error sin JSON se dice por su estado.
  return { res, body: res.ok ? UNREADABLE_BODY : undefined };
}

export async function loadMemberDetail(
  source: MemberDetailSource,
): Promise<Loaded<MemberDetailView>> {
  const out = await request(memberDetailUrl(source));
  if ('offline' in out) return { ok: false, message: OFFLINE };
  if (!out.res.ok) {
    return {
      ok: false,
      message: memberDetailLoadError(out.res.status, errorOf(out.body), source.kind),
    };
  }
  const detail = out.body === UNREADABLE_BODY ? undefined : parseMemberDetail(out.body);
  return detail === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data: detail };
}

export async function loadMemberAudit(
  source: MemberDetailSource,
  before?: string,
): Promise<Loaded<AuditPageView>> {
  const out = await request(memberAuditUrl(source, before));
  if ('offline' in out) {
    return {
      ok: false,
      message: 'No pudimos cargar la actividad. Revisa tu conexión e inténtalo de nuevo.',
    };
  }
  if (!out.res.ok) return { ok: false, message: auditLoadError(out.res.status, out.body) };
  if (out.body === UNREADABLE_BODY) return { ok: false, message: UNREADABLE };
  return { ok: true, data: parseAuditPage(out.body) };
}

/** `gone`: la sesión ya no estaba abierta; la ficha se vuelve a leer. */
export type RevokeSessionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly gone?: true };

export async function revokeMemberSession(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<RevokeSessionResult> {
  const out = await request(
    `/api/tenants/${seg(tenantId)}/members/${seg(userId)}/sessions/${seg(sessionId)}/revoke`,
    { method: 'POST' },
  );
  if ('offline' in out) return { ok: false, message: OFFLINE };
  if (out.res.ok) return { ok: true };
  const message = revokeSessionError(out.res.status, errorOf(out.body));
  return out.res.status === 404 ? { ok: false, message, gone: true } : { ok: false, message };
}
