import {
  TboApiError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
  type TboFailureKind,
} from '../errors';
import type { TboBookReply } from './book.response.mapper';

/**
 * Desenlace de UN Book: confirmado, fallido o incierto (docs/tbo/03 §3.9; 01 §8.5; 08 RF-03 CA-2,
 * RF-20 CA 2 y 3, RF-21; BK-06). Función pura: la usan el adapter, para lo que TBO respondió con
 * `200`, y la saga, para lo que el Book lanzó.
 *
 * La regla de fondo es la de vuelos: "Una excepción NO es un `FAILED`. Un `FAILED` es el proveedor
 * diciendo 'no reservé nada'; un timeout es el proveedor no diciendo nada"
 * (`apps/api/src/orders/orders.service.ts`). En TBO, además, lo incierto obliga por contrato:
 * "In case of timeout/failure/http/network related error in book response then it is mandatory to
 * call the BookingDetail method by using BookingReferenceId after 120 seconds" (p. 42).
 *
 * | Observado                                                             | Desenlace   |
 * | --------------------------------------------------------------------- | ----------- |
 * | `200` con `ConfirmationNumber` y `ClientReferenceId` igual al enviado | `CONFIRMED` |
 * | `200` sin `ConfirmationNumber`, o con otra referencia o sin ella      | `UNCERTAIN` |
 * | `Status.Code` 201, 207, 300, 315, 400, 401 o 402 en el cuerpo         | `FAILED`    |
 * | `405`, `500`, `429`, código desconocido o que no es del Book          | `UNCERTAIN` |
 * | Red, timeout de 120 s, HTTP sin envelope, cuerpo ilegible             | `UNCERTAIN` |
 * | Rechazo local ANTES del cable (build, cupo, credenciales, vencimiento) | `FAILED`    |
 * | Cualquier otra excepción                                              | `UNCERTAIN` |
 *
 * - **Sólo el código del CUERPO prueba un rechazo definitivo.** Un HTTP 401 o 404 sin envelope dice
 *   algo del transporte, no de la reserva (01 §8.4; Q-07): se verifica leyendo. Con envelope, manda
 *   el código aunque el HTTP diga otra cosa.
 * - **`405 BOOKING_FAIL` es incierto** hasta que TBO confirme que no reservó nada (Q-36): la nota de
 *   p. 42 dice "failure" sin definirla.
 * - **Un rechazo local es `FAILED` con `dispatched: false`**: no salió ningún byte, la clave se libera
 *   y no hay nada que verificar. La saga lo distingue de un `FAILED` de TBO por ese campo (RF-20
 *   CA-4).
 * - **Lo desconocido es incierto.** Una clase de error que no está en la lista local puede haber
 *   salido o no; dar por fallido un Book que quizá reservó es la doble reserva de R-01.
 *
 * Nunca se copia el `message` de un error: sólo su nombre de clase (como `orders.service.ts` en el
 * `OrderCreateFailed`).
 */

export type TboBookOutcome = 'CONFIRMED' | 'FAILED' | 'UNCERTAIN';

/** Motivo como vocabulario cerrado: es lo que viaja en eventos y en `provider_raw` (03 §6). */
export const TBO_BOOK_OUTCOME_REASONS = [
  'confirmed',
  // FAILED por el código del cuerpo.
  'no-availability',
  'rate-unavailable',
  'insufficient-balance',
  'session-expired',
  'invalid-request',
  'credentials-invalid',
  'agent-blocked',
  // FAILED sin llegar a TBO.
  'not-dispatched',
  // UNCERTAIN.
  'missing-confirmation-number',
  'client-reference-missing',
  'client-reference-mismatch',
  'booking-failed',
  'provider-error',
  'throttled',
  'timeout',
  'transport',
  'http-error',
  'malformed-response',
  'unreadable-response',
  'unknown-code',
  'unexpected-code',
  'unexpected-error',
] as const;
export type TboBookOutcomeReason = (typeof TBO_BOOK_OUTCOME_REASONS)[number];

/**
 * Los códigos que prueban que TBO no reservó nada (01 §8.5; 03 §3.9), con el motivo que llevan. El
 * reparto de códigos por método es INFERIDO (Q-08): un código de esta tabla que llegue en un Book es
 * un rechazo de precondición.
 */
const DEFINITIVE_CODES: ReadonlyMap<number, TboBookOutcomeReason> = new Map([
  [201, 'no-availability'],
  [207, 'rate-unavailable'],
  [300, 'insufficient-balance'],
  [315, 'session-expired'],
  [400, 'invalid-request'],
  [401, 'credentials-invalid'],
  [402, 'agent-blocked'],
]);

