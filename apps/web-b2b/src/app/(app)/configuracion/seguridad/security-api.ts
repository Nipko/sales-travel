import { apiWithStatus } from '../../../../lib/api';
import { failureFrom, type ApiFailure } from './security-errors';

export type SecurityCall =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly failure: ApiFailure };

/**
 * Llamada al API para las acciones de Seguridad. Usa `apiWithStatus` y no `api()` porque hace falta
 * el `reason` del error: un `MFA_CODE_INVALID` se muestra en el formulario, un `SESSION_REPLACED`
 * manda al login con su motivo. Nunca registra cuerpos: llevan contraseñas, códigos y tokens.
 */
export async function callSecurityApi(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<SecurityCall> {
  const res = await apiWithStatus(path, {
    method: init.method ?? 'POST',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  // Un 204 (o un 200 vacío) llega como `not-json`: también es éxito, sin cuerpo.
  if (res.kind !== 'unreachable' && res.status >= 200 && res.status < 300) {
    return { ok: true, body: res.kind === 'json' ? res.body : null };
  }
  return { ok: false, failure: failureFrom(res) };
}
