import { lastAccessLabel, lockedUntilLabel, relativeTime } from './tenant-admin-format';

/**
 * El equipo de un nodo en "Equipo": quién es cada miembro, si tiene 2FA, cuándo entró por última
 * vez, si está bloqueado y qué acciones de soporte se le ofrecen. Sin I/O.
 *
 * Lo que se muestra u ofrece acá es una guía: quién puede qué lo decide el API en cada llamada
 * (administrar TODOS los nodos del miembro y superarlo en rango, o ser superadmin).
 */

/** Espejo de ROLE_RANK del API (apps/api/src/auth/roles.ts). */
export const ROLE_RANK: Readonly<Record<string, number>> = {
  superadmin: 100,
  platform_admin: 90,
  consolidator_admin: 70,
  tenant_admin: 60,
  agency_admin: 50,
  admin: 40,
  vendedor: 20,
  cliente_final: 10,
};

/** Espejo de MFA_REQUIRED_ROLES del API (apps/api/src/auth/roles.ts). */
export const MFA_REQUIRED_ROLES: readonly string[] = [
  'superadmin',
  'platform_admin',
  'consolidator_admin',
  'tenant_admin',
];

export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 0;
}

export function requiresMfa(role: string): boolean {
  return MFA_REQUIRED_ROLES.includes(role);
}

/** Un miembro tal como lo devuelve `GET /tenants/network/users`. */
export interface NetworkMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly userStatus: string;
  readonly role: string;
  readonly membershipStatus: string;
  readonly createdAt: string;
  /** Último ingreso completo (después del 2FA). `null` = nunca; `undefined` = el API no lo dice. */
  readonly lastLoginAt: string | null | undefined;
  readonly mfaEnabled: boolean | undefined;
  readonly lockedUntil: string | null | undefined;
  readonly activeSessions: number | undefined;
  /**
   * Un admin le pidió elegir una contraseña nueva y todavía no lo hizo: no puede ingresar hasta usar
   * el enlace del correo. `undefined` si el API no lo dice.
   */
  readonly passwordResetRequired: boolean | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Un campo que el API puede no mandar todavía: se distingue "no lo dice" de "es null". */
function optionalTime(r: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in r)) return undefined;
  const value = r[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseMember(value: unknown): NetworkMember | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const userId = str(r['userId']);
  const email = str(r['email']);
  const role = str(r['role']);
  if (userId === undefined || email === undefined || role === undefined) return undefined;
  const sessions = r['activeSessions'];
  const mfa = r['mfaEnabled'];
  const resetRequired = r['passwordResetRequired'];
  return {
    userId,
    email,
    name: str(r['name']) ?? null,
    userStatus: str(r['userStatus']) ?? 'active',
    role,
    membershipStatus: str(r['membershipStatus']) ?? 'active',
    createdAt: str(r['createdAt']) ?? '',
    lastLoginAt: optionalTime(r, 'lastLoginAt'),
    mfaEnabled: typeof mfa === 'boolean' ? mfa : undefined,
    lockedUntil: optionalTime(r, 'lockedUntil'),
    activeSessions:
      typeof sessions === 'number' && Number.isInteger(sessions) && sessions >= 0
        ? sessions
        : undefined,
    passwordResetRequired: typeof resetRequired === 'boolean' ? resetRequired : undefined,
  };
}

/** `{ users: [...] }` del API. `undefined` si la forma no es la esperada (es un error, no un vacío). */
export function parseMembers(value: unknown): NetworkMember[] | undefined {
  const list = asRecord(value)?.['users'];
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((item) => {
    const member = parseMember(item);
    return member === undefined ? [] : [member];
  });
}

/** Una invitación pendiente (`GET /invitations`). */
export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedByEmail: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** `{ invitations: [...] }`. `undefined` si la forma no es la esperada. */
export function parseInvitations(value: unknown): PendingInvitation[] | undefined {
  const list = asRecord(value)?.['invitations'];
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((item) => {
    const r = asRecord(item);
    const id = str(r?.['id']);
    const email = str(r?.['email']);
    const role = str(r?.['role']);
    const expiresAt = str(r?.['expiresAt']);
    if (r === undefined || id === undefined || email === undefined || role === undefined) return [];
    if (expiresAt === undefined) return [];
    return [
      {
        id,
        email,
        role,
        invitedByEmail: str(r['invitedByEmail']) ?? null,
        expiresAt,
        createdAt: str(r['createdAt']) ?? '',
      },
    ];
  });
}

