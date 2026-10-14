import { roleLabel } from '../app/(app)/admin/usuarios/_components/roles';

/**
 * Cómo se lee el audit log en el panel: la Actividad de la red (Mi Red) y el historial de una persona
 * (su ficha). Sin I/O ni React, para probar los textos sin levantar Next.
 *
 * El API devuelve los eventos crudos (`event_type` y payload); acá se vuelven una frase: qué pasó
 * ("Cambio de rol") y el detalle ("a ana@agencia.com · de Vendedor a Admin agencia"). Un tipo sin
 * etiqueta se muestra con su código, en monoespaciada: mejor el código que una frase inventada.
 */

export type AuditCategory = 'users' | 'credentials' | 'pricing' | 'network';
export type AuditFilter = 'all' | AuditCategory;

/** Los filtros de la Actividad de la red. Espejo de AUDIT_CATEGORIES del API. */
export const AUDIT_FILTERS: readonly { readonly id: AuditFilter; readonly label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'users', label: 'Usuarios' },
  { id: 'credentials', label: 'Credenciales' },
  { id: 'pricing', label: 'Precios' },
  { id: 'network', label: 'Red' },
];

export function isAuditFilter(value: string): value is AuditFilter {
  return AUDIT_FILTERS.some((f) => f.id === value);
}