/** Las clases que el paquete lanza SIN haber mandado nada a TBO (01 §9.1). */
const NOT_DISPATCHED: readonly (abstract new (...args: never[]) => Error)[] = [
  TboRequestBuildError,
  TboDispatchRejectedError,
  TboCredentialsMissingError,
  TboConfigError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboUnsupportedCurrencyError,
];

export type TboBookObservation =
  /** TBO respondió `Status.Code` 200 y el cuerpo se leyó. */
  | { readonly kind: 'answered'; readonly reply: TboBookReply }
  /** El Book lanzó: lo que haya lanzado, sin filtrar. */
  | { readonly kind: 'threw'; readonly error: unknown };

export interface TboBookExpectation {
  /** El `ClientReferenceId` que se mandó (igual al `BookingReferenceId`, RF-19). */
  readonly clientReferenceId: string;
}

export interface TboBookClassification {
  readonly outcome: TboBookOutcome;
  readonly reason: TboBookOutcomeReason;
  /** `false` sólo si se sabe que no salió nada hacia TBO. */
  readonly dispatched: boolean;
  /**
   * Hay que leer la reserva por `BookingReferenceId` a +120 s del fallo (p. 42; RF-21). Sólo en
   * `UNCERTAIN`: un `FAILED` no tiene nada que buscar y un `CONFIRMED` se cierra por su localizador.
   */
  readonly verifyByReference: boolean;
  /** Sólo en `CONFIRMED`. */
  readonly confirmationNumber?: string;
  /** `Status.Code` del cuerpo, si lo hubo. */
  readonly tboCode?: number;
  readonly failureKind?: TboFailureKind;
  /** Nombre de la clase del error, nunca su mensaje. */
  readonly errorClass?: string;
}

function uncertain(
  reason: TboBookOutcomeReason,
  extra: Partial<TboBookClassification> = {},
): TboBookClassification {
  return { ...extra, outcome: 'UNCERTAIN', reason, dispatched: true, verifyByReference: true };
}

function classifyReply(reply: TboBookReply, expected: TboBookExpectation): TboBookClassification {
  const base = { tboCode: reply.tboCode };
  if (reply.confirmationNumber === undefined) return uncertain('missing-confirmation-number', base);
  if (reply.clientReferenceId === undefined) return uncertain('client-reference-missing', base);
  if (reply.clientReferenceId !== expected.clientReferenceId) {
    return uncertain('client-reference-mismatch', base);
  }
  return {
    ...base,
    outcome: 'CONFIRMED',
    reason: 'confirmed',
    dispatched: true,
    verifyByReference: false,
    confirmationNumber: reply.confirmationNumber,
  };
}

/** El motivo de un `TboApiError` que no prueba un rechazo: se verifica leyendo. */
function uncertainReason(error: TboApiError): TboBookOutcomeReason {
  const bare = error.tboCode === undefined;
  switch (error.kind) {
    case 'BOOKING_FAILED':
      return 'booking-failed';
    case 'TRANSPORT':
      return error.timedOut ? 'timeout' : 'transport';
    case 'MALFORMED_RESPONSE':
      return 'malformed-response';
    case 'UNKNOWN_CODE':
      return 'unknown-code';
    case 'UPSTREAM':
      return bare ? 'http-error' : 'provider-error';
    case 'THROTTLED':
      return bare ? 'http-error' : 'throttled';
    default:
      return bare ? 'http-error' : 'unexpected-code';
  }
}

function classifyError(error: unknown): TboBookClassification {
  const errorClass =
    error instanceof Error
      ? error.name.slice(0, 64)
      : typeof error === 'object'
        ? 'object'
        : 'value';

  if (error instanceof TboApiError) {
    const extra = {
      failureKind: error.kind,
      errorClass,
      ...(error.tboCode === undefined ? {} : { tboCode: error.tboCode }),
    };
    const definitive =
      error.tboCode === undefined ? undefined : DEFINITIVE_CODES.get(error.tboCode);
    if (definitive !== undefined) {
      return {
        ...extra,
        outcome: 'FAILED',
        reason: definitive,
        dispatched: true,
        verifyByReference: false,
      };
    }
    return uncertain(uncertainReason(error), extra);
  }

  // Un 200 que no se pudo leer: TBO respondió y quizá reservó, y lo ilegible es justo lo que diría
  // con qué localizador.
  if (error instanceof TboResponseMappingError) {
    return uncertain('unreadable-response', { errorClass });
  }
  if (NOT_DISPATCHED.some((type) => error instanceof type)) {
    return {
      outcome: 'FAILED',
      reason: 'not-dispatched',
      dispatched: false,
      verifyByReference: false,
      errorClass,
    };
  }
  return uncertain('unexpected-error', { errorClass });
}

export function classifyTboBookOutcome(
  observation: TboBookObservation,
  expected: TboBookExpectation,
): TboBookClassification {
  return observation.kind === 'answered'
    ? classifyReply(observation.reply, expected)
    : classifyError(observation.error);
}
