/**
 * El motor de la guardia de sesión, fuera de React: escucha la actividad, lleva el reloj
 * compartido entre pestañas, hace los pings y decide cuándo avisar o salir. El componente
 * (`session-guard.tsx`) sólo lo arranca y dibuja el aviso.
 *
 * Todo el estado vive acá y no en `useState`/`useRef` porque cambia con eventos del navegador
 * (cada segundo, cada tecla, cada mensaje de otra pestaña) que no tienen por qué re-renderizar.
 */

import { SESSION_CHECK_EVENT } from '../../lib/session-check';
import { motivoForUnauthorized } from '../../lib/session-reasons';
import { MFA_STEP_UP_REQUIRED, mfaDemand } from './session-gate';
import {
  ACTIVITY_KEY,
  ACTIVITY_THROTTLE_MS,
  PING_KEY,
  PING_TIMEOUT_MS,
  REPORTED_KEY,
  acceptClock,
  clockFromSnapshot,
  evaluateGuard,
  isNewerForeignClock,
  parsePingResult,
  type GuardDecision,
  type GuardMessage,
  type PingResult,
  type SessionClock,
  type SessionSnapshot,
} from './session-guard-state';
import {
  endSession,
  isLeaving,
  leave,
  logout,
  publish,
  readClock,
  readLastLogout,
  readNumber,
  resetLeaving,
  setIdleMinutes,
  subscribe,
  writeNumber,
} from './session-sync';

/** Cada cuánto se reevalúa. Es barato: sólo compara marcas de tiempo. */
const TICK_MS = 1_000;

/**
 * Cuánto se espera para confirmar un `cerrada` que trajo el ping. Alcanza para que llegue la cookie
 * de la sesión nueva que emite el cambio de contraseña (ver {@link startSessionGuard}).
 */
export const REVOKED_RECHECK_MS = 2_000;

/** `scroll` va aparte: no burbujea y se escucha en captura sobre el documento. */
const WINDOW_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface SessionGuardOptions {
  /** El estado de la sesión que leyó el layout (`GET /auth/session`). */
  initial: SessionSnapshot | null;
  /** ms que faltan para el cierre por inactividad, o `null` para cerrar el aviso. */
  onWarning: (remainingMs: number | null) => void;
  /** Faltan 10 minutos o menos para el vencimiento absoluto (`expiresAt`, reloj del navegador). */
  onExpiryWarning: (expiresAt: number) => void;
  /**
   * El API dice que el rol ahora exige 2FA y el usuario no lo tiene (lo ascendieron en plena
   * sesión). El enrolamiento lo dibuja el layout, que no se vuelve a ejecutar en una navegación de
   * cliente: hay que volver a pedirlo. Se llama una sola vez por página.
   */
  onMfaEnrollmentRequired?: () => void;
  /** El layout ya está mostrando el enrolamiento: que falte el 2FA es lo esperado. */
  mfaEnrollmentGate?: boolean;
}

export interface SessionGuardController {
  /** "Seguir conectado". */
  stay: () => void;
  stop: () => void;
}

type EndPhase = 'idle-expired' | 'expired';

function isEndPhase(phase: GuardDecision['phase']): phase is EndPhase {
  return phase === 'idle-expired' || phase === 'expired';
}

