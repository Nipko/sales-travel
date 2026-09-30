/**
 * Lógica pura de la guardia de sesión del panel (inactividad, vencimiento absoluto y sincronía
 * entre pestañas). Sin DOM, sin React y sin `fetch`: la usan `session-guard.tsx`, `session-sync.ts`
 * y los route handlers de `/api/session/*`, y se prueba sola.
 *
 * El servidor es la fuente de verdad: la API revoca la sesión que superó su inactividad y responde
 * `SESSION_IDLE`. El navegador sólo AVISA antes y cierra a tiempo, así que todo se calcula con el
 * `lastSeenAt` que devuelve la API y no con un contador local. Y con marcas de tiempo, no con
 * intervalos: una PC suspendida congela los `setInterval`, pero al despertar `Date.now()` dice la
 * verdad y la sesión que venció mientras tanto se cierra en vez de revivir.
 */

import { isSessionMotivo, parseIdleMinutes, type SessionMotivo } from '../../lib/session-reasons';
import { SAFE_NEXT_FALLBACK, safeNextPath } from '../../lib/safe-next';

// ---------------------------------------------------------------------------------------------
// Constantes compartidas
// ---------------------------------------------------------------------------------------------

/** Canal entre pestañas del mismo panel. */
export const SESSION_CHANNEL = 'st-session';

/** Última actividad del usuario en CUALQUIER pestaña (ms, reloj del navegador). */
export const ACTIVITY_KEY = 'st:last-activity';
/** Último ping enviado por cualquier pestaña: marca el ritmo para que N pestañas no hagan N pings. */
export const PING_KEY = 'st:last-ping';
/** Actividad que ya llegó al servidor en un ping `active` que respondió bien. */
export const REPORTED_KEY = 'st:reported-activity';
/** El reloj de la sesión que dio el último ping, para que una pestaña nueva arranque sabiendo. */
export const CLOCK_KEY = 'st:session-clock';
/** Respaldo del aviso de cierre para navegadores sin BroadcastChannel (evento `storage`). */
export const LOGOUT_KEY = 'st:logout';

/** Cada cuánto se consulta la sesión. */
export const PING_INTERVAL_MS = 60_000;
/**
 * Pausa mínima entre dos pings urgentes (actividad que tiene que llegar antes del corte). Evita
 * una ráfaga si el usuario sigue moviéndose mientras el ping anterior está en vuelo.
 */
export const URGENT_PING_GAP_MS = 10_000;
/**
 * La misma pausa después de "Seguir conectado", mientras ese clic no llegó al servidor. Es mucho
 * más corta porque el aviso se cierra en los últimos 2 minutos: con 10 s, un ping que falla a
 * 0:07 hacía que el servidor cortara igual, después de que el usuario eligió seguir.
 */
export const STAY_RETRY_GAP_MS = 2_000;
/**
 * Un ping que no vuelve en este tiempo se da por perdido. Sin límite, uno colgado dejaba a la
 * pestaña sin poder mandar ninguno más (hay uno solo en vuelo por pestaña).
 */
export const PING_TIMEOUT_MS = 15_000;
/** El aviso de inactividad aparece cuando faltan 2 minutos. */
export const IDLE_WARNING_MS = 120_000;
/** El aviso de vencimiento absoluto, 10 minutos antes. */
export const EXPIRY_WARNING_MS = 10 * 60_000;
/** La actividad se registra como mucho una vez cada 5 s: un scroll dispara decenas de eventos. */
export const ACTIVITY_THROTTLE_MS = 5_000;
/**
 * La API refresca `last_seen_at` sólo si tiene más de 60 s. Después de un ping `active` el valor
 * real es, como mínimo, la hora del servidor menos esto, aunque la respuesta traiga el anterior.
 */
export const SERVER_TOUCH_GRANULARITY_MS = 60_000;
/** El lector de pantalla oye la cuenta regresiva cada 15 s, no cada segundo. */
export const ANNOUNCE_STEP_SECONDS = 15;

// ---------------------------------------------------------------------------------------------
// Lo que dice la API (GET /auth/session) y lo que responde /api/session/ping
// ---------------------------------------------------------------------------------------------

