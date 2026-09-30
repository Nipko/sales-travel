import { randomBytes } from 'node:crypto';

/** Códigos de recuperación que se entregan al activar o regenerar. */
export const RECOVERY_CODE_COUNT = 10;

export type MfaCodeInput =
  | { kind: 'totp'; value: string }
  | { kind: 'recovery'; value: string }
  | { kind: 'invalid' };

/**
 * Qué es lo que tipeó el usuario, antes de tocar la base.
 *
 * Un código de recuperación son 10 hex (se muestran como `XXXXX-XXXXX`); un TOTP, 6 dígitos. Antes
 * todo código de 6 dígitos que fallaba como TOTP se probaba además contra los 10 códigos de
 * recuperación con bcrypt (~250 ms cada uno): un solo desafío alcanzaba para saturar el threadpool.
 * Ahora cada forma se prueba sólo como lo que es, y lo que no tiene ninguna no dispara nada.
 */
export function classifyMfaCode(raw: string): MfaCodeInput {
  const compact = raw.replace(/[\s-]+/g, '');
  if (/^\d{6}$/.test(compact)) return { kind: 'totp', value: compact };
  if (/^[0-9a-f]{10}$/i.test(compact)) return { kind: 'recovery', value: compact.toUpperCase() };
  return { kind: 'invalid' };
}

/** Código nuevo: 10 hex en mayúscula, la forma que se hashea (sin guion). */
export function generateRecoveryCode(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

/** `ABCDE12345` → `ABCDE-12345`, como se muestra y se imprime. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
