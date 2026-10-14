import { sessionEndPath } from '../../components/layout/session-guard-state';
import type { ApiError } from '../../lib/api';
import { invitationExpiry } from '../../lib/invitation-expiry';
import { motivoForUnauthorized } from '../../lib/session-reasons';
import { offeredRoleLabel } from '../(app)/admin/usuarios/_components/roles';

/**
 * Qué muestra /invitacion (USR-17), sin Next ni I/O para probarlo: de la vista previa del API
 * (`POST /invitations/preview`) a la pantalla. La página la lee primero y después decide:
 *
 * - invitación que no se puede aceptar (o enlace sin token): que pida otra;
 * - el correo no tiene cuenta: elige su nombre y su contraseña, como siempre;
 * - tiene cuenta y no hay sesión: ingresa con su contraseña de siempre y vuelve acá;
 * - tiene cuenta y la sesión es la suya: un solo botón, "Aceptar invitación";
 * - la sesión es de otra cuenta: salir e ingresar con la invitada.
 *
 * La vista previa no trae ids ni correos; esta capa tampoco los inventa.
 */

/** Quién abre la invitación. Espejo de InvitationViewer del API. */
export type InvitationViewer = 'anonymous' | 'invitee' | 'other';

/** Lo que dice la vista previa de una invitación vigente. */
export interface InvitationPreviewData {
  readonly tenantName: string;
  readonly role: string;
  readonly inviterName: string | null;
  readonly expiresAt: string;
  readonly existingAccount: boolean;
  readonly viewer: InvitationViewer;
}

/** Lo que se pinta arriba: a qué nodo, con qué rol, quién y hasta cuándo. */
export interface InvitationDetails {
  readonly tenantName: string;
  readonly roleLabel: string;
  /** "Te invitó Laura Gómez. La invitación vence en 6 días." o lo que se sepa de eso. */
  readonly summary: string;
}

