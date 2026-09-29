import { createHash, randomUUID } from 'node:crypto';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';
import {
  missingTboCredentials,
  requireUsableTboConfig,
  type TboEnvironment,
  type TboHotelsConfig,
  type TboUsableConfig,
} from '../config';
import {
  TboApiError,
  TboCancelMappingError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboError,
  TboRequestBuildError,
  TboResponseMappingError,
  type TboFailureKind,
  type TboRequestBuildReason,
} from '../errors';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { isTboCardKey, normalizeTboKey, pickTboLogMeta } from '../redaction';
import { TboInMemoryRateLimiter, type TboRateLimiter } from './limiter';
import {
  TBO_OPERATIONS,
  isTboMoneyPath,
  type TboLane,
  type TboOperationName,
  type TboOperationSpec,
} from './operations';
import {
  classifyTboResponse,
  type TboEnvelopeInput,
  type TboEnvelopeOutcome,
} from './status-envelope';

/**
 * Cliente HTTP de TBO Hotels (docs/tbo/01 §10; 08 RF-02, RF-03, RNF-01, RNF-02, RNF-04 capa 3 y
 * RNF-05). Forma del cliente de AgentCars —timeout por operación con `AbortSignal.timeout`— y
 * salvaguardas de Sabre —`fetch` y logger inyectables, cero reintentos en dinero— (06 §3.3).
 *
 * Lo que hace y un `fetch` pelado no:
 *
 * 1. **El desenlace lo decide `Status.Code` del cuerpo**, no `res.ok` (`./status-envelope`).
 * 2. **Book y Cancel salen UNA vez**, aunque alguien edite la tabla: la guarda mira el nombre de la
 *    operación y el path además de la columna `money` (`money-paths.guard.test.ts`). Si hay duda,
 *    se concilia con BookingDetail (p. 42); repetir un Book puede crear dos reservas.
 * 3. **El timeout cubre también el cuerpo.** Despegar y Sabre limpian su timer antes de
 *    `res.text()`, así que un servidor que manda cabeceras y después el cuerpo a cuentagotas no
 *    tiene techo (01 §5.5).
 * 4. **Nada con forma de tarjeta sale al cable** (guarda D1, 01 §10.5), y sólo `PaymentMode:
 *    "Limit"`. Se barre el JSON que viaja, no el objeto que lo produjo: `toJSON` existe.
 * 5. **El log es una lista blanca** (`pickTboLogMeta`): nunca cabeceras, cuerpos ni el usuario.
 *    Los RQ/RS completos van, si está configurada, a la bóveda de payloads, nunca al log.
 * 6. **`redirect: 'manual'`**: un redirect reenviaría el `Authorization` a donde diga el servidor.
 *    Un 3xx sin envelope es `CLIENT_BUG` y cambiar de URL es una decisión explícita (01 §2.2).
 */

export type TboFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Mismo vocabulario que `CredentialSource` de `apps/api/src/providers/provider.types.ts`. */
export type TboCredentialSource = 'own' | 'inherited' | 'env';

/** Un intento, completo, para la bóveda de payloads (D-TBO-31 A; 01 §11.2). */
export interface TboPayloadRecord {
  readonly requestId: string;
  readonly operation: TboOperationName;
  readonly path: string;
  readonly method: TboOperationSpec['method'];
  readonly attempt: number;
  readonly accountRef: string;
  readonly environment: TboEnvironment;
  /** ISO 8601 del envío. */
  readonly sentAt: string;
  readonly durationMs: number;
  /** El JSON exacto que salió, o `undefined` en un GET. */
  readonly requestBody: string | undefined;
  /** HTTP de transporte; `0` si no hubo respuesta completa. */
  readonly responseStatus: number;
  readonly responseBody: string | undefined;
  readonly tboCode: number | undefined;
  readonly outcome: TboEnvelopeOutcome | TboFailureKind;
}

/**
 * Almacén cifrado, con retención corta y acceso auditado, de los RQ/RS completos (PR-4.9). Lo
 * implementa `apps/api`; el ACL sólo escribe. Un fallo de la bóveda nunca cambia el desenlace de
 * la llamada: se registra y se sigue.
 */
export interface TboPayloadVault {
  record(entry: TboPayloadRecord): void | Promise<void>;
}

