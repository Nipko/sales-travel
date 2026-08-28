/** Desenlaces que el proveedor puede afirmar de forma explícita. */
export type ProviderBookingOutcome = 'CONFIRMED' | 'PARTIAL' | 'PENDING' | 'FAILED';

/** `UNCERTAIN` es un estado de la UI, no un desenlace inventado del proveedor. */
export type BookingOutcome = ProviderBookingOutcome | 'UNCERTAIN';

export interface CreateOrderProviderResult {
  readonly outcome?: ProviderBookingOutcome;
  readonly pnr?: string;
  readonly orderId?: string;
  readonly issues?: readonly {
    readonly severity: 'ERROR' | 'WARNING';
    readonly category: string;
    readonly type: string;
  }[];
}

export interface BookingOutcomeView {
  readonly outcome: BookingOutcome;
  readonly pnr?: string;
  /** UUID de la fila local que debe conciliarse. */
  readonly orderId?: string;
  readonly error?: string;
}

export interface CreateOrderResponseBody {
  readonly order?: { readonly id?: string };
  readonly providerResult?: CreateOrderProviderResult;
  readonly saga?: {
    readonly kind?: 'settled' | 'compensate' | 'escalate';
    readonly status?: 'pending' | 'confirmed' | 'cancelled' | 'failed';
    readonly reason?: string;
  };
  readonly error?: string;
  readonly message?: string;
  readonly reconciliationRequired?: boolean;
  readonly retryForbidden?: boolean;
  readonly orderId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Convierte el error fail-closed del backend en un estado que NO vuelve a mostrar el formulario.
 *
 * No se publica el texto libre de `error`/`message`: el mensaje fijo explica la única acción
 * segura y evita hacer eco de datos que un proveedor pudiera haber incluido en la excepción.
 */
export function createOrderReconciliationView(value: unknown): BookingOutcomeView | null {
  const body = record(value);
  if (body === null) return null;

  const reconciliationRequired = body['reconciliationRequired'] === true;
  const retryForbidden = body['retryForbidden'] === true;
  const providerResult = record(body['providerResult']);
  const providerOutcome = nonEmptyString(providerResult?.['outcome']);
  const saga = record(body['saga']);
  const sagaKind = nonEmptyString(saga?.['kind']);
  const sagaStatus = nonEmptyString(saga?.['status']);
  const unsafeSaga = sagaKind === 'escalate';
  const confirmedWithoutClosedSaga =
    providerOutcome === 'CONFIRMED' && !(sagaKind === 'settled' && sagaStatus === 'confirmed');
  const failedWithoutClosedSaga =
    providerOutcome === 'FAILED' && !(sagaKind === 'settled' && sagaStatus === 'failed');
  if (
    !reconciliationRequired &&
    !retryForbidden &&
    !unsafeSaga &&
    !confirmedWithoutClosedSaga &&
    !failedWithoutClosedSaga
  ) {
    return null;
  }

  const localOrder = record(body['order']);
  const orderId = nonEmptyString(body['orderId']) ?? nonEmptyString(localOrder?.['id']);
  const pnr = nonEmptyString(providerResult?.['pnr']);
  const reference = orderId === undefined ? '' : ` Revisa la reserva local ${orderId}.`;

  return {
    outcome: 'UNCERTAIN',
    ...(pnr === undefined ? {} : { pnr }),
    ...(orderId === undefined ? {} : { orderId }),
    error:
      `No volver a reservar esta cotización. La creación quedó pendiente de conciliación ` +
      `con el proveedor.${reference}`,
  };
}

/**
 * Tras enviar el POST, un error de red o una respuesta no JSON/5xx no demuestra que el write no
 * ocurrió. Se cierra el formulario con el mismo mensaje fail-closed que una conciliación durable.
 */
export function createOrderTransportFailureView(): BookingOutcomeView {
  return {
    outcome: 'UNCERTAIN',
    error:
      'No volver a reservar esta cotización. No se pudo confirmar la respuesta de creación; ' +
      'hay que conciliarla con el proveedor.',
  };
}

export function isAmbiguousCreateHttpStatus(status: number): boolean {
  return status >= 500;
}

/** Sólo un `FAILED` explícito del proveedor permite ofrecer un create nuevo. */
export function shouldShowBookingForm(result: BookingOutcomeView | null): boolean {
  return result === null || result.outcome === 'FAILED';
}
