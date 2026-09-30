import type { ApiResponse } from '../../lib/api';

/**
 * El login como máquina de pasos: credenciales → (segundo factor) → (cupo lleno) → panel.
 *
 * Todo lo que decide a qué paso ir vive acá, sin Next ni cookies, para poder probarlo: la server
 * action sólo llama a la API, pasa la respuesta por {@link classifyAuthResponse} y arma el estado
 * con `after*`. La regla de fondo es no mostrar nunca el mensaje crudo de la API: cada respuesta se
 * clasifica por estado HTTP y `reason` máquina, y el texto sale de {@link LOGIN_MESSAGES}.
 */

export type MfaMode = 'totp' | 'recovery';

/** Una sesión que ocupa un puesto del cupo, tal como la manda la API en `SEATS_FULL`. */
export interface SeatSession {
  sessionId: string;
  name: string | null;
  email: string | null;
  tenantName: string | null;
  lastSeenAt: string | null;
  /** User-Agent del navegador de esa sesión. */
  device: string | null;
  ip: string | null;
}

/**
 * El 409 `SEATS_FULL`. `release` sólo viene si quien intenta entrar administra el nodo del cupo:
 * con él puede desconectar a alguien y entrar en su lugar.
 */
export interface SeatsFull {
  tenantName: string | null;
  limit: number | null;
  inUse: number | null;
  release: { token: string; sessions: SeatSession[] } | null;
}

export type CredentialsErrorKind =
  | 'missing'
  | 'invalid'
  | 'rate-limited'
  | 'unavailable'
  | 'unexpected';

interface StepBase {
  /**
   * Cuántas respuestas del servidor lleva este intento. La UI lo usa para reaccionar a CADA
   * respuesta (limpiar el código, volver a enfocar) aunque el texto del error sea el mismo.
   */
  attempt: number;
  /** El email en curso: se conserva entre pasos y tras un error para no tener que tipearlo otra vez. */
  email: string;
}

export interface CredentialsState extends StepBase {
  step: 'credentials';
  error?: { kind: CredentialsErrorKind; message: string };
  /** Por qué se volvió a este paso (la verificación venció, la cuenta quedó bloqueada…). */
  notice?: string;
  /**
   * El aviso ofrece restablecer la contraseña: la cuenta quedó bloqueada y es la única forma de
   * entrar antes de que pasen los 15 minutos.
   */
  offerPasswordReset?: true;
}

export interface MfaState extends StepBase {
  step: 'mfa';
  /** Token del desafío (5 min, audiencia propia): no sirve como bearer de API. */
  mfaToken: string;
  rememberDevice: boolean;
  mode: MfaMode;
  error?: string;
}

export interface SeatsState extends StepBase {
  step: 'seats';
  seats: SeatsFull;
  /**
   * Cuándo llegó esta lista (ms). Es el "ahora" de "Activo hace 3 min": fijarlo al montar el paso
   * dejaba una lista que llega después (alguien ocupó el puesto antes) medida contra un reloj viejo,
   * con las sesiones recientes como "Activo ahora" y el resto con menos inactividad de la real, que
   * es justo lo que mira el admin para elegir a quién desconectar.
   */
  listedAt: number;
  error?: string;
  notice?: string;
}

export type LoginState = CredentialsState | MfaState | SeatsState;

/**
 * La lista de cupo lleno que se estaba mostrando, para volver a pintarla si liberar un puesto falla.
 * Viene del navegador: sólo se usa para mostrar (lo que se manda a la API sale del formulario), y si
 * `listedAt` no es una fecha razonable se toma `nowMs`.
 */
export function shownSeats(
  prev: LoginState,
  nowMs: number = Date.now(),
): { seats: SeatsFull; listedAt: number } | null {
  if (prev.step !== 'seats') return null;
  const listedAt =
    typeof prev.listedAt === 'number' && Number.isFinite(prev.listedAt) && prev.listedAt <= nowMs
      ? prev.listedAt
      : nowMs;
  return { seats: prev.seats, listedAt };
}

export function initialLoginState(email = '', notice?: string): CredentialsState {
  return notice
    ? { step: 'credentials', attempt: 0, email, notice }
    : { step: 'credentials', attempt: 0, email };
}

/**
 * El estado anterior de `useActionState` lo manda el navegador: no se confía en él para nada más
 * que numerar el intento (y volver a pintar lo que ya se mostraba, ver {@link shownSeats}).
 */
export function nextAttempt(prev: unknown): number {
  const attempt =
    typeof prev === 'object' && prev !== null ? (prev as { attempt?: unknown }).attempt : undefined;
  return typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 0
    ? attempt + 1
    : 1;
}

