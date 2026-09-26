import { randomUUID } from 'node:crypto';
import { createCapturingLogger } from './acl.mjs';
import { pickInsensitive } from './evidence.mjs';
import { HarnessGuardError, PARSED } from './recorder.mjs';

/**
 * Lo que comparten `check` y `probe`: construir el ACL con el `fetch` grabador, correr un paso y
 * leer lo que pasó. Cada paso usa un adapter nuevo: una sonda no hereda el limitador ni el estado
 * de la anterior.
 */

/** El ACL no lee el contexto de búsqueda; el puerto lo exige. */
const SEARCH_CONTEXT = Object.freeze({ tenantId: 'tbo-cert-harness' });

export class Harness {
  #acl;
  #deps;

  /**
   * @param {object} init
   * @param {object} init.acl Módulo del ACL (`loadAcl`).
   * @param {object} init.settings `readSettings`.
   * @param {object} init.recorder `createRecorder`.
   * @param {import('./evidence.mjs').Evidence} init.evidence
   * @param {object} [init.deps] `sleep` para los reintentos del cliente (los tests no esperan) y
   *   `now`, el reloj de pared de las fechas que arma el arnés.
   */
  constructor({ acl, settings, recorder, evidence, deps = {} }) {
    this.#acl = acl;
    this.settings = settings;
    this.recorder = recorder;
    this.evidence = evidence;
    this.#deps = deps;
    this.searchContext = SEARCH_CONTEXT;
    this.now = deps.now ?? (() => Date.now());
  }

  get acl() {
    return this.#acl;
  }