/**
 * Quién mandó una invitación y cuándo: "Invitado por ana@agencia.co · hace 2 días". Deja ver de un
 * vistazo las que mandó alguien que ya no está en el equipo.
 */
export function invitationOrigin(
  invitation: Pick<PendingInvitation, 'invitedByEmail' | 'createdAt'>,
  now: number,
): string {
  const who = `Invitado por ${invitation.invitedByEmail ?? 'un usuario eliminado'}`;
  const when = relativeTime(invitation.createdAt, now);
  return when === undefined ? who : `${who} · ${when}`;
}

/** Lo que arrastraría un cambio sobre una membership (`GET /admin/memberships/impact`). */
export interface MembershipImpact {
  readonly invitationsToRevoke: number;
}

export function parseMembershipImpact(value: unknown): MembershipImpact | undefined {
  const n = asRecord(value)?.['invitationsToRevoke'];
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
    ? { invitationsToRevoke: n }
    : undefined;
}

/**
 * La frase de una confirmación sobre las invitaciones que el cambio revoca: las que el miembro
 * envió y ya no podría enviar. `null` = no pudimos saber cuántas; se avisa igual, sin número.
 */
export function revokedInvitationsNotice(count: number | null): string {
  if (count === null) return ' Si envió invitaciones que ya no podría enviar, se revocan.';
  if (count === 0) return '';
  return count === 1
    ? ' Se revocará 1 invitación que envió.'
    : ` Se revocarán ${count} invitaciones que envió.`;
}

export type MfaState = 'active' | 'pending' | 'not-required' | 'unknown';

/**
 * El estado de 2FA de un miembro. "Pendiente" es que su rol lo exige y todavía no lo activó: el
 * próximo ingreso lo obliga a enrolarse. Se mira el rol en ESTE nodo; si en otro tiene uno que lo
 * exige, el API lo va a pedir igual.
 */
export function mfaState(member: Pick<NetworkMember, 'mfaEnabled' | 'role'>): MfaState {
  if (member.mfaEnabled === undefined) return 'unknown';
  if (member.mfaEnabled) return 'active';
  return requiresMfa(member.role) ? 'pending' : 'not-required';
}

export const MFA_STATE_LABEL: Readonly<Record<MfaState, string>> = {
  active: '2FA activo',
  pending: '2FA pendiente',
  'not-required': 'No requerido',
  unknown: '—',
};

export const MFA_STATE_HINT: Readonly<Record<MfaState, string>> = {
  active: 'Ingresa con contraseña y código de verificación.',
  pending: 'Su rol lo exige: al próximo ingreso tiene que activarlo antes de seguir.',
  'not-required': 'Su rol no lo exige. Puede activarlo desde su Seguridad.',
  unknown: 'No sabemos si tiene 2FA.',
};

export type MemberStatusTone = 'ok' | 'danger' | 'warn' | 'muted';

/**
 * El estado que se muestra: la cuenta suspendida en la plataforma pesa más que la membership del
 * nodo (antes se veía "Activo" a alguien que no podía entrar a ningún lado).
 */
export function memberStatus(member: Pick<NetworkMember, 'userStatus' | 'membershipStatus'>): {
  readonly label: string;
  readonly tone: MemberStatusTone;
} {
  if (member.userStatus !== 'active') {
    return member.userStatus === 'suspended'
      ? { label: 'Cuenta suspendida', tone: 'danger' }
      : { label: member.userStatus === 'invited' ? 'Invitado' : 'Cuenta inactiva', tone: 'muted' };
  }
  switch (member.membershipStatus) {
    case 'active':
      return { label: 'Activo', tone: 'ok' };
    case 'suspended':
      return { label: 'Suspendido', tone: 'danger' };
    case 'invited':
      return { label: 'Invitado', tone: 'warn' };
    default:
      return { label: member.membershipStatus, tone: 'muted' };
  }
}

export interface MemberAccess {
  /** "hace 3 h", "Nunca ingresó" o `undefined` si el API no lo manda. */
  readonly lastAccess: string | undefined;
  readonly locked: string | undefined;
  /**
   * Tiene al menos una sesión viva en este subárbol. Es parcial por diseño (`user_admin_overview`
   * no cuenta las sesiones que abrió en otro de sus nodos): sirve para mostrar "En línea", no para
   * decidir si tiene sesiones que cerrar.
   */
  readonly online: boolean;
}