export interface TboHttpDeps {
  readonly fetch?: TboFetch;
  readonly logger?: LoggerPort;
  /** Métricas de 01 §11.1 por el port de `packages/core`, no por un SDK importado aquí. */
  readonly metrics?: MetricsPort;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter del backoff, en [0, 1). */
  readonly random?: () => number;
  readonly uuid?: () => string;
  /**
   * El limitador de la cuenta. Tiene que ser UNO por proceso y compartido por todos los clientes:
   * el cupo es de la cuenta TBO, no del adapter. Sin inyectar, cada cliente usa el suyo, que sólo
   * sirve cuando hay un cliente por cuenta (el arnés, los tests).
   */
  readonly limiter?: TboRateLimiter;
  readonly payloadVault?: TboPayloadVault;
  /** Por defecto `AbortSignal.timeout`. Se inyecta para fijar en un test qué espera pide cada operación. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
}

/** De quién es la cuenta con la que se construyó el cliente. Sólo alimenta `accountRef` y el log. */
export interface TboAccountContext {
  readonly ownerTenantId?: string;
  readonly credentialSource?: TboCredentialSource;
}

export interface TboSendOptions<T> {
  /** Sólo acorta el de la tabla; en Search puede subir hasta el techo de `ResponseTime`. */
  readonly timeoutMs?: number;
  /** Sólo acorta el de la tabla. En Book y Cancel es 1 pase lo que pase. */
  readonly maxAttempts?: number;
  /**
   * Señal del request entrante, para las lecturas interactivas. En Book y Cancel se IGNORA: abortar
   * no cancela nada en TBO y sólo convierte un resultado conocido en uno incierto (01 §5.4).
   */
  readonly signal?: AbortSignal;
  /** Uno de los cupos que declara la operación. Book y Cancel van siempre al de dinero. */
  readonly lane?: TboLane;
  /** Zod de SALIDA (`.strict()` en los builders de dinero), aplicado justo antes del cable. */
  readonly requestSchema?: ZodType<unknown, ZodTypeDef, unknown>;
  /**
   * Zod de la respuesta de la operación. Un fallo es `TboResponseMappingError` y, en `/Cancel`,
   * `TboCancelMappingError`, para que la política de cancelaciones no cierre como fallida una
   * cancelación que pudo aplicarse (01 §9.3).
   */
  readonly responseSchema?: ZodType<T, ZodTypeDef, unknown>;
}

interface TboHttpResultBase {
  /** HTTP del intento que resolvió. */
  readonly status: number;
  /** `undefined` sólo en `hotelcodelist` sin `Status` (p. 55). */
  readonly tboCode: number | undefined;
  readonly requestId: string;
  /** Desde la entrada a `send`, esperas del limitador y reintentos incluidos. */
  readonly durationMs: number;
  readonly attempts: number;
}

/**
 * `NO_AVAILABILITY` es el vacío que la fila admite: el 201 de Search o el 500 "No Hotels Found" de
 * TBOHotelCodeList (`tboCode` dice cuál). No es un error, así que no reintenta ni cuenta para el
 * breaker.
 */
export type TboHttpResult<T> =
  | (TboHttpResultBase & { readonly outcome: 'SUCCESS'; readonly data: T })
  | (TboHttpResultBase & { readonly outcome: 'NO_AVAILABILITY' });

/** Backoff exponencial con jitter, precedente de Sabre (`providers/sabre/src/errors.ts`). INFERIDO. */
export const TBO_MIN_BACKOFF_MS = 500;
export const TBO_MAX_BACKOFF_MS = 4_000;

/**
 * En Search y PreBook, un reintento con menos de esto por delante no llega a ninguna parte y sólo
 * gasta QPS de la cuenta (INFERIDO).
 */
export const TBO_MIN_RETRY_WINDOW_MS = 2_000;

export function tboBackoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(TBO_MIN_BACKOFF_MS * 2 ** exponent, TBO_MAX_BACKOFF_MS);
  return Math.round(base + random() * (TBO_MIN_BACKOFF_MS / 2));
}

/**
 * Digest truncado de dueño + usuario (01 §11.1; 08 §9 C-16): la clave del limitador y del circuito
 * de cuenta. No expone ids de tenant ni el usuario, que es "la mitad de la credencial", y al rotar
 * la credencial cambia, así que una cuenta nueva no hereda el castigo de la vieja. Partes separadas
 * por NUL, como el `fingerprint` de Sabre.
 */
