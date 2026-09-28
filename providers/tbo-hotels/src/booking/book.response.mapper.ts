import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import { isTboConfirmationNumber } from './booking-reference';
import { TBO_BOOK_ROOT_KEYS, type TboBookEnvelope } from './book.response.schema';

/**
 * Respuesta del Book → lo que dijo TBO, en vocabulario nuestro (docs/tbo/03 §3.8; 08 RF-20).
 *
 * Este mapper NO decide si la reserva está confirmada: eso es `classify-book-outcome.ts`, que
 * compara lo que volvió con lo que se mandó. Aquí sólo se lee, y se lee de forma que no se pueda
 * confundir "no vino" con "vino": un `ConfirmationNumber` con forma rara no se reenvía a
 * BookingDetail ni se guarda como localizador, se informa como ausente y la reserva queda para
 * verificar por nuestra referencia (p. 42).
 *
 * Nunca registra valores: sólo nombres de claves desconocidas y conteos (RNF-05).
 */

const BOOK_PATH = TBO_OPERATIONS.book.path;
const OP = 'book';
const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;

/**
 * Forma aceptable de un `ClientReferenceId` devuelto: ASCII visible y con techo. Es texto de TBO que
 * termina en el resultado del puerto (`bookingReference`) y de ahí en la orden; los ejemplos llegan
 * a 24 caracteres (p. 35) y la nuestra tiene 20. Lo que no cumple se trata como ausente: el Book
 * queda incierto igual, sin cargar a la orden un texto arbitrario.
 */
const CLIENT_REFERENCE_PATTERN = /^[\x21-\x7E]{1,64}$/;

/** Lo que volvió de un Book con `Status.Code` 200. */
export interface TboBookReply {
  readonly tboCode: 200;
  /** Localizador de TBO, sólo si vino y tiene forma de uno. */
  readonly confirmationNumber: string | undefined;
  /** El `ClientReferenceId` que TBO devolvió, para compararlo con el enviado. */
  readonly clientReferenceId: string | undefined;
  readonly diagnostics: TboBookReplyDiagnostics;
}

export interface TboBookReplyDiagnostics {
  readonly unknownKeys: readonly string[];
  /** Vino un `ConfirmationNumber` que no tiene forma de localizador: se trató como ausente. */
  readonly confirmationNumberMalformed: boolean;
  /** Vino un `ClientReferenceId` sin forma de referencia (largo o no imprimible): ausente. */
  readonly clientReferenceIdMalformed: boolean;
}

export interface TboBookMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
  readonly requestId?: string;
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Se descarta a propósito: la observabilidad nunca cambia qué se hace con una reserva.
  }
}

/**
 * Lee un Book ya aceptado por el cliente HTTP (`TboBookEnvelopeSchema` como `responseSchema`). Un
 * `Status.Code` distinto de 200 no puede llegar aquí: el cliente lo lanza como `TboApiError`; si
 * llegara, es un error de cableado y se falla cerrado.
 */
export function mapTboBookResponse(
  envelope: TboBookEnvelope,
  deps: TboBookMapDeps = {},
): TboBookReply {
  const code = envelope.Status?.Code;
  if (code !== undefined && code !== 200) {
    throw new TboResponseMappingError(
      BOOK_PATH,
      ['Status.Code:not_a_success_code'],
      deps.requestId,
    );
  }

  const unknownKeys = Object.keys(envelope)
    .filter((key) => !TBO_BOOK_ROOT_KEYS.includes(key))
    .slice(0, MAX_UNKNOWN_KEYS)
    .map((key) => key.slice(0, UNKNOWN_KEY_MAX));
  const raw = envelope.ConfirmationNumber;
  const confirmationNumberMalformed = raw !== undefined && !isTboConfirmationNumber(raw);
  const returnedReference = envelope.ClientReferenceId;
  const clientReferenceIdMalformed =
    returnedReference !== undefined && !CLIENT_REFERENCE_PATTERN.test(returnedReference);

  const meta = {
    provider: TBO_HOTELS_PROVIDER_CODE,
    op: OP,
    ...(deps.requestId === undefined ? {} : { requestId: deps.requestId }),
  };
  for (const key of unknownKeys) {
    safely(() => deps.metrics?.counter('tbo.contract.unknown_key', 1, { op: OP, key }));
  }
  if (unknownKeys.length > 0) {
    safely(() =>
      deps.logger?.warn('tbo.book.unknown_keys', pickTboLogMeta({ ...meta, unknownKeys })),
    );
  }
  if (confirmationNumberMalformed) {
    safely(() => deps.metrics?.counter('tbo.book.confirmation_number_malformed', 1, { op: OP }));
  }
  if (clientReferenceIdMalformed) {
    safely(() => deps.metrics?.counter('tbo.book.client_reference_malformed', 1, { op: OP }));
  }

  return {
    tboCode: 200,
    confirmationNumber: confirmationNumberMalformed ? undefined : raw,
    clientReferenceId: clientReferenceIdMalformed ? undefined : returnedReference,
    diagnostics: { unknownKeys, confirmationNumberMalformed, clientReferenceIdMalformed },
  };
}