export function memberAccess(member: NetworkMember, now: number): MemberAccess {
  return {
    lastAccess:
      member.lastLoginAt === undefined ? undefined : lastAccessLabel(member.lastLoginAt, now),
    locked: lockedUntilLabel(member.lockedUntil, now),
    online: (member.activeSessions ?? 0) > 0,
  };
}

/** La marca de la fila de quien tiene que elegir una contraseña nueva antes de volver a ingresar. */
export const PASSWORD_RESET_PENDING_LABEL = 'Cambio de contraseña pendiente';

export const PASSWORD_RESET_PENDING_HINT =
  'No puede ingresar hasta que elija una contraseña nueva con el enlace que le enviamos a su correo.';

/** Tiene un bloqueo por intentos fallidos vigente: sólo entonces se ofrece "Desbloquear cuenta". */
export function isLocked(member: Pick<NetworkMember, 'lockedUntil'>, now: number): boolean {
  return lockedUntilLabel(member.lockedUntil, now) !== undefined;
}

/**
 * Su acceso está suspendido, en la plataforma o en este nodo: un enlace para restablecer la
 * contraseña no le serviría para entrar (el API lo rechaza con 409).
 */
export function accessSuspended(
  member: Pick<NetworkMember, 'userStatus' | 'membershipStatus'>,
): boolean {
  return member.userStatus === 'suspended' || member.membershipStatus === 'suspended';
}

/** El nombre con que se nombra a un miembro en una confirmación. */
export function memberName(member: Pick<NetworkMember, 'name' | 'email'>): string {
  return member.name?.trim() || member.email;
}

const who = memberName;

/** Quién mira la pantalla, para ofrecer sólo lo que tiene chance de poder hacer. */
export interface TeamActor {
  readonly userId: string | null;
  readonly superadmin: boolean;
  /** El rango más alto de sus memberships activas. */
  readonly rank: number;
}

export const ANONYMOUS_ACTOR: TeamActor = { userId: null, superadmin: false, rank: 0 };

export function teamActorOf(
  userId: string | null,
  memberships: readonly { readonly role: string; readonly status: string }[],
): TeamActor {
  const active = memberships.filter((m) => m.status === 'active');
  return {
    userId,
    superadmin: active.some((m) => m.role === 'superadmin'),
    rank: active.reduce((max, m) => Math.max(max, roleRank(m.role)), 0),
  };
}

/** Equipo abierto en ese nodo. Un id fuera de la red de quien mira, Equipo lo ignora. */
export function teamHrefFor(tenantId: string): string {
  return `/admin/usuarios?${new URLSearchParams({ tenant: tenantId }).toString()}`;
}

export function isSelf(actor: TeamActor, member: Pick<NetworkMember, 'userId'>): boolean {
  return actor.userId !== null && actor.userId === member.userId;
}

/**
 * Sin memberships leídas no sabemos quién mira (falló `/me/memberships`): la pantalla es de admins,
 * así que se ofrecen las acciones y decide el API, en vez de dejar al admin sin ninguna.
 */
function actorUnknown(actor: TeamActor): boolean {
  return !actor.superadmin && actor.rank === 0;
}

/** ¿Tiene sentido ofrecerle acciones sobre este miembro? Nunca sobre sí mismo ni sobre un par. */
export function canActOn(
  actor: TeamActor,
  member: Pick<NetworkMember, 'userId' | 'role'>,
): boolean {
  if (isSelf(actor, member)) return false;
  return actor.superadmin || actorUnknown(actor) || actor.rank > roleRank(member.role);
}

/** Los roles que el actor puede dar: estrictamente por debajo del suyo. */
export function grantableRoles<T extends { readonly value: string }>(
  roles: readonly T[],
  actor: TeamActor,
): T[] {
  if (actor.superadmin || actorUnknown(actor)) return [...roles];
  return roles.filter((r) => roleRank(r.value) < actor.rank);
}

export interface ConfirmCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

/** ¿Pasar de `from` a `to` le quita rango? Sólo entonces puede dejar invitaciones sin respaldo. */
export function demotes(from: string, to: string): boolean {
  return roleRank(to) < roleRank(from);
}

/**
 * La confirmación de un cambio de rol, con lo que implica: el 2FA obligatorio y, al degradar, las
 * invitaciones que se revocan (`invitationsToRevoke`, ver {@link revokedInvitationsNotice}).
 */
