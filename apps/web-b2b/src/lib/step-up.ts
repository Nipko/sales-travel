import { readJson } from './read-json';
import type { TenantAdminProxyPlan } from './tenant-admin-proxy';

/**
 * Reconfirmar el 2FA antes de una acción de alto impacto (USR-13, founder D1 = C).
 *
 * El API responde 403 `MFA_RECENT_REQUIRED` a una acción crítica (suspender una cuenta en toda la
 * plataforma, restablecer el 2FA de alguien, forzar el cambio de contraseña, enviarle el enlace a un
 * admin, exportar a CSV) si la sesión no pasó el segundo factor en los últimos 10 minutos.
 * `withStepUp` envuelve la llamada: ante ese 403 abre el diálogo "Confirma que eres tú"
 * (`StepUpProvider`, montado una vez en el layout del panel), manda el código a
 * `POST /api/auth/step-up` y repite la llamada UNA vez. Si se cierra el diálogo, la acción no se
 * hizo y no hay error que mostrar (`isStepUpCancelled`).
 *
 * Para sumarlo a otra acción: que su llamada devuelva el `reason` del API en el fallo
 * (`StepUpAware`) y envolverla, `withStepUp(() => miLlamada(...))`. Nada más.
 */

/** El motivo del 403 que pide reconfirmar. */
export const STEP_UP_REASON = 'MFA_RECENT_REQUIRED';
/** El 403 de quien no tiene el 2FA activo: no hay código que pedirle, se muestra el mensaje. */
export const STEP_UP_UNAVAILABLE_REASON = 'MFA_REQUIRED_FOR_ACTION';

export const STEP_UP_COPY = {
  title: 'Confirma que eres tú',
  description: 'Escribe el código de 6 dígitos de tu app de autenticación.',
  confirm: 'Confirmar',
  invalid: 'Ese código no es válido. Inténtalo de nuevo.',
  locked: 'Demasiados intentos. Espera unos minutos.',
  incomplete: 'Escribe los 6 dígitos del código.',
  expired: 'Tu sesión venció. Vuelve a iniciar sesión.',
  failed: 'No pudimos verificar el código. Inténtalo de nuevo.',
  offline: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
} as const;

/** El resultado de una llamada del panel que puede pedir la reconfirmación. */
export type StepUpAware<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string; readonly reason?: string };

/** Se cerró el diálogo sin confirmar: la acción no se hizo. */
export interface StepUpCancelled {
  readonly ok: false;
  readonly cancelled: true;
  readonly message: string;
}

const CANCELLED: StepUpCancelled = { ok: false, cancelled: true, message: '' };

/** Abre el diálogo y resuelve `true` cuando el código se aceptó, `false` si se cerró. */
export type StepUpPrompt = () => Promise<boolean>;

const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/** El `reason` del cuerpo de error del BFF (`{ error, reason? }`), si tiene forma de motivo. */
export function reasonOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const reason = (body as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && MACHINE_REASON.test(reason) ? reason : undefined;
}

export function needsStepUp(result: { readonly ok: boolean; readonly reason?: string }): boolean {
  return !result.ok && result.reason === STEP_UP_REASON;
}

export function isStepUpCancelled(result: unknown): result is StepUpCancelled {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { cancelled?: unknown }).cancelled === true
  );
}

let registered: StepUpPrompt | null = null;
let pending: Promise<boolean> | null = null;

/**
 * Lo llama `StepUpProvider` al montarse; devuelve con qué darse de baja. Uno solo por pestaña: el
 * último que se monta es el que abre.
 */
export function registerStepUpPrompt(prompt: StepUpPrompt): () => void {
  registered = prompt;
  return () => {
    if (registered === prompt) registered = null;
  };
}

/**
 * El diálogo montado, o null si no hay (fuera del panel, en un test). Dos acciones que lo piden a la
 * vez comparten el mismo: un solo código para las dos.
 */
export function currentStepUpPrompt(): StepUpPrompt | null {
  const open = registered;
  if (open === null) return null;
  return () => {
    pending ??= open().finally(() => {
      pending = null;
    });
    return pending;
  };
}

/**
 * Corre `run`; si el API pide reconfirmar el 2FA, lo pide con `prompt` y repite `run` una sola vez.
 * Nunca entra en bucle: si la segunda también lo pide, se devuelve tal cual (su mensaje dice qué
 * hacer). Sin diálogo montado, el 403 vuelve como cualquier error.
 */
export async function withStepUp<T extends { readonly ok: boolean; readonly reason?: string }>(
  run: () => Promise<T>,
  prompt: StepUpPrompt | null = currentStepUpPrompt(),
): Promise<T | StepUpCancelled> {
  const first = await run();
  if (!needsStepUp(first) || prompt === null) return first;
  if (!(await prompt())) return CANCELLED;
  return run();
}

/** Los 6 dígitos del código, sin espacios ni guiones; null si no son 6. */
export function normalizeStepUpCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.normalize('NFKC').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** `POST /auth/step-up` del API con el cuerpo reconstruido: sólo `{ code }` de 6 dígitos. */
export function stepUpPlan(raw: unknown): TenantAdminProxyPlan {
  const code =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? normalizeStepUpCode((raw as Record<string, unknown>)['code'])
      : null;
  if (code === null) return { ok: false, error: STEP_UP_COPY.incomplete };
  return { ok: true, path: '/auth/step-up', body: { code } };
}

/** Qué decirle cuando el código no se aceptó, según el estado del API. */
export function stepUpErrorMessage(status: number, message: string | undefined): string {
  if (status === 400) return STEP_UP_COPY.invalid;
  if (status === 429) return STEP_UP_COPY.locked;
  if (status === 401) return STEP_UP_COPY.expired;
  // 409: el 2FA ya no está activo (lo restablecieron en el medio); 403: el chequeo de origen.
  const text = message?.trim() ?? '';
  return text !== '' && status < 500 ? text : STEP_UP_COPY.failed;
}

export type StepUpSubmit = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Manda el código al BFF. Nunca lanza. */
export async function submitStepUp(raw: string): Promise<StepUpSubmit> {
  const code = normalizeStepUpCode(raw);
  if (code === null) return { ok: false, message: STEP_UP_COPY.incomplete };
  let res: Response;
  try {
    res = await fetch('/api/auth/step-up', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, message: STEP_UP_COPY.offline };
  }
  if (res.ok) return { ok: true };
  const read = await readJson<unknown>(res);
  const body =
    read.ok && typeof read.data === 'object' && read.data !== null
      ? (read.data as Record<string, unknown>)
      : undefined;
  const error = body?.['error'];
  return {
    ok: false,
    message: stepUpErrorMessage(res.status, typeof error === 'string' ? error : undefined),
  };
}
