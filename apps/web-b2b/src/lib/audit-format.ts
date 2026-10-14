import { roleLabel } from '../app/(app)/admin/usuarios/_components/roles';
import { providerMetaFor } from './provider-display';

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
  // USR-17: una sesión de otra cuenta intentó aceptarla; quedó pendiente para su dueño.
  UserInvitationAccountMismatch: 'Invitación rechazada (otra cuenta intentó aceptarla)',
  // USR-18: la persona cambió su propio nombre (Mi cuenta → Perfil).
  UserProfileUpdated: 'Cambió su nombre',
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
  'auth.mfa.reauth_failed': 'Verificación fallida dentro de su sesión',
  'users.exported': 'Exportó la lista de usuarios',
  TenantCreated: 'Nodo creado',
  ProviderCredentialsUpdated: 'Credenciales de proveedor actualizadas',
  MarkupRuleCreated: 'Regla de markup creada',
  MarkupRuleDeleted: 'Regla de markup eliminada',
};

/**
 * Accesos y sesiones que la plataforma también registra (Plataforma → Actividad, chip Accesos).
 * Van aparte de LABELS para que cada frente sume las suyas sin pisarse; si un tipo está en las dos,
 * manda LABELS.
 */
const ACCESS_LABELS: Readonly<Record<string, string>> = {
  'auth.register': 'Se registró',
  'auth.email_verified': 'Verificó su correo',
  'auth.logout': 'Cerró sesión',
  'auth.logout_all': 'Cerró todas sus sesiones',
  'auth.switch_tenant': 'Cambió de agencia',
  'auth.session.revoked': 'Cerró una de sus sesiones',
  'auth.session.replaced': 'Sesión reemplazada por un ingreso nuevo',
  'auth.session.idle_timeout': 'Sesión cerrada por inactividad',
  'auth.seat.denied': 'Ingreso frenado: sin puestos libres',
  'auth.seat.released_at_login': 'Liberó un puesto al ingresar',
  'auth.sessions.revoked_by_tenant_move': 'Sesiones cerradas al mover su nodo',
  'auth.mfa.challenged': 'Se le pidió el código del 2FA',
  'auth.mfa.failed': 'Código del 2FA incorrecto',
  'auth.mfa.enrollment_started': 'Empezó a activar el 2FA',
  'auth.mfa.recovery_regenerated': 'Generó códigos de recuperación nuevos',
  'auth.mfa.recovery_code_used': 'Usó un código de recuperación',
  'auth.mfa.reauth_failed': 'Falló al reconfirmar su 2FA',
  'auth.password_reset.email_failed': 'No se pudo enviar el correo para restablecer la contraseña',
  UserInvitationEmailFailed: 'No se pudo enviar la invitación por correo',
};

/**
 * Lo que pasa en la operación (Plataforma → Actividad): reservas, carteras, nodos, proveedores, la
 * consola de la plataforma y lo que corre solo. Los de una reserva son también los de la Actividad de
 * su ficha (Reservas de la red).
 */