export function roleChangeCopy(
  member: Pick<NetworkMember, 'name' | 'email' | 'role' | 'mfaEnabled'>,
  to: string,
  labelOf: (role: string) => string,
  invitationsToRevoke: number | null = 0,
): ConfirmCopy {
  const promotes = roleRank(to) > roleRank(member.role);
  const mfa =
    requiresMfa(to) && member.mfaEnabled !== true
      ? ' Su nuevo rol exige verificación en dos pasos: al próximo ingreso tiene que activarla antes de seguir.'
      : '';
  const invitations = demotes(member.role, to) ? revokedInvitationsNotice(invitationsToRevoke) : '';
  return {
    title: `${promotes ? 'Promover' : 'Cambiar el rol de'} ${who(member)}`,
    description: `Pasa de ${labelOf(member.role)} a ${labelOf(to)} en este nodo.${mfa}${invitations}`,
    confirmLabel: promotes ? `Promover a ${labelOf(to)}` : 'Cambiar rol',
  };
}

/**
 * La confirmación de suspender o reactivar la membership de este nodo. Suspender corta sólo este
 * nodo (y cierra las sesiones que tenía abiertas en él): si trabaja en otros, ahí sigue.
 */
export function statusChangeCopy(
  member: Pick<NetworkMember, 'name' | 'email'>,
  status: 'active' | 'suspended',
  invitationsToRevoke: number | null = 0,
): ConfirmCopy {
  const name = who(member);
  if (status === 'active') {
    return {
      title: `Reactivar a ${name}`,
      description: 'Vuelve a tener acceso a este nodo.',
      confirmLabel: 'Reactivar',
    };
  }
  return {
    title: `Suspender a ${name}`,
    description: `Pierde el acceso a este nodo de inmediato y se cierran sus sesiones abiertas en él. Si trabaja en otros nodos, ahí sigue operando.${revokedInvitationsNotice(invitationsToRevoke)}`,
    confirmLabel: 'Suspender',
  };
}

export type MemberAction =
  | 'reset-mfa'
  | 'revoke-sessions'
  | 'send-password-reset'
  | 'require-password-reset'
  | 'unlock';

export interface MemberActionCopy {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly done: string;
}

/** Lo que los textos de una acción miran del miembro. */
export type MemberCopySubject = Pick<NetworkMember, 'name' | 'email' | 'role'> &
  Partial<Pick<NetworkMember, 'passwordResetRequired'>>;