export function tboAccountRef(ownerTenantId: string | undefined, username: string): string {
  return createHash('sha256')
    .update(ownerTenantId ?? '')
    .update('\u0000')
    .update(username)
    .digest('hex')
    .slice(0, 16);
}

const PROVIDER = TBO_HOTELS_PROVIDER_CODE;

/** Profundidad máxima de un body de salida. Ninguno de TBO pasa de 6; más es un objeto roto. */
const MAX_BODY_DEPTH = 64;
const MAX_ISSUES = 20;

/**
 * En Book y Cancel, estos desenlaces no dicen si TBO aplicó el write: la saga los deja
 * `UNVERIFIED` y el log sube a `error` (01 §8.4, última fila; §11.1).
 */
const UNCERTAIN_ON_MONEY_PATH: ReadonlySet<TboFailureKind> = new Set<TboFailureKind>([
  'TRANSPORT',
  'UPSTREAM',
  'THROTTLED',
  'MALFORMED_RESPONSE',
  'UNKNOWN_CODE',
  'BOOKING_FAILED',
]);

const ALWAYS_ERROR_LEVEL: ReadonlySet<TboFailureKind> = new Set<TboFailureKind>([
  'UNKNOWN_CODE',
  'MALFORMED_RESPONSE',
]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Señal interna de "la lectura del cuerpo se cortó". Nunca sale del cliente. */
class BodyReadInterrupted extends Error {
  constructor() {
    super('lectura del cuerpo interrumpida');
    this.name = 'BodyReadInterrupted';
  }
}

/**
 * Lee el cuerpo bajo la MISMA señal que el `fetch`. Se corre una carrera explícita contra la señal
 * en vez de confiar en que el stream la respete: un `fetch` inyectado —el arnés, un proxy de
 * pruebas— puede devolver un stream que no la conoce, y la garantía de 01 §5.5 no puede depender
 * de quién implementa `fetch`.
 */
async function readBodyWithin(
  res: Response,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number }> {
  const stream = res.body;
  if (stream === null) return { text: '', bytes: 0 };
  const reader = stream.getReader();
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new BodyReadInterrupted());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  // Si la lectura termina antes de la señal, este rechazo no lo espera nadie.
  void interrupted.catch(() => undefined);

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      const value: unknown = chunk.value;
      // Un `fetch` real entrega bytes; cualquier otra cosa es un stream roto, no un cuerpo.
      if (!(value instanceof Uint8Array)) throw new BodyReadInterrupted();
      chunks.push(value);
      bytes += value.byteLength;
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
  // `TextDecoder` quita el BOM, que `JSON.parse` no acepta.
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), bytes };
}