const OPERATION_LABELS: Readonly<Record<string, string>> = {
  // Una reserva (ORDER_EVENTS y HOTEL_EVENTS del API).
  OrderCreateRequested: 'Se pidió la reserva al proveedor',
  OrderCreated: 'Respondió el proveedor',
  OrderCreateFailed: 'Falló el pedido al proveedor',
  OrderCreationVerified: 'Reserva verificada con el proveedor',
  OrderCompensationScheduled: 'Se programó una compensación',
  OrderEscalated: 'Pasó a revisión de una persona',
  OrderCancellationAttempted: 'Se intentó cancelar',
  OrderTicketIssueRequested: 'Se pidió emitir los tiquetes',
  OrderTicketed: 'Tiquetes emitidos',
  OrderTicketIssueFailed: 'La emisión de tiquetes no terminó',
  OrderTicketsVoided: 'Tiquetes anulados',
  OrderTicketingDeadlineApproaching: 'Aviso del plazo de emisión',
  OrderSeatsNotConfirmed: 'La aerolínea no confirmó asientos',
  OrderProviderStatusChanged: 'Cambió el estado en el proveedor',
  OrderFlightDocumentsChanged: 'Cambiaron los documentos del vuelo',
  OrderReconciliationDiscrepancy: 'Diferencia en la conciliación',
  HotelConfirmationNumberReceived: 'Llegó la confirmación del hotel (HCN)',
  HotelConfirmationNumberMissing: 'Sin confirmación del hotel (HCN)',
  HotelOfferRepriced: 'El proveedor cambió el precio',
  HotelNonRefundableAcknowledged: 'Se aceptó la tarifa no reembolsable',
  CarReservationCreated: 'Reserva de auto creada',
  'platform.order.viewed': 'El superadmin abrió la reserva',
  // Los proveedores.
  ProviderBookingUnmatched: 'Reserva del proveedor sin orden',
  ProviderAccountIssueDetected: 'Problema con la cuenta del proveedor',
  ProviderReconciliationRequested: 'Se pidió conciliar con el proveedor',
  ProviderPayloadsExported: 'Se leyeron los mensajes con el proveedor',
  ProviderPayloadsPurged: 'Se borraron los mensajes vencidos con el proveedor',
  'platform.provider_enablement.updated': 'Cambió la habilitación de un proveedor',
  'platform.provider_kill_switch.set': 'Apagado de emergencia de un proveedor',
  'platform.provider_kill_switch.cleared': 'Se levantó el apagado de un proveedor',
  'platform.provider_circuit.reset': 'Se reabrió el circuito de un proveedor',
  'tenant.provider_disclosure.updated': 'Cambió qué proveedores se muestran',
  // Las carteras.
  'portfolio.created': 'Cartera habilitada',
  'portfolio.credit_limit.changed': 'Cupo de crédito cambiado',
  'portfolio.status.changed': 'Estado de la cartera cambiado',
  'portfolio.deposit.recorded': 'Depósito registrado',
  'portfolio.adjustment.recorded': 'Ajuste registrado',
  'portfolio.deposit_report.submitted': 'La agencia informó un depósito',
  'portfolio.deposit_report.approved': 'Depósito informado aprobado',
  'portfolio.deposit_report.rejected': 'Depósito informado rechazado',
  'portfolio.hold.retained': 'Se retuvo cupo por una reserva',
  'portfolio.hold.captured': 'Retención cobrada',
  'portfolio.hold.released': 'Retención liberada',
  'portfolio.hold.uncaptured': 'Se deshizo el cobro de una retención',
  'portfolio.hold.conflict': 'Retención en conflicto',
  'portfolio.hold.exempted': 'Reserva sin retención (credenciales propias)',
  'portfolio.network_hold.blocked': 'Venta frenada por falta de cupo en la red',
  'portfolio.network_hold.would_block': 'La venta se habría frenado por cupo (modo observar)',
  'portfolios.network_hold.report_failed': 'No se pudo revisar el cupo de la red',
  'wallet_hold.policy_changed': 'Cambió el modo de la retención en cascada',
  // Los nodos.
  'tenant.updated': 'Nodo actualizado',
  'tenant.moved': 'Nodo movido en la red',
  'tenant.type.changed': 'Cambió el tipo del nodo',
  'tenant.seats.updated': 'Puestos del nodo cambiados',
  'tenant.config.updated': 'Configuración del nodo cambiada',
  'tenant.branding.updated': 'Marca del nodo cambiada',
  'tenant.brand_asset.uploaded': 'Imagen de marca subida',
  'booking.permissions.non_refundable_rates.changed':
    'Cambió el permiso de tarifas no reembolsables',
  'mail.test': 'Correo de prueba enviado',
  // La consola de la plataforma y lo que corre solo.
  'platform.announcement.published': 'Anuncio publicado',
  'platform.announcement.updated': 'Anuncio corregido',
  'platform.announcement.archived': 'Anuncio archivado',
  'platform.audit.exported': 'Exportó la actividad de la plataforma',
  'platform.orders.exported': 'Exportó las reservas de la red',
  'system.post_sale_sweep.completed': 'Barrido de post-venta',
  'system.post_sale_sweep.failed': 'El barrido de post-venta falló',
};