/** Lo que la guardia necesita de `GET /auth/session`. */
export interface SessionSnapshot {
  /**
   * Qué sesión es. Separa el estado que dejó en `localStorage` una sesión anterior (cerrada ayer,
   * o la de otro usuario en la misma PC) del de la actual: sin esto, un reloj viejo "vencido"
   * echaría al usuario recién ingresado. `null` si la API no lo manda.
   */
  sessionId: string | null;
  idleTimeoutSeconds: number;
  /** ISO. Vencimiento absoluto de la sesión (12 h). */
  expiresAt: string;
  /** ISO. Última actividad que registró el servidor. */
  lastSeenAt: string;
  /** ISO. Hora del servidor al responder: corrige el reloj del navegador si está corrido. */
  serverNow: string;
  /**
   * El estado del 2FA con el que el API validó la sesión (rol que lo exige, 2FA activo, sesión que
   * pasó el código). Sirve para enterarse en plena sesión de que el rol pasó a exigirlo: el layout,
   * que es quien lo decide al cargar, no se vuelve a ejecutar en una navegación de cliente. Cada
   * uno sólo si vino: un API que no lo manda no le exige nada a nadie.
   */
  mfaRequired?: boolean;
  mfaEnabled?: boolean;
  mfaVerified?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** La API acota la inactividad a 5–480 min; algo fuera de eso no es un dato en que confiar. */
const MIN_IDLE_SECONDS = 60;
const MAX_IDLE_SECONDS = 24 * 60 * 60;

/** Valida la respuesta de `GET /auth/session` (o el `ok: true` del ping) y se queda sólo con lo que se usa. */
export function parseSessionSnapshot(raw: unknown): SessionSnapshot | null {
  if (!isRecord(raw)) return null;
  const { sessionId, idleTimeoutSeconds, expiresAt, lastSeenAt, serverNow } = raw;
  if (sessionId !== undefined && sessionId !== null && !isShortString(sessionId)) return null;
  if (
    typeof idleTimeoutSeconds !== 'number' ||
    !Number.isInteger(idleTimeoutSeconds) ||
    idleTimeoutSeconds < MIN_IDLE_SECONDS ||
    idleTimeoutSeconds > MAX_IDLE_SECONDS
  ) {
    return null;
  }
  if (!isIsoDate(expiresAt) || !isIsoDate(lastSeenAt) || !isIsoDate(serverNow)) return null;
  const snapshot: SessionSnapshot = {
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    idleTimeoutSeconds,
    expiresAt,
    lastSeenAt,
    serverNow,
  };
  const { mfaRequired, mfaEnabled, mfaVerified } = raw;
  if (typeof mfaRequired === 'boolean') snapshot.mfaRequired = mfaRequired;
  if (typeof mfaEnabled === 'boolean') snapshot.mfaEnabled = mfaEnabled;
  if (typeof mfaVerified === 'boolean') snapshot.mfaVerified = mfaVerified;
  return snapshot;
}

/**
 * Respuesta de `POST /api/session/ping`:
 * - `ok: true` con el estado de la sesión;
 * - `ok: false` con `motivo`: la sesión terminó (hay que ir al login con ese aviso);
 * - `ok: false` con `retry`: no se pudo saber (API caída, red). NO es un cierre: se reintenta.
 */
export type PingResult =
  | ({ ok: true } & SessionSnapshot)
  | { ok: false; motivo: SessionMotivo }
  | { ok: false; retry: true };

export function parsePingResult(raw: unknown): PingResult | null {
  if (!isRecord(raw)) return null;
  if (raw['ok'] === true) {
    const snapshot = parseSessionSnapshot(raw);
    return snapshot ? { ok: true, ...snapshot } : null;
  }
  if (raw['ok'] === false) {
    if (isSessionMotivo(raw['motivo'])) return { ok: false, motivo: raw['motivo'] };
    if (raw['retry'] === true) return { ok: false, retry: true };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reloj de la sesión en el reloj del navegador
// ---------------------------------------------------------------------------------------------

/** El estado de la sesión pasado al reloj de ESTE navegador (ms de `Date.now()`). */
export interface SessionClock {
  sessionId: string | null;
  idleTimeoutMs: number;
  /** Cuándo corta el servidor por inactividad si no llega más actividad. */
  idleDeadlineAt: number;
  /** Vencimiento absoluto. */
  expiresAt: number;
  /** Cuándo se recibió: entre dos pestañas gana el más nuevo. */
  receivedAt: number;
}

/**
 * `reportedActivity`: el ping que trajo este estado era `active`. En ese caso el servidor tocó
 * `last_seen_at` (si tenía más de 60 s), pero la respuesta puede traer el valor de antes: se usa
 * como piso la hora del servidor menos esos 60 s, que es lo mínimo que el servidor tiene guardado.
 */
export function clockFromSnapshot(
  snapshot: SessionSnapshot,
  receivedAt: number,
  reportedActivity: boolean,
): SessionClock {
  const serverNow = Date.parse(snapshot.serverNow);
  // Diferencia servidor − navegador. Un reloj local corrido cinco minutos no puede adelantar ni
  // atrasar el aviso cinco minutos.
  const offset = serverNow - receivedAt;
  let lastSeen = Date.parse(snapshot.lastSeenAt);
  if (reportedActivity) lastSeen = Math.max(lastSeen, serverNow - SERVER_TOUCH_GRANULARITY_MS);
  const idleTimeoutMs = snapshot.idleTimeoutSeconds * 1000;
  return {
    sessionId: snapshot.sessionId,
    idleTimeoutMs,
    idleDeadlineAt: lastSeen + idleTimeoutMs - offset,
    expiresAt: Date.parse(snapshot.expiresAt) - offset,
    receivedAt,
  };
}

/** El más reciente de dos relojes. */
export function newerClock(a: SessionClock | null, b: SessionClock | null): SessionClock | null {
  if (!a) return b;
  if (!b) return a;
  return b.receivedAt > a.receivedAt ? b : a;
}

/**
 * Un reloj que dejó otra pestaña (o una sesión anterior en `localStorage`) sólo se adopta si es de
 * ESTA sesión. Si todavía no se sabe cuál es la propia (la API no mandó `sessionId`), sólo vale uno
 * recibido después de cargar esta página: uno anterior puede ser de una sesión ya cerrada.
 */
export function acceptClock(
  current: SessionClock | null,
  incoming: SessionClock | null,
  ownSessionId: string | null,
  loadedAt: number,
): SessionClock | null {
  if (!incoming) return current;
  if (ownSessionId !== null && incoming.sessionId !== null) {
    if (incoming.sessionId !== ownSessionId) return current;
  } else if (incoming.receivedAt < loadedAt) {
    return current;
  }
  return newerClock(current, incoming);
}

/**
 * ¿Es el reloj de OTRA sesión, recibido después de cargar esta página y más nuevo que el propio?
 *
 * {@link acceptClock} lo descarta, pero no se puede ignorar: la cookie es una sola por navegador,
 * así que si otra pestaña ya habla de otra sesión (cambió la contraseña, volvió a ingresar) lo más
 * probable es que la de ESTA pestaña ya no exista. Seguir con su plazo terminaba cerrando por
 * inactividad la sesión nueva, en la que el usuario estaba trabajando. Tampoco se adopta a ciegas
 * (el de la otra pestaña podría ser el viejo): se le pregunta al servidor.
 */
export function isNewerForeignClock(
  current: SessionClock | null,
  incoming: SessionClock | null,
  ownSessionId: string | null,
  loadedAt: number,
): boolean {
  if (!incoming || ownSessionId === null || incoming.sessionId === null) return false;
  if (incoming.sessionId === ownSessionId) return false;
  if (incoming.receivedAt < loadedAt) return false;
  return current === null || incoming.receivedAt > current.receivedAt;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Lee un reloj guardado por otra pestaña (localStorage o BroadcastChannel). */
export function parseClock(raw: unknown): SessionClock | null {
  if (!isRecord(raw)) return null;
  const { sessionId, idleTimeoutMs, idleDeadlineAt, expiresAt, receivedAt } = raw;
  if (sessionId !== null && !isShortString(sessionId)) return null;
  if (
    !isFiniteNumber(idleTimeoutMs) ||
    !isFiniteNumber(idleDeadlineAt) ||
    !isFiniteNumber(expiresAt) ||
    !isFiniteNumber(receivedAt) ||
    idleTimeoutMs <= 0
  ) {
    return null;
  }
  return { sessionId, idleTimeoutMs, idleDeadlineAt, expiresAt, receivedAt };
}

// ---------------------------------------------------------------------------------------------
// Mensajes entre pestañas
// ---------------------------------------------------------------------------------------------

export type GuardMessage =
  | { type: 'activity'; at: number }
  | { type: 'clock'; clock: SessionClock }
  /** `motivo: null` es un cierre a mano: el login no muestra aviso. */
  | { type: 'logout'; motivo: SessionMotivo | null; at: number };

/** Un mensaje del canal o del `storage`. Lo arma otra pestaña: se valida igual. */
export function parseGuardMessage(raw: unknown): GuardMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'activity':
      return isFiniteNumber(raw['at']) ? { type: 'activity', at: raw['at'] } : null;
    case 'clock': {
      const clock = parseClock(raw['clock']);
      return clock ? { type: 'clock', clock } : null;
    }
    case 'logout': {
      const motivo = raw['motivo'];
      if (!isFiniteNumber(raw['at'])) return null;
      if (motivo !== null && !isSessionMotivo(motivo)) return null;
      return { type: 'logout', motivo, at: raw['at'] };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// La decisión de cada instante
// ---------------------------------------------------------------------------------------------

export interface GuardInputs {
  now: number;
  clock: SessionClock | null;
  /** Última actividad en cualquier pestaña. */
  lastActivityAt: number;
  /** Actividad que ya llegó al servidor. */
  reportedActivityAt: number;
  /** Último ping enviado (por cualquier pestaña), haya respondido o no. */
  lastPingAt: number;
  /** La actividad que registró "Seguir conectado" en esta pestaña (0 si no hubo). */
  stayActivityAt?: number;
}

export type GuardPhase =
  /** Todo bien. */
  | 'active'
  /** Faltan 2 minutos o menos para el corte por inactividad: diálogo con cuenta regresiva. */
  | 'warning'
  /** Venció la inactividad: cerrar con `reason: 'idle'`. */
  | 'idle-expired'
  /** Venció la sesión absoluta (12 h): terminar con motivo `expirada`. */
  | 'expired';

export interface GuardDecision {
  phase: GuardPhase;
  /** ms hasta el corte por inactividad; `null` si todavía no se sabe la política. */
  remainingMs: number | null;
  ping: 'none' | 'active' | 'passive';
  /** Faltan 10 minutos o menos para el vencimiento absoluto. */
  expiryWarning: boolean;
}

/**
 * Qué hacer ahora. El plazo es el del SERVIDOR (`idleDeadlineAt`); si hay actividad que todavía no
 * le llegó, se proyecta lo que va a quedar cuando llegue: la última actividad más la inactividad,
 * menos la granularidad con la que el servidor refresca `last_seen_at`.
 */
export function evaluateGuard(input: GuardInputs): GuardDecision {
  const { now, clock, lastActivityAt, reportedActivityAt, lastPingAt } = input;
  const pending = lastActivityAt > reportedActivityAt;
  const sinceLastPing = now - lastPingAt;
  const dueByInterval = sinceLastPing >= PING_INTERVAL_MS;
  const intervalPing = dueByInterval ? (pending ? 'active' : 'passive') : 'none';

  if (!clock) {
    return { phase: 'active', remainingMs: null, ping: intervalPing, expiryWarning: false };
  }

  if (now >= clock.expiresAt) {
    return { phase: 'expired', remainingMs: 0, ping: 'none', expiryWarning: false };
  }
  const expiryWarning = clock.expiresAt - now <= EXPIRY_WARNING_MS;

  const projected = pending
    ? Math.max(
        clock.idleDeadlineAt,
        lastActivityAt + clock.idleTimeoutMs - SERVER_TOUCH_GRANULARITY_MS,
      )
    : clock.idleDeadlineAt;
  const remainingMs = Math.max(0, projected - now);

  if (projected <= now) {
    return { phase: 'idle-expired', remainingMs: 0, ping: 'none', expiryWarning };
  }

  let ping: GuardDecision['ping'] = intervalPing;
  // "Seguir conectado" que todavía no llegó: se reintenta a los pocos segundos mientras el
  // servidor no haya cortado. Pasado su plazo ya no hay apuro que justifique un ping cada 2 s.
  const stayPending =
    (input.stayActivityAt ?? 0) > reportedActivityAt && now < clock.idleDeadlineAt;
  const urgentGap = stayPending ? STAY_RETRY_GAP_MS : URGENT_PING_GAP_MS;
  // La actividad tiene que llegar al servidor ANTES de que el servidor corte con el plazo viejo:
  // si falta poco, no se espera al minuto.
  if (
    ping === 'none' &&
    pending &&
    clock.idleDeadlineAt - now <= IDLE_WARNING_MS + PING_INTERVAL_MS &&
    sinceLastPing >= urgentGap
  ) {
    ping = 'active';
  }

  const phase: GuardPhase = remainingMs <= IDLE_WARNING_MS ? 'warning' : 'active';
  return { phase, remainingMs, ping, expiryWarning };
}

// ---------------------------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------------------------

function wholeSeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/** `m:ss` para la cuenta regresiva visible ("1:59"). */
export function formatCountdown(ms: number): string {
  const seconds = wholeSeconds(ms);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * El tramo de 15 s en el que está la cuenta regresiva. Cambia exactamente cuando lo que queda es
 * múltiplo de 15 (1:45, 1:30…), así lo que se anuncia coincide con lo que se ve en ese momento.
 */
export function announceBucket(ms: number): number {
  return Math.ceil(wholeSeconds(ms) / ANNOUNCE_STEP_SECONDS) * ANNOUNCE_STEP_SECONDS;
}

/** Lo que oye el lector de pantalla en cada tramo: "Quedan 1 minuto y 45 segundos." */
export function announceText(bucketSeconds: number): string {
  const seconds = Math.max(0, Math.floor(bucketSeconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const minutes = m === 1 ? '1 minuto' : `${m} minutos`;
  const secs = s === 1 ? '1 segundo' : `${s} segundos`;
  if (m === 0) return `Quedan ${secs}.`;
  if (s === 0) return m === 1 ? 'Queda 1 minuto.' : `Quedan ${minutes}.`;
  return `Quedan ${minutes} y ${secs}.`;
}

/** "18:40" en la hora local del navegador. `timeZone` existe para los tests. */
export function formatClockTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(ms));
}

/** El aviso de vencimiento absoluto (SPEC §3). */
export function expiryWarningText(expiresAtMs: number, timeZone?: string): string {
  return `Tu sesión vence a las ${formatClockTime(expiresAtMs, timeZone)}; guardá tu trabajo.`;
}

// ---------------------------------------------------------------------------------------------
// A dónde ir al terminar
// ---------------------------------------------------------------------------------------------

/**
 * Los parámetros del aviso: el motivo, con inactividad los minutos (si son del rango que admite un
 * nodo), y `next` sólo si es una ruta interna.
 */
function reasonParams(
  motivo: SessionMotivo,
  next: string | null | undefined,
  idleMinutes: unknown,
): URLSearchParams {
  const params = new URLSearchParams({ motivo });
  const minutes = motivo === 'inactividad' ? parseIdleMinutes(idleMinutes) : undefined;
  if (minutes !== undefined) params.set('minutos', String(minutes));
  const safe = next ? safeNextPath(next) : SAFE_NEXT_FALLBACK;
  if (safe !== SAFE_NEXT_FALLBACK) params.set('next', safe);
  return params;
}

/**
 * `/api/session/end`, que borra las cookies (salvo `st_trusted`) y manda al login con el aviso.
 * `motivo: null` es un cierre a mano: sin aviso y sin `next` (quien cierra sesión no pidió volver).
 * Con motivo, `next` lleva de vuelta a la pantalla donde estaba después de ingresar, e
 * `idleMinutes` hace que el aviso de inactividad diga cuántos minutos fueron.
 */
export function sessionEndPath(
  motivo: SessionMotivo | null,
  next?: string | null,
  idleMinutes?: unknown,
): string {
  if (motivo === null) return '/api/session/end';
  return `/api/session/end?${reasonParams(motivo, next, idleMinutes).toString()}`;
}

/** El login con el aviso del motivo y, si vale, la vuelta a donde estaba. */
export function loginPath(
  motivo: SessionMotivo | null,
  next?: string | null,
  idleMinutes?: unknown,
): string {
  if (motivo === null) return '/login';
  return `/login?${reasonParams(motivo, next, idleMinutes).toString()}`;
}