/** Los textos de la confirmación y del aviso de cada acción de soporte. */
export function memberActionCopy(
  action: MemberAction,
  member: MemberCopySubject,
): MemberActionCopy {
  const name = who(member);
  if (action === 'send-password-reset' && member.passwordResetRequired === true) {
    // Con el cambio forzado pendiente la actual ya no sirve: no se puede decir que sigue funcionando.
    return {
      label: 'Enviar enlace para restablecer contraseña',
      title: `Enviar a ${name} un enlace para restablecer su contraseña`,
      description: `Le enviamos a ${member.email} un enlace nuevo para que elija su contraseña. Vence en 60 minutos y deja sin efecto los enlaces anteriores. Tú no ves el enlace ni la contraseña, y hasta que la elija no puede ingresar.`,
      confirmLabel: 'Enviar enlace',
      done: `Le enviamos a ${name} un enlace nuevo para elegir su contraseña. Vence en 1 hora.`,
    };
  }
  if (action === 'require-password-reset') {
    return {
      label: 'Forzar cambio de contraseña',
      title: `Forzar a ${name} a cambiar su contraseña`,
      description:
        'Se cierran todas sus sesiones y no puede volver a ingresar hasta que elija una contraseña nueva con el enlace que le enviamos a su correo. Úsalo si crees que su contraseña está comprometida.',
      confirmLabel: 'Forzar cambio',
      done: `${name} tiene que elegir una contraseña nueva. Le enviamos el enlace y cerramos sus sesiones.`,
    };
  }
  if (action === 'send-password-reset') {
    return {
      label: 'Enviar enlace para restablecer contraseña',
      title: `Enviar a ${name} un enlace para restablecer su contraseña`,
      description: `Le enviamos a ${member.email} un enlace para que elija una contraseña nueva. Vence en 60 minutos y deja sin efecto los enlaces anteriores. Tú no ves el enlace ni la contraseña, y la actual sigue funcionando hasta que la cambie.`,
      confirmLabel: 'Enviar enlace',
      done: `Le enviamos a ${name} un enlace para elegir una contraseña nueva. Vence en 1 hora.`,
    };
  }
  if (action === 'unlock') {
    return {
      label: 'Desbloquear cuenta',
      title: `Desbloquear a ${name}`,
      description:
        'Se levanta el bloqueo por intentos fallidos y puede volver a intentar ingresar de inmediato. No cambia su contraseña ni su 2FA. Si no reconoce esos intentos, mejor envíale un enlace para restablecer la contraseña.',
      confirmLabel: 'Desbloquear',
      done: `Desbloqueamos la cuenta de ${name}.`,
    };
  }
  if (action === 'reset-mfa') {
    return {
      label: 'Restablecer 2FA',
      title: `Restablecer el 2FA de ${name}`,
      description: `Se borran su app de autenticación, sus códigos de recuperación y sus equipos de confianza, se levanta el bloqueo por intentos fallidos si lo tenía, y se cierran todas sus sesiones. ${
        requiresMfa(member.role)
          ? 'Como su rol lo exige, al próximo ingreso tiene que configurarlo de nuevo antes de seguir.'
          : 'Al próximo ingreso entra sólo con su contraseña y puede volver a activarlo.'
      } Hazlo sólo si confirmaste que es la persona (por ejemplo, perdió el teléfono).`,
      confirmLabel: 'Restablecer 2FA',
      done: `Restablecimos el 2FA de ${name}. Se cerraron sus sesiones.`,
    };
  }
  return {
    label: 'Cerrar sus sesiones',
    title: `Cerrar las sesiones de ${name}`,
    description:
      'Se cierran todas sus sesiones abiertas, en cualquier equipo, y se liberan sus puestos. Si estaba trabajando, pierde lo que no haya guardado. Puede volver a ingresar cuando quiera: no se suspende su acceso.',
    confirmLabel: 'Cerrar sesiones',
    done: `Cerramos las sesiones de ${name}.`,
  };
}

