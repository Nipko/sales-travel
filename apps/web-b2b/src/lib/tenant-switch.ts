import {
  LOGIN_MESSAGES,
  classifyAuthResponse,
  type AuthOutcome,
  type AuthSuccess,
  type SeatsFull,
  type SeatsState,
} from '../app/login/login-state';
import type { ApiResponse } from './api';
import { motivoForUnauthorized, type SessionMotivo } from './session-reasons';

/**
 * Cambiar de agencia (POST /auth/switch-tenant) como pasos, sin Next ni cookies, para probarlo: la
 * server action llama a la API, clasifica con {@link classifySwitchResponse} y arma el resultado
 * con {@link switchResultFor}. Como en el login, nunca se muestra el texto crudo de la API: se
 * decide por estado HTTP y `reason`.
 *
 * El cupo lleno del destino (409 SEATS_FULL) se resuelve con el MISMO panel del login
 * (SeatsFullStep): quien administra el nodo del cupo desconecta a alguien y entra; el resto ve a
 * quién pedírselo. La sesión actual sigue viva mientras tanto.
 */

export type SwitchOutcome =
  | { kind: 'switched'; auth: AuthSuccess }
  | { kind: 'seats'; seats: SeatsFull }
  | { kind: 'suspended' }
  | { kind: 'forbidden' }
  | { kind: 'session-ended'; motivo: SessionMotivo }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' }
  | { kind: 'unexpected' };

export const SWITCH_MESSAGES = {
  suspended: 'Esa agencia está suspendida: no podés operar con ella por ahora.',
  forbidden: 'Ya no tenés acceso a esa agencia. Actualizamos la lista.',
  rateLimited: 'Hiciste muchos cambios seguidos. Esperá un minuto y probá de nuevo.',
  unavailable: 'No pudimos conectar con el servidor. Probá de nuevo en unos segundos.',
  unexpected: 'No pudimos cambiar de agencia. Probá de nuevo.',
  invalidTarget: 'Elegí una agencia de la lista.',
  releaseExpired: 'El permiso para liberar un puesto venció. Elegí la agencia de nuevo.',
  releaseSessionGone:
    'Esa sesión ya se había cerrado, así que puede haber un puesto libre. Elegí la agencia de nuevo.',
} as const;

function reasonOf(res: ApiResponse): unknown {
  if (res.kind !== 'json') return undefined;
  const body = res.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)['reason']
    : undefined;
}

/** Lo que respondió POST /auth/switch-tenant. */
export function classifySwitchResponse(res: ApiResponse): SwitchOutcome {
  if (res.kind === 'unreachable') return { kind: 'unavailable' };
  const { status } = res;

  // Éxito y cupo lleno se leen igual que en el login: token con su vencimiento, o los `details`.
  if ((status >= 200 && status < 300) || status === 409) {
    const auth = classifyAuthResponse('release', res);
    if (auth.kind === 'session') return { kind: 'switched', auth: auth.auth };
    if (auth.kind === 'seats') return { kind: 'seats', seats: auth.seats };
    return { kind: 'unexpected' };
  }

  const reason = reasonOf(res);
  // 401: la sesión ACTUAL ya no sirve (inactividad, otro dispositivo…): se sale con su motivo.
  if (status === 401) return { kind: 'session-ended', motivo: motivoForUnauthorized(reason) };
  if (status === 403)
    return reason === 'TENANT_SUSPENDED' ? { kind: 'suspended' } : { kind: 'forbidden' };
  if (status === 429) return { kind: 'rate-limited' };
  if (status >= 500) return { kind: 'unavailable' };
  return { kind: 'unexpected' };
}

/** Lo que la server action le devuelve al selector (serializable, sin el token). */
export type SwitchResult =
  | { kind: 'switched'; tenantId: string }
  | { kind: 'seats'; seats: SeatsFull }
  /** `refresh`: la lista de agencias quedó vieja (la suspendieron o le quitaron el acceso). */
  | { kind: 'error'; message: string; refresh: boolean }
  | { kind: 'ended'; motivo: SessionMotivo };

export function switchResultFor(
  outcome: Exclude<SwitchOutcome, { kind: 'switched' }>,
): SwitchResult {
  switch (outcome.kind) {
    case 'seats':
      return { kind: 'seats', seats: outcome.seats };
    case 'session-ended':
      return { kind: 'ended', motivo: outcome.motivo };
    case 'suspended':
      return { kind: 'error', message: SWITCH_MESSAGES.suspended, refresh: true };
    case 'forbidden':
      return { kind: 'error', message: SWITCH_MESSAGES.forbidden, refresh: true };
    case 'rate-limited':
      return { kind: 'error', message: SWITCH_MESSAGES.rateLimited, refresh: false };
    case 'unavailable':
      return { kind: 'error', message: SWITCH_MESSAGES.unavailable, refresh: false };
    case 'unexpected':
      return { kind: 'error', message: SWITCH_MESSAGES.unexpected, refresh: false };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El id que llega del navegador, antes de mandarlo a la API. */
export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

// ---------------------------------------------------------------------------------------------
// Cupo lleno: el panel del login dentro del selector
// ---------------------------------------------------------------------------------------------

/**
 * El estado del panel de cupo lleno dentro del selector. `seats` es el mismo `SeatsState` del
 * login, así SeatsFullStep lo pinta sin saber que no está en el login.
 */
export type SwitchSeatsState =
  | SeatsState
  | { step: 'switched'; attempt: number; tenantId: string }
  /** Hay que volver a elegir la agencia (el permiso venció, la sesión elegida ya no estaba). */
  | { step: 'retry'; attempt: number; message: string };

/** `listedAt`: cuándo llegó la lista, el "ahora" de "Activo hace 3 min" (ver SeatsState). */
export function initialSwitchSeatsState(seats: SeatsFull, nowMs: number = Date.now()): SeatsState {
  return { step: 'seats', attempt: 0, email: '', seats, listedAt: nowMs };
}

/** Después de POST /auth/seats/release sin sesión emitida, dentro del selector. */
export function afterSwitchRelease(
  outcome: Exclude<AuthOutcome, { kind: 'session' }>,
  ctx: { attempt: number; seats: SeatsFull; listedAt: number },
  nowMs: number = Date.now(),
): SwitchSeatsState {
  const seatsState = (patch: Partial<SeatsState> = {}): SeatsState => ({
    step: 'seats',
    attempt: ctx.attempt,
    email: '',
    seats: ctx.seats,
    listedAt: ctx.listedAt,
    ...patch,
  });
  switch (outcome.kind) {
    case 'seats':
      // Una lista nueva se mide contra la hora en que llegó, no contra la de la anterior.
      return seatsState({
        seats: outcome.seats,
        listedAt: nowMs,
        notice: LOGIN_MESSAGES.seatsTakenAgain,
      });
    case 'release-invalid':
      return { step: 'retry', attempt: ctx.attempt, message: SWITCH_MESSAGES.releaseExpired };
    case 'release-session-gone':
      return { step: 'retry', attempt: ctx.attempt, message: SWITCH_MESSAGES.releaseSessionGone };
    case 'release-forbidden':
      return seatsState({
        seats: { ...ctx.seats, release: null },
        error: LOGIN_MESSAGES.releaseForbidden,
      });
    case 'rate-limited':
      return seatsState({ error: LOGIN_MESSAGES.rateLimited });
    case 'unavailable':
      return seatsState({ error: LOGIN_MESSAGES.unavailable });
    default:
      return seatsState({ error: SWITCH_MESSAGES.unexpected });
  }
}
