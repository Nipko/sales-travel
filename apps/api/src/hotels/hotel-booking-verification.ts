import type { HotelBookingView } from '@sales-travel/domain';
import type { HotelOrderSubStatus } from '../database/database.types.js';
import { HOTEL_BOOK_VERIFY_DELAY_MS } from './hotel-booking.saga.js';

/**
 * Verificación de una reserva de hotel cuya respuesta no llegó: **las decisiones, sin I/O**
 * (docs/tbo/09 PR-4.7; 08 RF-21, RNF-10; 03 §4.2, §4.3 y §4.6; 04 §7).
 *
 * Mismo criterio que `hotel-booking.saga.ts` (D9): la cola y el barrido sólo despiertan; lo que
 * decide qué paso toca, qué significa una lectura y cuándo se deja de preguntar vive aquí, para
 * que pasar a Temporal sea reescribir el runner y nada más.
 *
 * Reglas que no se negocian:
 *
 *   - **Sólo se lee.** Ninguna rama vuelve a reservar: no se sabe si el proveedor deduplica por
 *     nuestra referencia (03 §4.4), y una segunda reserva consume el crédito de la cuenta.
 *   - **La primera lectura sale a `tf + 120 s`, no antes** ("after 120 seconds of book response",
 *     p. 42, contado desde el fallo observado: Q-38).
 *   - **"No la encontré" no es "no existe"** (D-TBO-24 A): agotado el calendario, la orden queda
 *     `pending` y bloqueada hasta que la conciliación diaria la cierre con evidencia fuerte.
 *   - **Una lectura que falla no prueba nada**: se reintenta, se escala, pero no avanza el
 *     calendario como si hubiera dicho "no está".
 */

const MIN = 60_000;

/**
 * Cuándo se lee, contado desde el ancla: `tf + 120 s`, `+5`, `+15` y `+60 min` (03 §4.2 punto 6).
 * El calendario es provisorio hasta que TBO responda Q-38.
 */
export const HOTEL_BOOK_VERIFY_SCHEDULE_MS: readonly number[] = Object.freeze([
  HOTEL_BOOK_VERIFY_DELAY_MS,
  5 * MIN,
  15 * MIN,
  60 * MIN,
]);

export const HOTEL_BOOK_VERIFY_STEPS = HOTEL_BOOK_VERIFY_SCHEDULE_MS.length;

/**
 * El último instante en que un Book en vuelo pudo terminar, contado desde la última escritura del
 * intent: el PreBook de revalidación (hasta 23 s, p. 8) y el Book (120 s), redondeado. Es el ancla
 * de una orden que el proceso dejó sin desenlace (murió o se reinició con la reserva en vuelo):
 * nunca antes de un fallo que sí pudo observarse.
 */
export const HOTEL_BOOK_ORPHAN_ANCHOR_MS = 150_000;

/**
 * Cuánto después de su hora un paso se da por perdido en la cola. Cubre los reintentos del job
 * (10 + 20 + 40 + 80 s de backoff) con margen: el barrido no pisa un job que sigue vivo.
 */
export const HOTEL_BOOK_VERIFY_GRACE_MS = 5 * MIN;

/** Cuántas órdenes de un tenant revisa el barrido por corrida: el resto, en la siguiente. */
export const HOTEL_BOOK_VERIFY_SWEEP_LIMIT = 25;

// ───────────────────────── El calendario ─────────────────────────

/** Instante del paso `step`, o `undefined` si el calendario no tiene ese paso. */
export function verificationStepAt(anchorAt: number, step: number): number | undefined {
  const offset = HOTEL_BOOK_VERIFY_SCHEDULE_MS[step];
  return offset === undefined ? undefined : anchorAt + offset;
}

export interface HotelVerificationStep {
  readonly step: number;
  readonly at: number;
}

/** El último paso cuya hora ya llegó, o `undefined` si todavía no toca ninguno. */
export function dueStep(anchorAt: number, now: number): HotelVerificationStep | undefined {
  let due: HotelVerificationStep | undefined;
  HOTEL_BOOK_VERIFY_SCHEDULE_MS.forEach((offset, step) => {
    if (anchorAt + offset <= now) due = { step, at: anchorAt + offset };
  });
  return due;
}

/**
 * Qué paso ejecuta el barrido: el de la fila o, si llegó tarde, el último que ya venció. Leer una
 * vez tarde dice lo mismo que las lecturas intermedias que se perdieron.
 */
export function sweepStep(stored: number, anchorAt: number, now: number): number {
  return Math.max(stored, dueStep(anchorAt, now)?.step ?? stored);
}

/**
 * El calendario de una orden que el proceso dejó sin desenlace: el ancla es el último instante en
 * que su reserva pudo terminar, y el paso, el que ya toca (o el primero, si todavía no toca).
 */
