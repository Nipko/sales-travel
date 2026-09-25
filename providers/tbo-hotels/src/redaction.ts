import { TBO_REDACTED } from './config';

/**
 * Qué sale del ACL de TBO hacia un log o hacia una exportación (docs/tbo/01 §11; 08 RNF-05).
 *
 * Son dos reglas distintas y no se mezclan:
 *
 * 1. **El log se arma por LISTA BLANCA** ({@link pickTboLogMeta}). No se redacta un cuerpo para
 *    loguearlo: el cuerpo no entra nunca, ni recortado. El patrón de Despegar —250 caracteres del
 *    cuerpo en el filtro y 300 en el `message`— no se repite, porque Book y BookingDetail de TBO
 *    devuelven nombres, email y teléfono (p. 32-33, 45-48).
 * 2. **La exportación desde la bóveda de payloads** ({@link redactTboPayload}) enmascara las claves
 *    personales y de tarjeta de 01 §11.3. La bóveda guarda los RQ/RS completos porque TBO los pide
 *    para un `500` (p. 9) y la certificación los exige (D-TBO-31 A); esta función es la que se
 *    aplica al sacarlos en live.
 *
 * No se importa la redacción de Sabre: un ACL no depende de otro, y su lista deja pasar
 * `AddressLine1`, `PostalCode` y `CardExpirationMonth` (01 §11.3).
 */

/**
 * Minúsculas y sólo alfanuméricos. TBO mezcla el casing de una misma clave (`CardHolderlastName`,
 * p. 35 y 38; `Hotelcodes`, p. 56), así que toda comparación de claves pasa por aquí.
 */
export function normalizeTboKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Clave del carril de tarjeta: empieza por `card`, contiene `cvv` o es `paymentinfo` (01 §10.5).
 * Es la misma regla para la guarda D1 del cliente y para la exportación: una clave de tarjeta no
 * sale al cable ni sale de la bóveda sin enmascarar.
 */
export function isTboCardKey(key: string): boolean {
  const normalized = normalizeTboKey(key);
  return (
    normalized.startsWith('card') || normalized.includes('cvv') || normalized === 'paymentinfo'
  );
}

/**
 * Claves personales de 01 §11.3, ya normalizadas. `tripname` porque su ejemplo, `Sharma_02Dec_Dubai`
 * (p. 64), parece llevar el apellido del huésped (INFERIDO).
 */
const PERSONAL_KEYS: ReadonlySet<string> = new Set([
  'firstname',
  'lastname',
  'emailid',
  'email',
  'phonenumber',
  'phone',
  'addressline1',
  'addressline2',
  'postalcode',
  'cardholderaddress',
  'tripname',
]);

export function isTboSensitiveKey(key: string): boolean {
  return PERSONAL_KEYS.has(normalizeTboKey(key)) || isTboCardKey(key);
}

/** Tope de profundidad de la exportación: un payload de TBO no llega ni a la mitad. */
const MAX_DEPTH = 64;

function redactNode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return TBO_REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactNode(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // Se enmascara el SUBÁRBOL entero: un `PaymentInfo` es sensible por lo que contiene.
      out[key] = isTboSensitiveKey(key) ? TBO_REDACTED : redactNode(child, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Copia de un RQ o RS de TBO con las claves sensibles enmascaradas, a cualquier profundidad. Sólo
 * para exportar desde la bóveda en live: en test y certificación los datos son ficticios y el zip
 * de certificación va sin redactar (D-TBO-31 A).
 */
export function redactTboPayload(payload: unknown): unknown {
  return redactNode(payload, 0);
}

/**
 * La lista blanca de 01 §11.1: vocabulario nuestro, enteros, identificadores operativos y
 * `Status.Description` recortada (sólo en las operaciones cuyo request no lleva datos personales;
 * eso lo decide el cliente con `logDescription`). Nunca cabeceras, cuerpos, `username`, nombres,
 * email ni teléfono: no hay clave para ellos, así que no pueden pasar.
 */
export const TBO_LOG_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'op',
  'path',
  'method',
  'lane',
  'attempt',
  'maxAttempts',
  'timeoutMs',
  'durationMs',
  'waitedMs',
  'retryInMs',
  'status',
  'tboCode',
  'outcome',
  'kind',
  'retry',
  'circuit',
  'timedOut',
  'contentType',
  'bodyBytes',
  'casingVariant',
  'description',
  'requestId',
  'accountRef',
  'credentialSource',
  'environment',
  'errorClass',
  'reason',
  'issues',
  'missing',
  // Lectura de Search: conteos y NOMBRES de claves desconocidas, nunca sus valores (RNF-12, C-12).
  'hotelsReceived',
  'packsReceived',
  'packsMapped',
  'unknownKeys',
  // Resultado de una búsqueda del adapter: nuestro `searchId` y conteos. Nunca los códigos de hotel,
  // las fechas ni la ocupación, y menos la nacionalidad del huésped (02 §5.3 punto 7).
  'searchId',
  'detailed',
  'batchCount',
  'failedBatchCount',
  'hotelCodeCount',
  'omittedHotelCodeCount',
  // Identificadores de la reserva: operativos, no personales (01 §11.1).
  'bookingReferenceId',
  'clientReferenceId',
  'confirmationNumber',
]);

export type TboLogValue = string | number | boolean | readonly string[];

export type TboLogMeta = Readonly<Record<string, TboLogValue>>;

/** Techo de un texto en el log. Lo nuestro nunca llega; es la red por si algo ajeno se cuela. */
const MAX_LOG_TEXT = 200;
const MAX_LOG_LIST = 20;

function logValue(value: unknown): TboLogValue | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_LOG_TEXT);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
    return value.slice(0, MAX_LOG_LIST).map((item) => item.slice(0, MAX_LOG_TEXT));
  }
  return undefined;
}

/**
 * Lo único que el cliente entrega al logger. Una clave fuera de {@link TBO_LOG_FIELDS}, o un valor
 * que no sea escalar o lista de textos, se descarta en silencio: un objeto anidado es justo la
 * forma en que un cuerpo o una cabecera llegarían al log.
 */
export function pickTboLogMeta(meta: Readonly<Record<string, unknown>>): TboLogMeta {
  const out: Record<string, TboLogValue> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!TBO_LOG_FIELDS.has(key)) continue;
    const safe = logValue(value);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}