  /**
   * La config de la cuenta tal como la arma el factory de `apps/api`: `parseTboConfig`. Por
   * defecto la de `.env.tbo`; una sonda puede cambiar la `baseUrl` o usar otras credenciales.
   */
  config({ baseUrl, username, password } = {}) {
    const { secrets } = this.settings;
    return this.#acl.parseTboConfig({
      environment: 'test',
      baseUrl: baseUrl ?? this.settings.baseUrl,
      username: username ?? secrets.revealUsername(),
      password: password ?? secrets.revealPassword(),
    });
  }

  #httpDeps(step) {
    return {
      fetch: this.recorder.fetchFor(step),
      logger: step.logger,
      ...(this.#deps.sleep === undefined ? {} : { sleep: this.#deps.sleep }),
    };
  }

  adapter(step, { config, options } = {}) {
    return new this.#acl.TboHotelsAdapter(
      config ?? this.config(),
      this.#httpDeps(step),
      { credentialSource: 'env' },
      options ?? {},
    );
  }

  staticClient(step, { config } = {}) {
    return new this.#acl.TboStaticContentClient(
      config ?? this.config(),
      this.#httpDeps(step),
      { credentialSource: 'env' },
      {},
    );
  }

  httpClient(step, { config } = {}) {
    return new this.#acl.TboHttpClient(config ?? this.config(), this.#httpDeps(step), {
      credentialSource: 'env',
    });
  }

  /**
   * Un paso: `call(step)` construye su cliente con `step` y llama. Un error del ACL (`TboError`)
   * es un resultado del paso —la sonda existe para verlo—; cualquier otro, o una guarda del arnés
   * que bloqueó una llamada, corta la corrida.
   */
  async step(folder, label, call, { rewrite } = {}) {
    const logger = createCapturingLogger();
    const step = { folder, label, rewrite, logger };
    const before = this.recorder.calls.length;
    let value;
    let error;
    try {
      value = await call(step);
    } catch (err) {
      if (!(err instanceof this.#acl.TboError)) throw err;
      error = err;
    } finally {
      for (const event of logger.events) {
        const line = JSON.stringify({ label, ...event });
        await folder.appendLine('acl-events.jsonl', this.settings.secrets.scrubText(line).text);
      }
    }
    const calls = this.recorder.calls.slice(before);
    const blocked = calls.find((c) => c.blocked !== undefined);
    // El ACL convierte cualquier rechazo del `fetch` en un fallo de red: la guarda se mira aquí.
    if (blocked !== undefined) {
      const detail = blocked.blockedPaths ?? (blocked.detail === undefined ? [] : [blocked.detail]);
      throw new HarnessGuardError(blocked.blocked, detail);
    }
    return { label, value, error, calls };
  }

  criteriaCaseOne(hotelCodes = this.settings.hotelCodes) {
    return caseOneCriteria(this.settings, hotelCodes);
  }
}

/**
 * La ocupación del caso 1 de certificación (07 §4.2): una habitación, un adulto, nacionalidad CO.
 * `currency` no viaja: TBO cotiza en la moneda del perfil (p. 13); el criterio neutral la exige.
 */
export function caseOneCriteria(settings, hotelCodes) {
  return {
    hotelIds: [...hotelCodes],
    checkinDate: settings.checkIn,
    checkoutDate: settings.checkOut,
    rooms: [{ adults: 1, childrenAges: [] }],
    currency: 'USD',
    guestNationality: 'CO',
    refundableOnly: false,
  };
}

/** Hoteles, opciones (roompacks) y monedas de un RS de Search, leídos del JSON crudo. */
export function searchSummary(json) {
  const results = pickInsensitive(json, 'HotelResult');
  if (!Array.isArray(results)) return { hotels: 0, options: 0, currencies: [] };
  const currencies = new Set();
  let options = 0;
  for (const hotel of results) {
    const currency = pickInsensitive(hotel, 'Currency');
    if (typeof currency === 'string' && currency !== '') currencies.add(currency);
    const rooms = pickInsensitive(hotel, 'Rooms');
    if (Array.isArray(rooms)) options += rooms.length;
  }
  return { hotels: results.length, options, currencies: [...currencies].sort() };
}

export function parsedResponse(call) {
  return call?.[PARSED];
}

/** La lectura del ACL en una palabra: `ok`, `empty`, el `kind` del fallo o la clase del error. */
export function errorOutcome(err) {
  if (err === undefined) return undefined;
  switch (err.name) {
    case 'TboApiError':
      return err.kind;
    case 'TboRequestBuildError':
      return `TboRequestBuildError:${err.reason}`;
    case 'TboDispatchRejectedError':
      return `not-dispatched:${err.reason}`;
    case 'TboResponseMappingError':
    case 'TboCancelMappingError':
    case 'TboConfigError':
      return `${err.name}(${(err.issues ?? []).slice(0, 3).join(', ')})`;
    default:
      return err.name;
  }
}

export function searchOutcome(report) {
  const batches = report.batches.map((batch) =>
    batch.status === 'failed' || batch.status === 'not-dispatched'
      ? (errorOutcome(batch.error) ?? batch.status)
      : batch.status,
  );
  return `${batches.join(',')} · ${report.diagnostics.packsMapped} packs válidos`;
}

/**
 * Lo que queda de una variante para el resumen: la ÚLTIMA llamada (la que resolvió, tras los
 * reintentos del cliente), cuántas hubo y dónde están los archivos.
 */
export function variantResult(label, stepResult, acl) {
  const last = stepResult.calls.at(-1);
  return {
    label,
    calls: stepResult.calls.length,
    url: last?.url ?? null,
    httpStatus: last?.httpStatus ?? 0,
    tboCode: last?.tboCode ?? null,
    description: last?.description ?? null,
    latencyMs: last?.latencyMs ?? null,
    transportError: last?.error ? (last.error.code ?? last.error.name) : null,
    acl,
    files: stepResult.calls.flatMap((c) =>
      [c.requestFile, c.aclRequestFile, c.responseFile].filter(Boolean),
    ),
  };
}

/** TBO entendió el request: `200`, o `201` (sin disponibilidad, que no es un rechazo). */
export function acceptedByTbo(variant) {
  return variant.tboCode === 200 || variant.tboCode === 201;
}

/** Hubo respuesta HTTP con envelope o con 2xx: el path existe. */
export function answered(variant) {
  return variant.tboCode !== null || (variant.httpStatus >= 200 && variant.httpStatus < 300);
}

export function describeVariant(variant) {
  if (variant.calls === 0) return `no salió (${variant.acl})`;
  if (variant.httpStatus === 0) {
    return `sin respuesta (${variant.transportError ?? 'red'}) · ACL ${variant.acl}`;
  }
  const code = variant.tboCode === null ? 'sin Status.Code' : `Status.Code ${variant.tboCode}`;
  const description = variant.description ? ` "${variant.description}"` : '';
  return `HTTP ${variant.httpStatus} · ${code}${description} · ${variant.latencyMs} ms · ACL ${variant.acl}`;
}

export function syntheticBookingCode(hotelCode) {
  // La forma de los ejemplos del PDF (p. 15): `<HotelCode>!TB!<n>!TB!<uuid>`, con un uuid nuevo.
  return `${hotelCode}!TB!1!TB!${randomUUID()}`;
}
