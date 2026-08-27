import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@sales-travel/core';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import {
  hasUsableSabreCredentials,
  missingSabreCredentials,
  sabreConversationIdPrefix,
  sabreRequestTimeoutMs,
  sabreUrl,
  type SabreConfig,
} from '../config';
import {
  SABRE_MAX_ATTEMPTS,
  SabreApiError,
  SabreConfigError,
  classifySabreEnvelope,
  classifySabreFailure,
  sabreBackoffDelayMs,
  sabreEnvelopeRecord,
  sabreEnvelopeString,
  sabreOperationToken,
  type SabreFailureClass,
  type SabreIssue,
} from '../errors';
import { logRedacted, type SabreLogLevel } from '../redaction';

/**
 * Operaciones que mueven dinero o crean estado en el GDS. **Cero reintentos, siempre**, aunque
 * quien llame jure que son idempotentes: un `ERR.2SG.GATEWAY.TIMEOUT` no dice si la operación se
 * ejecutó, y reintentar una emisión la duplica (RF-01 CA-5, docs/sabre/09 §2.2 aviso 2).
 *
 * Los paths salen del contrato: `booking-management-v1.yml:15` declara `basePath /v1/trip/orders`
 * y las operaciones en `:64, :89, :190, :140, :214, :39`.
 */
export const SABRE_NON_IDEMPOTENT_PATHS: readonly string[] = [
  '/v1/trip/orders/createBooking',
  '/v1/trip/orders/fulfillFlightTickets',
  '/v1/trip/orders/voidFlightTickets',
  '/v1/trip/orders/refundFlightTickets',
  '/v1/trip/orders/modifyBooking',
  '/v1/trip/orders/cancelBooking',
];

/**
 * La normalización la hace `sabreOperationToken` de `../errors`, que es la canónica, y **aquí ya no
 * hay copia**.
 *
 * Había una, y ya HABÍA DIVERGIDO: partía sólo por `?`, así que
 * `/v1/trip/orders/createBooking#tramo` no se reconocía como operación de dinero. Con
 * `options.idempotent: true` —lo que pide una búsqueda, y lo que puede pedir cualquier llamador—
 * eso devolvía `moneyOperation === false` y `postJson` REINTENTABA una escritura. Reintentar una
 * reserva crea dos, y un `ERR.2SG.GATEWAY.TIMEOUT` no dice si la primera se ejecutó.
 *
 * Se compara con `endsWith` sobre el token en minúsculas, que es lo que ya hacía `declaresOperation`
 * en `errors.ts` para los dos ejes del contexto de operación: sólo puede casar en frontera de
 * segmento, porque las rutas de la lista empiezan por `/`.
 */