// Los números del bloqueo son los de `apps/api/src/auth/auth.service.ts` (LOCKOUT_THRESHOLD,
// LOCKOUT_MINUTES): si cambian allá, cambian acá.
export const LOGIN_MESSAGES = {
  missing: 'Ingresá tu correo y tu contraseña.',
  invalid: 'El correo o la contraseña no son correctos.',
  lockoutHint:
    'Después de 5 intentos fallidos bloqueamos la cuenta por 15 minutos; restablecer la contraseña la desbloquea en el momento.',
  rateLimited: 'Hiciste muchos intentos seguidos. Esperá un minuto y probá de nuevo.',
  unavailable: 'No pudimos conectar con el servidor. Probá de nuevo en unos segundos.',
  unexpected: 'No pudimos completar el ingreso. Probá de nuevo.',
  mfaExpired: 'Por seguridad, la verificación venció. Ingresá tu contraseña de nuevo.',
  mfaLocked:
    'Hubo demasiados intentos fallidos, así que bloqueamos la cuenta por 15 minutos. Restablecer la contraseña la desbloquea en el momento.',
  mfaLost: 'Se perdió el paso de verificación. Ingresá tu contraseña de nuevo.',
  totpFormat: 'Ingresá los 6 dígitos del código.',
  // Guion que no corta la línea (U+2011): el ejemplo partido en dos renglones parecía dos códigos.
  recoveryFormat: 'Revisá el código de recuperación: son 10 caracteres, como A1B2C\u20113D4E5.',
  releaseExpired:
    'El permiso para liberar un puesto venció. Ingresá de nuevo para ver quién está conectado.',
  releaseMissing: 'Elegí a quién desconectar.',
  releaseForbidden:
    'Ya no administrás el nodo de estos puestos: pedile a un administrador que libere uno.',
  releaseSessionGone:
    'Esa sesión ya se había cerrado, así que puede haber un puesto libre. Ingresá de nuevo.',
  seatsTakenAgain: 'Alguien ocupó el puesto antes que vos. Revisá la lista de nuevo.',
} as const;

export function mfaInvalidMessage(attemptsLeft: number | null): string {
  if (attemptsLeft === null) return 'El código no es correcto. Probá de nuevo.';
  if (attemptsLeft === 1) return 'El código no es correcto. Te queda 1 intento.';
  return `El código no es correcto. Te quedan ${attemptsLeft} intentos.`;
}

/**
 * Un código TOTP: 6 dígitos. Se aceptan espacios porque algunas apps lo muestran como "123 456".
 * `null` si no tiene esa forma: se avisa sin gastar un intento del desafío.
 */
export function normalizeTotpCode(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '');
  return /^\d{6}$/.test(compact) ? compact : null;
}

/**
 * Un código de recuperación: 10 hexadecimales, que se muestran como `XXXXX-XXXXX`. Se manda sin
 * guion y en mayúsculas, la forma en que se generan, así lo entiende cualquier versión de la API.
 */
export function normalizeRecoveryCode(raw: string): string | null {
  const compact = raw.replace(/[\s-]+/g, '').toUpperCase();
  return /^[0-9A-F]{10}$/.test(compact) ? compact : null;
}

export interface AuthSuccess {
  token: string;
  /** ISO del vencimiento del access token: la cookie de sesión muere con él. */
  expiresAt: string | null;
  tenantId: string | null;
  /** Presente si se pidió "recordar este equipo": va a la cookie `st_trusted`. */
  trustedDevice: { token: string; expiresAt: string } | null;
}

export type AuthOutcome =
  | { kind: 'session'; auth: AuthSuccess }
  | { kind: 'mfa'; mfaToken: string }
  | { kind: 'seats'; seats: SeatsFull }
  | { kind: 'invalid-credentials' }
  | { kind: 'mfa-invalid'; attemptsLeft: number | null }
  | { kind: 'mfa-expired' }
  | { kind: 'mfa-locked' }
  | { kind: 'release-invalid' }
  | { kind: 'release-forbidden' }
  | { kind: 'release-session-gone' }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' }
  | { kind: 'unexpected' };

/** Qué endpoint respondió: el mismo 401 significa cosas distintas en cada uno. */
export type AuthCall = 'login' | 'mfa' | 'release';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseAuthSuccess(body: unknown): AuthSuccess | null {
  const obj = asRecord(body);
  const token = optionalString(obj?.['token']);
  if (!obj || !token) return null;
  const trusted = asRecord(obj['trustedDevice']);
  const trustedToken = optionalString(trusted?.['token']);
  const trustedExpires = optionalString(trusted?.['expiresAt']);
  return {
    token,
    expiresAt: optionalString(obj['expiresAt']),
    tenantId: optionalString(obj['tenantId']),
    trustedDevice:
      trustedToken && trustedExpires ? { token: trustedToken, expiresAt: trustedExpires } : null,
  };
}

