import type { TboFailureKind } from '../errors';
import type { TboOperationSpec } from './operations';

/**
 * La ÚNICA pieza que decide "éxito / vacío / error" de una respuesta de TBO (docs/tbo/01 §8 y
 * §10.3; 08 RF-03; 06 §4.2).
 *
 * TBO informa el desenlace en `Status.Code` DENTRO del cuerpo y el PDF no dice qué HTTP lo acompaña
 * (p. 8-10, 13; Q-07). Por eso aquí `res.ok` no significa nada: un 200 de transporte con
 * `Code: 405` es un Book fallido, y un 500 de transporte con `Code: 201` en Search es "sin
 * disponibilidad". Manda el cuerpo cuando trae un envelope válido; sin él, el HTTP.
 *
 * Ninguna rama compara `Status.Description` (01 §8.6): los textos de los ejemplos no coinciden con
 * los de la tabla. Sólo se devuelve, recortada, para el log de las operaciones sin datos personales.
 */

/** Los 12 códigos de la tabla de p. 8-10, en el orden del PDF, con su desenlace (01 §8.3). */
export const TBO_STATUS_CODES: ReadonlyMap<number, 'SUCCESS' | TboFailureKind> = new Map<
  number,
  'SUCCESS' | TboFailureKind
>([
  [200, 'SUCCESS'],
  [201, 'NO_AVAILABILITY'],
  [207, 'RATE_UNAVAILABLE'],
  [405, 'BOOKING_FAILED'],
  [479, 'CANCEL_FAILED'],
  [401, 'CREDENTIALS_INVALID'],
  [400, 'CLIENT_BUG'],
  [500, 'UPSTREAM'],
  [429, 'THROTTLED'],
  [315, 'OFFER_EXPIRED'],
  [300, 'INSUFFICIENT_BALANCE'],
  [402, 'ACCOUNT_BLOCKED'],
]);

/** Largo máximo de `Status.Description` en un log (01 §11.1). */
export const TBO_DESCRIPTION_LOG_MAX = 120;

export type TboEnvelopeOutcome = 'SUCCESS' | 'NO_AVAILABILITY';

interface VerdictBase {
  /** `Status.Code` del cuerpo, sólo si hubo un envelope legible. */
  readonly tboCode: number | undefined;
  /** El envelope llegó como `status`/`code` u otra grafía (métrica `tbo.envelope.casing_variant`). */
  readonly casingVariant: boolean;
  /** `Status.Description` recortada y en una línea. Quien decide si se loguea es la operación. */
  readonly description: string | undefined;
}

export type TboEnvelopeVerdict =
  | (VerdictBase & {
      readonly ok: true;
      readonly outcome: TboEnvelopeOutcome;
      /** El JSON entero, sin tipar: lo valida el esquema de la operación. */
      readonly data: unknown;
    })
  | (VerdictBase & { readonly ok: false; readonly kind: TboFailureKind });

export interface TboEnvelopeInput {
  /** HTTP de transporte. */
  readonly httpStatus: number;
  /** El cuerpo leído como texto. */
  readonly bodyText: string;
  readonly operation: Pick<TboOperationSpec, 'envelope' | 'emptyOnNoAvailability'>;
}

type ParsedBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseBody(text: string): ParsedBody {
  // Un cuerpo sólo de espacios es un cuerpo vacío: no hay nada que clasificar.
  if (text.trim().length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type KeyLookup =
  | { readonly state: 'none' }
  | { readonly state: 'ambiguous' }
  | { readonly state: 'one'; readonly key: string; readonly value: unknown };

/**
 * Busca una clave sin distinguir mayúsculas: el PDF trae variantes de casing en nombres de campo
 * (`Hotelcodes`, `fromdate`, p. 56 y 63). Dos claves que sólo difieren en mayúsculas son
 * ambiguas y se tratan como envelope inválido: elegir una sería adivinar cuál manda.
 */
function lookupKey(record: Readonly<Record<string, unknown>>, wanted: string): KeyLookup {
  const matches = Object.keys(record).filter((key) => key.toLowerCase() === wanted);
  if (matches.length === 0) return { state: 'none' };
  const [key] = matches;
  if (matches.length > 1 || key === undefined) return { state: 'ambiguous' };
  return { state: 'one', key, value: record[key] };
}

/** `Code` es Integer (p. 13); se acepta también como string de 3 dígitos. Nada más. */
function readCode(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^\d{3}$/.test(raw)) return Number(raw);
  return undefined;
}

function readDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length === 0 ? undefined : oneLine.slice(0, TBO_DESCRIPTION_LOG_MAX);
}