export function adoptOrphan(
  updatedAt: number,
  now: number,
): HotelVerificationStep & { readonly anchorAt: number } {
  const anchorAt = updatedAt + HOTEL_BOOK_ORPHAN_ANCHOR_MS;
  const due = dueStep(anchorAt, now) ?? { step: 0, at: anchorAt + HOTEL_BOOK_VERIFY_DELAY_MS };
  return { anchorAt, ...due };
}

/** Lo que un job necesita saber de la fila para ejecutar su paso. */
export interface HotelVerificationCalendarState {
  /** La orden sigue sin desenlace consolidado. */
  readonly open: boolean;
  readonly anchorAt: number | null;
  readonly step: number | null;
  readonly nextAt: number | null;
}

/**
 * ¿El paso del job sigue siendo el de la fila? Un job de un paso que otro camino ya hizo, de una
 * orden ya consolidada o de un calendario detenido no lee ni escribe nada.
 */
export function stepIsCurrent<T extends HotelVerificationCalendarState>(
  state: T,
  step: number,
): state is T & { readonly anchorAt: number; readonly step: number; readonly nextAt: number } {
  return state.open && state.anchorAt !== null && state.nextAt !== null && state.step === step;
}

// ───────────────────────── La lectura ─────────────────────────

/**
 * Qué dice un error de la lectura, sin conocer al proveedor (su forma, como
 * `orders/cancel-retry-policy.ts`):
 *
 * - `transient`: red, 5xx, 429, cuerpo que no llegó entero o el breaker que no dejó salir la
 *   llamada. Repetir la lectura puede funcionar.
 * - `account`: la cuenta no puede leer (credencial rechazada, cuenta bloqueada). Sin cuenta no se
 *   puede concluir nada de la reserva, y el dueño de la credencial tiene que saberlo (03 §4.3).
 * - `permanent`: repetirla da lo mismo (pedido mal armado, respuesta que no se entiende, proveedor
 *   que ya no está habilitado).
 */
export type HotelVerificationReadError = 'transient' | 'account' | 'permanent';

interface ErrorShape {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly retryable?: unknown;
  readonly sentToProvider?: unknown;
  readonly failure?: {
    readonly kind?: unknown;
    readonly retry?: unknown;
    readonly notifyAccountOwner?: unknown;
  };
}

const ACCOUNT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'CREDENTIALS_INVALID',
  'ACCOUNT_BLOCKED',
]);

// Sin `Rejected`, a diferencia de `orders/cancel-retry-policy.ts`: allí "rechazada antes del cable"
// significa que el Cancel no salió y se puede cerrar; en una lectura significa que hay que repetirla.
const DETERMINISTIC_ERROR =
  /(?:Build|Input|Config|Validation|Mapping|NotSupported|NotAvailable)Error$/;

/** El limitador de la cuenta no le dio cupo a la llamada (o se abortó esperándolo): no salió. */
const NOT_DISPATCHED_ERROR = /DispatchRejectedError$/;

export function classifyVerificationReadError(err: unknown): HotelVerificationReadError {
  const shape: ErrorShape = typeof err === 'object' && err !== null ? err : {};
  const name = typeof shape.name === 'string' ? shape.name : '';
  const status = typeof shape.status === 'number' ? shape.status : undefined;
  const kind = typeof shape.failure?.kind === 'string' ? shape.failure.kind : '';

  // El breaker, el kill-switch o el limitador no dejaron salir la llamada: nada que concluir, se
  // repite. Detener el calendario por falta de cupo dejaría de buscar una reserva que puede existir.
  if (shape.sentToProvider === false || NOT_DISPATCHED_ERROR.test(name)) return 'transient';
  if (
    shape.failure?.notifyAccountOwner === true ||
    ACCOUNT_FAILURE_KINDS.has(kind) ||
    /CredentialsMissingError$/.test(name) ||
    status === 401
  ) {
    return 'account';
  }
  if (shape.retryable === true || shape.failure?.retry === 'RETRY_BACKOFF') return 'transient';
  if (
    DETERMINISTIC_ERROR.test(name) ||
    shape.retryable === false ||
    shape.failure?.retry === 'NO_RETRY' ||
    (status !== undefined && status >= 400 && status < 500 && ![408, 425, 429].includes(status))
  ) {
    return 'permanent';
  }
  // Una lectura siempre se puede repetir: ante la duda, se repite en vez de dejar de mirar.
  return 'transient';
}

/** Lo que salió de intentar un paso. */
export type HotelVerificationRead =
  /** El proveedor respondió: la vista dice si la encontró. */
  | { readonly kind: 'read'; readonly view: HotelBookingView }
  | { readonly kind: 'failed'; readonly error: HotelVerificationReadError }
  /**
   * La cuenta con la que hoy lee el tenant no es la que hizo la reserva: leer con otra diría "no
   * está" de una reserva que puede existir (04 §9.2, PV-15).
   */
  | { readonly kind: 'account-changed' };