function parseSeatSession(value: unknown): SeatSession | null {
  const obj = asRecord(value);
  const sessionId = optionalString(obj?.['sessionId']);
  if (!obj || !sessionId) return null;
  return {
    sessionId,
    name: optionalString(obj['name']),
    email: optionalString(obj['email']),
    tenantName: optionalString(obj['tenantName']),
    lastSeenAt: optionalString(obj['lastSeenAt']),
    device: optionalString(obj['device']),
    ip: optionalString(obj['ip']),
  };
}

/**
 * Los `details` de un `SEATS_FULL`. Si vienen rotos igual se muestra el paso de cupo lleno (con un
 * texto sin números): el login ya se negó, lo que falta es explicar por qué.
 */
export function parseSeatsFull(details: unknown): SeatsFull {
  const obj = asRecord(details);
  const limit = optionalCount(obj?.['limit']);
  const release = asRecord(obj?.['release']);
  const releaseToken = optionalString(release?.['token']);
  const rawSessions = release?.['sessions'];
  const sessions = Array.isArray(rawSessions)
    ? rawSessions.map(parseSeatSession).filter((s): s is SeatSession => s !== null)
    : [];
  return {
    tenantName: optionalString(obj?.['tenantName']),
    limit: limit !== null && limit > 0 ? limit : null,
    inUse: optionalCount(obj?.['inUse']),
    release: releaseToken ? { token: releaseToken, sessions } : null,
  };
}

/** Clasifica lo que respondió la API. Nunca mira `message`: sólo estado, `reason` y `details`. */
export function classifyAuthResponse(call: AuthCall, res: ApiResponse): AuthOutcome {
  if (res.kind === 'unreachable') return { kind: 'unavailable' };
  const { status } = res;
  const body = res.kind === 'json' ? asRecord(res.body) : null;

  if (status >= 200 && status < 300) {
    if (!body) return { kind: 'unexpected' };
    if (call === 'login' && body['mfaRequired'] === true) {
      const mfaToken = optionalString(body['mfaToken']);
      return mfaToken ? { kind: 'mfa', mfaToken } : { kind: 'unexpected' };
    }
    const auth = parseAuthSuccess(body);
    return auth ? { kind: 'session', auth } : { kind: 'unexpected' };
  }

  const reason = body?.['reason'];
  if (status === 409 && reason === 'SEATS_FULL') {
    return { kind: 'seats', seats: parseSeatsFull(body?.['details']) };
  }
  if (status === 429) return { kind: 'rate-limited' };
  if (status >= 500) return { kind: 'unavailable' };

  switch (call) {
    case 'login':
      // 400 = el formato del email no pasó la validación de la API: para el usuario es lo mismo.
      return status === 401 || status === 400
        ? { kind: 'invalid-credentials' }
        : { kind: 'unexpected' };
    case 'mfa':
      if (status === 401 && reason === 'MFA_CHALLENGE_EXPIRED') return { kind: 'mfa-expired' };
      // La cuenta se bloqueó (los códigos fallidos suman al mismo contador que la contraseña). Acá
      // decirlo no enumera nada: para llegar al código ya se probó la contraseña.
      if (status === 401 && reason === 'MFA_ACCOUNT_LOCKED') return { kind: 'mfa-locked' };
      if (status === 401 || status === 400) {
        const details = asRecord(body?.['details']);
        return { kind: 'mfa-invalid', attemptsLeft: optionalCount(details?.['attemptsLeft']) };
      }
      return { kind: 'unexpected' };
    case 'release':
      // 403: quien quedó afuera dejó de administrar el nodo del cupo. 404: la sesión elegida ya se
      // había cerrado (puede que ya haya un puesto libre). El resto: permiso vencido o ya usado.
      if (status === 403) return { kind: 'release-forbidden' };
      if (status === 404) return { kind: 'release-session-gone' };
      return [400, 401, 410].includes(status)
        ? { kind: 'release-invalid' }
        : { kind: 'unexpected' };
  }
}

type FailedOutcome = Exclude<AuthOutcome, { kind: 'session' }>;

function credentialsError(
  base: StepBase,
  kind: CredentialsErrorKind,
  message: string,
): CredentialsState {
  return { step: 'credentials', ...base, error: { kind, message } };
}

function seatsState(
  base: StepBase,
  seats: SeatsFull,
  listedAt: number,
  notice?: string,
): SeatsState {
  const state: SeatsState = { step: 'seats', ...base, seats, listedAt };
  return notice ? { ...state, notice } : state;
}