export type InvitationView =
  | { readonly kind: 'missing-token' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | {
      readonly kind: 'create';
      readonly details: InvitationDetails;
      /** Hay una sesión abierta de otra cuenta en este navegador. */
      readonly signedInElsewhere: boolean;
    }
  | { readonly kind: 'sign-in'; readonly details: InvitationDetails; readonly loginHref: string }
  | { readonly kind: 'join'; readonly details: InvitationDetails }
  | { readonly kind: 'wrong-account'; readonly details: InvitationDetails };

export const INVITATION_MESSAGES = {
  missingToken: 'Este enlace no tiene un token válido.',
  invalid: 'Esta invitación ya no es válida. Pídele a quien te invitó que te la reenvíe.',
  rateLimited: 'Hiciste muchos intentos seguidos. Espera un minuto y prueba de nuevo.',
  unavailable: 'No pudimos conectar con el servidor. Prueba de nuevo en unos segundos.',
  signInRequired:
    'Ya tienes una cuenta con este correo. Ingresa con tu contraseña de siempre para aceptar la invitación.',
  wrongAccount:
    'Esta invitación es para otra cuenta. Sal de esta sesión e ingresa con el correo al que te llegó.',
  alreadyMember: 'Ya formas parte de este nodo. Elígelo en el selector de agencia.',
  noLongerValid: 'Esta invitación ya no es válida, pide una nueva.',
  usedOrExpired:
    'La invitación ya se usó, venció o fue revocada. Pídele a tu administrador que te envíe una nueva.',
  sessionEnded: 'Tu sesión se cerró. Ingresa de nuevo para aceptar la invitación.',
  mfaEnrollment:
    'Tu rol exige la verificación en dos pasos. Actívala en el panel y vuelve a abrir este enlace.',
  unexpected: 'No pudimos aceptar la invitación. Prueba de nuevo.',
} as const;

const MIN_TOKEN = 10;
const MAX_TOKEN = 512;

/**
 * El token de `?token=`, o `null` si no tiene forma de uno. Los que emite el API son base64url; se
 * admite lo mismo que su borde (10 a 512 caracteres) sin espacios ni caracteres de control.
 */
export function invitationTokenFrom(raw: unknown): string | null {
  const value = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (typeof value !== 'string') return null;
  if (value.length < MIN_TOKEN || value.length > MAX_TOKEN) return null;
  // eslint-disable-next-line no-control-regex -- justamente se descartan los caracteres de control
  return /[\s\u0000-\u001f\u007f]/.test(value) ? null : value;
}

/** La ruta de esta misma invitación, para volver después de ingresar. */
export function invitationPath(token: string): string {
  return `/invitacion?token=${encodeURIComponent(token)}`;
}

/**
 * El login que vuelve a esta invitación. `next` pasa por `safeNextPath` en el login (sólo rutas del
 * panel): no hay redirect abierto aunque la URL la arme cualquiera.
 */
export function invitationLoginHref(token: string): string {
  return `/login?next=${encodeURIComponent(invitationPath(token))}`;
}

/** ¿El login viene de una invitación? (`next` ya validado con `safeNextPath`). */
export function isInvitationReturn(next: string): boolean {
  return next.startsWith('/invitacion?');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const VIEWERS: readonly string[] = ['anonymous', 'invitee', 'other'];

/**
 * La vista previa del API, validada. `null` si dice que no es válida o si no tiene la forma
 * esperada: en los dos casos la pantalla dice lo mismo.
 */
export function parseInvitationPreview(body: unknown): InvitationPreviewData | null {
  const r = asRecord(body);
  if (r?.['valid'] !== true) return null;
  const { tenantName, role, inviterName, expiresAt, existingAccount, viewer } = r;
  if (typeof tenantName !== 'string' || tenantName.trim() === '') return null;
  if (typeof role !== 'string' || role === '') return null;
  if (typeof expiresAt !== 'string') return null;
  if (typeof existingAccount !== 'boolean') return null;
  if (typeof viewer !== 'string' || !VIEWERS.includes(viewer)) return null;
  const inviter = typeof inviterName === 'string' && inviterName.trim() !== '' ? inviterName : null;
  return {
    tenantName: tenantName.trim(),
    role,
    inviterName: inviter === null ? null : inviter.trim(),
    expiresAt,
    existingAccount,
    viewer: viewer as InvitationViewer,
  };
}

export function invitationDetails(preview: InvitationPreviewData, now: Date): InvitationDetails {
  const expiry = invitationExpiry(preview.expiresAt, now);
  const parts = [
    preview.inviterName === null ? null : `Te invitó ${preview.inviterName}.`,
    expiry === undefined || expiry.expired ? null : `La invitación ${expiry.label}.`,
  ].filter((p): p is string => p !== null);
  return {
    tenantName: preview.tenantName,
    roleLabel: offeredRoleLabel(preview.role),
    summary: parts.length > 0 ? parts.join(' ') : 'Acepta la invitación para empezar.',
  };
}

/** El título de la pantalla: "Te invitaron a {nodo} como {rol}". */
export function invitationHeadline(details: InvitationDetails): string {
  return `Te invitaron a ${details.tenantName} como ${details.roleLabel}`;
}

/** Lo que responde `api()` a la vista previa. */
export type PreviewResponse = { ok: true; data: unknown } | { ok: false; error: ApiError };

/**
 * La pantalla para esa respuesta de la vista previa.
 *
 * `sessionCookie`: el navegador trae una cookie de sesión. Si aun así el API no vio sesión (la
 * revocaron, la desplazó otro equipo), ir directo al login no sirve: el middleware ve la cookie y
 * devuelve acá. Se pasa por `/api/session/end`, que la borra y sigue al login con la vuelta.
 */
export function invitationViewFor(
  res: PreviewResponse,
  token: string,
  now: Date,
  options: { sessionCookie?: boolean } = {},
): InvitationView {
  if (!res.ok) {
    if (res.error.status === 429) {
      return { kind: 'unavailable', message: INVITATION_MESSAGES.rateLimited };
    }
    // Un 400 es un token con una forma que el API no acepta: tampoco es una invitación válida.
    if (res.error.status === 400) return { kind: 'invalid' };
    // Lo demás no dice nada de la invitación: un 5xx, o el 404 de un API anterior a la vista previa
    // mientras se despliega. Decir que no vale haría pedir un reenvío, que deja sin efecto el enlace.
    return { kind: 'unavailable', message: INVITATION_MESSAGES.unavailable };
  }

  const preview = parseInvitationPreview(res.data);
  if (preview === null) return { kind: 'invalid' };
  const details = invitationDetails(preview, now);

  if (!preview.existingAccount) {
    return { kind: 'create', details, signedInElsewhere: preview.viewer === 'other' };
  }
  switch (preview.viewer) {
    case 'invitee':
      return { kind: 'join', details };
    case 'other':
      return { kind: 'wrong-account', details };
    default:
      return {
        kind: 'sign-in',
        details,
        loginHref: options.sessionCookie
          ? sessionEndPath('expirada', invitationPath(token))
          : invitationLoginHref(token),
      };
  }
}

/**
 * Qué hacer después de un rechazo de `POST /invitations/join`. Se decide por estado y motivo, nunca
 * por el texto del API.
 */
export interface JoinFailure {
  readonly message: string;
  /**
   * La sesión ya no sirve (401): `/api/session/end` borra la cookie y lleva al login con el motivo,
   * que después vuelve a esta invitación.
   */
  readonly signInHref?: string;
  /** La sesión es de otra cuenta: hay que salir de ella. */
  readonly switchAccount?: true;
}

export function joinInvitationFailure(
  error: Pick<ApiError, 'status' | 'reason'>,
  token: string,
): JoinFailure {
  const { status, reason } = error;
  if (status === 401) {
    return {
      message: INVITATION_MESSAGES.sessionEnded,
      signInHref: sessionEndPath(motivoForUnauthorized(reason), invitationPath(token)),
    };
  }
  if (status === 403 && reason === 'INVITATION_ACCOUNT_MISMATCH') {
    return { message: INVITATION_MESSAGES.wrongAccount, switchAccount: true };
  }
  if (status === 403 && reason === 'MFA_ENROLLMENT_REQUIRED') {
    return { message: INVITATION_MESSAGES.mfaEnrollment };
  }
  if (status === 409 && reason === 'ALREADY_MEMBER') {
    return { message: INVITATION_MESSAGES.alreadyMember };
  }
  if (status === 400) {
    return {
      message:
        reason === 'INVITATION_NO_LONGER_VALID'
          ? INVITATION_MESSAGES.noLongerValid
          : INVITATION_MESSAGES.usedOrExpired,
    };
  }
  if (status === 429) return { message: INVITATION_MESSAGES.rateLimited };
  if (status >= 500) return { message: INVITATION_MESSAGES.unavailable };
  return { message: INVITATION_MESSAGES.unexpected };
}
