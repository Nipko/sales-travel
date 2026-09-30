import type { ApiResponse } from '../../../../lib/api';
import {
  isSessionReason,
  motivoForUnauthorized,
  type SessionMotivo,
} from '../../../../lib/session-reasons';

/**
 * Un error del API tal como lo necesita la pantalla de Seguridad: el estado, el `reason` máquina y
 * los `details` publicables (`AllExceptionsFilter`). `api()` sólo conserva el mensaje; acá hace
 * falta el motivo para distinguir "código incorrecto" de "tu sesión se cerró".
 */
export interface ApiFailure {
  status: number;
  message: string;
  reason?: string;
  details?: Record<string, unknown>;
}

const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(body: Record<string, unknown>): string {
  const message = body['message'];
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join(', ');
  return '';
}

export const UNREACHABLE_MESSAGE =
  'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.';

/** El error de una respuesta que no fue 2xx (o que ni siquiera llegó). */
export function failureFrom(res: ApiResponse): ApiFailure {
  if (res.kind !== 'json') return { status: res.status, message: res.message };
  const body = isRecord(res.body) ? res.body : {};
  const reason = body['reason'];
  const details = body['details'];
  return {
    status: res.status,
    message: messageOf(body),
    ...(typeof reason === 'string' && MACHINE_REASON.test(reason) ? { reason } : {}),
    ...(isRecord(details) ? { details } : {}),
  };
}

/**
 * Si el error dice que la sesión ya no existe, el motivo para el login; si no, `null`.
 *
 * Sólo un 401 CON motivo de sesión (o de segundo factor pendiente): un 401 sin motivo en estas
 * pantallas es "contraseña actual incorrecta", que no debe sacar a nadie del panel.
 */
export function sessionEndMotivo(failure: ApiFailure): SessionMotivo | null {
  if (failure.status !== 401) return null;
  if (isSessionReason(failure.reason) || failure.reason === 'MFA_STEP_UP_REQUIRED') {
    return motivoForUnauthorized(failure.reason);
  }
  return null;
}

/** Qué pedía el formulario que falló: define qué quiere decir un 400/401 sin motivo conocido. */
export type FailureContext = 'code' | 'password' | 'password-and-code' | 'other';

const CODE_INVALID = 'El código no es válido. Esperá el siguiente en tu app y probá de nuevo.';
const PASSWORD_INVALID = 'La contraseña actual no es correcta.';

// Los `reason` que emite apps/api/src/auth/auth-errors.ts. La contraseña actual incorrecta de
// "Cambiar contraseña" llega como 401 SIN reason: la resuelve el contexto del formulario.
const BY_REASON: Record<string, string> = {
  MFA_CODE_INVALID: CODE_INVALID,
  MFA_REAUTH_INVALID: 'La contraseña o el código no son correctos.',
  MFA_ALREADY_ENABLED: 'La verificación en dos pasos ya está activa. Recargá la página.',
  MFA_REQUIRED_BY_ROLE:
    'Tu rol exige la verificación en dos pasos, así que no se puede desactivar.',
  MFA_NOT_ENABLED: 'La verificación en dos pasos no está activa. Recargá la página.',
  MFA_NO_PENDING_ENROLLMENT:
    'No hay un código QR pendiente de confirmar. Empezá de nuevo desde el principio.',
  MFA_ENROLLMENT_REQUIRED: 'Activá la verificación en dos pasos para seguir.',
  MFA_ACCOUNT_LOCKED:
    'Demasiados intentos fallidos. Por seguridad pausamos la verificación 15 minutos; probá de nuevo más tarde.',
  SESSION_NOT_FOUND: 'Esa sesión ya estaba cerrada.',
  CANNOT_REVOKE_CURRENT_SESSION:
    'No podés cerrar desde acá la sesión que estás usando. Usá "Cerrar sesión".',
  TRUSTED_DEVICE_NOT_FOUND: 'Ese equipo ya no estaba en la lista.',
};

const BY_CONTEXT: Record<FailureContext, string | null> = {
  code: CODE_INVALID,
  password: PASSWORD_INVALID,
  'password-and-code': 'La contraseña o el código no son correctos.',
  other: null,
};

/**
 * El texto para el usuario. Nunca el mensaje crudo de un 400 de validación (llega en inglés desde
 * Zod) cuando el contexto permite decir algo concreto.
 */
export function failureMessage(failure: ApiFailure, context: FailureContext): string {
  const known = failure.reason ? BY_REASON[failure.reason] : undefined;
  if (known) return known;
  if (failure.status === 429) return 'Demasiados intentos. Esperá un minuto y probá de nuevo.';
  if (failure.status === 400 || failure.status === 401) {
    const byContext = BY_CONTEXT[context];
    if (byContext) return byContext;
  }
  if (failure.status === 403) return 'No tenés permiso para hacer esto.';
  if (failure.status >= 500) {
    return failure.message === UNREACHABLE_MESSAGE
      ? UNREACHABLE_MESSAGE
      : 'No pudimos completar la operación. Intentá de nuevo en unos minutos.';
  }
  return failure.message || 'No pudimos completar la operación. Intentá de nuevo.';
}

/** Intentos que le quedan al código, si el API los informa (`details.attemptsLeft`). */
export function attemptsLeftOf(failure: ApiFailure): number | null {
  const value = failure.details?.['attemptsLeft'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