/**
 * Vuelta a la contraseña con la cuenta bloqueada. Sin decirlo, el aviso era "la verificación
 * venció" y la contraseña correcta se rechazaba después como incorrecta durante 15 minutos.
 */
function lockedOut(base: StepBase): CredentialsState {
  return {
    step: 'credentials',
    ...base,
    notice: LOGIN_MESSAGES.mfaLocked,
    offerPasswordReset: true,
  };
}

/** Después de `POST /auth/login` sin sesión emitida. `nowMs`: cuándo llegó la respuesta. */
export function afterLogin(
  outcome: FailedOutcome,
  base: StepBase,
  nowMs: number = Date.now(),
): LoginState {
  switch (outcome.kind) {
    case 'mfa':
      return {
        step: 'mfa',
        ...base,
        mfaToken: outcome.mfaToken,
        // "Recordar este equipo" viene marcado: es lo que eligió el founder para todos los roles.
        rememberDevice: true,
        mode: 'totp',
      };
    case 'seats':
      return seatsState(base, outcome.seats, nowMs);
    case 'invalid-credentials':
      return credentialsError(base, 'invalid', LOGIN_MESSAGES.invalid);
    case 'rate-limited':
      return credentialsError(base, 'rate-limited', LOGIN_MESSAGES.rateLimited);
    case 'unavailable':
      return credentialsError(base, 'unavailable', LOGIN_MESSAGES.unavailable);
    default:
      return credentialsError(base, 'unexpected', LOGIN_MESSAGES.unexpected);
  }
}

export interface MfaContext extends StepBase {
  mfaToken: string;
  rememberDevice: boolean;
  mode: MfaMode;
}

/** Después de `POST /auth/mfa/verify` sin sesión emitida. `nowMs`: cuándo llegó la respuesta. */
export function afterMfa(
  outcome: FailedOutcome,
  ctx: MfaContext,
  nowMs: number = Date.now(),
): LoginState {
  const base = { attempt: ctx.attempt, email: ctx.email };
  const stay = (error: string): MfaState => ({ step: 'mfa', ...ctx, error });
  switch (outcome.kind) {
    case 'seats':
      return seatsState(base, outcome.seats, nowMs);
    case 'mfa-expired':
      return { step: 'credentials', ...base, notice: LOGIN_MESSAGES.mfaExpired };
    case 'mfa-locked':
      return lockedOut(base);
    case 'mfa-invalid':
      // Sin intentos, el desafío ya no sirve: seguir pidiendo el código sería un bucle. Y como cada
      // código fallido suma al bloqueo de la cuenta (5, igual que el desafío), a esta altura la
      // cuenta está bloqueada: volver a la contraseña sin decirlo la hacía parecer incorrecta.
      if (outcome.attemptsLeft === 0) return lockedOut(base);
      return stay(mfaInvalidMessage(outcome.attemptsLeft));
    case 'rate-limited':
      return stay(LOGIN_MESSAGES.rateLimited);
    case 'unavailable':
      return stay(LOGIN_MESSAGES.unavailable);
    default:
      return stay(LOGIN_MESSAGES.unexpected);
  }
}

/**
 * Después de `POST /auth/seats/release` sin sesión emitida. `ctx` trae la lista que se estaba
 * mostrando y cuándo había llegado: si la respuesta no trae una nueva, se sigue midiendo contra ese
 * momento. `nowMs`: cuándo llegó la respuesta.
 */
export function afterRelease(
  outcome: FailedOutcome,
  ctx: StepBase & { seats: SeatsFull; listedAt: number },
  nowMs: number = Date.now(),
): LoginState {
  const base = { attempt: ctx.attempt, email: ctx.email };
  switch (outcome.kind) {
    case 'seats':
      return seatsState(base, outcome.seats, nowMs, LOGIN_MESSAGES.seatsTakenAgain);
    case 'release-invalid':
      return { step: 'credentials', ...base, notice: LOGIN_MESSAGES.releaseExpired };
    case 'release-session-gone':
      return { step: 'credentials', ...base, notice: LOGIN_MESSAGES.releaseSessionGone };
    case 'release-forbidden':
      // Sin permiso para liberar, la pantalla pasa a ser la de quien no administra el nodo.
      return {
        ...seatsState(base, { ...ctx.seats, release: null }, ctx.listedAt),
        error: LOGIN_MESSAGES.releaseForbidden,
      };
    case 'rate-limited':
      return { ...seatsState(base, ctx.seats, ctx.listedAt), error: LOGIN_MESSAGES.rateLimited };
    case 'unavailable':
      return { ...seatsState(base, ctx.seats, ctx.listedAt), error: LOGIN_MESSAGES.unavailable };
    default:
      return { ...seatsState(base, ctx.seats, ctx.listedAt), error: LOGIN_MESSAGES.unexpected };
  }
}
