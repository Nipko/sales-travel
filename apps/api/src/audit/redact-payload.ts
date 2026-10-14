/**
 * Lo que se le muestra a una persona del `payload` de un evento de auditoría (`domain_events`).
 *
 * El payload no debería llevar secretos (AuditEvent lo prohíbe), pero es append-only: un evento que
 * alguna vez se escribió mal queda para siempre, y la consola de la plataforma muestra eventos de toda
 * la red. Antes de que un payload salga por la API se le quitan las claves que nombran algo sensible,
 * a cualquier profundidad. Lo usan la ficha de una reserva (Reservas de la red) y la Actividad de la
 * plataforma. Sin I/O.
 */

/**
 * Por subcadena: `refreshToken`, `client_secret`, `x-api-key`, `cardBrand`, `passwordHash`,
 * `privateKey`, `setCookie`, `recoveryCodes`, `otpauthUrl`.
 */
const SENSITIVE_KEY =
  /(secret|password|passwd|token|api[_-]?key|private[_-]?key|authori[sz]ation|cvv|cvc|card|cookie|recovery[_-]?codes?|otpauth)/i;

/**
 * El id de una sesión (`sessionId`, `replacedSessionIds`): como en `meta`, no sale de la base. Los
 * conteos (`revokedSessions`) sí.
 */
const SESSION_ID_KEY = /session[_-]?ids?$/i;

/**
 * Las que sólo cuentan como palabra (`pan`, `pan_number`, `cardPan`, `otp`, `mfa_otp`, `totp`): como
 * subcadena se llevarían `company`, `expand` o `footprint`.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set(['pan', 'otp', 'totp']);

function hasSensitiveWord(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SENSITIVE_WORDS.has(word));
}

/** ¿La clave nombra algo que no se muestra? */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SESSION_ID_KEY.test(key) || hasSensitiveWord(key);
}

/** Más hondo que esto un payload de auditoría no tiene nada legítimo: se corta. */
const MAX_DEPTH = 12;

function redact(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH ? [] : value.map((item) => redact(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return {};
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue;
      out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * El payload sin las claves sensibles, a cualquier profundidad (también dentro de listas). Un payload
 * que no es un objeto (la columna es JSONB: puede ser una lista o un escalar) sale como `{}`.
 */
export function redactPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return redact(payload, 0) as Record<string, unknown>;
}