/** Por qué una persona tiene que mirar la orden. Vocabulario cerrado: va al `domain_event`. */
export type HotelVerificationEscalation =
  /**
   * El barrido encontró una orden abierta sin calendario: el proceso murió con la reserva en
   * vuelo, o no pudo escribirlo. El mismo motivo con que la saga escala un desenlace incierto.
   */
  | 'create-uncertain'
  /** Calendario agotado sin encontrarla. La cierra la conciliación (D-TBO-24 A). */
  | 'create-not-found'
  /** La lectura no se pudo hacer (o no se puede hacer nunca): no sabemos nada de la reserva. */
  | 'verification-unavailable'
  /** La cuenta no puede leer: avisar a su dueño. */
  | 'provider-account-issue'
  /** El tenant ya no lee con la cuenta que reservó. */
  | 'provider-account-changed'
  /** La encontró, pero cancelada o cancelándose: no se esperaba. */
  | 'verified-cancelled-upstream'
  /** La encontró con un estado que no es de una reserva confirmada ni cancelada. */
  | 'provider-status-unknown';

export type HotelVerificationDecision =
  /** Confirmada: se consolida el intent con el localizador que devolvió la lectura. */
  | {
      readonly kind: 'consolidate';
      readonly providerBookingId: string;
      readonly providerStatus?: string;
    }
  /** No apareció todavía: el paso siguiente del calendario. */
  | { readonly kind: 'advance'; readonly step: number; readonly at: number }
  /** No apareció en ningún paso: queda `pending` y bloqueada hasta la conciliación. */
  | { readonly kind: 'not-found-yet' }
  /** Se deja de preguntar y la mira una persona. */
  | {
      readonly kind: 'hold';
      readonly reason: HotelVerificationEscalation;
      readonly subStatus: Extract<HotelOrderSubStatus, 'create-uncertain' | 'unknown'>;
      readonly providerStatus?: string;
      readonly providerBookingId?: string;
    }
  /** Fallo de transporte con reintentos de la cola por delante: que la cola lo repita. */
  | { readonly kind: 'retry' }
  /**
   * La lectura no se hizo y el paso queda como estaba, vencido: el barrido lo vuelve a intentar.
   * `escalate` sólo una vez por job; el barrido no repite el aviso cada 15 minutos.
   */
  | {
      readonly kind: 'unavailable';
      readonly reason: Extract<
        HotelVerificationEscalation,
        'verification-unavailable' | 'provider-account-issue'
      >;
      readonly escalate: boolean;
    };

export interface HotelVerificationFacts {
  readonly read: HotelVerificationRead;
  /** El paso que se ejecutó. */
  readonly step: number;
  readonly anchorAt: number;
  /** Quién ejecuta: el job de la cola (con sus reintentos) o el barrido (un intento). */
  readonly runner: 'job' | 'sweep';
  /** Es el último intento que la cola le da a este job. */
  readonly finalAttempt: boolean;
}

/** Los desenlaces de 03 §4.3, más lo que 04 §7.3 agrega para la cuenta. */
export function decideVerification(facts: HotelVerificationFacts): HotelVerificationDecision {
  const { read } = facts;

  if (read.kind === 'account-changed') {
    return { kind: 'hold', reason: 'provider-account-changed', subStatus: 'create-uncertain' };
  }

  if (read.kind === 'failed') {
    switch (read.error) {
      case 'permanent':
        return { kind: 'hold', reason: 'verification-unavailable', subStatus: 'create-uncertain' };
      case 'account':
        return {
          kind: 'unavailable',
          reason: 'provider-account-issue',
          escalate: facts.runner === 'job',
        };
      case 'transient':
        if (facts.runner === 'job' && !facts.finalAttempt) return { kind: 'retry' };
        return {
          kind: 'unavailable',
          reason: 'verification-unavailable',
          escalate: facts.runner === 'job',
        };
    }
  }

  const { view } = read;
  if (!view.found) {
    const next = facts.step + 1;
    const at = verificationStepAt(facts.anchorAt, next);
    return at === undefined ? { kind: 'not-found-yet' } : { kind: 'advance', step: next, at };
  }

  const found = {
    ...(view.providerStatus === undefined ? {} : { providerStatus: view.providerStatus }),
    ...(view.providerBookingId === undefined ? {} : { providerBookingId: view.providerBookingId }),
  };
  const locator = view.providerBookingId?.trim();
  if (view.status === 'CONFIRMED' && locator !== undefined && locator.length > 0) {
    return { kind: 'consolidate', ...found, providerBookingId: locator };
  }
  if (view.status === 'CANCELLED' || view.status === 'CANCELLATION_IN_PROGRESS') {
    return {
      kind: 'hold',
      reason: 'verified-cancelled-upstream',
      subStatus: 'create-uncertain',
      ...found,
    };
  }
  // Un estado fuera del vocabulario, o confirmada sin un localizador con el que leerla o cancelarla.
  return { kind: 'hold', reason: 'provider-status-unknown', subStatus: 'unknown', ...found };
}