/** `AbortSignal.timeout` no existe en navegadores de antes de 2022: ahí el ping va sin límite. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

export function startSessionGuard(options: SessionGuardOptions): SessionGuardController {
  const loadedAt = Date.now();
  let clock: SessionClock | null = null;
  let sessionId: string | null = null;
  let lastActivityAt = 0;
  let reportedActivityAt = 0;
  let lastPingAt = 0;
  let lastActivityWrite = 0;
  /** La actividad de "Seguir conectado", para reintentarla rápido hasta que llegue. */
  let stayActivityAt = 0;
  let inflight = false;
  /** Un ping pedido mientras otro viajaba: sale apenas vuelve aquél. */
  let queued: 'active' | 'passive' | null = null;
  /** Se está confirmando con el servidor un cierre que dice el reloj local. */
  let confirming = false;
  /** El último reloj de otra sesión por el que ya se le preguntó al servidor. */
  let probedForeignAt = 0;
  let enrollmentRequested = false;
  let warningOpen = false;
  let expiryWarnedKey: number | null = null;
  /**
   * Un `cerrada` del ping se confirma una vez antes de salir: `pending` mientras se espera (no sale
   * ningún otro ping, que viajaría con la misma cookie vieja), `confirming` en el ping que confirma.
   */
  let revokedCheck: 'none' | 'pending' | 'confirming' = 'none';
  let revokedTimer: number | undefined;

  /**
   * Un reloj de otra pestaña (o que quedó guardado): sólo se adopta si es de esta sesión. Si es de
   * OTRA y más nuevo, se le pregunta al servidor cuál es la sesión de la cookie (ver
   * {@link isNewerForeignClock}); la respuesta llega como un reloj propio.
   */
  function adoptForeignClock(incoming: SessionClock | null): void {
    if (
      incoming !== null &&
      isNewerForeignClock(clock, incoming, sessionId, loadedAt) &&
      incoming.receivedAt > probedForeignAt
    ) {
      probedForeignAt = incoming.receivedAt;
      void ping(lastActivityAt > reportedActivityAt);
    }
    clock = acceptClock(clock, incoming, sessionId, loadedAt);
    rememberIdleMinutes();
  }

  /** Un reloj que trajo un ping o el layout de ESTA pestaña: manda sobre lo que hubiera. */
  function adoptOwnClock(own: SessionClock): void {
    if (own.sessionId !== null) sessionId = own.sessionId;
    clock = own;
    rememberIdleMinutes();
    publish({ type: 'clock', clock: own });
  }

  /** "Cerramos tu sesión después de N minutos sin actividad": N es el tope de esta sesión. */
  function rememberIdleMinutes(): void {
    setIdleMinutes(clock ? Math.round(clock.idleTimeoutMs / 60_000) : null);
  }

  /** Lo que dejaron las otras pestañas; siempre gana lo más reciente. */
  function syncFromStorage(): void {
    lastActivityAt = Math.max(lastActivityAt, readNumber(ACTIVITY_KEY));
    reportedActivityAt = Math.max(reportedActivityAt, readNumber(REPORTED_KEY));
    lastPingAt = Math.max(lastPingAt, readNumber(PING_KEY));
    adoptForeignClock(readClock());
  }

  function evaluate(): GuardDecision {
    return evaluateGuard({
      now: Date.now(),
      clock,
      lastActivityAt,
      reportedActivityAt,
      lastPingAt,
      stayActivityAt,
    });
  }

  /** Manda un ping y devuelve lo que respondió; `null` si no se pudo saber (red, timeout). */
  async function requestPing(active: boolean): Promise<PingResult | null> {
    const sentAt = Date.now();
    // Se marca al ENVIAR: así las demás pestañas no mandan el mismo ping mientras éste viaja.
    lastPingAt = sentAt;
    writeNumber(PING_KEY, sentAt);
    try {
      const res = await fetch('/api/session/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active }),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: timeoutSignal(PING_TIMEOUT_MS),
      });
      return parsePingResult(await res.json().catch(() => null));
    } catch {
      return null;
    }
  }

  /** El estado que devolvió el servidor pasa a ser el de esta pestaña (y el de todas). */
  function adoptPing(snapshot: SessionSnapshot, active: boolean, activityAtSend: number): void {
    adoptOwnClock(clockFromSnapshot(snapshot, Date.now(), active));
    if (active && activityAtSend > reportedActivityAt) {
      reportedActivityAt = activityAtSend;
      writeNumber(REPORTED_KEY, activityAtSend);
    }
  }

  /**
   * Lo que el 2FA le exige a la sesión según el API, con la misma regla que el layout. Devuelve
   * si la pestaña está saliendo.
   */
  function enforceMfa(snapshot: SessionSnapshot): boolean {
    const demand = mfaDemand({
      required: snapshot.mfaRequired,
      enabled: snapshot.mfaEnabled,
      verified: snapshot.mfaVerified,
    });
    if (demand === 'step-up') {
      endSession(motivoForUnauthorized(MFA_STEP_UP_REQUIRED));
      return true;
    }
    if (demand === 'enroll' && !options.mfaEnrollmentGate && !enrollmentRequested) {
      // Una sola vez: si el usuario cancela la recarga (tiene algo sin guardar) no se le insiste
      // cada minuto; el API igual le rechaza todo con el motivo.
      enrollmentRequested = true;
      options.onMfaEnrollmentRequired?.();
    }
    return false;
  }

  /** El ping que se pidió mientras otro viajaba. */
  function flushQueued(): void {
    const next = queued;
    queued = null;
    if (next === null || isLeaving()) return;
    // Un activo encolado sólo si todavía hay actividad sin reportar: el que volvió pudo llevarla.
    void ping(next === 'active' && lastActivityAt > reportedActivityAt);
  }

  async function ping(active: boolean): Promise<void> {
    if (isLeaving() || revokedCheck === 'pending') return;
    if (inflight) {
      // No se descarta: "Seguir conectado" con el ping pasivo del minuto en vuelo tiene que llegar
      // igual, y apenas vuelva aquél (el urgente recién salía 10 s después, a veces tarde).
      if (active || queued === null) queued = active ? 'active' : 'passive';
      return;
    }
    inflight = true;
    const activityAtSend = lastActivityAt;
    let result: PingResult | null;
    try {
      result = await requestPing(active);
    } finally {
      inflight = false;
    }
    if (isLeaving()) return;
    if (result?.ok) {
      revokedCheck = 'none';
      adoptPing(result, active, activityAtSend);
      if (enforceMfa(result)) return;
    } else if (result && 'motivo' in result) {
      if (result.motivo === 'cerrada' && revokedCheck === 'none') {
        // Puede ser el cambio de contraseña de este mismo equipo: el API revoca todas las sesiones
        // y recién después emite la nueva, cuya cookie llega con la respuesta de la acción. Este
        // ping salió en esa ventana con el token viejo. Se pregunta de nuevo: con la cookie nueva
        // responde el estado de la sesión nueva; si de verdad se cerró, vuelve a decir `cerrada`.
        revokedCheck = 'pending';
        queued = null;
        revokedTimer = window.setTimeout(() => {
          revokedCheck = 'confirming';
          void ping(lastActivityAt > reportedActivityAt);
        }, REVOKED_RECHECK_MS);
        return;
      }
      endSession(result.motivo);
      return;
    }
    // `retry` o sin respuesta: no es un cierre; el próximo ping vuelve a probar.
    flushQueued();
    if (result?.ok) tick();
  }

  /**
   * El reloj de esta pestaña dice que la sesión terminó. Antes de cerrarla se le pregunta al
   * servidor, que es la fuente de verdad: el reloj puede ser de una sesión que ya no es la de la
   * cookie (otra pestaña cambió la contraseña o volvió a ingresar), y revocar a ciegas cerraba la
   * sesión NUEVA, compartida por cookie, en la que el usuario estaba trabajando.
   *
   * - El servidor la cortó: responde el motivo (con `SESSION_IDLE` ya la revocó como
   *   `idle_timeout`) y se sale con ése.
   * - Responde el estado y el plazo sigue vencido: se cierra como siempre, revocando.
   * - Responde el estado y la sesión sigue viva: se sigue con ese reloj.
   * - No responde: se sale igual, SIN revocar. Una sesión inactiva no puede quedar abierta en
   *   pantalla porque el API esté caído, pero tampoco se revoca una que no se pudo confirmar: si
   *   de verdad está inactiva la corta el servidor, y mientras tanto no ocupa puesto.
   */
  async function confirmEnd(phase: EndPhase): Promise<void> {
    if (confirming || isLeaving()) return;
    confirming = true;
    let result: PingResult | null;
    try {
      result = await requestPing(false);
    } finally {
      confirming = false;
    }
    if (isLeaving()) return;

    if (result === null || !result.ok) {
      if (result && 'motivo' in result) endSession(result.motivo);
      else endSession(phase === 'expired' ? 'expirada' : 'inactividad');
      return;
    }

    adoptPing(result, false, lastActivityAt);
    if (enforceMfa(result)) return;
    const again = evaluate().phase;
    if (again === 'expired') {
      endSession('expirada');
    } else if (again === 'idle-expired') {
      warningOpen = false;
      void logout({ idle: true });
    } else {
      tick();
    }
  }

  function tick(): void {
    if (isLeaving()) return;
    syncFromStorage();
    const decision = evaluate();

    if (isEndPhase(decision.phase)) {
      void confirmEnd(decision.phase);
      return;
    }

    warningOpen = decision.phase === 'warning' && decision.remainingMs !== null;
    options.onWarning(warningOpen ? decision.remainingMs : null);

    if (decision.ping !== 'none') void ping(decision.ping === 'active');

    if (decision.expiryWarning && clock) {
      // Por minuto: el vencimiento se recalcula en cada ping y varía unos milisegundos.
      const key = Math.round(clock.expiresAt / 60_000);
      if (expiryWarnedKey !== key) {
        expiryWarnedKey = key;
        options.onExpiryWarning(clock.expiresAt);
      }
    }
  }

  /**
   * Actividad de ESTA pestaña. `force` la registra aunque el aviso esté abierto ("Seguir
   * conectado"). Devuelve si contó.
   */
  function recordActivity(force: boolean): boolean {
    if (isLeaving()) return false;
    // Con el aviso abierto sólo cuentan sus botones: tabular entre ellos no es "seguir conectado".
    if (warningOpen && !force) return false;
    const now = Date.now();
    if (!force && now - lastActivityWrite < ACTIVITY_THROTTLE_MS) return false;

    // Actividad después del corte no revive la sesión: la PC que despierta pasados los 30 min sin
    // uso (o las 12 h) tiene que ir al login, no seguir como si nada.
    syncFromStorage();
    const decision = evaluate();
    if (isEndPhase(decision.phase)) {
      tick();
      return false;
    }

    lastActivityWrite = now;
    lastActivityAt = Math.max(lastActivityAt, now);
    publish({ type: 'activity', at: now });
    return true;
  }

  function onActivity(): void {
    recordActivity(false);
  }

  function onVisibility(): void {
    if (document.visibilityState !== 'visible') return;
    // Primero se evalúa con la actividad de antes: si venció mientras la pestaña estaba oculta (o
    // la PC suspendida), se cierra en vez de contar el regreso como actividad.
    tick();
    if (isLeaving()) return;
    recordActivity(false);
    void ping(lastActivityAt > reportedActivityAt);
  }

  /** Un fetch del panel recibió 401 (`requestSessionCheck`): se pregunta ya, sin esperar al minuto. */
  function onSessionCheck(): void {
    if (isLeaving()) return;
    void ping(lastActivityAt > reportedActivityAt);
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (!event.persisted) return;
    // Volvió del bfcache ("Atrás" después de cerrar sesión): si hubo un cierre después de que se
    // cargó esta página se va sin mostrar nada más; si no, se confirma con el servidor.
    resetLeaving();
    const last = readLastLogout();
    if (last && last.type === 'logout' && last.at >= loadedAt) {
      leave(last.motivo);
      return;
    }
    tick();
    void ping(false);
  }

  function onMessage(message: GuardMessage): void {
    switch (message.type) {
      case 'activity':
        lastActivityAt = Math.max(lastActivityAt, message.at);
        break;
      case 'clock':
        adoptForeignClock(message.clock);
        break;
      case 'logout':
        leave(message.motivo);
        return;
    }
    tick();
  }

  // ---- Arranque ----

  if (options.initial) adoptOwnClock(clockFromSnapshot(options.initial, loadedAt, true));
  syncFromStorage();
  // Cargar una pantalla del panel es actividad; pero si la sesión ya había vencido por
  // inactividad en otra pestaña, `recordActivity` no la revive.
  recordActivity(false);

  if (options.initial) {
    // El layout acaba de pedir la sesión SIN `x-session-ping: passive`: para el servidor esta carga
    // ya fue actividad, así que no hace falta otro ping hasta dentro de un minuto.
    lastPingAt = Math.max(lastPingAt, loadedAt);
    writeNumber(PING_KEY, lastPingAt);
    reportedActivityAt = Math.max(reportedActivityAt, lastActivityAt);
    writeNumber(REPORTED_KEY, reportedActivityAt);
    tick();
  } else {
    // Sin el estado del layout no se sabe qué sesión es ni cuándo corta: se pregunta ya.
    tick();
    void ping(true);
  }

  const interval = window.setInterval(tick, TICK_MS);
  for (const type of WINDOW_ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  }
  // Quien scrollea es el `<main>` del shell, no la ventana, y `scroll` no burbujea.
  document.addEventListener('scroll', onActivity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener(SESSION_CHECK_EVENT, onSessionCheck);
  const unsubscribe = subscribe(onMessage);

  return {
    stay() {
      if (!recordActivity(true)) return;
      // Hasta que este clic llegue al servidor se reintenta cada pocos segundos, no cada 10.
      stayActivityAt = lastActivityAt;
      warningOpen = false;
      options.onWarning(null);
      void ping(true);
    },
    stop() {
      window.clearInterval(interval);
      window.clearTimeout(revokedTimer);
      for (const type of WINDOW_ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
      document.removeEventListener('scroll', onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener(SESSION_CHECK_EVENT, onSessionCheck);
      unsubscribe();
    },
  };
}