type Envelope =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly casingVariant: boolean }
  | {
      readonly state: 'valid';
      readonly code: number;
      readonly casingVariant: boolean;
      readonly description: string | undefined;
    };

function readEnvelope(value: unknown): Envelope {
  const root = asRecord(value);
  if (root === undefined) return { state: 'absent' };
  const status = lookupKey(root, 'status');
  if (status.state === 'none') return { state: 'absent' };
  if (status.state === 'ambiguous') return { state: 'invalid', casingVariant: true };

  const statusRecord = asRecord(status.value);
  const code = statusRecord === undefined ? undefined : lookupKey(statusRecord, 'code');
  if (statusRecord === undefined || code === undefined || code.state !== 'one') {
    return { state: 'invalid', casingVariant: status.key !== 'Status' };
  }
  const casingVariant = status.key !== 'Status' || code.key !== 'Code';
  const parsedCode = readCode(code.value);
  if (parsedCode === undefined) return { state: 'invalid', casingVariant };

  const description = lookupKey(statusRecord, 'description');
  return {
    state: 'valid',
    code: parsedCode,
    casingVariant,
    description: description.state === 'one' ? readDescription(description.value) : undefined,
  };
}

/**
 * Un HTTP no-2xx sin envelope se clasifica por el transporte (01 §8.4). Un 404 o 405 sin cuerpo de
 * TBO es un path o un verbo equivocados (01 §3.2): `CLIENT_BUG`, nunca "sin disponibilidad". Un
 * 3xx llega aquí porque el cliente usa `redirect: 'manual'` (01 §2.2) y tampoco se sigue.
 */
function kindForBareHttp(status: number): TboFailureKind {
  if (status === 401 || status === 403) return 'CREDENTIALS_INVALID';
  if (status === 429) return 'THROTTLED';
  if (status === 408 || status >= 500) return 'UPSTREAM';
  return 'CLIENT_BUG';
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

/**
 * Clasificación de un `Status.Code` legible, igual con transporte 2xx que sin él: un HTTP no-2xx
 * con envelope válido se clasifica por el código del cuerpo (01 §8.4, segunda fila).
 */
function classifyCode(
  envelope: Extract<Envelope, { state: 'valid' }>,
  data: unknown,
  operation: TboEnvelopeInput['operation'],
): TboEnvelopeVerdict {
  const base = {
    tboCode: envelope.code,
    casingVariant: envelope.casingVariant,
    description: envelope.description,
  };
  const mapped = TBO_STATUS_CODES.get(envelope.code);
  if (mapped === 'SUCCESS') return { ...base, ok: true, outcome: 'SUCCESS', data };
  if (mapped === 'NO_AVAILABILITY' && operation.emptyOnNoAvailability) {
    return { ...base, ok: true, outcome: 'NO_AVAILABILITY', data };
  }
  return { ...base, ok: false, kind: mapped ?? 'UNKNOWN_CODE' };
}

/** El algoritmo de 01 §10.3, pasos 4 a 6. */
export function classifyTboResponse(input: TboEnvelopeInput): TboEnvelopeVerdict {
  const { httpStatus, bodyText, operation } = input;
  const parsed = parseBody(bodyText);
  const envelope: Envelope = parsed.ok ? readEnvelope(parsed.value) : { state: 'absent' };
  const casingVariant = envelope.state === 'absent' ? false : envelope.casingVariant;
  const noEnvelope = { tboCode: undefined, casingVariant, description: undefined };

  if (isSuccessStatus(httpStatus)) {
    if (!parsed.ok) return { ...noEnvelope, ok: false, kind: 'MALFORMED_RESPONSE' };
    if (envelope.state === 'valid') return classifyCode(envelope, parsed.value, operation);
    if (envelope.state === 'absent' && operation.envelope === 'optional') {
      return { ...noEnvelope, ok: true, outcome: 'SUCCESS', data: parsed.value };
    }
    return { ...noEnvelope, ok: false, kind: 'MALFORMED_RESPONSE' };
  }

  if (envelope.state === 'valid') {
    // El transporte dice "error" y el cuerpo "éxito": se contradicen y no se elige uno.
    if (envelope.code === 200) {
      return {
        tboCode: 200,
        casingVariant: envelope.casingVariant,
        description: envelope.description,
        ok: false,
        kind: 'MALFORMED_RESPONSE',
      };
    }
    return classifyCode(envelope, parsed.ok ? parsed.value : undefined, operation);
  }
  return { ...noEnvelope, ok: false, kind: kindForBareHttp(httpStatus) };
}
