import { performance } from 'node:perf_hooks';
import { REDACTED } from './secrets.mjs';
import { peekEnvelope, safeName } from './evidence.mjs';

/**
 * El `fetch` grabador de docs/tbo/07 §6.4. Envuelve el `fetch` real y guarda los bytes ANTES de
 * que el ACL parsee nada: si la respuesta rompe el Zod del ACL, la evidencia ya está en disco y
 * eso es un hallazgo, no un fallo del arnés.
 *
 * Al ACL le devuelve una `Response` nueva con los mismos bytes, así que lo que el ACL lee es lo
 * que llegó. El timeout del ACL sigue valiendo: la señal viaja al `fetch` real y corta también la
 * lectura del cuerpo.
 *
 * Además, dos guardas propias sobre lo que de verdad sale, porque una sonda puede reescribir el
 * request después de que el ACL pasó las suyas:
 *
 * - **D1** (G-2 y G-3 de 07 §6.7): ninguna clave de tarjeta, `PaymentMode` sólo `"Limit"` y,
 *   en PreBook, Book y BookingDetail, presente. Un request que no cumple no sale ni se escribe a
 *   disco.
 * - **Host**: sólo el host de la `baseUrl` configurada. Reescribir el path o el protocolo no
 *   puede mandar el `Authorization` a otro servidor.
 */

/** Claves de `PaymentInfo` (p. 33-34) normalizadas, con la `l` minúscula de los ejemplos (p. 35). */
const CARD_KEYS = new Set([
  'paymentinfo',
  'cvvnumber',
  'cardnumber',
  'cardexpirationmonth',
  'cardexpirationyear',
  'cardholderfirstname',
  'cardholderlastname',
  'billingamount',
  'billingcurrency',
  'cardholderaddress',
]);

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** La misma familia que barre el cliente del ACL (docs/tbo/01 §10.5), más las claves de G-2. */
export function isCardKey(key) {
  const k = normalizeKey(key);
  return CARD_KEYS.has(k) || k.startsWith('card') || k.includes('cvv');
}

function sweep(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => sweep(item, [...path, index], out));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (isCardKey(key)) {
      out.card.push(here.join('.'));
      continue;
    }
    if (normalizeKey(key) === 'paymentmode' && child !== 'Limit')
      out.paymentMode.push(here.join('.'));
    sweep(child, here, out);
  }
}

/**
 * G-3 pide `PaymentMode === "Limit"` en todo RQ de estas operaciones, no sólo que no haya otro
 * valor: sin el campo, el modo lo decidiría TBO (p. 19, 32, 43).
 */
const LIMIT_OPERATIONS = new Set(['PreBook', 'Book', 'BookingDetail']);

function carriesLimit(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false;
  return Object.entries(json).some(
    ([key, value]) => normalizeKey(key) === 'paymentmode' && value === 'Limit',
  );
}

/**
 * Rutas de claves que violan D1 en el body que sale, o `undefined` si está limpio. Con
 * `operation`, además exige el `PaymentMode` de G-3 en PreBook, Book y BookingDetail.
 */
export function d1Violation(bodyText, operation) {
  const needsLimit = LIMIT_OPERATIONS.has(operation);
  if (bodyText === undefined) {
    return needsLimit ? { reason: 'D1_PAYMENT_MODE', paths: ['PaymentMode'] } : undefined;
  }
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { reason: 'D1_NOT_JSON', paths: [] };
  }
  const out = { card: [], paymentMode: [] };
  sweep(json, [], out);
  if (out.card.length > 0) return { reason: 'D1_CARD_DATA', paths: out.card };
  if (out.paymentMode.length > 0) return { reason: 'D1_PAYMENT_MODE', paths: out.paymentMode };
  if (needsLimit && !carriesLimit(json)) {
    return { reason: 'D1_PAYMENT_MODE', paths: ['PaymentMode'] };
  }
  return undefined;
}

