/**
 * Política durable para un intento de cancelación.
 *
 * Una cancelación es una escritura no idempotente. `retryable` sólo puede ser `true` cuando el
 * error demuestra que el fallo ocurrió en una lectura/preflight anterior al write. Si no hay
 * evidencia suficiente, el resultado seguro es `UNVERIFIED`: se bloquea otro write y se escala.
 */
export type CancelOperationOutcome = 'SUCCEEDED' | 'FAILED' | 'UNVERIFIED';

export type CancelFailureReason =
  | 'completed'
  | 'provider-rejected'
  | 'deterministic'
  | 'pre-write-transient'
  | 'write-unverified'
  | 'legacy-unknown';

export interface CancelRetryPolicy {
  outcome: CancelOperationOutcome;
  retryable: boolean;
  reconciliationRequired: boolean;
  reason: CancelFailureReason;
}

interface ErrorShape {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly status?: unknown;
  readonly retryable?: unknown;
  readonly failure?: {
    readonly kind?: unknown;
    readonly retry?: unknown;
  };
}

const CANCEL_WRITE_PATH = /(?:^|\/)(?:cancel(?:booking)?|cancel\/bnpl)(?:$|[/?])/i;
const CANCEL_RESPONSE_MAPPING_ERROR = /Cancel(?:Booking)?MappingError$/;
const DETERMINISTIC_ERROR =
  /(?:Build|Input|Config|Validation|Mapping|CredentialsMissing|NotSupported|Rejected)Error$/;

const DETERMINISTIC_FAILURE_KINDS = new Set([
  'BUSINESS',
  'CLIENT_BUG',
  'CREDENTIALS_INVALID',
  'ENTITLEMENT',
  'HUMAN_REVIEW',
  'NO_DATA',
]);

function errorShape(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? error : {};
}

function isTransient(shape: ErrorShape): boolean {
  if (shape.retryable === true) return true;
  if (shape.failure?.retry === 'RETRY_BACKOFF' || shape.failure?.retry === 'RETRY_AFTER_REAUTH') {
    return true;
  }
  const status = typeof shape.status === 'number' ? shape.status : undefined;
  return status === 0 || status === 408 || status === 425 || status === 429 || (status ?? 0) >= 500;
}

function isDeterministic(shape: ErrorShape): boolean {
  const name = typeof shape.name === 'string' ? shape.name : '';
  if (DETERMINISTIC_ERROR.test(name)) return true;
  if (shape.retryable === false || shape.failure?.retry === 'NO_RETRY') return true;
  if (
    typeof shape.failure?.kind === 'string' &&
    DETERMINISTIC_FAILURE_KINDS.has(shape.failure.kind)
  ) {
    return true;
  }
  const status = typeof shape.status === 'number' ? shape.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

/**
 * Clasifica una excepción de cancelación sin depender del nombre de un proveedor concreto.
 *
 * Los adapters tipados ya exponen `path`, `status`, `retryable` o `failure.retry`. Un error de
 * mapeo de la respuesta de cancelación se considera post-write: hubo respuesta, pero no se pudo
 * demostrar el desenlace. Un error desconocido también se queda del lado seguro.
 */
export function classifyCancelThrownFailure(error: unknown): CancelRetryPolicy {
  const shape = errorShape(error);
  const name = typeof shape.name === 'string' ? shape.name : '';
  const path = typeof shape.path === 'string' ? shape.path : undefined;

  if (CANCEL_RESPONSE_MAPPING_ERROR.test(name)) {
    return {
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    };
  }

  if (isDeterministic(shape)) {
    return {
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
      reason: shape.failure?.kind === 'BUSINESS' ? 'provider-rejected' : 'deterministic',
    };
  }

  // Un timeout/5xx en el endpoint de cancelación no prueba que el proveedor no haya aplicado el
  // write. La política de retry genérica del HTTP client sólo es válida para operaciones
  // idempotentes y por tanto NO autoriza un segundo cancel.
  if (path !== undefined && CANCEL_WRITE_PATH.test(path)) {
    return {
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    };
  }

  // Sólo una ruta conocida distinta del write demuestra que la excepción ocurrió en el
  // get/check previo. Éste es el único caso que puede entrar a BullMQ.
  if (path !== undefined && isTransient(shape)) {
    return {
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    };
  }

  return {
    outcome: 'UNVERIFIED',
    retryable: false,
    reconciliationRequired: true,
    reason: 'write-unverified',
  };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === 'object' && candidate !== null
    ? (candidate as Record<string, unknown>)
    : null;
}

/** Lee la política persistida; las filas antiguas se bloquean porque su desenlace es desconocido. */
export function persistedCancelRetryPolicy(result: unknown): CancelRetryPolicy {
  const data = jsonObject(result);
  const outcome = data?.['outcome'];
  const reason = data?.['reason'];
  if (
    (outcome === 'SUCCEEDED' || outcome === 'FAILED' || outcome === 'UNVERIFIED') &&
    typeof data?.['retryable'] === 'boolean' &&
    typeof data['reconciliationRequired'] === 'boolean' &&
    (reason === 'completed' ||
      reason === 'provider-rejected' ||
      reason === 'deterministic' ||
      reason === 'pre-write-transient' ||
      reason === 'write-unverified' ||
      reason === 'legacy-unknown')
  ) {
    return {
      outcome,
      retryable: data['retryable'],
      reconciliationRequired: data['reconciliationRequired'],
      reason,
    };
  }

  return {
    outcome: 'UNVERIFIED',
    retryable: false,
    reconciliationRequired: true,
    reason: 'legacy-unknown',
  };
}

export const CANCEL_SUCCESS_POLICY: CancelRetryPolicy = {
  outcome: 'SUCCEEDED',
  retryable: false,
  reconciliationRequired: false,
  reason: 'completed',
};

export const CANCEL_REJECTED_POLICY: CancelRetryPolicy = {
  outcome: 'FAILED',
  retryable: false,
  reconciliationRequired: false,
  reason: 'provider-rejected',
};

export const CANCEL_UNVERIFIED_POLICY: CancelRetryPolicy = {
  outcome: 'UNVERIFIED',
  retryable: false,
  reconciliationRequired: true,
  reason: 'write-unverified',
};