function zodIssueRefs(error: ZodError): readonly string[] {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}:${issue.code}`);
}

interface D1Findings {
  readonly card: string[];
  readonly paymentMode: string[];
  tooDeep: boolean;
}

/**
 * El barrido D1 de 01 §10.5, a cualquier profundidad: una clave de tarjeta (normalizada, empieza por
 * `card`, contiene `cvv` o es `paymentinfo`) o un `PaymentMode` distinto de `Limit`. Los issues son
 * rutas de claves, nunca valores.
 */
function sweepD1(
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  out: D1Findings,
): void {
  if (depth > MAX_BODY_DEPTH) {
    out.tooDeep = true;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => sweepD1(item, [...path, index], depth + 1, out));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (isTboCardKey(key)) {
      out.card.push(here.join('.'));
      continue;
    }
    if (normalizeTboKey(key) === 'paymentmode' && child !== 'Limit') {
      out.paymentMode.push(here.join('.'));
    }
    sweepD1(child, here, depth + 1, out);
  }
}

function assertD1(path: string, body: unknown): void {
  const findings: D1Findings = { card: [], paymentMode: [], tooDeep: false };
  sweepD1(body, [], 0, findings);
  if (findings.tooDeep) throw new TboRequestBuildError(path, 'SCHEMA', ['<root>:too_deep']);
  if (findings.card.length > 0) {
    throw new TboRequestBuildError(path, 'CARD_DATA', findings.card.slice(0, MAX_ISSUES));
  }
  if (findings.paymentMode.length > 0) {
    throw new TboRequestBuildError(path, 'PAYMENT_MODE', findings.paymentMode.slice(0, MAX_ISSUES));
  }
}

/**
 * Las filas de un solo intento por su NOMBRE. El path solo no alcanza: si alguien cambia `/Book` por
 * `/HotelBook` (la etiqueta del PDF, p. 32) y además apaga `money`, ni la columna ni el path lo
 * detectarían. Nombre, path y columna son tres defensas independientes (money-paths.guard.test.ts).
 */
const MONEY_OPERATIONS: ReadonlySet<string> = new Set<TboOperationName>(['book', 'cancel']);

interface CallPlan {
  readonly name: TboOperationName;
  readonly spec: TboOperationSpec;
  /**
   * Las columnas de la fila que usa el clasificador. En Book y Cancel, sin la excepción de "No
   * Hotels Found" aunque la fila la pida: un 500 ahí es incierto y se concilia, nunca un vacío.
   */
  readonly verdictRules: TboEnvelopeInput['operation'];
  readonly money: boolean;
  readonly isCancel: boolean;
  readonly lane: TboLane;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly signal: AbortSignal | undefined;
  readonly requestId: string;
  readonly startedAt: number;
  /** Sólo en las operaciones con plazo compartido (Search, PreBook). */
  readonly deadline: number | undefined;
}

/** Lo que se sabe de un intento para el log: sólo campos de la lista blanca. */
type AttemptObservation = Readonly<Record<string, unknown>>;

type AttemptOutcome =
  | {
      readonly ok: true;
      readonly outcome: TboEnvelopeOutcome;
      readonly data: unknown;
      readonly status: number;
      readonly tboCode: number | undefined;
    }
  | { readonly ok: false; readonly error: TboApiError; readonly observed: AttemptObservation };

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Credentials {
  readonly usable: TboUsableConfig;
  readonly authorization: string;
}

export class TboHttpClient {
  // Todo en campos `#`: no aparecen en `JSON.stringify` ni en `util.inspect` del cliente, que es lo
  // que termina en un log cuando alguien vuelca un adapter (08 RF-01 CA-5).
  readonly #config: TboHotelsConfig;
  readonly #credentials: Credentials | undefined;
  readonly #accountRef: string;
  readonly #credentialSource: TboCredentialSource | undefined;
  readonly #fetch: TboFetch;
  readonly #logger: LoggerPort | undefined;
  readonly #metrics: MetricsPort | undefined;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #uuid: () => string;
  readonly #limiter: TboRateLimiter;
  readonly #vault: TboPayloadVault | undefined;
  readonly #timeoutSignal: (ms: number) => AbortSignal;

  constructor(config: TboHotelsConfig, deps: TboHttpDeps = {}, context: TboAccountContext = {}) {
    this.#config = config;
    this.#credentials = usableCredentials(config);
    this.#accountRef = tboAccountRef(context.ownerTenantId, config.username?.reveal() ?? '');
    this.#credentialSource = context.credentialSource;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#logger = deps.logger;
    this.#metrics = deps.metrics;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#uuid = deps.uuid ?? randomUUID;
    this.#limiter = deps.limiter ?? new TboInMemoryRateLimiter();
    this.#vault = deps.payloadVault;
    this.#timeoutSignal = deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
  }

  /** Clave de la cuenta para el limitador y el circuito de cuenta (`tbo-hotels@{accountRef}`). */
  get accountRef(): string {
    return this.#accountRef;
  }

  get environment(): TboEnvironment {
    return this.#config.environment;
  }

  /**
   * Una llamada a una operación de `TBO_OPERATIONS`, con el algoritmo de 01 §10.3: puertas
   * locales, cupo, `fetch`, lectura del cuerpo bajo la misma señal, clasificación por
   * `Status.Code` y reintento sólo donde la tabla lo permite y el path no es de dinero.
   *
   * `data` sólo sale tipada si pasó por `responseSchema`; sin esquema es `unknown`. Dos firmas para
   * que `send<Algo>(…)` sin esquema no compile: sería un cast sin validar en el borde (CLAUDE.md).
   */
  send<T>(
    operation: TboOperationName,
    body: unknown,
    options: TboSendOptions<T> & {
      readonly responseSchema: ZodType<T, ZodTypeDef, unknown>;
    },
  ): Promise<TboHttpResult<T>>;
  send(
    operation: TboOperationName,
    body: unknown,
    options?: TboSendOptions<unknown>,
  ): Promise<TboHttpResult<unknown>>;
  async send(
    operation: TboOperationName,
    body: unknown,
    options: TboSendOptions<unknown> = {},
  ): Promise<TboHttpResult<unknown>> {
    const plan = this.#plan(operation, options);

    let credentials: Credentials;
    let requestText: string | undefined;
    try {
      // Las puertas locales: nada de esto llega a TBO ni es un fallo del proveedor.
      credentials = this.#credentials ?? this.#rejectUnusable();
      requestText = serializeBody(plan.spec, body, options.requestSchema);
    } catch (err) {
      if (err instanceof TboError) {
        this.#log('warn', 'tbo.http.request_rejected', {
          ...this.#baseMeta(plan),
          ...err.toLogMeta(),
        });
      }
      throw err;
    }

    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#attempt(plan, attempt, credentials, requestText);
      if (outcome.ok) return this.#resolve(plan, attempt, outcome, options.responseSchema);

      const { error } = outcome;
      if (error.kind === 'THROTTLED') this.#limiter.reportThrottled(this.#accountRef);
      const delay = tboBackoffDelayMs(attempt, this.#random);
      const retry = this.#shouldRetry(plan, attempt, error, delay);
      this.#log(this.#failureLevel(plan, error), 'tbo.http.error', {
        ...this.#baseMeta(plan),
        ...outcome.observed,
        attempt,
        ...error.toLogMeta(),
        ...(retry ? { retryInMs: delay } : {}),
      });
      if (!retry) throw this.#finalError(plan, error);
      await this.#sleep(delay);
    }
  }

  #plan(operation: TboOperationName, options: TboSendOptions<unknown>): CallPlan {
    // `hasOwn`: sin él, `toString` o `__proto__` encuentran algo en Object.prototype y el cliente
    // revienta con un TypeError en vez de un error tipado.
    const spec: TboOperationSpec | undefined = Object.hasOwn(TBO_OPERATIONS, operation)
      ? TBO_OPERATIONS[operation]
      : undefined;
    if (spec === undefined) {
      throw new TboRequestBuildError(String(operation), 'SCHEMA', ['operation:unknown']);
    }
    // La guarda de 01 §10.2: el path y el nombre mandan aunque la columna `money` diga otra cosa.
    const money = spec.money || isTboMoneyPath(spec.path) || MONEY_OPERATIONS.has(operation);
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
        ? Math.min(spec.maxTimeoutMs, Math.max(1, Math.floor(options.timeoutMs)))
        : spec.timeoutMs;
    const tableAttempts = money ? 1 : Math.max(1, Math.floor(spec.maxAttempts));
    const maxAttempts =
      options.maxAttempts !== undefined && Number.isFinite(options.maxAttempts)
        ? Math.min(tableAttempts, Math.max(1, Math.floor(options.maxAttempts)))
        : tableAttempts;
    const lane: TboLane = money
      ? 'money'
      : options.lane !== undefined && spec.lanes.includes(options.lane)
        ? options.lane
        : spec.lanes[0];
    const startedAt = this.#now();
    return {
      name: operation,
      spec,
      verdictRules: {
        envelope: spec.envelope,
        emptyOnNoAvailability: spec.emptyOnNoAvailability,
        emptyOnNoHotelsFound: !money && spec.emptyOnNoHotelsFound,
      },
      money,
      isCancel: operation === 'cancel',
      lane,
      timeoutMs,
      maxAttempts,
      signal: money ? undefined : options.signal,
      requestId: this.#uuid(),
      startedAt,
      deadline: spec.sharedDeadline ? startedAt + timeoutMs : undefined,
    };
  }

  /** Vuelve a pasar por la puerta para lanzar el error tipado de ESTA llamada, con su stack. */
  #rejectUnusable(): never {
    requireUsableTboConfig(this.#config);
    // Inalcanzable: con una config usable el constructor ya guardó las credenciales. Si alguna vez
    // se llega, se falla cerrado con el mismo tipo que la puerta.
    throw new TboCredentialsMissingError(missingTboCredentials(this.#config));
  }

  async #attempt(
    plan: CallPlan,
    attempt: number,
    credentials: Credentials,
    requestText: string | undefined,
  ): Promise<AttemptOutcome> {
    const queuedAt = this.#now();
    const grant = await this.#limiter.acquire({
      accountRef: this.#accountRef,
      lane: plan.lane,
      // En Search y PreBook la espera del cupo consume el mismo plazo que la llamada: un lote que
      // no sale a tiempo se degrada con motivo en vez de encolarse más allá (01 §7.2 punto 5).
      maxWaitMs:
        plan.deadline === undefined ? plan.timeoutMs : Math.max(0, plan.deadline - queuedAt),
      ...(plan.signal === undefined ? {} : { signal: plan.signal }),
    });
    if (!grant.granted) {
      const rejection = new TboDispatchRejectedError(
        plan.spec.path,
        grant.reason,
        this.#now() - queuedAt,
      );
      this.#count('tbo.limiter.rejected', { op: plan.name, lane: plan.lane, reason: grant.reason });
      this.#log('warn', 'tbo.http.not_dispatched', {
        ...this.#baseMeta(plan),
        attempt,
        ...rejection.toLogMeta(),
      });
      throw rejection;
    }
    try {
      const timeoutMs =
        plan.deadline === undefined
          ? plan.timeoutMs
          : Math.max(1, Math.min(plan.timeoutMs, plan.deadline - this.#now()));
      return await this.#exchange(plan, attempt, credentials, requestText, timeoutMs);
    } finally {
      grant.permit.release();
    }
  }

  async #exchange(
    plan: CallPlan,
    attempt: number,
    credentials: Credentials,
    requestText: string | undefined,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    const { spec } = plan;
    const timeoutSignal = this.#timeoutSignal(timeoutMs);
    const signal =
      plan.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, plan.signal]);
    const headers: Record<string, string> = {
      Authorization: credentials.authorization,
      Accept: 'application/json',
    };
    if (requestText !== undefined) headers['Content-Type'] = 'application/json';
    const sentAt = this.#now();

    let res: Response | undefined;
    let text: string | undefined;
    let bytes = 0;
    try {
      res = await this.#fetch(`${credentials.usable.baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        ...(requestText === undefined ? {} : { body: requestText }),
        signal,
        redirect: 'manual',
      });
      ({ text, bytes } = await readBodyWithin(res, signal));
    } catch {
      // Sin respuesta completa: red, DNS, conexión rechazada, timeout o un cuerpo cortado. Se
      // informa `status: 0` aunque hayan llegado cabeceras, porque la respuesta no llegó.
      text = undefined;
    }

    const durationMs = this.#now() - sentAt;
    const verdict =
      res === undefined || text === undefined
        ? undefined
        : classifyTboResponse({
            httpStatus: res.status,
            bodyText: text,
            operation: plan.verdictRules,
          });
    const status = verdict === undefined || res === undefined ? 0 : res.status;
    const outcome: TboEnvelopeOutcome | TboFailureKind =
      verdict === undefined ? 'TRANSPORT' : verdict.ok ? verdict.outcome : verdict.kind;
    const tboCode = verdict?.tboCode;

    const observed: AttemptObservation = {
      status,
      durationMs,
      ...(tboCode === undefined ? {} : { tboCode }),
      ...(res === undefined || verdict === undefined
        ? {}
        : {
            contentType: (res.headers.get('content-type') ?? '').slice(0, 100),
            bodyBytes: bytes,
            casingVariant: verdict.casingVariant,
          }),
      ...(spec.logDescription && verdict?.description !== undefined
        ? { description: verdict.description }
        : {}),
    };
    this.#count('tbo.http.requests', {
      op: plan.name,
      kind: outcome,
      tbo_code: tboCode === undefined ? 'none' : String(tboCode),
    });
    this.#safely(() =>
      this.#metrics?.histogram('tbo.http.duration', durationMs, { op: plan.name }),
    );
    if (verdict?.casingVariant === true) {
      this.#count('tbo.envelope.casing_variant', { op: plan.name });
    }
    this.#store({
      requestId: plan.requestId,
      operation: plan.name,
      path: spec.path,
      method: spec.method,
      attempt,
      accountRef: this.#accountRef,
      environment: this.#config.environment,
      sentAt: new Date(sentAt).toISOString(),
      durationMs,
      requestBody: requestText,
      responseStatus: status,
      responseBody: text,
      tboCode,
      outcome,
    });

    if (verdict?.ok === true) {
      this.#log('debug', 'tbo.http.ok', {
        ...this.#baseMeta(plan),
        ...observed,
        attempt,
        outcome,
      });
      return { ok: true, outcome: verdict.outcome, data: verdict.data, status, tboCode };
    }
    const error = new TboApiError({
      status,
      ...(tboCode === undefined ? {} : { tboCode }),
      path: spec.path,
      kind: verdict === undefined ? 'TRANSPORT' : verdict.kind,
      requestId: plan.requestId,
      timedOut: verdict === undefined && signal.aborted,
    });
    return { ok: false, error, observed };
  }

  #resolve(
    plan: CallPlan,
    attempts: number,
    outcome: Extract<AttemptOutcome, { ok: true }>,
    schema: ZodType<unknown, ZodTypeDef, unknown> | undefined,
  ): TboHttpResult<unknown> {
    const base = {
      status: outcome.status,
      tboCode: outcome.tboCode,
      requestId: plan.requestId,
      durationMs: this.#now() - plan.startedAt,
      attempts,
    };
    if (outcome.outcome === 'NO_AVAILABILITY') return { ...base, outcome: 'NO_AVAILABILITY' };
    if (schema === undefined) return { ...base, outcome: 'SUCCESS', data: outcome.data };

    const parsed = schema.safeParse(outcome.data);
    if (parsed.success) return { ...base, outcome: 'SUCCESS', data: parsed.data };
    const issues = zodIssueRefs(parsed.error);
    const error = plan.isCancel
      ? new TboCancelMappingError(plan.spec.path, issues, plan.requestId)
      : new TboResponseMappingError(plan.spec.path, issues, plan.requestId);
    this.#count('tbo.http.response_unreadable', { op: plan.name });
    this.#log('error', 'tbo.http.response_unreadable', {
      ...this.#baseMeta(plan),
      attempt: attempts,
      ...error.toLogMeta(),
    });
    throw error;
  }

  /**
   * 01 §10.4. `failure.retry` es la NATURALEZA del fallo; el permiso de repetir lo dan la tabla y
   * el path. En Search y PreBook, nunca tras un timeout y sólo si queda plazo de verdad.
   */
  #shouldRetry(plan: CallPlan, attempt: number, error: TboApiError, delay: number): boolean {
    if (plan.money || attempt >= plan.maxAttempts) return false;
    if (error.failure.retry !== 'RETRY_BACKOFF') return false;
    if (plan.signal?.aborted === true) return false;
    if (plan.deadline !== undefined) {
      if (error.timedOut) return false;
      if (plan.deadline - this.#now() - delay < TBO_MIN_RETRY_WINDOW_MS) return false;
    }
    return true;
  }

  /** `error` para lo que no entendemos y para todo lo incierto en Book o Cancel (01 §11.1). */
  #failureLevel(plan: CallPlan, error: TboApiError): LogLevel {
    if (ALWAYS_ERROR_LEVEL.has(error.kind)) return 'error';
    return plan.money && UNCERTAIN_ON_MONEY_PATH.has(error.kind) ? 'error' : 'warn';
  }

  /**
   * Un `Status.Code` que no reconocemos no prueba que una cancelación no se aplicó. Como
   * `TboApiError` con `NO_RETRY`, la política de cancelaciones lo cerraría como FAILED sin releer
   * la reserva (01 §9.3, penúltima fila); con el nombre `…CancelMappingError` queda `UNVERIFIED`.
   */
  #finalError(plan: CallPlan, error: TboApiError): TboError {
    if (plan.isCancel && error.kind === 'UNKNOWN_CODE') {
      return new TboCancelMappingError(
        plan.spec.path,
        ['Status.Code:unknown_code'],
        plan.requestId,
      );
    }
    return error;
  }

  #baseMeta(plan: CallPlan): Record<string, unknown> {
    return {
      provider: PROVIDER,
      op: plan.name,
      path: plan.spec.path,
      method: plan.spec.method,
      lane: plan.lane,
      maxAttempts: plan.maxAttempts,
      timeoutMs: plan.timeoutMs,
      requestId: plan.requestId,
      accountRef: this.#accountRef,
      environment: this.#config.environment,
      ...(this.#credentialSource === undefined ? {} : { credentialSource: this.#credentialSource }),
    };
  }

  #store(entry: TboPayloadRecord): void {
    const vault = this.#vault;
    if (vault === undefined) return;
    // Sin `await`: la bóveda no suma latencia a un Book ni puede cambiar su desenlace.
    void Promise.resolve()
      .then(() => vault.record(entry))
      .catch(() =>
        this.#log('warn', 'tbo.payload_vault.failed', {
          provider: PROVIDER,
          op: entry.operation,
          requestId: entry.requestId,
          attempt: entry.attempt,
        }),
      );
  }

  #count(name: string, tags: Record<string, string>): void {
    this.#safely(() => this.#metrics?.counter(name, 1, tags));
  }

  #log(level: LogLevel, message: string, meta: Record<string, unknown>): void {
    const logger = this.#logger;
    if (logger === undefined) return;
    this.#safely(() => logger[level](message, pickTboLogMeta(meta)));
  }

  /** La observabilidad nunca cambia el desenlace: un logger que lanza tras un Book no pierde la reserva. */
  #safely(run: () => void): void {
    try {
      run();
    } catch {
      // Se descarta a propósito: no hay a dónde reportar un fallo del propio canal de reporte.
    }
  }
}