/** Una violación de las guardas del arnés. Corta la corrida: no es un hallazgo de TBO. */
export class HarnessGuardError extends Error {
  constructor(reason, detail = []) {
    super(`guarda del arnés: ${reason}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}`);
    this.name = 'HarnessGuardError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Nombre de la operación por el último segmento del path, sin distinguir mayúsculas: la colección
 * usa otros casings (`/search`) y la sonda PR-04 manda los dos (07 §6.4).
 */
const OPERATION_BY_SEGMENT = Object.freeze({
  search: 'Search',
  prebook: 'PreBook',
  book: 'Book',
  bookingdetail: 'BookingDetail',
  cancel: 'Cancel',
  bookingdetailsbasedondate: 'BookingDetailsBasedOnDate',
  hoteldetails: 'HotelDetails',
  hotelcodelist: 'hotelcodelist',
  tbohotelcodelist: 'TBOHotelCodeList',
  countrylist: 'CountryList',
  citylist: 'CityList',
});

export function operationOf(url) {
  const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  return OPERATION_BY_SEGMENT[segment.toLowerCase()] ?? (safeName(segment) || 'root');
}

/** Cabeceras para `calls.jsonl`: `Authorization` nunca con su valor (G-1). */
function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of new Headers(headers ?? {})) {
    out[name] =
      name.toLowerCase() === 'authorization'
        ? `${String(value).split(' ', 1)[0]} ${REDACTED}`
        : String(value);
  }
  return out;
}

/** Estados sin cuerpo: `new Response` lanza si se le pasa uno. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** El JSON parseado de la respuesta, fuera de la serialización de `calls.jsonl`. */
export const PARSED = Symbol('parsed');

const PARSED_MAX_BYTES = 5_000_000;

const DESCRIPTION_MAX = 160;

/**
 * Una `Description` o un mensaje de error en una sola línea, sin secretos ni caracteres de
 * control: va a `calls.jsonl` y a la consola, y un RS de TBO puede traer HTML escapado y
 * caracteres rotos (p. 26, 51).
 */
