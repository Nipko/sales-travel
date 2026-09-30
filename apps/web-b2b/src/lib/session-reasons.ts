/**
 * Por qué se cerró una sesión: del `reason` máquina del 401 de la API al `?motivo=` de la URL del
 * login, y de ahí al texto que ve el usuario.
 *
 * Existe para que el login pueda explicar el cierre en vez de mostrar el formulario vacío como si
 * nada ("¿me desconectó un admin?, ¿alguien entró con mi usuario?"). El `motivo` va en castellano
 * porque se ve en la barra de direcciones, y sólo se acepta de esta lista blanca: la URL la puede
 * armar cualquiera y el texto del banner no debe salir de ella.
 */

export const SESSION_REASONS = [
  'SESSION_IDLE',
  'SESSION_REPLACED',
  'SESSION_RELEASED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
] as const;
export type SessionReason = (typeof SESSION_REASONS)[number];

export const SESSION_MOTIVOS = [
  'inactividad',
  'otro-dispositivo',
  'liberada',
  'expirada',
  'cerrada',
] as const;
export type SessionMotivo = (typeof SESSION_MOTIVOS)[number];

const MOTIVO_BY_REASON: Record<SessionReason, SessionMotivo> = {
  SESSION_IDLE: 'inactividad',
  SESSION_REPLACED: 'otro-dispositivo',
  SESSION_RELEASED: 'liberada',
  SESSION_EXPIRED: 'expirada',
  SESSION_REVOKED: 'cerrada',
};

export function isSessionReason(value: unknown): value is SessionReason {
  return typeof value === 'string' && (SESSION_REASONS as readonly string[]).includes(value);
}

export function isSessionMotivo(value: unknown): value is SessionMotivo {
  return typeof value === 'string' && (SESSION_MOTIVOS as readonly string[]).includes(value);
}

/** El motivo de un `reason` de sesión de la API, o `null` si no es uno de ellos. */
export function motivoForReason(reason: unknown): SessionMotivo | null {
  return isSessionReason(reason) ? MOTIVO_BY_REASON[reason] : null;
}

/**
 * El motivo de CUALQUIER 401 de la API: el de su `reason` si es de sesión; `cerrada` si la sesión
 * no pasó el segundo factor que su rol exige (hay que volver a entrar con el código); y `expirada`
 * si no trae motivo (un token vencido o de antes de estos códigos).
 */
export function motivoForUnauthorized(reason: unknown): SessionMotivo {
  if (reason === 'MFA_STEP_UP_REQUIRED') return 'cerrada';
  return motivoForReason(reason) ?? 'expirada';
}

/** `?motivo=` de la URL, sólo si está en la lista blanca. */
export function parseMotivo(raw: unknown): SessionMotivo | null {
  const value = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  return isSessionMotivo(value) ? value : null;
}

/** Los minutos de inactividad que admite un nodo (`tenants.idle_timeout_minutes`, 0055). */
const IDLE_MINUTES_MIN = 5;
const IDLE_MINUTES_MAX = 480;

/**
 * `?minutos=` junto a `motivo=inactividad`, para que el aviso diga cuántos. Sólo un entero del
 * rango que admite un nodo: la URL la puede armar cualquiera. Acepta también el número que calcula
 * la guardia con el tope de la sesión.
 */
export function parseIdleMinutes(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  let minutes: number;
  if (typeof value === 'number') minutes = value;
  else if (typeof value === 'string' && /^\d{1,3}$/.test(value)) minutes = Number(value);
  else return undefined;
  return Number.isInteger(minutes) && minutes >= IDLE_MINUTES_MIN && minutes <= IDLE_MINUTES_MAX
    ? minutes
    : undefined;
}

/**
 * El texto del aviso. `idleMinutes` es opcional porque la URL del login no lo trae siempre; sin él
 * se dice lo mismo sin el número.
 */
export function motivoMessage(
  motivo: SessionMotivo,
  options: { idleMinutes?: number } = {},
): string {
  switch (motivo) {
    case 'inactividad': {
      const minutes = options.idleMinutes;
      if (minutes !== undefined && Number.isInteger(minutes) && minutes > 0) {
        return `Cerramos tu sesión después de ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} sin actividad.`;
      }
      return 'Cerramos tu sesión por inactividad.';
    }
    case 'otro-dispositivo':
      return 'Tu sesión se abrió en otro dispositivo.';
    case 'liberada':
      return 'Un administrador liberó tu puesto.';
    case 'expirada':
      return 'Tu sesión venció. Volvé a ingresar.';
    case 'cerrada':
      return 'Tu sesión se cerró. Volvé a ingresar.';
  }
}