function usableCredentials(config: TboHotelsConfig): Credentials | undefined {
  try {
    const usable = requireUsableTboConfig(config);
    // RFC 7617. Se calcula UNA vez: es base64 reversible, equivale a la contraseña en claro.
    const token = Buffer.from(
      `${usable.username.reveal()}:${usable.password.reveal()}`,
      'utf8',
    ).toString('base64');
    return { usable, authorization: `Basic ${token}` };
  } catch (err) {
    if (err instanceof TboError) return undefined;
    throw err;
  }
}

function buildError(
  spec: TboOperationSpec,
  reason: TboRequestBuildReason,
  issues: readonly string[],
): TboRequestBuildError {
  return new TboRequestBuildError(spec.path, reason, issues);
}

/**
 * El tipo de `JSON.stringify` dice `string`, pero un `toJSON` que devuelve `undefined` da
 * `undefined`: sin esta firma saldría un POST sin cuerpo y sin Content-Type.
 */
function stringifyOrUndefined(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/**
 * El body de salida: GET sin cuerpo, POST con cuerpo; guarda D1 sobre lo que pidió el llamador y
 * sobre lo que de verdad viaja; y sólo `JSON.stringify` de un objeto, nunca texto armado a mano
 * (el Postman de BookingDetail trae un comentario `//` dentro del JSON, 01 §4).
 */
function serializeBody(
  spec: TboOperationSpec,
  body: unknown,
  schema: ZodType<unknown, ZodTypeDef, unknown> | undefined,
): string | undefined {
  if (spec.method === 'GET') {
    if (body !== undefined) throw buildError(spec, 'SCHEMA', ['<root>:unexpected_body']);
    return undefined;
  }
  if (body === undefined) throw buildError(spec, 'SCHEMA', ['<root>:missing_body']);

  // Primero sobre la entrada, para que una tarjeta se informe como CARD_DATA y no como el fallo de
  // esquema que un `.strict()` daría antes.
  assertD1(spec.path, body);
  let outgoing: unknown = body;
  if (schema !== undefined) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw buildError(spec, 'SCHEMA', zodIssueRefs(parsed.error));
    outgoing = parsed.data;
  }
  if (typeof outgoing !== 'object' || outgoing === null) {
    throw buildError(spec, 'SCHEMA', ['<root>:not_an_object']);
  }
  let text: string | undefined;
  let wire: unknown;
  try {
    text = stringifyOrUndefined(outgoing);
    wire = text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw buildError(spec, 'SCHEMA', ['<root>:not_serializable']);
  }
  if (text === undefined) throw buildError(spec, 'SCHEMA', ['<root>:not_serializable']);
  if (typeof wire !== 'object' || wire === null) {
    throw buildError(spec, 'SCHEMA', ['<root>:not_an_object']);
  }
  // D1 sobre los bytes del cable y no sobre el objeto: `JSON.stringify` llama a `toJSON`, y un
  // esquema que transforma también puede producir claves que el llamador no escribió.
  assertD1(spec.path, wire);
  return text;
}
