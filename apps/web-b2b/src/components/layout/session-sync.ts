/**
 * El estado de sesión que comparten las pestañas del panel, y las dos salidas (cerrar sesión y
 * terminar una sesión que ya cortó el servidor).
 *
 * `localStorage` guarda lo compartido (así una pestaña nueva arranca sabiendo) y `BroadcastChannel`
 * avisa al instante. Sin `BroadcastChannel` (Safari viejo, algunos WebViews) el evento `storage`
 * hace de canal. `localStorage` puede no estar (modo privado, cookies bloqueadas) o tirar: cada
 * acceso va con try/catch y la guardia sigue funcionando con lo que tiene en memoria.
 */

import type { SessionMotivo } from '../../lib/session-reasons';
import {
  ACTIVITY_KEY,
  CLOCK_KEY,
  LOGOUT_KEY,
  SESSION_CHANNEL,
  parseClock,
  parseGuardMessage,
  sessionEndPath,
  type GuardMessage,
  type SessionClock,
} from './session-guard-state';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readNumber(key: string): number {
  try {
    const raw = storage()?.getItem(key);
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function writeNumber(key: string, value: number): void {
  try {
    storage()?.setItem(key, String(value));
  } catch {
    // Sin almacenamiento: queda el valor en memoria y el canal.
  }
}

export function readClock(): SessionClock | null {
  try {
    const raw = storage()?.getItem(CLOCK_KEY);
    return raw ? parseClock(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Ídem writeNumber.
  }
}

/** Traduce un cambio de `localStorage` hecho por otra pestaña a un mensaje del canal. */
function messageFromStorage(event: StorageEvent): GuardMessage | null {
  if (event.newValue === null) return null;
  try {
    switch (event.key) {
      case ACTIVITY_KEY: {
        const at = Number(event.newValue);
        return Number.isFinite(at) ? { type: 'activity', at } : null;
      }
      case CLOCK_KEY: {
        const clock = parseClock(JSON.parse(event.newValue) as unknown);
        return clock ? { type: 'clock', clock } : null;
      }
      case LOGOUT_KEY:
        return parseGuardMessage(JSON.parse(event.newValue) as unknown);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

let channel: BroadcastChannel | null | undefined;

function sharedChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(SESSION_CHANNEL) : null;
  } catch {
    channel = null;
  }
  return channel;
}

/**
 * Publica un mensaje para las otras pestañas y lo deja guardado. Un `BroadcastChannel` no se
 * entrega a sí mismo, y el evento `storage` tampoco dispara en la pestaña que escribe: nadie se
 * procesa su propio mensaje dos veces.
 */
export function publish(message: GuardMessage): void {
  switch (message.type) {
    case 'activity':
      writeNumber(ACTIVITY_KEY, message.at);
      break;
    case 'clock':
      writeJson(CLOCK_KEY, message.clock);
      break;
    case 'logout':
      writeJson(LOGOUT_KEY, message);
      break;
  }
  try {
    sharedChannel()?.postMessage(message);
  } catch {
    // Canal cerrado o mensaje no clonable: queda el `storage` como respaldo.
  }
}

/** Escucha a las otras pestañas. Devuelve la función para dejar de escuchar. */
export function subscribe(onMessage: (message: GuardMessage) => void): () => void {
  const bc = sharedChannel();
  if (bc) {
    const handler = (event: MessageEvent<unknown>) => {
      const message = parseGuardMessage(event.data);
      if (message) onMessage(message);
    };
    bc.addEventListener('message', handler);
    return () => bc.removeEventListener('message', handler);
  }

  const handler = (event: StorageEvent) => {
    const message = messageFromStorage(event);
    if (message) onMessage(message);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

/** Último cierre publicado por cualquier pestaña, para una página que vuelve del bfcache. */
export function readLastLogout(): GuardMessage | null {
  try {
    const raw = storage()?.getItem(LOGOUT_KEY);
    return raw ? parseGuardMessage(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** La ruta y la búsqueda actuales, para volver después de ingresar. */
export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

let leaving = false;

/** Los minutos de inactividad de la sesión, para que el aviso del login diga cuántos. */
let idleMinutes: number | null = null;

/** La guardia lo actualiza con cada reloj que adopta (el tope es el de ESTA sesión). */
export function setIdleMinutes(minutes: number | null): void {
  idleMinutes = minutes;
}

/**
 * Una página que vuelve del bfcache trae el módulo tal como quedó, con `leaving` en `true` si ya
 * había salido: sin esto no podría volver a salir aunque su sesión esté muerta.
 */
export function resetLeaving(): void {
  leaving = false;
}

/**
 * Navegación DURA (`location.replace`): vacía el Router Cache de Next, así "Atrás" no vuelve a
 * dibujar clientes u órdenes sin pedirlos al servidor, y reemplaza la entrada del historial en vez
 * de apilar otra. Pasa por `/api/session/end`, que borra las cookies aunque quien cerró la sesión
 * haya sido otra pestaña o el servidor.
 */
function go(motivo: SessionMotivo | null): void {
  window.location.replace(
    sessionEndPath(motivo, motivo === null ? null : currentPath(), idleMinutes),
  );
}

/** Sale porque otra pestaña ya cerró la sesión (no vuelve a avisar ni a revocar). */
export function leave(motivo: SessionMotivo | null): void {
  if (leaving) return;
  leaving = true;
  go(motivo);
}

/** Ya se está saliendo: la guardia deja de evaluar y de registrar actividad. */
export function isLeaving(): boolean {
  return leaving;
}

/** Termina una sesión que el servidor ya dio por muerta: avisa a las demás pestañas y sale. */
export function endSession(motivo: SessionMotivo): void {
  if (leaving) return;
  leaving = true;
  publish({ type: 'logout', motivo, at: Date.now() });
  go(motivo);
}

/**
 * Cierra sesión: revoca en la API (con `reason: 'idle'` si fue por inactividad), avisa a las demás
 * pestañas y sale. La revocación es best-effort: si la red falla, igual se borran las cookies en
 * `/api/session/end` y la sesión muere en el servidor por su propio plazo.
 */
export async function logout(options: { idle?: boolean } = {}): Promise<void> {
  if (leaving) return;
  // Se marca ANTES de esperar a la API: mientras tanto la guardia sigue con su reloj y no debe
  // disparar un segundo cierre.
  leaving = true;
  const motivo: SessionMotivo | null = options.idle ? 'inactividad' : null;
  try {
    await fetch('/api/session/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.idle ? { reason: 'idle' } : {}),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    // Ver arriba: se sale igual.
  }
  publish({ type: 'logout', motivo, at: Date.now() });
  go(motivo);
}
