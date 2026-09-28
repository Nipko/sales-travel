import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { isTboConfirmationNumber } from '../booking/booking-reference';
import { TboApiError, TboCancelMappingError, TboCancelOutcomeUnknownError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import { TBO_CANCEL_ROOT_KEYS, type TboCancelEnvelope } from './response.schema';

/**
 * Lo que respondió `/Cancel` → `{ success }` en vocabulario nuestro (docs/tbo/04 §4.2 y §4.3; 08
 * RF-25 y §9 C-05).
 *
 * - **`200` es "cancelación ACEPTADA"**, no "cancelada": el enum de estados tiene tres estados de
 *   cancelación en curso (p. 70-71) y el estado final lo fija la lectura posterior (PV-16). Aquí sólo
 *   se comprueba que la respuesta habla de la reserva pedida.
 * - **`479 CANCEL_FAIL` vuelve como `{ success: false }` SIN lanzar** (C-05): es un "no" de TBO, y la
 *   lectura posterior decide si la reserva ya estaba cancelada. El cliente HTTP lo lanza como
 *   `TboApiError` —su naturaleza es `NO_RETRY`, un rechazo— y este mapper lo recibe como
 *   observación.
 * - **Cualquier otro desenlace que pasó por el cable es `TboCancelOutcomeUnknownError`** (HARD-1): el
 *   contrato de Cancel sólo define `200` y `479`, así que un `405`, un `401`, un `500`, un timeout o
 *   un HTTP de error no prueban que TBO no haya cancelado. Con su `TboApiError` original, un código
 *   `NO_RETRY` cerraría la cancelación como fallida sin releer la reserva y la orden volvería a
 *   confirmada aunque TBO la hubiera liberado. Lo que no salió (el limitador, el body) se relanza
 *   tal cual: ahí sí se sabe que TBO no recibió nada.
 * - **Una respuesta ilegible es `TboCancelMappingError`**, nunca la clase madre: con el nombre
 *   genérico la política cerraría como fallida una cancelación que TBO pudo aplicar (01 §9.3).
 *
 * Nunca registra valores del cuerpo: sólo nombres de claves desconocidas (RNF-05).
 */

const CANCEL_PATH = TBO_OPERATIONS.cancel.path;
const OP = 'cancel';
const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;

/** Lo que se sabe de la llamada a `/Cancel`: la respuesta leída o lo que lanzó el cliente. */
export type TboCancelObservation =
  | { readonly kind: 'answered'; readonly envelope: TboCancelEnvelope }
  | { readonly kind: 'threw'; readonly error: unknown };

export interface TboCancelMapContext {
  /** El localizador que se mandó: la respuesta tiene que hablar de ESA reserva. */
  readonly confirmationNumber: string;
  readonly requestId?: string;
}

export interface TboCancelMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

export interface TboCancelReplyDiagnostics {
  /** Nombres de claves que el esquema no conoce. Nunca valores. */
  readonly unknownKeys: readonly string[];
}

export type TboCancelReply =
  | {
      readonly success: true;
      readonly tboCode: 200;
      readonly confirmationNumber: string;
      readonly diagnostics: TboCancelReplyDiagnostics;
    }
  | {
      readonly success: false;
      /** `CANCEL_FAIL`, "Cannot cancel booking" (p. 9). */
      readonly tboCode: 479;
      readonly error: 'TBO_CANCEL_FAIL';
      readonly diagnostics: TboCancelReplyDiagnostics;
    };

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Se descarta a propósito: la observabilidad nunca cambia qué se hace con una cancelación.
  }
}

function isCancelAnswer(error: unknown): error is TboApiError {
  return error instanceof TboApiError && error.path.toLowerCase() === CANCEL_PATH.toLowerCase();
}

function isCancelFail(error: unknown): error is TboApiError {
  return isCancelAnswer(error) && error.kind === 'CANCEL_FAILED';
}

export function mapTboCancelResponse(
  observation: TboCancelObservation,
  context: TboCancelMapContext,
  deps: TboCancelMapDeps = {},
): TboCancelReply {
  if (observation.kind === 'threw') {
    const { error } = observation;
    if (isCancelFail(error)) {
      return {
        success: false,
        tboCode: 479,
        error: 'TBO_CANCEL_FAIL',
        diagnostics: { unknownKeys: [] },
      };
    }
    if (isCancelAnswer(error) && !(error instanceof TboCancelOutcomeUnknownError)) {
      throw TboCancelOutcomeUnknownError.from(error);
    }
    throw error;
  }

  const { envelope } = observation;
  const { requestId } = context;
  const unknownKeys = Object.keys(envelope)
    .filter((key) => !TBO_CANCEL_ROOT_KEYS.includes(key))
    .slice(0, MAX_UNKNOWN_KEYS)
    .map((key) => key.slice(0, UNKNOWN_KEY_MAX));
  for (const key of unknownKeys) {
    safely(() => deps.metrics?.counter('tbo.contract.unknown_key', 1, { op: OP, key }));
  }
  if (unknownKeys.length > 0) {
    safely(() =>
      deps.logger?.warn(
        'tbo.cancel.unknown_keys',
        pickTboLogMeta({
          provider: TBO_HOTELS_PROVIDER_CODE,
          op: OP,
          unknownKeys,
          ...(requestId === undefined ? {} : { requestId }),
        }),
      ),
    );
  }

  const fail = (issue: string): never => {
    throw new TboCancelMappingError(CANCEL_PATH, [issue], requestId);
  };
  const code = envelope.Status?.Code;
  // Inalcanzable: el cliente lanza todo código que no sea éxito. Si llegara, es un cableado roto y
  // no una cancelación aceptada.
  if (code !== undefined && code !== 200) return fail('Status.Code:not_a_success_code');
  const echoed = envelope.ConfirmationNumber;
  if (!isTboConfirmationNumber(echoed)) return fail('ConfirmationNumber:invalid_format');
  // Un `200` que nombra otra reserva no dice qué pasó con la pedida.
  if (echoed.toUpperCase() !== context.confirmationNumber.toUpperCase()) {
    return fail('ConfirmationNumber:not_the_requested_booking');
  }
  return { success: true, tboCode: 200, confirmationNumber: echoed, diagnostics: { unknownKeys } };
}
