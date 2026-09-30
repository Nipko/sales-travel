/**
 * Qué dibuja el layout del panel según lo que respondió el API al cargarlo: el panel, la pantalla de
 * enrolamiento de 2FA (sin forma de saltarla), o nada porque la sesión terminó.
 *
 * Antes el layout se tragaba el 401 de `/me` y dibujaba el shell vacío ("Sin tenant", sin rol, cada
 * pantalla con su error): el usuario quedaba en un panel roto y `/login` lo devolvía a `/`. Ahora
 * todo 401 termina la sesión con su motivo.
 */

import type { ApiError } from '../../lib/api';
import {
  isSessionReason,
  motivoForUnauthorized,
  type SessionMotivo,
} from '../../lib/session-reasons';

export const MFA_ENROLLMENT_REQUIRED = 'MFA_ENROLLMENT_REQUIRED';
export const MFA_STEP_UP_REQUIRED = 'MFA_STEP_UP_REQUIRED';

/** Lo que devuelve `api()`, sin importar el tipo del dato. */
export type ApiResult = { ok: true; data: unknown } | { ok: false; error: ApiError };

export interface LayoutGateInputs {
  /** `GET /auth/session`. */
  session: ApiResult;
  /** `GET /me`. */
  me: ApiResult;
  /** `GET /me/memberships`. */
  memberships: ApiResult;
  /** `GET /auth/mfa`. */
  mfa: ApiResult;
}

export type LayoutGate =
  | { kind: 'shell' }
  /** El rol exige 2FA y el usuario no lo tiene: sólo el enrolamiento (y "Cerrar sesión"). */
  | { kind: 'mfa-enrollment' }
  | { kind: 'end'; motivo: SessionMotivo };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorOf(result: ApiResult): ApiError | null {
  return result.ok ? null : result.error;
}

/** Lo que el 2FA le exige a la sesión: enrolarse, volver a ingresar con el código, o nada. */
export type MfaDemand = 'enroll' | 'step-up' | null;

/**
 * La misma regla que aplica el API (`MfaEnforcementGuard`), para decidir qué dibujar: el layout al
 * cargar y la guardia de sesión en cada ping, porque el rol puede pasar a exigir 2FA en plena
 * sesión y el layout no se vuelve a ejecutar en una navegación de cliente.
 *
 * - `enroll`: el rol lo exige y el usuario no lo tiene.
 * - `step-up`: lo tiene, pero ESTA sesión no pasó el segundo factor (una sesión de antes del
 *   deploy, o emitida sin código): el API le responde MFA_STEP_UP_REQUIRED a todo.
 *
 * Un dato que no vino (API vieja) no exige nada: no se echa a nadie por falta de información.
 */
export function mfaDemand(state: {
  required: unknown;
  enabled: unknown;
  verified: unknown;
}): MfaDemand {
  if (state.required !== true) return null;
  if (state.enabled !== true) return 'enroll';
  return state.verified === false ? 'step-up' : null;
}

export function decideLayoutGate(inputs: LayoutGateInputs): LayoutGate {
  const results = [inputs.session, inputs.me, inputs.memberships, inputs.mfa];
  const errors = results.map(errorOf).filter((e): e is ApiError => e !== null);

  // 1. Cualquier 401 termina la sesión. Si alguno trae el motivo (el de `/auth/session` suele ser
  //    el más preciso), se usa ése; sin motivo, "expirada".
  const unauthorized = errors.filter((e) => e.status === 401);
  if (unauthorized.length > 0) {
    const explained = unauthorized.find(
      (e) => isSessionReason(e.reason) || e.reason === MFA_STEP_UP_REQUIRED,
    );
    return { kind: 'end', motivo: motivoForUnauthorized(explained?.reason) };
  }

  // 2. El API ya dijo que falta enrolar el 2FA.
  if (errors.some((e) => e.status === 403 && e.reason === MFA_ENROLLMENT_REQUIRED)) {
    return { kind: 'mfa-enrollment' };
  }

  // 3. Las llamadas del layout están exentas del chequeo de 2FA en el API (tienen que poder dibujar
  //    esta pantalla), así que el estado se lee de `GET /auth/mfa`; si no respondió, de
  //    `GET /auth/session`, que es lo mismo que mira la guardia en cada ping. Sin ese respaldo, con
  //    `/auth/mfa` caído el layout dibujaba el panel y la guardia pedía recargar cada vez.
  const mfa = inputs.mfa.ok && isRecord(inputs.mfa.data) ? inputs.mfa.data : null;
  const session = inputs.session.ok && isRecord(inputs.session.data) ? inputs.session.data : null;
  const demand = mfaDemand({
    required: mfa ? mfa['required'] : session?.['mfaRequired'],
    enabled: mfa ? mfa['enabled'] : session?.['mfaEnabled'],
    verified: session?.['mfaVerified'],
  });
  if (demand === 'enroll') return { kind: 'mfa-enrollment' };
  // 4. Se vuelve a ingresar con el código.
  if (demand === 'step-up') {
    return { kind: 'end', motivo: motivoForUnauthorized(MFA_STEP_UP_REQUIRED) };
  }

  return { kind: 'shell' };
}