/** Un evento como lo devuelve el API (`occurredAt` ya en texto). */
export interface AuditEntryView {
  readonly id: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly actorEmail: string | null;
  /** Sobre quién se hizo, si no es quien lo hizo. */
  readonly targetEmail: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditPageView {
  readonly events: readonly AuditEntryView[];
  /** Lo que se manda como `before` para la página siguiente; `null` si no hay más. */
  readonly nextBefore: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * La página que mandó el API. Nunca lanza: lo que no se puede leer se descarta (un evento sin id,
 * tipo o fecha), y una respuesta rara es una página vacía sin más.
 */
export function parseAuditPage(raw: unknown): AuditPageView {
  const body = record(raw);
  const list = Array.isArray(body?.['events']) ? (body['events'] as unknown[]) : [];
  const events: AuditEntryView[] = [];
  for (const item of list) {
    const e = record(item);
    const id = text(e?.['id']);
    const eventType = text(e?.['eventType']);
    const occurredAt = text(e?.['occurredAt']);
    if (e === null || id === null || eventType === null || occurredAt === null) continue;
    if (Number.isNaN(Date.parse(occurredAt))) continue;
    events.push({
      id,
      eventType,
      occurredAt,
      tenantId: text(e['tenantId']),
      tenantName: text(e['tenantName']),
      actorEmail: text(e['actorEmail']),
      targetEmail: text(e['targetEmail']),
      payload: record(e['payload']) ?? {},
    });
  }
  return { events, nextBefore: text(body?.['nextBefore']) };
}

/**
 * En qué filtro cae un evento, por el prefijo de su tipo. Espejo de CATEGORY_FILTERS del API:
 * `null` = sólo aparece en "Todo".
 */
export function categoryOf(eventType: string): AuditCategory | null {
  if (
    eventType.startsWith('auth.') ||
    eventType.startsWith('users.') ||
    eventType.startsWith('User') ||
    eventType.startsWith('Membership')
  ) {
    return 'users';
  }
  if (eventType.startsWith('ProviderCredentials')) return 'credentials';
  if (eventType.startsWith('Markup')) return 'pricing';
  if (eventType.startsWith('Tenant') || eventType.startsWith('tenant.')) return 'network';
  return null;
}

const LABELS: Readonly<Record<string, string>> = {
  UserInvited: 'Invitación enviada',
  UserInvitationResent: 'Invitación reenviada',
  UserInvitationRevoked: 'Invitación revocada',
  UserInvitationAccepted: 'Invitación aceptada',
  UserInvitationRejected: 'Invitación rechazada (ya no era válida)',
  MembershipRoleChanged: 'Cambio de rol',
  MembershipRemoved: 'Quitado del nodo',
  'auth.mfa.reset_by_admin': '2FA restablecido por un administrador',
  'auth.sessions.revoked_by_admin': 'Sesiones cerradas por un administrador',
  'auth.session.revoked_by_admin': 'Sesión cerrada por un administrador',
  'auth.session.released_by_admin': 'Puesto liberado',
  'auth.password_reset.sent_by_admin': 'Enlace para restablecer contraseña enviado',
  'auth.password_reset.required_by_admin': 'Cambio de contraseña forzado',
  'auth.lockout.cleared_by_admin': 'Cuenta desbloqueada',
  'auth.login.success': 'Ingresó',
  'auth.login.failed': 'Ingreso fallido',
  'auth.login.blocked': 'Ingreso bloqueado por intentos',
  'auth.login.password_reset_required': 'Ingreso frenado: debe cambiar su contraseña',
  'auth.password_reset.requested': 'Pidió restablecer su contraseña',
  'auth.password_reset.completed': 'Restableció su contraseña',
  'auth.password_changed': 'Cambió su contraseña',
  'auth.mfa.enabled': '2FA activado',
  'auth.mfa.disabled': '2FA desactivado',
  'auth.mfa.step_up': 'Reconfirmó su 2FA para una acción de alto impacto',
  'users.exported': 'Exportó la lista de usuarios',
  TenantCreated: 'Nodo creado',
  ProviderCredentialsUpdated: 'Credenciales de proveedor actualizadas',
  MarkupRuleCreated: 'Regla de markup creada',
  MarkupRuleDeleted: 'Regla de markup eliminada',
  // Maletas y servicios adicionales de una reserva, antes de emitir (SAB-20).
  OrderServicesRequested: 'Pidió un cambio de servicios adicionales',
  OrderServicesAdded: 'Servicios adicionales agregados a una reserva',
  OrderServicesRemoved: 'Servicios adicionales quitados de una reserva',
  OrderServicesChangeFailed: 'Cambio de servicios adicionales sin completar',
  'portfolio.hold.adjusted': 'Retención de cartera ajustada por servicios adicionales',
  // Datos de los pasajeros de una reserva hecha (SAB-25).
  OrderTravelersModifyRequested: 'Pidió corregir datos de pasajeros',
  OrderTravelersModified: 'Datos de pasajeros corregidos en una reserva',
  OrderTravelersModifyFailed: 'Corrección de datos de pasajeros sin completar',
};

export interface EventLabel {
  readonly text: string;
  /** No hay etiqueta para ese tipo: `text` es el código crudo y se muestra en monoespaciada. */
  readonly raw: boolean;
}

/** Qué pasó, en una frase. Algunos tipos dicen distinto según el payload (suspendido o reactivado). */
export function eventLabel(
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): EventLabel {
  const suspended = payload['status'] === 'suspended';
  if (eventType === 'MembershipStatusChanged') {
    return {
      text: suspended ? 'Acceso al nodo suspendido' : 'Acceso al nodo reactivado',
      raw: false,
    };
  }
  if (eventType === 'UserStatusChanged') {
    return {
      text: suspended ? 'Cuenta suspendida en toda la plataforma' : 'Cuenta reactivada',
      raw: false,
    };
  }
  const label = LABELS[eventType];
  return label === undefined ? { text: eventType, raw: true } : { text: label, raw: false };
}

const LOGIN_FAILURES: Readonly<Record<string, string>> = {
  bad_password: 'Contraseña incorrecta',
  inactive: 'Con la cuenta suspendida',
  unknown_user: 'Correo no registrado',
};

const LOGIN_METHODS: Readonly<Record<string, string>> = {
  password: 'Con contraseña',
  mfa: 'Con contraseña y 2FA',
  trusted_device: 'Desde un equipo de confianza',
  seat_release: 'Liberando un puesto',
};

/** Por qué se revocó una invitación que nadie revocó a mano: algo le pasó a quien la envió. */
const REVOCATION_CAUSES: Readonly<Record<string, string>> = {
  membership_suspended: 'al suspender el acceso de quien la envió',
  membership_removed: 'al quitar del nodo a quien la envió',
  role_changed: 'al cambiar el rol de quien la envió',
  user_suspended: 'al suspender la cuenta de quien la envió',
};

const INVITATION_DEFECTS: Readonly<Record<string, string>> = {
  inviter_missing: 'quien la envió ya no está',
  inviter_inactive: 'quien la envió está suspendido',
  inviter_outranked: 'quien la envió ya no tiene rango para ese rol',
  tenant_inactive: 'el nodo está suspendido',
};

const VERTICALS: Readonly<Record<string, string>> = {
  all: 'Todas las verticales',
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
  assistance: 'Asistencia',
  activities: 'Actividades',
};

const RULE_TYPES: Readonly<Record<string, string>> = {
  percentage: 'porcentaje',
  fixed: 'monto fijo',
};

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function sessionsClosed(value: unknown): string | null {
  const n = count(value);
  if (n === null || n === 0) return null;
  return n === 1 ? '1 sesión cerrada' : `${n} sesiones cerradas`;
}

function role(value: unknown): string | null {
  const r = text(value);
  return r === null ? null : roleLabel(r);
}

function asRole(value: unknown): string | null {
  const r = role(value);
  return r === null ? null : `como ${r}`;
}

/**
 * El detalle de un evento, en una línea: a quién y qué cambió. Vacío si no hay nada que agregar a la
 * etiqueta. Nunca muestra ids: sólo correos, roles y estados.
 */
export function eventDetail(
  entry: Pick<AuditEntryView, 'eventType' | 'payload' | 'targetEmail'>,
): string {
  const p = entry.payload;
  const target = entry.targetEmail === null ? null : `a ${entry.targetEmail}`;
  const parts: (string | null)[] = [];

  switch (entry.eventType) {
    case 'MembershipRoleChanged': {
      const from = role(p['previousRole']);
      const to = role(p['newRole']);
      parts.push(target, from !== null && to !== null ? `de ${from} a ${to}` : null);
      break;
    }
    case 'MembershipStatusChanged':
    case 'MembershipRemoved':
      parts.push(target, role(p['role']));
      break;
    case 'UserInvited': {
      const to = text(p['email']);
      parts.push(to === null ? null : `a ${to}`, asRole(p['role']));
      break;
    }
    case 'UserInvitationAccepted':
      parts.push(text(p['email']), asRole(p['role']));
      break;
    case 'UserInvitationResent':
      parts.push(asRole(p['role']));
      break;
    case 'UserInvitationRevoked': {
      const cause = text(p['cause']);
      parts.push(asRole(p['role']), cause === null ? null : (REVOCATION_CAUSES[cause] ?? null));
      break;
    }
    case 'UserInvitationRejected': {
      const defect = text(p['defect']);
      parts.push(defect === null ? null : (INVITATION_DEFECTS[defect] ?? null));
      break;
    }
    case 'UserStatusChanged':
      parts.push(target, sessionsClosed(p['revokedSessions']));
      break;
    case 'auth.sessions.revoked_by_admin':
      parts.push(target, sessionsClosed(p['revoked']));
      break;
    case 'auth.password_reset.required_by_admin':
      parts.push(target, sessionsClosed(p['revokedSessions']));
      break;
    case 'auth.login.failed': {
      const reason = text(p['reason']);
      parts.push(reason === null ? null : (LOGIN_FAILURES[reason] ?? null));
      break;
    }
    case 'auth.login.success': {
      const method = text(p['method']);
      parts.push(method === null ? null : (LOGIN_METHODS[method] ?? null));
      break;
    }
    case 'auth.login.password_reset_required':
      parts.push(p['linkSent'] === true ? 'Se le reenvió el enlace' : null);
      break;
    case 'ProviderCredentialsUpdated':
      parts.push(text(p['providerCode']), text(p['label']));
      break;
    case 'MarkupRuleCreated': {
      const vertical = text(p['vertical']);
      const ruleType = text(p['ruleType']);
      parts.push(
        vertical === null ? null : (VERTICALS[vertical] ?? vertical),
        ruleType === null ? null : (RULE_TYPES[ruleType] ?? null),
      );
      break;
    }
    case 'TenantCreated':
      parts.push(text(p['slug']));
      break;
    default:
      parts.push(target);
  }
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** Cuándo, corto: "13 oct, 09:41". */
export function auditTime(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Qué decir cuando la actividad no carga, según lo que respondió el BFF (`{ error, reason? }` con
 * el estado del API). El mensaje del API ya viene en castellano; si no vino, uno por estado.
 */
export function auditLoadError(status: number, body: unknown): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a ingresar.';
  const message = text(record(body)?.['error']);
  if (status === 403) return message ?? 'No tienes acceso a la actividad de este nodo.';
  if (status === 400)
    return message ?? 'Los filtros de la actividad no son válidos. Recarga la página.';
  return 'No pudimos cargar la actividad. Inténtalo de nuevo.';
}

/** La consulta de la Actividad de la red al BFF: el nodo, el filtro y desde dónde sigue. */
export function networkAuditUrl(tenantId: string, filter: AuditFilter, before?: string): string {
  const params = new URLSearchParams({ tenantId });
  if (filter !== 'all') params.set('category', filter);
  if (before !== undefined) params.set('before', before);
  return `/api/tenants/network/audit?${params.toString()}`;
}