export type AdminOrderActionKind = 'send-confirmation' | 'retrieve' | 'retry-cancel' | 'cancel';

/** Las acciones de post-venta del superadmin sobre una reserva (`platform.order.action`). */
export const ADMIN_ORDER_ACTION_LABELS: Readonly<
  Record<AdminOrderActionKind, { readonly ok: string; readonly failed: string }>
> = {
  'send-confirmation': {
    ok: 'El superadmin reenvió la confirmación',
    failed: 'El superadmin intentó reenviar la confirmación',
  },
  retrieve: {
    ok: 'El superadmin consultó el estado al proveedor',
    failed: 'El superadmin intentó consultar el estado al proveedor',
  },
  'retry-cancel': {
    ok: 'El superadmin reintentó la cancelación',
    failed: 'El superadmin intentó reintentar la cancelación',
  },
  cancel: {
    ok: 'El superadmin canceló la reserva',
    failed: 'El superadmin intentó cancelar la reserva',
  },
};

function isAdminOrderAction(value: unknown): value is AdminOrderActionKind {
  return typeof value === 'string' && Object.hasOwn(ADMIN_ORDER_ACTION_LABELS, value);
}

function adminOrderActionLabel(payload: Readonly<Record<string, unknown>>): string {
  const action = payload['action'];
  if (!isAdminOrderAction(action)) return 'Acción del superadmin sobre la reserva';
  const labels = ADMIN_ORDER_ACTION_LABELS[action];
  return payload['outcome'] === 'ok' ? labels.ok : labels.failed;
}

/** El estado al que quedó un nodo en `tenant.updated` (`payload.after.status`), si cambió. */
function tenantStatusAfter(payload: Readonly<Record<string, unknown>>): string | null {
  return text(record(payload['after'])?.['status']);
}

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
  if (eventType === 'tenant.updated') {
    const status = tenantStatusAfter(payload);
    if (status === 'suspended') return { text: 'Nodo suspendido', raw: false };
    if (status === 'active') return { text: 'Nodo reactivado', raw: false };
  }
  if (eventType === 'platform.order.action') {
    return { text: adminOrderActionLabel(payload), raw: false };
  }
  const label = LABELS[eventType] ?? ACCESS_LABELS[eventType] ?? OPERATION_LABELS[eventType];
  return label === undefined ? { text: eventType, raw: true } : { text: label, raw: false };
}

const LOGIN_FAILURES: Readonly<Record<string, string>> = {
  bad_password: 'Contraseña incorrecta',
  inactive: 'Con la cuenta suspendida',
  unknown_user: 'Correo no registrado',
};

/**
 * Qué intentaba quien falló la contraseña o el código dentro de su sesión (`action` de
 * MfaService.withLockout). Cada fallo suma al bloqueo de la cuenta, como en el login.
 */
