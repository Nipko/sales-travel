/**
 * Datos de la pantalla de Seguridad y las reglas de qué se muestra, sin I/O ni React: lo usan la
 * página (servidor), las acciones y los componentes de cliente, y se prueba solo.
 */

/** `GET /auth/mfa`. `required` y `pendingEnrollment` llegaron con el 2FA obligatorio. */
export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
  /** Algún rol del usuario exige 2FA: no se puede desactivar. */
  required: boolean;
  /** Empezó a enrolar (o a cambiar de teléfono) y no confirmó. */
  pendingEnrollment: boolean;
}

/** `GET /auth/sessions`. */
export interface SessionRow {
  id: string;
  issuedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** `GET /auth/trusted-devices`. `current` = el token de este navegador coincide. */
export interface TrustedDeviceRow {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Lo que devuelve `POST /auth/mfa/enroll`: el secreto nuevo, todavía pendiente de confirmar. */
export interface MfaEnrollmentSecret {
  secret: string;
  otpauthUri: string;
}

/** Con esta cantidad o menos de códigos de recuperación se avisa que conviene generar nuevos. */
export const LOW_RECOVERY_CODES = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * El estado del 2FA tal como llegue, o `null` si no se sabe (el API falló o respondió algo sin
 * `enabled`). No saber NO es "desactivada": pintarlo así mostraba el badge "Desactivada" y
 * "Activar" a quien la tiene activa, justo en la pantalla que dice cómo está protegida su cuenta.
 *
 * Un API anterior a `required` no lo manda: se asume `false`, que sólo muestra el botón
 * "Desactivar" (el API igual lo rechaza con 403 si el rol lo exige).
 */
export function toMfaStatus(raw: unknown): MfaStatus | null {
  if (!isRecord(raw) || typeof raw['enabled'] !== 'boolean') return null;
  const remaining = raw['recoveryCodesRemaining'];
  return {
    enabled: raw['enabled'] === true,
    recoveryCodesRemaining:
      typeof remaining === 'number' && Number.isInteger(remaining) && remaining > 0 ? remaining : 0,
    required: raw['required'] === true,
    pendingEnrollment: raw['pendingEnrollment'] === true,
  };
}

function toRow<T>(raw: unknown, parse: (r: Record<string, unknown>) => T | null): T | null {
  return isRecord(raw) ? parse(raw) : null;
}

export function toSessionRows(raw: unknown): SessionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = toRow(item, (r) => {
      const { id, issuedAt, lastSeenAt, expiresAt } = r;
      if (typeof id !== 'string' || typeof lastSeenAt !== 'string') return null;
      return {
        id,
        issuedAt: typeof issuedAt === 'string' ? issuedAt : lastSeenAt,
        lastSeenAt,
        expiresAt: typeof expiresAt === 'string' ? expiresAt : lastSeenAt,
        ip: stringOrNull(r['ip']),
        userAgent: stringOrNull(r['userAgent']),
        current: r['current'] === true,
      };
    });
    return row ? [row] : [];
  });
}

export function toTrustedDeviceRows(raw: unknown): TrustedDeviceRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = toRow(item, (r) => {
      const { id, createdAt, lastUsedAt, expiresAt } = r;
      if (typeof id !== 'string' || typeof createdAt !== 'string' || typeof expiresAt !== 'string')
        return null;
      return {
        id,
        createdAt,
        lastUsedAt: typeof lastUsedAt === 'string' ? lastUsedAt : createdAt,
        expiresAt,
        ip: stringOrNull(r['ip']),
        userAgent: stringOrNull(r['userAgent']),
        current: r['current'] === true,
      };
    });
    return row ? [row] : [];
  });
}

/**
 * La sesión actual primero y después la actividad más reciente: la que más importa ver es la tuya
 * y, de las otras, la que puede estar usando alguien ahora.
 */
export function sortSessions(rows: readonly SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  });
}

export function sortTrustedDevices(rows: readonly TrustedDeviceRow[]): TrustedDeviceRow[] {
  return [...rows].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt);
  });
}

/** Lo que el usuario abrió dentro de la tarjeta del 2FA ya activo. */
export type MfaPanel = 'rotate' | 'regenerate' | 'disable';

/** `unavailable`: no se pudo saber si el 2FA está activo; no se ofrece activar ni desactivar. */
export type MfaView = 'codes' | 'unavailable' | 'enroll' | 'enabled' | MfaPanel;

/**
 * Qué muestra la tarjeta del 2FA.
 *
 * Los códigos de recuperación recién entregados van PRIMERO, pase lo que pase con el estado del
 * servidor: antes la rama "2FA activo → formulario Desactivar" se evaluaba antes, y como confirmar
 * revalidaba la página, `enabled` llegaba en `true` en el mismo viaje y los códigos no se veían
 * nunca (auditoría: recovery-codes-never-displayed). Se van sólo cuando el usuario dice "Listo".
 *
 * Sin estado (`status: null`) no hay enrolamiento ni panel: cualquier acción partiría de un dato
 * que no tenemos.
 */
export function pickMfaView(input: {
  revealedCodes: readonly string[] | null;
  status: Pick<MfaStatus, 'enabled' | 'required'> | null;
  panel: MfaPanel | null;
}): MfaView {
  if (input.revealedCodes && input.revealedCodes.length > 0) return 'codes';
  if (!input.status) return 'unavailable';
  if (!input.status.enabled) return 'enroll';
  if (input.panel === 'disable' && input.status.required) return 'enabled';
  return input.panel ?? 'enabled';
}

/** Si conviene avisar que quedan pocos códigos de recuperación. */
export function recoveryCodesLow(status: Pick<MfaStatus, 'enabled' | 'recoveryCodesRemaining'>) {
  return status.enabled && status.recoveryCodesRemaining <= LOW_RECOVERY_CODES;
}