function oneLine(text, secrets) {
  let flat = '';
  for (const char of secrets.scrubText(text).text) {
    const code = char.codePointAt(0) ?? 0;
    flat += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return flat.replace(/ {2,}/g, ' ').trim().slice(0, DESCRIPTION_MAX);
}

/**
 * @param {object} deps
 * @param {(url: string, init: RequestInit) => Promise<Response>} deps.fetch El `fetch` real.
 * @param {import('./secrets.mjs').HarnessSecrets} deps.secrets
 * @param {() => number} deps.now Reloj de pared, para `startedAt`.
 * @param {readonly string[]} deps.allowedHostnames
 */
export function createRecorder({ fetch: realFetch, secrets, now, allowedHostnames }) {
  const allowed = new Set(allowedHostnames.map((host) => host.toLowerCase()));
  const calls = [];
  const violations = [];

  /**
   * Un paso: la carpeta donde se escribe, una etiqueta para el nombre de archivo y, sólo en las
   * sondas, una reescritura declarada del path o del body que el ACL armó.
   */
  function fetchFor(step) {
    return async (input, init = {}) => {
      const aclUrl = String(input);
      const method = String(init.method ?? 'GET').toUpperCase();
      const aclBody = init.body ?? undefined;
      if (aclBody !== undefined && typeof aclBody !== 'string') {
        // El cliente del ACL manda siempre texto (JSON.stringify): otra cosa no se sabe grabar.
        throw new HarnessGuardError('BODY_NOT_TEXT');
      }

      const rewrite = step.rewrite;
      let wireUrl = aclUrl;
      let wireBody = aclBody;
      try {
        if (rewrite?.url) wireUrl = rewrite.url(aclUrl);
        if (rewrite?.body && aclBody !== undefined) {
          wireBody = JSON.stringify(rewrite.body(JSON.parse(aclBody)));
        }
      } catch (err) {
        // Una reescritura que ya no encaja con lo que arma el ACL no se "arregla" mandando otra
        // cosa: el ACL lo leería como un fallo de red y la sonda contestaría otra pregunta.
        const record = {
          folder: step.folder.rel,
          label: step.label ?? null,
          blocked: 'REWRITE_FAILED',
          detail: String(err?.message ?? err).slice(0, 200),
        };
        violations.push(record);
        calls.push(record);
        await step.folder.appendJsonl('calls.jsonl', record);
        throw new HarnessGuardError('REWRITE_FAILED', [record.detail]);
      }
      const mutated = wireUrl !== aclUrl || wireBody !== aclBody;

      const operation = operationOf(wireUrl);
      const seq = step.folder.nextSeq();
      const base = `${seq}_${operation}${step.label ? `_${safeName(step.label)}` : ''}`;
      const record = {
        seq: Number(seq),
        folder: step.folder.rel,
        label: step.label ?? null,
        operation,
        method,
        url: wireUrl,
        startedAt: new Date(now()).toISOString(),
        headers: redactHeaders(init.headers),
        ...(mutated ? { mutation: rewrite?.description ?? 'reescrito', aclUrl } : {}),
      };

      const hostname = new URL(wireUrl).hostname.toLowerCase();
      const blocked = !allowed.has(hostname)
        ? { reason: 'HOST', paths: [] }
        : d1Violation(wireBody, operation);
      if (blocked !== undefined) {
        // Nada sale y el body tampoco se escribe: si trae una tarjeta, no puede quedar en disco.
        record.blocked = blocked.reason;
        record.blockedPaths = blocked.paths.slice(0, 20);
        violations.push(record);
        calls.push(record);
        await step.folder.appendJsonl('calls.jsonl', record);
        throw new HarnessGuardError(blocked.reason, record.blockedPaths);
      }

      if (wireBody !== undefined) {
        const rq = secrets.scrubText(wireBody);
        record.requestFile = await step.folder.write(`${base}_RQ.json`, rq.text);
        record.requestBytes = Buffer.byteLength(wireBody, 'utf8');
      }
      if (mutated && aclBody !== undefined && wireBody !== aclBody) {
        // Lo que armó el ACL antes de la reescritura de la sonda: la trazabilidad de la mutación.
        record.aclRequestFile = await step.folder.write(
          `${base}_RQ.acl.json`,
          secrets.scrubText(aclBody).text,
        );
      }

      const t0 = performance.now();
      let res;
      let bytes;
      try {
        res = await realFetch(wireUrl, { ...init, body: wireBody });
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        // Red, DNS, TLS o timeout: también es evidencia (07 §6.4).
        record.latencyMs = Math.round(performance.now() - t0);
        if (res !== undefined) record.httpStatus = res.status;
        const cause = err?.cause;
        record.error = {
          name: String(err?.name ?? 'Error'),
          ...(cause?.code || err?.code ? { code: String(cause?.code ?? err.code) } : {}),
          message: oneLine(String(cause?.message ?? err?.message ?? ''), secrets),
          timedOut: init.signal?.aborted === true,
        };
        calls.push(record);
        await step.folder.appendJsonl('calls.jsonl', record);
        throw err;
      }

      record.latencyMs = Math.round(performance.now() - t0);
      record.httpStatus = res.status;
      const contentType = res.headers.get('content-type');
      const location = res.headers.get('location');
      if (contentType) record.contentType = contentType.slice(0, 100);
      if (location) record.location = oneLine(location, secrets);
      const envelope = peekEnvelope(bytes);
      if (envelope.tboCode !== undefined) record.tboCode = envelope.tboCode;
      if (envelope.description !== undefined) {
        record.description = oneLine(envelope.description, secrets);
      }
      const stored = secrets.scrubBytes(bytes);
      if (stored.hits.length > 0) record.redactedSecrets = stored.hits;
      record.responseBytes = bytes.length;
      record.responseFile = await step.folder.write(
        `${base}_RS.${envelope.json === undefined ? 'txt' : 'json'}`,
        stored.bytes,
      );
      await step.folder.appendJsonl('calls.jsonl', record);
      // Sólo lo que alguien va a leer (el resumen de un Search): `hotelcodelist` trae todos los
      // códigos de TBO y retenerlo toda la corrida no le sirve a nadie.
      if (bytes.length <= PARSED_MAX_BYTES) {
        Object.defineProperty(record, PARSED, { value: envelope.json, enumerable: false });
      }
      calls.push(record);

      return new Response(NULL_BODY_STATUSES.has(res.status) ? null : bytes, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };
  }

  return { fetchFor, calls, violations };
}