const REAUTH_ACTIONS: Readonly<Record<string, string>> = {
  enroll: 'Contraseña incorrecta al activar el 2FA',
  rotation: 'Al cambiar de teléfono',
  recovery_codes: 'Al regenerar los códigos de recuperación',
  disable: 'Al desactivar el 2FA',
  step_up: 'Al reconfirmar el 2FA',
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

/** "de «Ana Ruiz» a «Ana María Ruiz»", o sólo el nuevo si antes no tenía. */
function nameChange(p: Readonly<Record<string, unknown>>): string | null {
  const before = text(record(p['before'])?.['name']);
  const after = text(record(p['after'])?.['name']);
  if (after === null) return null;
  return before === null ? `«${after}»` : `de «${before}» a «${after}»`;
}

const ANNOUNCEMENT_SEVERITIES: Readonly<Record<string, string>> = {
  info: 'Informativo',
  warning: 'Advertencia',
  critical: 'Crítico',
};

const HOLD_MODES: Readonly<Record<string, string>> = {
  off: 'apagada',
  observe: 'observar',
  enforce: 'aplicar',
};

function reasonText(value: unknown): string | null {
  const reason = text(value);
  return reason === null ? null : `Motivo: ${reason}`;
}

function provider(value: unknown): string | null {
  const code = text(value);
  return code === null ? null : providerMetaFor(code).name;
}

function currencyCode(value: unknown): string | null {
  const code = text(value);
  return code !== null && /^[A-Z]{3}$/.test(code) ? code : null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n.toLocaleString('es-CO')} ${many}`;
}

/**
 * El detalle de los eventos de la operación (OPERATION_LABELS) que dicen algo más que a quién.
 * `null` si no: el detalle de siempre (a quién). Nunca ids: códigos legibles, monedas, conteos y el
 * motivo escrito.
 */
function operationDetail(
  eventType: string,
  p: Readonly<Record<string, unknown>>,
): (string | null)[] | null {
  if (eventType.startsWith('portfolio.')) return [currencyCode(p['currency'])];
  if (eventType.startsWith('platform.announcement.')) {
    const severity = text(p['severity']);
    const audience = record(p['audience']);
    return [
      severity === null ? null : (ANNOUNCEMENT_SEVERITIES[severity] ?? null),
      audience?.['adminsOnly'] === true ? 'sólo administradores' : null,
    ];
  }
  switch (eventType) {
    case 'platform.order.action':
      return [reasonText(p['reason'])];
    case 'tenant.updated':
      return [reasonText(p['reason'])];
    case 'wallet_hold.policy_changed': {
      const from = text(p['previousMode']);
      const to = text(p['mode']);
      return [
        from !== null && to !== null
          ? `de ${HOLD_MODES[from] ?? from} a ${HOLD_MODES[to] ?? to}`
          : null,
      ];
    }
    case 'platform.provider_enablement.updated':
      return [
        provider(p['providerCode']),
        p['scope'] === 'global'
          ? 'para toda la red'
          : p['scope'] === 'tenant'
            ? 'para un nodo'
            : null,
      ];
    case 'platform.provider_kill_switch.set':
      return [provider(p['providerCode']), reasonText(p['reason'])];
    case 'platform.provider_kill_switch.cleared':
    case 'platform.provider_circuit.reset':
    case 'tenant.provider_disclosure.updated':
      return [provider(p['providerCode'] ?? p['provider'])];
    case 'ProviderAccountIssueDetected':
      return [provider(p['providerCode'] ?? p['provider'])];
    case 'platform.audit.exported': {
      const rows = count(p['rows']);
      return [
        rows === null
          ? null
          : plural(rows, 'fila', 'filas') + (p['truncated'] === true ? ' (hasta el tope)' : ''),
      ];
    }
    case 'platform.orders.exported': {
      // Nunca se corta: con más de 5.000 no sale archivo. La búsqueda por correo del cliente no
      // trae el correo (sólo `qByClientEmail`).
      const rows = count(p['rows']);
      const filters = record(p['filters']);
      return [
        rows === null ? null : plural(rows, 'reserva', 'reservas'),
        filters?.['qByClientEmail'] === true ? 'buscando por el correo de un cliente' : null,
      ];
    }
    case 'system.post_sale_sweep.completed': {
      const tenants = count(p['tenants']);
      const failed = count(p['tenantsFailed']);
      return [
        tenants === null ? null : plural(tenants, 'nodo revisado', 'nodos revisados'),
        failed === null || failed === 0
          ? null
          : plural(failed, 'nodo con error', 'nodos con error'),
      ];
    }
    case 'system.post_sale_sweep.failed':
      return [text(p['errorClass'])];
    default:
      return null;
  }
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
    case 'UserProfileUpdated':
      parts.push(nameChange(p));
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
    case 'auth.mfa.reauth_failed': {
      const action = text(p['action']);
      parts.push(
        action === null ? null : (REAUTH_ACTIONS[action] ?? null),
        p['locked'] === true ? 'Cuenta bloqueada por intentos' : null,
      );
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
      parts.push(...(operationDetail(entry.eventType, p) ?? [target]));
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