export function isNonIdempotentSabrePath(path: string): boolean {
  const token = sabreOperationToken(path);
  return SABRE_NON_IDEMPOTENT_PATHS.some((known) => token.endsWith(known.toLowerCase()));
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ AQUÍ NO HAY CLASIFICADOR DE SOBRES NI HELPERS PROPIOS PARA LEERLOS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `classifySabreEnvelope`, `SabreEnvelopeVerdict`, `sabreEnvelopeRecord` y `sabreEnvelopeString`
 * viven en `../errors` y **sólo** ahí. Este fichero los importa; jamás los reimplementa ni los
 * reexporta.
 *
 * No es preferencia de estilo, es la cicatriz de un incidente: durante una ronda entera hubo dos
 * copias de la regla dura —la endurecida en `errors.ts` y una copia vieja aquí, con tope de
 * profundidad 3 y sin bajar por arrays— y era ESTA la que corría en producción. Los 58 tests de
 * `errors.test.ts` ejercitaban la buena y estaban verdes mientras `postJson` aceptaba 16 de 16
 * sobres hostiles como reserva confirmada: el cliente no vuela y ya se le cobró.
 *
 * Los helpers escalares llegaron a la misma bifurcación por la puerta de atrás: hubo aquí un
 * `asRecord` (copia byte a byte) y un `str` que YA HABÍA DERIVADO —le faltaba el `Number.isFinite`
 * de `sabreEnvelopeString`—. Se dio por inobservable porque «JSON no transporta NaN», y es falso:
 * `JSON.parse('{"errorCode":1e999}')` devuelve `Infinity`, la copia lo convertía en el texto
 * `"Infinity"` y ese `errorCode` sintético ganaba el `??` de `transportError`, tapando el
 * `ERR.2SG.*` real y degradando un `RETRY_AFTER_REAUTH` al genérico del status.
 *
 * Copiar la regla —o el helper que la alimenta— al llamador para "no depender de errors.ts" es
 * exactamente cómo se llega ahí. Si la regla se queda corta, se endurece en `errors.ts` y todos
 * los carriles se benefician a la vez. `envelope-bypass.e2e.test.ts` vigila que siga habiendo un
 * solo clasificador en la fuente, `dist-artifact.guard.test.ts` que también lo haya en el
 * artefacto compilado, y `envelope-helpers.e2e.test.ts` que los escalares sean los canónicos.
 */

export interface SabreRequestOptions {
  /**
   * Marca explícita de idempotencia. Default `false`: quien quiera reintentos los pide. Aun con
   * `true`, un path de `SABRE_NON_IDEMPOTENT_PATHS` nunca reintenta.
   */
  idempotent?: boolean;
  conversationId?: string;
  timeoutMs?: number;
}

export interface SabreResult<T> {
  data: T;
  status: number;
  conversationId: string;
  durationMs: number;
  warnings: readonly SabreIssue[];
  /** Si no está vacío, la respuesta está capada: el fan-out debe marcar degradación. */
  partialUnauthorized: readonly SabreIssue[];
  /**
   * Problemas de severidad ERROR que el CONTRATO de la operación declara como parte del desenlace
   * —el `errors[]` que produce pedir `errorHandlingPolicy: [DO_NOT_HALT_ON_*]`—.
   *
   * Si no está vacío, **la operación no fue limpia**: hay una reserva o una cancelación a medias y
   * quien decide qué significa es el mapper de la operación, leyendo el cuerpo.
   *
   * Es una lista DISTINTA de `warnings` —severidad error frente a severidad aviso— y las dos pueden
   * venir llenas a la vez. Ver el bloque «EL DESENLACE PARCIAL» de `../errors`.
   */
  partialOutcome: readonly SabreIssue[];
}

export interface SabreHttpDeps {
  fetch?: SabreFetch;
  logger?: LoggerPort;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  now?: () => number;
  uuid?: () => string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cliente JSON de Sabre.
 *
 * Hace tres cosas que un `fetch` pelado no hace y sin las cuales el ACL es inseguro:
 *
 * 1. **Nunca entrega un `200` sin clasificar el sobre.** Los fallos de negocio de Sabre viajan
 *    dentro del `200` y `fetch` no lanza.
 * 2. **Nunca loguea el header `Authorization`, el body ni el texto del proveedor.** Sólo path,
 *    status, duración, `Conversation-ID` y `category`/`type`/`fieldPath` de los problemas.
 * 3. **Nunca reintenta una operación con dinero**, ni siquiera si quien llama se equivoca.
 */
export class SabreHttpClient {
  private readonly fetchImpl: SabreFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(
    private readonly cfg: SabreConfig,
    private readonly tokens: SabreTokenProvider,
    private readonly deps: SabreHttpDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.jitter = deps.jitter ?? Math.random;
    this.now = deps.now ?? (() => Date.now());
    this.uuid = deps.uuid ?? randomUUID;
  }

  async postJson<T = unknown>(
    path: string,
    body: unknown,
    options: SabreRequestOptions = {},
  ): Promise<SabreResult<T>> {
    // Última puerta antes del cable. Ya no hay modo al que desviarse: sin credenciales
    // usables esta llamada FALLA, que es lo único que no puede convertirse en una oferta.
    if (!hasUsableSabreCredentials(this.cfg)) {
      throw new SabreConfigError(
        `sin credenciales de Sabre no se puede llamar a ${path} (faltan: ${missingSabreCredentials(this.cfg).join(', ')})`,
      );
    }

    const conversationId =
      options.conversationId ?? `${sabreConversationIdPrefix(this.cfg)}-${this.uuid()}`;
    const moneyOperation = isNonIdempotentSabrePath(path);
    const retriesAllowed = options.idempotent === true && !moneyOperation;
    const maxAttempts = retriesAllowed ? SABRE_MAX_ATTEMPTS : 1;

    let reauthUsed = false;
    let attempt = 1;

    for (;;) {
      const outcome = await this.attempt<T>(path, body, conversationId, options);
      if ('result' in outcome) return outcome.result;

      const { error } = outcome;
      const policy = error.failure.retry;

      if (retriesAllowed && policy === 'RETRY_AFTER_REAUTH' && !reauthUsed) {
        // Un único reintento tras re-autenticar. Si el segundo 401 llega, el problema no era el
        // token y reintentar más sólo quema cupo del TAM Pool.
        reauthUsed = true;
        await this.tokens.invalidate();
        this.log('warn', 'sabre.http.reauth', { path, conversationId, ...error.toLogMeta() });
        continue;
      }

      if (retriesAllowed && policy === 'RETRY_BACKOFF' && attempt < maxAttempts) {
        await this.sleep(sabreBackoffDelayMs(attempt, this.jitter));
        attempt++;
        continue;
      }

      this.log('warn', 'sabre.http.error', {
        path,
        conversationId,
        moneyOperation,
        attempt,
        ...error.toLogMeta(),
      });
      throw error;
    }
  }

  private async attempt<T>(
    path: string,
    body: unknown,
    conversationId: string,
    options: SabreRequestOptions,
  ): Promise<{ result: SabreResult<T> } | { error: SabreApiError }> {
    const token = await this.tokens.getToken();
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? sabreRequestTimeoutMs(this.cfg);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = this.now();

    let res: Response;
    try {
      res = await this.fetchImpl(sabreUrl(this.cfg, path), {
        method: 'POST',
        headers: this.buildHeaders(token, conversationId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      return {
        error: new SabreApiError(0, isAbort ? 'timeout' : (err as Error).message, path, {
          conversationId,
        }),
      };
    } finally {
      clearTimeout(timer);
    }

    const durationMs = this.now() - started;
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      return { error: this.transportError(res.status, text, payload, path, conversationId) };
    }

    if (payload === null) {
      return {
        error: new SabreApiError(res.status, 'respuesta 2xx no parseable como JSON', path, {
          conversationId,
        }),
      };
    }

    // La ruta NO es decorativa: gobierna los dos ejes que dependen de la operacion — que
    // endpoints declaran el cuerpo vacio como exito (`/v1/ancillaries/remove`) y cuales
    // pueden conceder benignidad via `ApplicationResults` (solo las lecturas de inventario).
    // Sin ella el clasificador cae al modo estricto, que es fail-closed pero rechaza sobres
    // que el contrato declara validos. Omitirla dejo todo ese eje inalcanzable una vez.
    const verdict = classifySabreEnvelope(payload, { path });
    // `partialOutcome` NO es «pasa igual»: es «este rechazo es el desenlace parcial que el contrato
    // de ESTA operación declara, y el sobre trae algo que su mapper pueda decidir». El clasificador
    // sigue diciendo `ok: false` y `failures` sigue lleno; lo que cambia es quién decide el
    // desenlace. Morir aquí dejaba inalcanzable todo el éxito parcial —y, con localizador dentro,
    // tiraba el `confirmationId` de una reserva que EXISTE: un PNR huérfano que sólo encuentra una
    // persona. Cancelar un producto confirmado porque falló un accesorio es indefendible.
    if (!verdict.ok && !verdict.partialOutcome) {
      const first = verdict.failures[0];
      const failure: SabreFailureClass = classifySabreFailure({
        status: res.status,
        ...(first?.category === undefined ? {} : { category: first.category }),
        ...(first?.type === undefined ? {} : { type: first.type }),
      });
      // Se pasan las DOS listas del veredicto, no sólo `failures`, y no es cosmético.
      //
      // Medido sobre 12.000 sobres hostiles: en 750 (6,25 %) el rechazo llegaba con un único
      // issue sin estructura mientras el dato que EXPLICABA el fallo —`category`, `type`, `code`,
      // `fieldPath`— vivía en un issue de severidad `warning`. Pasando sólo `failures`, soporte
      // recibe «hubo algo bajo una clave de error y no sé qué era» teniendo el paquete el dato en
      // la mano. No es un fallo de seguridad: es un error real casi indiagnosticable.
      //
      // Se distinguen en el log porque `SabreIssue.severity` viaja entero en `toLogMeta()`, así
      // que un `warning` no puede leerse como causa del rechazo.
      //
      // `verdict.partialUnauthorized` NO se concatena aparte: por construcción es un FILTRO de
      // `failures ∪ warnings` (`classifySabreEnvelope`, último bloque), así que ya está aquí —con
      // su marca de entitlement dentro de `category`/`type`, que es lo que lo identifica—.
      // Añadirlo otra vez sólo duplicaría entradas. Ambas afirmaciones están fijadas por test.
      //
      // La CLASIFICACIÓN sigue mirando sólo `failures[0]`: un warning no puede decidir la política
      // de reintento de un rechazo.
      return {
        error: new SabreApiError(res.status, text, path, {
          failure,
          issues: [...verdict.failures, ...verdict.warnings],
          conversationId,
        }),
      };
    }

    if (verdict.partialUnauthorized.length > 0) {
      // Datos capados por entitlement: el 200 es real pero incompleto. Callarlo convierte una
      // falta de suscripción en "no hay vuelos" en la pantalla del vendedor.
      this.log('warn', 'sabre.http.entitlement_parcial', {
        path,
        conversationId,
        issues: verdict.partialUnauthorized,
      });
    }

    // `nodesVisited` es la única forma de recalibrar `SABRE_ENVELOPE_NODE_BUDGET` con tráfico real:
    // el presupuesto se fijó midiendo fixtures, y si un sobre de producción lo rozara, el veredicto
    // dejaría de ser exhaustivo y la llamada fallaría cerrada. Es un entero, no lleva PII.
    //
    // Un desenlace parcial NO se loguea como `ok`, y no es cosmética: se entrega el cuerpo, pero la
    // operación no fue limpia y quien lea el log tiene que verlo en el nivel `warn`. Lo que viaja
    // son los `SabreIssue` del veredicto, que ya han pasado la puerta de vocabulario — nunca el
    // cuerpo ni el texto libre del proveedor.
    if (verdict.partialOutcome) {
      this.log('warn', 'sabre.http.desenlace_parcial', {
        path,
        conversationId,
        status: res.status,
        durationMs,
        envelopeNodes: verdict.nodesVisited,
        issues: verdict.failures,
      });
    } else {
      this.log('debug', 'sabre.http.ok', {
        path,
        conversationId,
        status: res.status,
        durationMs,
        envelopeNodes: verdict.nodesVisited,
      });
    }

    return {
      result: {
        data: payload as T,
        status: res.status,
        conversationId,
        durationMs,
        warnings: verdict.warnings,
        partialUnauthorized: verdict.partialUnauthorized,
        // Vacío salvo en un desenlace parcial: `failures` sólo puede estar lleno con `ok: false`,
        // y con `ok: false` sólo se llega hasta aquí por el carril del desenlace parcial.
        partialOutcome: verdict.partialOutcome ? verdict.failures : [],
      },
    };
  }

  /**
   * `X-Sabre-Group` y `X-Sabre-Current-City` son el CARRIL DE GRUPO del modelo consolidador.
   *
   * `targetPcc` cambia el contexto del PCC dentro del body y **el API no lo revierte**
   * (`booking-management-v1.yml:708`); el grupo bajo el que se actúa viaja en cabecera, y así lo
   * mandan 28 de los 176 requests de la colección oficial (docs/sabre/04 §1). Hasta esta ronda el
   * cliente no las emitía: un `targetPcc` salía al cable sin grupo, o sea actuando sobre el PCC
   * propio, y `assertTargetPccIsAddressable` sólo podía comprobar que la config lo tuviera —no que
   * llegara—.
   *
   * Se emiten SIEMPRE que la config las declare, no sólo cuando hay `targetPcc`: la cabecera dice
   * bajo qué grupo trabaja esta cuenta, y una cuenta que declara grupo lo declara para todas sus
   * llamadas. El contrato **no documenta** estas cabeceras en el YAML —la evidencia es la
   * colección—, así que una cuenta que no las declare sigue saliendo sin ellas, exactamente como
   * antes.
   */
  private buildHeaders(token: string, conversationId: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Conversation-ID': conversationId,
    };
    if (this.cfg.applicationId) headers['Application-ID'] = this.cfg.applicationId;
    if (this.cfg.sabreGroup) headers['X-Sabre-Group'] = this.cfg.sabreGroup;
    if (this.cfg.sabreCurrentCity) headers['X-Sabre-Current-City'] = this.cfg.sabreCurrentCity;
    return headers;
  }

  /** Capa de transporte: `{status, type, errorCode, timeStamp, message}` (docs/sabre/09 §2.1). */
  private transportError(
    status: number,
    text: string,
    payload: unknown,
    path: string,
    conversationId: string,
  ): SabreApiError {
    // `sabreEnvelopeRecord`/`sabreEnvelopeString` son los canónicos de `../errors`, no copias: un
    // escalar no finito (`1e999` desborda a `Infinity` al parsear) NO es contenido, y dejarlo pasar
    // como el texto `"Infinity"` fabricaría un `errorCode` que gana este `??` y sepulta el
    // `ERR.2SG.*` de verdad.
    const record = sabreEnvelopeRecord(payload);
    const code = record
      ? (sabreEnvelopeString(record['errorCode']) ?? sabreEnvelopeString(record['error']))
      : undefined;
    const message = record
      ? (sabreEnvelopeString(record['message']) ??
        sabreEnvelopeString(record['error_description']) ??
        text)
      : text;
    // Se clasifica con el texto CRUDO: la tabla 2SG compara literales (`ERR.2SG.*`,
    // «Wrong clientID») y sobre texto redactado no acertaría.
    //
    // Y el `code` se pasa CRUDO al constructor, que es quien redacta. Aquí había un `redactText`
    // propio: la misma política escrita en dos sitios —el constructor de `SabreApiError` ya hace
    // exactamente `redactText(options.code)`— así que el campo se redactaba dos veces y el sitio
    // canónico recibía un valor ya masticado. `token.service.ts` documenta la regla buena y la
    // cumple: «quien redacta es el constructor, el sitio de llamada no tiene que acordarse». Este
    // carril era el único que se acordaba, y acordarse de más es cómo dos copias empiezan a
    // divergir.
    const failure = classifySabreFailure({ status, ...(code ? { code } : {}), text: message });
    return new SabreApiError(status, text, path, {
      failure,
      conversationId,
      ...(code === undefined ? {} : { code }),
    });
  }

  /**
   * Reenvío al único sitio que redacta. Aquí vivía una tercera copia byte a byte de la misma
   * línea; la política —etiqueta de proveedor y pasada por `redactMeta`— está en `redaction.ts`.
   */
  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}