/** Lo que respondió el API a una acción de soporte que salió bien. */
export interface MemberActionResult {
  /** Cuántas sesiones cerró "Cerrar sus sesiones"; `undefined` si la respuesta no lo dice. */
  readonly revoked: number | undefined;
  /** Si salió el correo con el enlace para restablecer (o elegir, si se forzó) la contraseña. */
  readonly sent?: boolean | undefined;
  /** Cuántas sesiones cerró "Forzar cambio de contraseña". */
  readonly revokedSessions?: number | undefined;
  /** Si "Desbloquear cuenta" levantó un bloqueo; `false` = ya no estaba bloqueado. */
  readonly unlocked?: boolean | undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * La respuesta de una acción de soporte. Nunca falla: si el cuerpo no trae el conteo, la acción
 * igual salió bien (el 2xx lo dice) y se avisa con el texto general.
 */
export function parseMemberActionResult(value: unknown): MemberActionResult {
  const r = asRecord(value);
  return {
    revoked: count(r?.['revoked']),
    sent: bool(r?.['sent']),
    revokedSessions: count(r?.['revokedSessions']),
    unlocked: bool(r?.['unlocked']),
  };
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * El aviso tras una acción que salió bien. "Cerrar sus sesiones" se ofrece siempre (el "En línea"
 * de la lista no ve las sesiones de otros nodos del miembro), así que puede no haber cerrado
 * ninguna: se dice, en vez de afirmar que se cerraron. Lo mismo con un desbloqueo que llegó tarde
 * (el bloqueo venció solo) y con un enlace cuyo correo no salió.
 */
export function memberActionDoneMessage(
  action: MemberAction,
  member: MemberCopySubject,
  result: MemberActionResult,
): string {
  if (action === 'revoke-sessions' && result.revoked === 0) {
    return `${who(member)} no tenía sesiones abiertas.`;
  }
  if (action === 'send-password-reset' && result.sent === false) {
    return 'Generamos el enlace, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo e inténtalo de nuevo.';
  }
  if (action === 'require-password-reset' && result.sent === false) {
    return `${who(member)} tiene que elegir una contraseña nueva y cerramos sus sesiones, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo y envíale el enlace de nuevo.`;
  }
  if (action === 'unlock' && result.unlocked === false) {
    return `${who(member)} ya no estaba bloqueado.`;
  }
  return memberActionCopy(action, member).done;
}

/**
 * Un enlace cuyo correo no salió es un éxito a medias: se avisa como advertencia, para que el admin
 * revise el correo del nodo en vez de esperar a que llegue.
 */
export function memberActionNoticeTone(
  action: MemberAction,
  result: MemberActionResult,
): 'success' | 'warning' {
  const sendsLink = action === 'send-password-reset' || action === 'require-password-reset';
  return sendsLink && result.sent === false ? 'warning' : 'success';
}

/** Una acción del menú de un miembro, con su texto y si se puede elegir. */
export interface MemberMenuItem {
  readonly action: MemberAction;
  readonly label: string;
  readonly disabled: boolean;
}

/** Un grupo del menú, con su encabezado. */
export interface MemberMenuGroup {
  readonly heading: string;
  readonly items: readonly MemberMenuItem[];
}

/**
 * Las acciones de soporte del menú de un miembro, agrupadas: lo que le devuelve el acceso y lo que
 * se lo corta. Suspender o reactivar va aparte, al final.
 *
 * "Desbloquear cuenta" sólo aparece con un bloqueo vigente. "Enviar enlace…" y "Forzar cambio de
 * contraseña" se ven deshabilitados si su acceso está suspendido, con el motivo en el texto, en vez
 * de esconderse: así el admin sabe que existen y qué le falta.
 */
export function memberMenuGroups(member: NetworkMember, now: number): MemberMenuGroup[] {
  const label = (action: MemberAction) => memberActionCopy(action, member).label;
  const suspended = accessSuspended(member);
  const linkItem = (action: 'send-password-reset' | 'require-password-reset'): MemberMenuItem => ({
    action,
    label: suspended ? `${label(action)} (acceso suspendido)` : label(action),
    disabled: suspended,
  });
  const access: MemberMenuItem[] = [
    linkItem('send-password-reset'),
    linkItem('require-password-reset'),
  ];
  if (isLocked(member, now)) {
    access.push({ action: 'unlock', label: label('unlock'), disabled: false });
  }
  const canResetMfa = member.mfaEnabled !== false;
  return [
    { heading: 'Acceso', items: access },
    {
      heading: 'Seguridad',
      items: [
        // Siempre disponible: `activeSessions` cuenta sólo las sesiones de este subárbol y el
        // miembro puede tener la suya abierta en otro de sus nodos. La acción las cierra todas, y si
        // no había ninguna el aviso lo dice.
        { action: 'revoke-sessions', label: label('revoke-sessions'), disabled: false },
        {
          action: 'reset-mfa',
          label: canResetMfa ? label('reset-mfa') : `${label('reset-mfa')} (no lo tiene activo)`,
          disabled: !canResetMfa,
        },
      ],
    },
  ];
}

/**
 * El mensaje de una acción rechazada. El 403 trae el motivo del API (no administra todos sus
 * nodos, no lo supera en rango…) y se muestra tal cual: es lo que el admin necesita para saber a
 * quién pedírselo.
 */
export function memberActionError(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  const text = message?.trim() ?? '';
  if (status === 403) {
    return text !== ''
      ? `No lo pudimos hacer: ${text}`
      : 'No tienes permiso para hacer esto con este miembro. Pídeselo a quien administra todos sus nodos o al superadmin.';
  }
  if (status === 404) return text || 'Ese miembro ya no está en este nodo. Recarga la lista.';
  // El 409 (su acceso está suspendido) y el 429 (ya se le enviaron varios enlaces) traen el motivo
  // del API y qué hacer: se muestran tal cual.
  if (status === 409) {
    return text || 'No lo pudimos hacer: su acceso está suspendido. Reactívalo primero.';
  }
  if (status === 429) {
    return text || 'Hiciste varios pedidos seguidos. Espera unos minutos e inténtalo de nuevo.';
  }
  if (text !== '') return text;
  return status >= 500
    ? 'No pudimos completar la acción. Inténtalo de nuevo en unos minutos.'
    : 'No pudimos completar la acción.';
}

/** El error de carga del equipo, distinto de "no hay nadie". */
export function teamLoadError(status: number): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'No tienes permiso para ver el equipo de este nodo.';
  if (status === 404) return 'No encontramos ese nodo. Elige otro de la lista.';
  return 'No pudimos cargar el equipo. Inténtalo de nuevo.';
}
