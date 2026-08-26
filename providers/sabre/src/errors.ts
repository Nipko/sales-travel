import { redactPath, redactText, safeBodySummary } from './redaction';

/**
 * Modelo de error de Sabre y su clasificación.
 *
 * Sabre tiene **dos capas** de error (VERIFICADO-SPEC, docs/sabre/09 §2.1):
 *
 * - **Transporte** — status HTTP + objeto `{status, type, errorCode, timeStamp, message}`.
 * - **Aplicación** — **HTTP 200** con `{timestamp, errors[]}`. 14 de los 21 contratos declaran
 *   únicamente `200`. Un adapter que mire `res.ok` da por confirmadas reservas que fallaron.
 *
 * La clasificación de abajo es la tabla oficial 2SG (`help/errors.txt`, idéntica en cuatro
 * productos) traducida a política, según docs/sabre/01 §5.2-§5.5 y docs/sabre/10 RNF-03.
 */

/** Qué se puede hacer con el fallo. El reintento sólo aplica a operaciones idempotentes. */
export type SabreRetryPolicy =
  /** Fallo terminal: reintentar no cambia el resultado. */
  | 'NO_RETRY'
  /** Reintentable con backoff (suelo 500 ms, el único número que Sabre publica). */
  | 'RETRY_BACKOFF'
  /** Invalidar el token cacheado, re-autenticar y reintentar **una** vez. */
  | 'RETRY_AFTER_REAUTH';

/** Efecto sobre el circuit breaker, que es por `provider_account` resuelta, no por `providerCode`. */
export type SabreCircuitEffect =
  /** No cuenta: es configuración del tenant, un bug nuestro o una respuesta sin datos. */
  | 'IGNORE'
  /** Suma al contador de fallos del proveedor. */
  | 'COUNT'
  /** Abre el circuito de inmediato. */
  | 'OPEN_NOW';

export type SabreFailureKind =
  /** Red caída, DNS, timeout local. `status === 0`. */
  | 'TRANSPORT'
  /** Bug nuestro: request mal construida, path inexistente, base64 mal armado. */
  | 'CLIENT_BUG'
  /** El token expiró o dejó de valer. Se re-autentica. */
  | 'AUTH_EXPIRED'
  /** `401 invalid_client`: credencial mala **o** TAM Pool agotado. Ambiguo por diseño. */
  | 'AUTH_POOL'
  /** Credencial confirmadamente inválida. Aquí sí se marca la cuenta BYOC. */
  | 'CREDENTIALS_INVALID'
  /** Producto no activado para ese PCC. No es caída: es alta comercial pendiente. */
  | 'ENTITLEMENT'
  /** "Response does not contain any data": una ruta sin vuelos, no una avería. */
  | 'NO_DATA'
  /** Cuota de concurrencia excedida. */
  | 'THROTTLED'
  /** Sabre o el proveedor detrás de Sabre están rotos. */
  | 'UPSTREAM'
  /** Fallo de negocio dentro de un 200. */
  | 'BUSINESS'
  /** Carril de sesión ATH (Sabre abre sesiones por su cuenta aunque usemos REST). */
  | 'SESSION'
  /** Warning que no se puede automatizar: va a cola humana. */
  | 'HUMAN_REVIEW';

export interface SabreFailureClass {
  readonly kind: SabreFailureKind;
  readonly retry: SabreRetryPolicy;
  readonly circuit: SabreCircuitEffect;
  /** Marcar la `provider_account` como inválida y avisar al tenant. Sólo con certeza. */
  readonly disableAccount: boolean;
  /** Alerta para nosotros (ingeniería u onboarding), no para el vendedor. */
  readonly operatorAlert: boolean;
  /** Por qué se clasificó así. Va al log estructurado, en español, sin datos del payload. */
  readonly reason: string;
}

/** Señales disponibles para clasificar. Todas opcionales salvo el status. */
export interface SabreFailureSignal {
  /** HTTP status. `0` = fallo de red o timeout local. */
  readonly status: number;
  /** `errorCode` del gateway (`ERR.2SG.*`) o literal OAuth2 (`invalid_client`). */
  readonly code?: string;
  /** Texto libre del gateway (`message` / `error_description`). */
  readonly text?: string;
  /** `errors[].category` de la capa de aplicación. */
  readonly category?: string;
  /** `errors[].type` de la capa de aplicación. */
  readonly type?: string;
  // Aquí vivía `description`, el texto libre de `errors[]`. Se borró con la rama que lo consumía
  // (ver `classifyApplication`, caso `UNAUTHORIZED`): ningún sitio de llamada podía rellenarlo
  // porque el texto libre del proveedor no cruza la frontera de `SabreIssue` (RNF-07). Un campo
  // que nadie puede rellenar es una invitación a escribir política que nunca se ejecuta.
}

/**
 * Un problema declarado por Sabre dentro del sobre.
 *
 * Deliberadamente **no** lleva `description`, `text` ni `fieldValue`: son texto libre que puede
 * arrastrar datos del pasajero, y esto se loguea (RNF-07). `category` + `type` + `fieldPath`
 * bastan para diagnosticar.
 */
export interface SabreIssue {
  readonly source: 'gateway' | 'application';
  readonly severity: 'error' | 'warning';
  readonly category?: string;
  readonly type?: string;
  readonly code?: string;
  readonly fieldPath?: string;
}

function cls(
  kind: SabreFailureKind,
  retry: SabreRetryPolicy,
  circuit: SabreCircuitEffect,
  reason: string,
  flags: { disableAccount?: boolean; operatorAlert?: boolean } = {},
): SabreFailureClass {
  return {
    kind,
    retry,
    circuit,
    disableAccount: flags.disableAccount ?? false,
    operatorAlert: flags.operatorAlert ?? false,
    reason,
  };
}

/**
 * Tabla del gateway 2SG. VERIFICADO-SPEC: `help/errors.txt` y las copias idénticas en Booking
 * Management, Offer Price NDC y Flight Reshop. La columna de política es nuestra
 * (docs/sabre/01 §5.2, docs/sabre/10 RNF-03).
 */
const GATEWAY_CODES: Readonly<Record<string, SabreFailureClass>> = {
  'ERR.2SG.CLIENT.INVALID_REQUEST': cls(
    'CLIENT_BUG',
    'NO_RETRY',
    'IGNORE',
    'request inválida: parámetros o tamaño. No cuenta para el breaker',
    { operatorAlert: true },
  ),
  'ERR.2SG.SCHEMA.INVALID': cls('CLIENT_BUG', 'NO_RETRY', 'IGNORE', 'body fuera de schema', {
    operatorAlert: true,
  }),
  'ERR.2SG.SEC.MISSING_CREDENTIALS': cls(
    'CLIENT_BUG',
    'NO_RETRY',
    'IGNORE',
    'faltan credenciales en el request: bug nuestro, no del tenant',
    { operatorAlert: true },
  ),
  // docs/sabre/01 §5.3 y RF-01 CA-4: invalidar caché de token, re-autenticar y reintentar UNA vez.
  'ERR.2SG.SEC.INVALID_CREDENTIALS': cls(
    'AUTH_EXPIRED',
    'RETRY_AFTER_REAUTH',
    'IGNORE',
    'token rechazado: invalidar caché y re-autenticar una vez',
  ),
  'ERR.2SG.SEC.NOT_AUTHORIZED': cls(
    'ENTITLEMENT',
    'NO_RETRY',
    'IGNORE',
    'producto no activado para el PCC: alta comercial, no caída. NO abre circuito',
    { operatorAlert: true },
  ),
  'ERR.2SG.CLIENT.SERVICE_UNKNOWN': cls(
    'CLIENT_BUG',
    'NO_RETRY',
    'IGNORE',
    'path o versión inexistente: bug nuestro, no entitlement',
    { operatorAlert: true },
  ),
  'ERR.2SG.GATEWAY.REQUEST_THROTTLED': cls(
    'THROTTLED',
    'RETRY_BACKOFF',
    'IGNORE',
    'cuota de concurrencia excedida: es cuota, no caída',
  ),
  'ERR.2SG.SEC.INTERNAL_PROCESSING_ERROR': cls(
    'UPSTREAM',
    'RETRY_BACKOFF',
    'COUNT',
    'error interno del gateway',
  ),
  'ERR.2SG.GATEWAY.INTERNAL_PROCESSING_ERROR': cls(
    'UPSTREAM',
    'RETRY_BACKOFF',
    'COUNT',
    'error interno del gateway',
  ),
  'ERR.2SG.GATEWAY.TIMEOUT': cls(
    'UPSTREAM',
    'RETRY_BACKOFF',
    'COUNT',
    'timeout del gateway: no dice si la operación se ejecutó — jamás reintentar una escritura',
  ),
  // docs/sabre/01 §5.2 y RNF-03: reintentar no arregla un formato roto del proveedor.
  'ERR.2SG.GATEWAY.INVALID_PROVIDER_RESPONSE': cls(
    'UPSTREAM',
    'NO_RETRY',
    'OPEN_NOW',
    'respuesta del proveedor con formato inválido: abrir circuito, reintentar no lo arregla',
    { operatorAlert: true },
  ),
  'ERR.2SG.GATEWAY.PROVIDER_CONNECTION_ERROR': cls(
    'UPSTREAM',
    'RETRY_BACKOFF',
    'COUNT',
    'error de transporte contra el proveedor',
  ),
  'ERR.2SG.PROVIDER_CONNECTION_ERROR': cls(
    'UPSTREAM',
    'RETRY_BACKOFF',
    'COUNT',
    'error de transporte contra el proveedor',
  ),
};

/**
 * Warnings que **no** se pueden automatizar: la reserva quedó a medias y alguien tiene que
 * mirarla (docs/sabre/10 RNF-03, docs/sabre/09 §3.1).
 */
export const SABRE_HUMAN_REVIEW_TYPES: ReadonlySet<string> = new Set([
  'PARTIAL_FULFILLMENT',
  'FULFILLMENT_NOT_CONFIRMED',
  'UNABLE_TO_RETRIEVE_TICKETS',
  'UNABLE_TO_RETRIEVE_BOOKING',
  'CLOSE_SESSION_WARNING',
]);

function classifyGatewayText(status: number, text: string): SabreFailureClass | null {
  if (/invalid_client/i.test(text)) {
    // Ambiguo POR DISEÑO: credencial mala o TAM Pool agotado (`help/errors.txt` 401/invalid_client).
    // Tratarlo como credencial revocada tumbaría a una agencia entera por saturación temporal.
    return cls(
      'AUTH_POOL',
      'RETRY_BACKOFF',
      'IGNORE',
      'invalid_client: puede ser TAM Pool agotado — nunca auto-deshabilitar la cuenta',
      { operatorAlert: true },
    );
  }
  if (/wrong client\s*id|wrong clientid/i.test(text)) {
    return cls(
      'CREDENTIALS_INVALID',
      'NO_RETRY',
      'IGNORE',
      'password del EPR incorrecto: marcar la cuenta y avisar al tenant',
      { disableAccount: true, operatorAlert: true },
    );
  }
  if (/credentials are missing|syntax is not correct/i.test(text)) {
    return cls(
      'CLIENT_BUG',
      'NO_RETRY',
      'IGNORE',
      'el Basic doble-base64 se construyó mal: bug nuestro, alerta de ingeniería',
      { operatorAlert: true },
    );
  }
  if (/not authorized to make this request/i.test(text)) {
    return cls(
      'ENTITLEMENT',
      'NO_RETRY',
      'IGNORE',
      'nivel de acceso insuficiente para el endpoint: no abre circuito',
      { operatorAlert: true },
    );
  }
  if (/temporarily_unavailable|too many requests|active token count is exceeded/i.test(text)) {
    return cls(
      'THROTTLED',
      'RETRY_BACKOFF',
      'IGNORE',
      'límite de concurrencia excedido: backoff y semáforo por cuenta',
    );
  }
  if (status === 404 && /does not contain any data/i.test(text)) {
    return cls('NO_DATA', 'NO_RETRY', 'IGNORE', 'sin resultados: no es una caída');
  }
  return null;
}

/**
 * Categoría del proveedor → literal comparable con el `switch` de {@link classifyApplication}.
 *
 * Tres normalizaciones, y cada una dice qué mide:
 *
 *   - **El sentinel de entitlement.** Cuando la categoría no pasa la puerta de publicación pero
 *     llevaba la marca `UNAUTHORIZED`/`RESOURCE_RESTRICTED`, lo que llega aquí es
 *     {@link SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED} — vocabulario NUESTRO, cero bytes del proveedor.
 *     Sin esta línea ese caso cae en `default` y sale como `BUSINESS` **sin aviso al operador**:
 *     el vendedor ve datos capados y nadie del equipo se entera de que hay una venta bloqueada
 *     por un alta comercial pendiente. El destino es el mismo `case` que tendría el literal, así
 *     que la línea no inventa política: sólo impide que la redacción la pierda.
 *   - **El troceado por `/`.** Las compuestas son vocabulario del expediente: 44 apariciones en
 *     las listas oficiales y todas con la misma cola de severidad — `CANCELLATION_ERROR/WARNING`
 *     (×36), `CHECK_ERROR/WARNING` (×6), `APPLICATION_ERROR/WARNING`, `RS/Warning`. Medido: no
 *     hay una sola compuesta con cabeza de entitlement en los `.yml` ni en las listas, así que
 *     `FORBIDDEN/WARNING` es forma hipotética; se trata igual porque la cola es la misma y el
 *     coste de no tratarla es perder el aviso. Qué significa la cola lo dice el propio expediente:
 *     la categoría sale como error o como warning según el `ErrorHandlingPolicy` de la request
 *     (`help-documentation-cancel-booking.txt:151`), o sea que no es parte del literal.
 *   - **La errata `APPLICATION_EROR`.** Inerte, y escrita como inerte: `APPLICATION_ERROR` no es
 *     un `case`, así que la errata y el literal correcto caen los dos en `default`. Lo fija
 *     `errors.category-normalization.test.ts` §2, que tampoco dice matar ningún mutante.
 */
function normalizeCategory(category: string): string {
  if (category === SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED) return 'UNAUTHORIZED';
  const head = category.split('/')[0] ?? category;
  const upper = head.trim().toUpperCase();
  return upper === 'APPLICATION_EROR' ? 'APPLICATION_ERROR' : upper;
}

/**
 * Capa de aplicación: se clasifica por `category` (21 literales estables), **nunca** por `type`
 * (457 valores, con `%s` interpolado y errata incluida) — docs/sabre/09 §2.3.
 */
function classifyApplication(signal: SabreFailureSignal): SabreFailureClass {
  const type = signal.type?.trim().toUpperCase();

  if (type === 'ATH_TOKEN_FAILURE') {
    return cls(
      'SESSION',
      'RETRY_BACKOFF',
      'IGNORE',
      'Sabre pide explícitamente reintentar la transacción',
    );
  }
  if (type === 'UNABLE_TO_RETRIEVE_SESSION_DATA') {
    return cls('SESSION', 'RETRY_BACKOFF', 'IGNORE', 'sesión interna de Sabre no disponible');
  }
  if (type === 'FAULT_RESPONSE') {
    return cls('UPSTREAM', 'RETRY_BACKOFF', 'COUNT', 'el sistema de fondo no pudo procesar');
  }
  if (type !== undefined && SABRE_HUMAN_REVIEW_TYPES.has(type)) {
    return cls(
      'HUMAN_REVIEW',
      'NO_RETRY',
      'IGNORE',
      'estado ambiguo de la reserva: cola NEEDS_HUMAN, nunca reintento automático',
      { operatorAlert: true },
    );
  }

  const category = signal.category === undefined ? undefined : normalizeCategory(signal.category);
  switch (category) {
    case 'UNAUTHORIZED':
      // Los siete comparten `type = UNAUTHORIZED_ACCESS` y sólo se distinguirían por una
      // descripción en inglés de texto libre (docs/sabre/01 §5.4).
      //
      // Aquí había un desempate por esa descripción que devolvía `AUTH_EXPIRED` +
      // `RETRY_AFTER_REAUTH` para el token expirado. Era **rama muerta**, el patrón de la ronda 2
      // en pequeño: ninguno de los cuatro sitios de llamada reales rellena `description`, y no es
      // un descuido que se pueda «arreglar» cableándolo — el cliente HTTP construye la señal desde
      // `verdict.failures[0]`, que es un `SabreIssue`, y `SabreIssue` deja fuera el texto libre A
      // PROPÓSITO porque puede arrastrar PII del pasajero y esto se loguea (RNF-07). El campo no
      // podía llegar nunca, así que la rama nunca podía ejecutarse; el único test que la tocaba
      // llamaba a `classifySabreFailure` directamente, que es medir la función en vez de medir lo
      // que corre.
      //
      // El coste de haberla borrado cae del lado seguro: un token que expira dentro de un 200 sale
      // como entitlement con alerta al operador en vez de re-autenticarse solo. Y no se pierde la
      // recuperación real, que vive en los dos carriles que sí están cableados y probados:
      // `ERR.2SG.SEC.INVALID_CREDENTIALS` (código del gateway) y el HTTP 401, ambos
      // `RETRY_AFTER_REAUTH`.
      return cls(
        'ENTITLEMENT',
        'NO_RETRY',
        'IGNORE',
        'sub-servicio no suscrito para este PCC: degradación visible, no reintento',
        { operatorAlert: true },
      );
    case 'INTERNAL_SERVER_ERROR':
    case 'EXTERNAL_SERVER_ERROR':
      return cls('UPSTREAM', 'RETRY_BACKOFF', 'COUNT', 'error de servidor dentro de un 200');
    case 'RESOURCE_NOT_FOUND':
      return cls('NO_DATA', 'NO_RETRY', 'IGNORE', 'el recurso no existe');
    case 'FORBIDDEN':
    case 'RESOURCE_RESTRICTED':
    case 'REQUEST_NOT_ALLOWED':
      return cls('ENTITLEMENT', 'NO_RETRY', 'IGNORE', 'operación no permitida para este PCC', {
        operatorAlert: true,
      });
    default:
      return cls(
        'BUSINESS',
        'NO_RETRY',
        'IGNORE',
        'fallo de negocio dentro de un 200: falla la operación, no cuenta para el breaker',
      );
  }
}

/**
 * Clasifica un fallo de Sabre. Es la única puerta: el cliente HTTP, el token service y el
 * exception filter de `apps/api` deben decidir con esto y no con heurísticas propias.
 */
export function classifySabreFailure(signal: SabreFailureSignal): SabreFailureClass {
  if (signal.status === 0) {
    return cls('TRANSPORT', 'RETRY_BACKOFF', 'COUNT', 'red caída o timeout local');
  }

  // Los `ERR.2SG.*` son inequívocos: mandan sobre cualquier texto.
  if (signal.code !== undefined) {
    const byCode = GATEWAY_CODES[signal.code.trim().toUpperCase()];
    if (byCode) return byCode;
  }

  // El texto va ANTES del código genérico a propósito. Sabre devuelve `invalid_client` —que es
  // ambiguo— acompañado de un `error_description` que sí desambigua ("Wrong clientID or
  // clientSecret"). Si el código ganara, una credencial confirmadamente mala se reintentaría
  // tres veces y nadie marcaría la cuenta.
  if (signal.text !== undefined) {
    const byText = classifyGatewayText(signal.status, signal.text);
    if (byText) return byText;
  }

  if (signal.code !== undefined) {
    const byCodeText = classifyGatewayText(signal.status, signal.code);
    if (byCodeText) return byCodeText;
  }

  if (signal.status === 200) return classifyApplication(signal);

  switch (signal.status) {
    case 400:
    case 405:
    case 406:
    case 413:
      return cls('CLIENT_BUG', 'NO_RETRY', 'IGNORE', `HTTP ${signal.status}: request inválida`, {
        operatorAlert: true,
      });
    case 401:
      // Sin texto que desambigüe se asume expiración: es el caso frecuente y el reintento
      // tras re-auth es barato. Nunca deshabilita la cuenta.
      return cls(
        'AUTH_EXPIRED',
        'RETRY_AFTER_REAUTH',
        'IGNORE',
        '401 sin texto reconocible: re-autenticar y reintentar una vez',
      );
    case 403:
      return cls(
        'ENTITLEMENT',
        'NO_RETRY',
        'IGNORE',
        '403: configuración del tenant, no fallo del proveedor. NO abre circuito',
        { operatorAlert: true },
      );
    case 404:
      return cls('NO_DATA', 'NO_RETRY', 'IGNORE', '404: trátalo como "sin resultados"');
    case 429:
      return cls('THROTTLED', 'RETRY_BACKOFF', 'IGNORE', '429: backoff, no abre circuito');
    case 503:
      return cls('UPSTREAM', 'RETRY_BACKOFF', 'OPEN_NOW', '503: caso canónico de abrir circuito');
    case 504:
      return cls(
        'UPSTREAM',
        'RETRY_BACKOFF',
        'OPEN_NOW',
        '504: abrir circuito. En escrituras, jamás reintentar',
      );
    default:
      if (signal.status >= 500) {
        return cls(
          'UPSTREAM',
          'RETRY_BACKOFF',
          'COUNT',
          `HTTP ${signal.status}: error de servidor`,
        );
      }
      return cls('CLIENT_BUG', 'NO_RETRY', 'IGNORE', `HTTP ${signal.status} inesperado`, {
        operatorAlert: true,
      });
  }
}

/** El único número de espera que Sabre publica, repetido en todas las filas reintentables. */
export const SABRE_MIN_BACKOFF_MS = 500;
export const SABRE_MAX_BACKOFF_MS = 4_000;
/** Tope de intentos (el original más dos reintentos) — docs/sabre/01 §5.2. */
export const SABRE_MAX_ATTEMPTS = 3;

/**
 * Backoff exponencial con jitter a partir del suelo de 500 ms. `jitter` se inyecta para que los
 * tests sean deterministas.
 */
export function sabreBackoffDelayMs(attempt: number, jitter: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(SABRE_MIN_BACKOFF_MS * 2 ** exponent, SABRE_MAX_BACKOFF_MS);
  return Math.round(base + jitter() * (SABRE_MIN_BACKOFF_MS / 2));
}

export interface SabreApiErrorOptions {
  readonly code?: string;
  readonly failure?: SabreFailureClass;
  readonly issues?: readonly SabreIssue[];
  readonly conversationId?: string;
}

// Aquí vivía `safeErrorPath`, una SEGUNDA implementación de la política de rutas: tiraba la query
// y no aplicaba ninguna pasada por forma, así que un `Bearer`, un JWT o el `secret` de Sabre en un
// segmento de ruta llegaban enteros a `error.message`. La regla canónica —y única— es `redactPath`
// en `./redaction`, que además explica por qué una ruta no puede pasar por `redactText` entero.

/**
 * Error tipado del proveedor Sabre. Cubre las dos capas: un `200` con `errors[]` produce un
 * `SabreApiError` con `status === 200`, igual que un `503` lo produce con `status === 503`.
 * `status === 0` es fallo de red o timeout.
 *
 * **Todo lo que entra al `message` se redacta en el constructor**, no en el sitio de la llamada:
 * `body`, `code` y la query del `path`. Una protección que depende de que cada llamador se acuerde
 * ya falló una vez —el cliente HTTP redactaba el `code` y el token service no— y el precio fue el
 * password de la oficina en un log.
 */
export class SabreApiError extends Error {
  readonly body: string;
  readonly failure: SabreFailureClass;
  readonly code: string | undefined;
  readonly conversationId: string | undefined;
  readonly issues: readonly SabreIssue[];
  readonly path: string;

  constructor(
    readonly status: number,
    body: string,
    path: string,
    options: SabreApiErrorOptions = {},
  ) {
    // La CLASIFICACIÓN mira el texto CRUDO y tiene que seguir haciéndolo: la tabla 2SG compara
    // literales (`ERR.2SG.*`, `invalid_client`, «Wrong clientID») y de ahí sale `disableAccount`,
    // que es lo que marca una cuenta BYOC. Clasificar sobre el texto ya redactado convertiría una
    // credencial confirmadamente mala en un fallo genérico y nadie avisaría al tenant.
    const failure =
      options.failure ?? classifySabreFailure({ status, code: options.code, text: body });

    // De aquí en adelante sólo circula lo redactado. El `code` es un campo del proveedor y Sabre
    // HACE ECO DE LA REQUEST en los errores de `/v2/auth/token`: el `error` de OAuth2 llega como
    // `invalid_client:V1:{EPR}:{PCC}:{Domain}:{secret}`, y ese secret es base64 REVERSIBLE del
    // password de la oficina (docs/sabre/01 §2.1 obs. 1, §5.3).
    //
    // Y ANTES de resumir, las casillas de vocabulario pasan por la misma puerta que las publica en
    // el `SabreIssue` ({@link sabreSafeIssueSlots}). Redactar por clave y por forma no basta para
    // ellas: un pasaporte, un localizador o un PCC son cortos, no llevan espacios y no viven bajo
    // una clave sensible, así que salían enteros al `message` y al `body` —40 de 56 combinaciones
    // medidas por `postJson`— justo por la superficie de la que tira monitorización.
    const safeCode =
      options.code === undefined ? undefined : sabreSafeJoinedValue(redactText(options.code));
    const safePath = redactPath(path);
    const safeBody = safeBodySummary(sabreSafeIssueSlots(body));
    super(
      `Sabre ${status} on ${safePath} [${failure.kind}]${safeCode ? ` ${safeCode}` : ''}: ${safeBody}`,
    );
    this.name = 'SabreApiError';
    this.body = safeBody;
    this.path = safePath;
    this.failure = failure;
    this.code = safeCode;
    this.conversationId = options.conversationId;
    this.issues = options.issues ?? [];
  }

  get retryable(): boolean {
    return this.failure.retry !== 'NO_RETRY';
  }

  /** Metadatos para el log estructurado. Nunca incluye el body ni texto libre del proveedor. */
  toLogMeta(): Record<string, unknown> {
    return {
      provider: 'sabre',
      status: this.status,
      path: this.path,
      code: this.code,
      kind: this.failure.kind,
      retry: this.failure.retry,
      circuit: this.failure.circuit,
      conversationId: this.conversationId,
      issues: this.issues.map((issue) => ({
        source: issue.source,
        severity: issue.severity,
        category: issue.category,
        type: issue.type,
        code: issue.code,
        fieldPath: issue.fieldPath,
      })),
    };
  }
}

// Aquí vivía `isSabreApiError`, un type guard exportado con CERO llamadas en todo el repo y cero
// tests. En este paquete un export sin llamadas tiene precedente: la copia débil de la regla dura
// que corrió en producción durante la ronda 2 llegó publicada por un export que nadie auditaba.
// `value instanceof SabreApiError` dice lo mismo en el sitio donde haga falta, sin API que
// mantener ni segunda definición que pueda derivar.

/* ────────────────────────────────────────────────────────────────────────────
 * La regla dura de éxito
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Sabre transporta fallos de negocio dentro de un HTTP 200 y 14 de los 21 contratos declaran
 * únicamente `200`. Quien dé por buena una respuesta que no lo es confirma una reserva que
 * nunca existió: el cliente no vuela y ya se le cobró.
 *
 * Por eso la regla **no enumera formas malas** — enumerarlas es perder, porque el proveedor
 * siempre tiene una forma más. La regla **invierte la carga de la prueba**:
 *
 *     éxito ⇔ el recorrido del sobre TERMINÓ  ∧  no se encontró nada que huela a error
 *
 * Todo lo que no se pueda demostrar benigno cuenta como error, en cualquier forma
 * (array, objeto, escalar) y a cualquier profundidad. Un falso positivo cuesta un reintento;
 * un falso negativo cuesta una reserva fantasma.
 */

/**
 * Presupuesto de nodos del recorrido. Agotarlo **no** es éxito: es "no verificable" (ver
 * `exhaustive`), y no verificable es error.
 *
 * El número sale de medir sobre el fixture real de BFM v5 replicando itinerarios (Node 20,
 * media de 50 pasadas; `nodesVisited` lo reporta el propio veredicto para poder recalibrar
 * con tráfico de producción):
 *
 *   |  tamaño | nodos   | escaneo  | `JSON.parse` | escaneo / parse |
 *   |--------:|--------:|---------:|-------------:|----------------:|
 *   |   11 KB |     682 | 0,17 ms  |     0,04 ms  |          4,6×   |
 *   |  112 KB |   7 712 | 0,84 ms  |     0,34 ms  |          2,5×   |
 *   | 1 066 KB|  74 312 | 8,65 ms  |     3,18 ms  |          2,7×   |
 *   | 4 246 KB| 250 134 | 31,4 ms  |    14,4  ms  |          2,2×   |
 *
 * Lectura: el escaneo cuesta ~2,5× el `JSON.parse` que ya se pagó incondicionalmente sobre el
 * mismo cuerpo, y ~9 000 nodos/ms. Un sobre de 100 KB —el caso citado en la auditoría— cuesta
 * 0,84 ms frente a los 2-8 s de latencia de red de Sabre: 0,03 % del tiempo de la llamada.
 * Ese es el precio de no confirmar reservas fantasma, y se paga.
 *
 * El tope se fija en 500 000 nodos ≈ 8,5 MB de JSON ≈ 60 ms: 6,7× por encima del sobre real más
 * grande que hemos visto (1 MB / 74 k nodos, BFM v5 con 200 itinerarios). Deja margen de sobra
 * para tráfico legítimo y aun así acota el peor caso de un cuerpo hostil o corrupto.
 */
export const SABRE_ENVELOPE_NODE_BUDGET = 500_000;

/**
 * Tope de anidamiento. No es una optimización: es la barandilla contra un desbordamiento de pila
 * con un sobre patológico. Los sobres reales de Sabre no pasan de ~20 niveles. Superarlo marca
 * el veredicto como no exhaustivo, que es como decir error.
 */
export const SABRE_ENVELOPE_MAX_DEPTH = 64;

/** Categoría sintética de un problema real cuyo contenido no es estructurado (o es texto libre). */
export const SABRE_ISSUE_UNSTRUCTURED = 'UNSTRUCTURED';
/** Categoría sintética de `ApplicationResults.status === 'NotProcessed'`. */
export const SABRE_ISSUE_NOT_PROCESSED = 'NOT_PROCESSED';
/** Categoría sintética de un sobre que no se pudo recorrer entero. */
export const SABRE_ISSUE_NOT_VERIFIABLE = 'ENVELOPE_NOT_VERIFIABLE';
/** Categoría sintética de una clave que no es comparable con el contrato. Ver `SABRE_KEY_NON_ASCII`. */
export const SABRE_ISSUE_UNINTERPRETABLE_KEY = 'ENVELOPE_KEY_NOT_INTERPRETABLE';

/* ────────────────────────────────────────────────────────────────────────────
 * EL CONTEXTO DE LA OPERACIÓN
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Hasta la ronda 6 el clasificador era función PURA del sobre, y esa pureza tenía un precio que
 * sólo se vio cuando por fin se midió el otro lado de la balanza: se pasaron los ejemplos de
 * ÉXITO de los 21 contratos oficiales por el clasificador y salieron 3 rechazados de 252. Los
 * tres son el mismo caso y ninguno es un descuido del proveedor — es el contrato diciendo lo
 * contrario de lo que la regla asumía:
 *
 *   `manage-ancillary-1.1.yml` declara para `POST /v1/ancillaries/remove` la respuesta
 *   `RemoveAncillariesResponse`, **cuyo único campo es `errors[]`** (`:932-940`). Los tres
 *   ejemplos de éxito de esa operación (`:837`, `:862`, `:887`) son literalmente `{ }`, con la
 *   descripción «Ancillaries have been successfully removed … We receive an empty response; no
 *   errors are returned». Para esa operación el cuerpo vacío ES la señal de éxito.
 *
 * Un clasificador que rechaza eso deja al vendedor con un error en pantalla después de que la
 * eliminación SÍ se ejecutó — y lo peor: le invita a reintentar una operación de escritura. Un
 * falso positivo también es un fallo de producción, no sólo un reintento barato.
 *
 * **Las tres salidas y dónde cae el coste de cada una:**
 *
 *  A. *Relajar la regla globalmente* («`{}` vuelve a ser éxito»). Coste: un `createBooking` que
 *     responde `{}` se entrega como reserva confirmada. Es exactamente la reserva fantasma para
 *     la que se escribió la regla en la ronda 5. **Rechazada.**
 *
 *  B. *Inferirlo del propio sobre*. Coste: imposible. El `{}` de `/remove` y el `{}` de
 *     `createBooking` son el MISMO valor; no hay nada en el payload que los separe. **Imposible.**
 *
 *  C. *Hacer el clasificador consciente de la OPERACIÓN* — la elegida. El sobre deja de ser lo
 *     único que decide y entra la ruta que se llamó, que es dato nuestro (constante del ACL), no
 *     del proveedor. Coste, y hay que escribirlo entero:
 *
 *       1. El clasificador ya no es función pura del payload: el mismo cuerpo puede clasificarse
 *          distinto según la ruta. Se acota a DOS ejes, ambos con lista cerrada derivada de los
 *          `.yml` pineados por `spec-manifest.test.ts`, y ninguno relaja nada fuera de su lista.
 *       2. Quien no pase la ruta se queda con el comportamiento ESTRICTO. El default falla
 *          cerrado: olvidarse del segundo argumento no puede fabricar una reserva fantasma, sólo
 *          mantiene el falso positivo de `/remove`.
 *       3. Cuando Sabre publique una versión nueva de un contrato, estas listas hay que
 *          re-derivarlas. El disparador existe y es automático: `spec-manifest.test.ts` fija el
 *          `sha256` de los 21 `.yml`, así que un contrato que cambie pone el build en rojo.
 */

/**
 * Lo que el clasificador sabe de la LLAMADA, no del sobre. Sin esto el mismo `{}` no puede ser
 * éxito en una operación y reserva a medias en otra, que es justo lo que dicen los contratos.
 */
export interface SabreEnvelopeContext {
  /**
   * Ruta de la operación tal y como se llamó (`/v1/ancillaries/remove`). Es una constante del
   * ACL, nunca texto del proveedor. Ausente ⇒ el clasificador aplica la política estricta.
   */
  readonly path?: string;
}

/**
 * Normaliza una ruta para compararla con el contrato: fuera la query —por donde viajan
 * localizadores y PII cuando alguien construye la URL a mano— y fuera las barras finales.
 *
 * **Se exporta a propósito: es la normalización canónica y ya no hay ninguna otra.**
 * `isNonIdempotentSabrePath` (en el cliente HTTP) tenía su propia copia y desde la ronda 11 importa
 * ésta, así que la deriva que se temía —dos copias de la misma normalización, el patrón que ya
 * costó un incidente en este paquete con `asRecord`/`str` en la ronda 2— ya no puede ocurrir por
 * construcción. Lo que sigue en pie es la batería de rutas de `errors.operation-context.test.ts`,
 * que fija el comportamiento de las dos puertas sobre los mismos casos: si alguien vuelve a
 * escribir una segunda normalización, se pone roja en cuanto difiera de ésta.
 */
export function sabreOperationToken(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? '';
  return withoutQuery.replace(/\/+$/, '').toLowerCase();
}

/**
 * Operaciones cuyo CONTRATO declara el cuerpo vacío como la señal de éxito.
 *
 * La lista tiene un elemento y no es por pereza: `/remove` es la única operación de los 21
 * contratos cuyo schema de respuesta **no declara un solo campo de datos** — sólo `errors[]`
 * (`manage-ancillary-1.1.yml:932-940`). Cuando no hay errores no queda nada que devolver, y por eso
 * sus tres ejemplos de éxito son `{ }`. Sus hermanas `/add` y `/exchange` sí declaran
 * `ancillaryDetails` (`:941-960`, `:920-931`) y sus ejemplos de éxito vienen llenos: para ellas un
 * `{}` sigue siendo un fallo silencioso y sigue rechazándose.
 *
 * El criterio para ampliarla es ese y sólo ese: que el schema de la respuesta 200 no tenga ningún
 * campo que no sea portador de problemas. No vale «Sabre a veces devuelve vacío».
 */
export const SABRE_EMPTY_BODY_SUCCESS_PATHS: readonly string[] = Object.freeze([
  '/v1/ancillaries/remove',
]);

/**
 * Operaciones cuyo contrato declara `ApplicationResults` — las ÚNICAS que pueden conceder
 * benignidad por `ApplicationResults.Success`.
 *
 * Sale de mirar los 21 `.yml`: `ApplicationResults` aparece en ocho, y los ocho son LECTURAS de
 * inventario (`get-hotel-avail` v3/v4/v5, `get-hotel-details` v2, `get-vehicle-availability`
 * v1/v2, `hotel-price-check` v4/v5). Ni `booking-management-v1` (crear, cancelar, emitir, anular,
 * reembolsar), ni `manage-ancillary-1.1`, ni `offer-price-ndc-v1`, ni `flight-reshop`, ni
 * `bargain-finder-max` lo declaran en ningún sitio.
 *
 * Por qué importa: `Success` apaga la carga de la prueba en su subárbol. Que una operación de
 * DINERO pudiera apagarla con una forma que su propio contrato no declara es conceder benignidad
 * por la forma suelta y no por el contrato — el mismo error de la ronda 4, un nivel más arriba.
 * Sabre es un agregador que hace eco de contenido de terceros; un `ApplicationResults.Success`
 * llegando dentro de un `createBooking` no es una respuesta de hoteles, es una forma que ahí no
 * pinta nada, y lo correcto es no darle poder.
 *
 * Las rutas son las de los `paths:` de cada contrato, que es lo que el ACL pasa a `postJson`.
 */
export const SABRE_APPLICATION_RESULTS_PATHS: readonly string[] = Object.freeze([
  '/v3.0.0/get/hotelavail',
  '/v4.0.0/get/hotelavail',
  '/v5/get/hotelavail',
  '/v2.0.0/get/hoteldetails',
  '/v1.0.0/get/vehavail',
  '/v2.0.0/get/vehavail',
  '/v4.0.0/hotel/pricecheck',
  '/v5/hotel/pricecheck',
]);

/**
 * El cuerpo vacío es éxito declarado para esta operación.
 *
 * Sin ruta devuelve `false`: **el default falla cerrado**. Un llamador que se olvide del contexto
 * conserva la política de la ronda 5 entera, y lo único que pierde es el falso positivo de
 * `/remove`. Al revés —default permisivo— un olvido fabricaría reservas fantasma, y un default
 * cuyo olvido cuesta una reserva cobrada no es un default, es una trampa.
 */
function contractDeclaresEmptyBodySuccess(path: string | undefined): boolean {
  if (path === undefined) return false;
  return declaresOperation(SABRE_EMPTY_BODY_SUCCESS_PATHS, path);
}

/**
 * La ruta llamada ES una de las que declara la lista.
 *
 * **Comparación única para los dos ejes del contexto**, y por eso está factorizada: eran dos
 * copias de la misma comparación y en este paquete las segundas copias derivan (`asRecord`/`str`,
 * ronda 2). Una sola línea también significa un solo sitio que auditar y un solo sitio que mutar.
 *
 * `endsWith` y no `includes`, y no es un detalle de estilo: las rutas de la lista empiezan por
 * `/`, así que `endsWith` sólo puede casar en frontera de segmento —lo justo para tolerar un
 * prefijo de base (`/sabre/v5/get/hotelavail`)—. Con `includes`, cualquier ruta que CONTUVIERA una
 * de las ocho lecturas le heredaría su permiso: `/v5/get/hotelavail/v1/trip/orders/createBooking`
 * concedería benignidad a una operación de DINERO, que es la reserva fantasma de la ronda 5
 * entrando por la puerta del contexto. Y `endsWith` tampoco vale a secas para el otro eje sin
 * fijarlo: `includes` haría de `/v1/ancillaries/remove-all` un `/remove`.
 *
 * El lado DECLARADO también se pasa a minúsculas, y eso cierra un footgun que hasta ahora no se
 * veía porque las dos listas existentes ya estaban en minúsculas por casualidad: `sabreOperationToken`
 * baja la caja del token, así que una entrada escrita con la caja del contrato
 * (`/v1/trip/orders/createBooking`) NO habría casado nunca — una lista que no casa con nada falla
 * abierta en el eje de `ApplicationResults` y silenciosa en los otros dos. Es exactamente lo que
 * `isNonIdempotentSabrePath` ya hacía en el cliente HTTP; ahora la comparación es la misma en los
 * dos sitios. No relaja nada: ninguna de las listas tiene hoy una sola mayúscula.
 *
 * Las tres afirmaciones están fijadas por test; no vale con este comentario.
 */
function declaresOperation(known: readonly string[], path: string): boolean {
  const token = sabreOperationToken(path);
  return known.some((declared) => token.endsWith(declared.toLowerCase()));
}

/**
 * La operación puede conceder benignidad por `ApplicationResults.Success`.
 *
 * Sin ruta devuelve `true`, y aquí el default va al otro lado que el de arriba **por medición, no
 * por simetría**: los ocho contratos que declaran `ApplicationResults` son lecturas de hoteles y
 * coches cuyos sobres reales meten los avisos del proveedor de fondo dentro de `Success[]`
 * (`get-hotel-avail-v5.0.yml:144-176`). Denegar por defecto convertiría cada búsqueda de hotel en
 * un error mientras nadie pase la ruta, que es cambiar un falso positivo medido de 3/252 por uno
 * masivo y no medido. El default estricto se puede poner el día que el llamador pase la ruta
 * siempre; hasta entonces lo honesto es que este eje sólo APRIETE cuando hay contexto.
 *
 * ## RONDA 9 — la asimetría de los dos ejes, dicha entera
 *
 * Circula por el paquete la frase «sin ruta el clasificador cae al modo estricto». Es cierta en UN
 * eje y falsa en el otro, y conviene no repetirla sin el matiz:
 *
 *   | eje                              | sin ruta   | falla…  |
 *   | -------------------------------- | ---------- | ------- |
 *   | `contractDeclaresEmptyBodySuccess` | `false`  | CERRADO |
 *   | `contractDeclaresApplicationResults` (aquí) | `true` | ABIERTO |
 *
 * Este eje **no falla cerrado y hoy no puede**, por dos razones distintas y las dos verificables:
 *
 *  1. *Medición.* Los ocho contratos que declaran `ApplicationResults` meten los avisos del
 *     proveedor de fondo DENTRO de `Success[]` (`get-hotel-avail-v5.0.yml:144-176`). Denegar por
 *     defecto convierte cada lectura de hotel sin ruta en un error: se cambiaría un falso positivo
 *     medido de 3/252 por uno masivo y no medido, que es peor negocio del que se está arreglando.
 *  2. *Alcance.* El default sólo lo ve quien llama a `classifySabreEnvelope` a pelo. El único
 *     llamador real —`http/sabre-http.client.ts`— pasa `{ path }` desde la ronda 7, y ese cableado
 *     está fijado por dos vías en `errors.operation-context.test.ts` §8. Es decir: en producción
 *     este default no se ejerce, y el riesgo abierto vive sólo en el uso directo de la función.
 *
 * Qué haría falta para cerrarlo, escrito para que no se pierda: hacer `path` OBLIGATORIO en
 * `SabreEnvelopeContext` y `context` obligatorio en `classifySabreEnvelope`. Entonces el default
 * deja de existir en vez de cambiar de lado, y el compilador —no un test— impide el olvido que la
 * ronda 7 encontró cableado. Es un cambio de API pública y de todos sus llamadores, así que no
 * entra aquí; lo que sí entra es que la asimetría esté MEDIDA por test y no sólo escrita, para que
 * el día que alguien invierta el default lo haga a sabiendas.
 */
function contractDeclaresApplicationResults(path: string | undefined): boolean {
  if (path === undefined) return true;
  return declaresOperation(SABRE_APPLICATION_RESULTS_PATHS, path);
}

/* ────────────────────────────────────────────────────────────────────────────
 * EL DESENLACE PARCIAL — cuando `errors[]` es lo que el cliente PIDIÓ
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## El fallo medido, y por qué lo causó el propio endurecimiento
 *
 * `createBooking` y `cancelBooking` aceptan `errorHandlingPolicy` en la REQUEST
 * (`booking-management-v1.yml:698` y `:352`). Seis de sus ocho valores son `DO_NOT_HALT_ON_*`
 * (`:8918-8940`): «sigue adelante aunque falle el hotel / el coche / el asiento / el ancillary».
 * La forma que produce elegir eso está declarada en la RESPUESTA: `CreateBookingResponse` lista
 * `confirmationId`, `booking` **y** `errors[]` como propiedades del mismo objeto (`:804-829`), y
 * `CancelBookingResponse` lista `booking`, `tickets[]`, `voidedTickets[]`, `refundedTickets[]`,
 * `flightRefunds[]` **y** `errors[]` (`:440-487`).
 *
 * O sea: un `200` con reserva dentro y `errors[]` al lado no es un sobre roto. Es el resultado que
 * el cliente pidió antes de llamar. Y la regla dura —correcta para BUSCAR— lo convertía en
 * `SabreApiError` ANTES de que el mapper corriera, con tres consecuencias medidas:
 *
 *   1. todo el mecanismo de éxito parcial de `create.response.mapper.ts` era INALCANZABLE: el
 *      `outcome` nunca podía valer `PARTIAL`, y con él nunca se ejecutaba la compensación acotada
 *      por `itemId`;
 *   2. `mapSabreCancelResponse` sólo podía devolver `CANCELLED`, porque sus otras cinco ramas se
 *      deciden LEYENDO `errors[]` y ese sobre no llegaba;
 *   3. lo peor: `SabreApiError` sólo conserva un resumen redactado del cuerpo, así que un
 *      `confirmationId` que llegara dentro de un sobre rechazado se PERDÍA. `createBooking` no
 *      expone idempotency key (`:694-802`) y `getBooking` se direcciona por `confirmationId`
 *      (`:240`): un PNR sin localizador queda huérfano y sólo lo encuentra una persona
 *      (docs/sabre/04 §5.5, riesgo MAYOR). Cancelar —o dar por no creado— un vuelo confirmado
 *      porque falló un accesorio es la avería que esta tanda existe para cerrar.
 *
 * ## Qué se afloja: NADA de la regla dura
 *
 * No se toca `scanNode`, ni un anotador, ni una lista de claves, ni el presupuesto. La regla dura
 * sigue corriendo entera y su veredicto (`ok`) significa exactamente lo mismo que antes. Lo que se
 * añade es una SEGUNDA pregunta, más estrecha, que sólo se hace cuando la primera ya dijo que no:
 *
 *     ¿es este rechazo EXACTAMENTE el desenlace parcial que el contrato de esta operación declara?
 *
 * Y se responde quitando del sobre la clave que el contrato declara portadora del desenlace
 * —`errors` en la RAÍZ, y ninguna otra— y volviendo a pasar **la misma regla dura, sin relajar**
 * por todo lo que queda. Si el resto del sobre no está impecable, no hay tolerancia. Un error
 * enterrado bajo `booking`, un `status: NotProcessed`, una clave no-ASCII, un `fault`, un
 * presupuesto agotado: todos siguen rechazando, y siguen rechazando en las dos operaciones.
 *
 * El conjunto perdonado es estrictamente MÁS ESTRECHO que la familia de error del recorrido: éste
 * lee como error `error`, `errorList`, `fault`, `exception` y todo lo acabado en `Error`/`Errors`;
 * aquí se perdona sólo lo que normaliza a `ERRORS`, que es la única clave que el contrato declara.
 *
 * ## Las cuatro condiciones, y por qué cada una
 *
 *  1. **La operación lo declara** (`SABRE_PARTIAL_OUTCOME_CONTRACTS`). Sin ruta no hay tolerancia:
 *     el default falla CERRADO, igual que el eje del cuerpo vacío y al revés que el de
 *     `ApplicationResults` (ver la tabla de la ronda 9 en `contractDeclaresApplicationResults`).
 *     Olvidarse del contexto no puede fabricar una entrega tolerada.
 *  2. **El recorrido terminó** (`exhaustive`). Un sobre que no se pudo mirar entero no es un sobre
 *     con un desenlace parcial: es un sobre desconocido, y desconocido nunca se entrega.
 *  3. **Todo el fallo está en el portador de la raíz**, medido re-pasando la regla dura por el
 *     resto. No es una lista de formas malas: es la misma carga de la prueba invertida aplicada al
 *     complemento del portador.
 *  4. **Hay algo que el mapper pueda decidir** (`SabrePartialOutcomeEvidence`). Aquí las dos
 *     operaciones se separan, y la asimetría es del CONTRATO, no de conveniencia — se explica en
 *     {@link SabrePartialOutcomeEvidence}.
 *
 * ## Quién decide el desenlace
 *
 * El clasificador NO dice que la operación fuera bien: dice que el sobre es entregable y que quien
 * tiene el vocabulario para leerlo es el mapper de la operación. `verdict.ok` sigue siendo `false`
 * y `verdict.failures` viaja entero hasta el llamador (`SabreResult.partialOutcome`) y hasta el
 * log. Ningún mapper puede confirmar sobre un sobre con errores: `resolveOutcome` de
 * `create.response.mapper.ts` devuelve `PARTIAL` en cuanto hay un issue `ERROR`, y
 * `mapSabreCancelResponse` sólo devuelve `success: true` con `errors[]` vacío, sólo con warnings o
 * sólo con `BOOKING_ALREADY_CANCELED`.
 */

/**
 * Forma de un localizador de Booking Management.
 *
 * El contrato la declara dos veces y de la misma familia: `CreateBookingResponse.confirmationId` es
 * `^[A-Z0-9]{6,}$` (`booking-management-v1.yml:814-818`) y `Booking.bookingId` es
 * `^[A-Z0-9]{6,14}$` (`:1057-1062`). Se usa la más ancha con un techo de 64 —4,5× el máximo que el
 * contrato declara—: aquí la longitud sólo decide un booleano, y una tirada de 65 caracteres no es
 * el localizador de nada.
 */
const SABRE_BOOKING_LOCATOR_SHAPE = /^[A-Z0-9]{6,64}$/;

/**
 * Qué demuestra que el sobre trae un desenlace que el mapper pueda decidir.
 *
 * Las dos operaciones no se pueden medir con la misma vara, y el motivo está en sus contratos:
 *
 * - **`LOCATOR`** — `createBooking`. El contrato declara un localizador, y su presencia demuestra
 *   un hecho del mundo: **hay un PNR ahí fuera**. Perderlo es irreversible (sin idempotency key y
 *   sin búsqueda por remark, `:694-802`), así que con localizador se entrega **pase lo que pase en
 *   `errors[]`**. Coste, dicho entero: un `UPSTREAM` o un `ENTITLEMENT` que llegue dentro de un
 *   `createBooking` CON localizador deja de contar para el breaker y de llegar como
 *   `SabreApiError`. Se paga a sabiendas — sigue viajando al log (`sabre.http.desenlace_parcial`) y
 *   en `SabreResult.partialOutcome`/`partialUnauthorized`—, porque la alternativa es tirar el
 *   localizador de una reserva que existe. Un `createBooking` que falla SIN localizador no entra
 *   por aquí y conserva su clasificación entera.
 *
 * - **`CARRIER_IS_OUTCOME`** — `cancelBooking`. Su respuesta **no declara localizador** (`:440-487`)
 *   y su desenlace vive literalmente dentro de `errors[]`: el fabricante lo dice palabra por
 *   palabra, _"if not present (empty or contains warnings only) then execution is successful"_
 *   (`help-documentation-cancel-booking.txt`). No hay nada que demuestre que algo cambió de estado,
 *   así que la evidencia es débil y se compensa con una condición que el carril del localizador no
 *   necesita: cada fallo tiene que ser un problema que el PROVEEDOR declaró con el vocabulario del
 *   contrato **y** clasificar a una clase que un mapper pueda leer
 *   ({@link SABRE_MAPPABLE_PARTIAL_KINDS}). Un entitlement, un fallo de sesión o un error de
 *   servidor dentro de ese `errors[]` siguen siendo `SabreApiError`, con su política de reintento,
 *   su efecto sobre el breaker y su alerta al operador.
 */
export type SabrePartialOutcomeEvidence = 'LOCATOR' | 'CARRIER_IS_OUTCOME';

export interface SabrePartialOutcomeContract {
  /** Ruta del `paths:` del contrato, tal y como el ACL la pasa a `postJson`. */
  readonly path: string;
  readonly evidence: SabrePartialOutcomeEvidence;
}

/**
 * Las operaciones cuyo contrato declara el éxito parcial como resultado NORMAL.
 *
 * El criterio para entrar es doble y los dos lados se pueden señalar en el `.yml`:
 *
 *   1. la REQUEST declara `errorHandlingPolicy` —o sea, el cliente puede PEDIR seguir adelante
 *      pese a un fallo parcial— y
 *   2. la RESPUESTA declara `errors[]` **junto a** campos de datos, o sea que traer las dos cosas a
 *      la vez es forma declarada y no una contradicción.
 *
 * Cinco operaciones de Booking Management cumplen (1): `cancelBooking` (`:352`),
 * `voidFlightTickets` (`:492`), `refundFlightTickets` (`:566`), `createBooking` (`:698`) y
 * `fulfillFlightTickets` (`:919`). **Aquí sólo están dos**, y la razón no es el contrato: es que
 * tolerar un sobre que nadie sabe leer es peor que rechazarlo. `createBooking` y `cancelBooking`
 * son las únicas dos con mapper propio (`booking/create.response.mapper.ts`,
 * `booking/cancel.response.mapper.ts`), o sea las únicas donde «que decida el mapper» nombra a
 * alguien. El día que se escriba el mapper de emisión, esta lista crece con él y con sus tests —no
 * antes—.
 */
export const SABRE_PARTIAL_OUTCOME_CONTRACTS: readonly SabrePartialOutcomeContract[] =
  Object.freeze([
    { path: '/v1/trip/orders/createBooking', evidence: 'LOCATOR' },
    { path: '/v1/trip/orders/cancelBooking', evidence: 'CARRIER_IS_OUTCOME' },
  ]);

/**
 * La clave que el contrato declara portadora del desenlace, normalizada con
 * {@link normalizeEnvelopeToken} — el mismo criterio de caja con el que el recorrido la lee.
 *
 * Es la ÚNICA clave que se perdona, y sólo en la raíz. `error` en singular, `errorList`, `fault`,
 * `exception` y todo lo acabado en `Error` siguen siendo fatales en las dos operaciones: el
 * contrato declara `errors`, y una clave que el contrato no declara no puede declarar un desenlace.
 */
const SABRE_PARTIAL_OUTCOME_CARRIER = 'ERRORS';

/**
 * Clases de fallo que un mapper de reserva puede convertir en desenlace.
 *
 * `BUSINESS` es el fallo de negocio dentro de un 200 —el hotel que no se pudo reservar, el asiento
 * denegado, el `NO_ITEMS_CANCELLED`— y `HUMAN_REVIEW` es el estado ambiguo que va a cola humana
 * (`PARTIAL_FULFILLMENT`, `UNABLE_TO_RETRIEVE_BOOKING`), que es literalmente el desenlace
 * `UNVERIFIED` de `mapSabreCancelResponse`. Las otras diez clases dicen que falló la plataforma, la
 * credencial o el entitlement: ésas no son un desenlace de la reserva y no las lee ningún mapper.
 */
export const SABRE_MAPPABLE_PARTIAL_KINDS: ReadonlySet<SabreFailureKind> =
  new Set<SabreFailureKind>(['BUSINESS', 'HUMAN_REVIEW']);

function partialOutcomeContractFor(
  path: string | undefined,
): SabrePartialOutcomeContract | undefined {
  if (path === undefined) return undefined;
  // Se compara con `declaresOperation`, que es la comparación única de los otros dos ejes: una
  // segunda forma de decidir «esta ruta es aquella operación» es la deriva que este paquete ya pagó.
  return SABRE_PARTIAL_OUTCOME_CONTRACTS.find((contract) =>
    declaresOperation([contract.path], path),
  );
}

interface SabreCarrierSplit {
  /**
   * El sobre traía el portador en la RAÍZ **con la forma que el contrato declara**: un array.
   *
   * La forma no es un detalle. Las dos respuestas declaran `errors: type: array`
   * (`booking-management-v1.yml:822-826` y `:461-465`), y un `errors` que no es un array es un
   * sobre que no se corresponde con el contrato — la «reserva que falló y además devolvió basura»,
   * no el desenlace parcial que el cliente pidió. Medido por la puerta pública: sin esta
   * comprobación, `{"errors":{"category":"…","type":"…"}}` —la forma que sale de un carril
   * XML/SOAP— se entregaba como desenlace de una cancelación, y el Zod del mapper la habría
   * rechazado después con peor diagnóstico.
   *
   * Coste, dicho entero: un `createBooking` que traiga localizador y un `errors` mal formado se
   * rechaza y su PNR no llega al llamador. Es el caso en el que no sabemos qué nos han devuelto, y
   * la recuperación es la que ya está escrita para todo desenlace ambiguo de una escritura: releer
   * con `getBooking`, jamás reintentar.
   *
   * Si hay más de una clave que normaliza a `ERRORS`, **todas** tienen que ser arrays: se quitan
   * todas del residuo, así que perdonar una que no lo sea sería perdonar contenido sin mirarlo.
   */
  readonly declared: boolean;
  /** Todo lo demás, tal cual, para volver a pasarle la regla dura sin tocarla. */
  readonly rest: Record<string, unknown>;
}

function splitOutcomeCarrier(record: Record<string, unknown>): SabreCarrierSplit {
  const rest: Record<string, unknown> = {};
  let carriers = 0;
  let arrays = 0;
  for (const key of Object.keys(record)) {
    if (normalizeEnvelopeToken(key) === SABRE_PARTIAL_OUTCOME_CARRIER) {
      carriers += 1;
      if (Array.isArray(record[key])) arrays += 1;
      continue;
    }
    rest[key] = record[key];
  }
  return { declared: carriers > 0 && carriers === arrays, rest };
}

/**
 * Hay un localizador con la forma que el contrato declara.
 *
 * Se leen las claves EXACTAS del contrato —`confirmationId` en la raíz y `booking.bookingId`—, y no
 * con el barrido insensible a la caja que usa el recorrido, a propósito: son exactamente las dos
 * que lee `mapSabreCreateBookingResponse` (por Zod y por `salvageLocator`). Tolerar un localizador
 * que el mapper luego no encuentra cambiaría un `SabreApiError` clasificado por un
 * `SabreCreateBookingMapError` sin clasificar, que es peor diagnóstico y el mismo PNR perdido.
 */
function hasBookingLocator(record: Record<string, unknown>): boolean {
  const confirmationId = sabreEnvelopeString(record['confirmationId']);
  const booking = sabreEnvelopeRecord(record['booking']);
  const bookingId = booking === null ? undefined : sabreEnvelopeString(booking['bookingId']);
  return [confirmationId, bookingId].some(
    (value) => value !== undefined && SABRE_BOOKING_LOCATOR_SHAPE.test(value),
  );
}

/**
 * El fallo es un problema que el PROVEEDOR declaró y que un mapper puede leer.
 *
 * Se exigen las dos casillas porque el contrato las exige: `Error` declara `category` y `type` como
 * `required` (`booking-management-v1.yml:4271-4302`), igual que `Warning` (`:4304-…`). Un item que
 * no trae las dos no es un `Error` del contrato.
 *
 * Y eso cierra de paso, por construcción y no por lista, la puerta a **todas** las categorías que
 * el propio clasificador sintetiza —`UNSTRUCTURED`, `NOT_PROCESSED`, `STATUS_*`,
 * `ENVELOPE_NOT_VERIFIABLE`, `ENVELOPE_KEY_NOT_INTERPRETABLE`—: ninguna declara `type`, porque
 * `type` sólo se rellena con vocabulario que vino en el sobre. Un `errors: ["texto"]` en una
 * cancelación tampoco pasa, y es el lado correcto: el Zod del mapper lo rechazaría después, y un
 * error del mapper diagnostica peor que uno del clasificador.
 */
function isMappablePartialFailure(issue: SabreIssue): boolean {
  if (issue.category === undefined || issue.type === undefined) return false;
  const { kind } = classifySabreFailure({
    status: 200,
    category: issue.category,
    type: issue.type,
  });
  return SABRE_MAPPABLE_PARTIAL_KINDS.has(kind);
}

/**
 * Las cuatro condiciones del bloque de arriba, en orden de coste creciente: primero lo que se
 * decide con un booleano, después lo que exige recorrer el sobre otra vez.
 *
 * El re-recorrido sólo ocurre cuando la regla dura YA rechazó, la operación está en la lista cerrada
 * y el sobre trae el portador en la raíz. Un sobre limpio —el caso normal— no paga ni un nodo.
 */
function isDeclaredPartialOutcome(
  payload: unknown,
  path: string | undefined,
  verdict: SabreEnvelopeVerdict,
): boolean {
  if (!verdict.exhaustive) return false;

  const contract = partialOutcomeContractFor(path);
  if (contract === undefined) return false;

  const record = sabreEnvelopeRecord(payload);
  if (record === null) return false;

  const carrier = splitOutcomeCarrier(record);
  if (!carrier.declared) return false;

  // La MISMA regla dura, sin un solo parámetro relajado, sobre todo lo que no es el portador.
  const residual = runEnvelopeScan(carrier.rest, contractDeclaresApplicationResults(path));
  if (!residual.verdict.exhaustive || residual.verdict.failures.length > 0) return false;

  return contract.evidence === 'LOCATOR'
    ? hasBookingLocator(record)
    : verdict.failures.every(isMappablePartialFailure);
}

export interface SabreEnvelopeVerdict {
  /** `true` sólo si el recorrido terminó **y** no encontró un solo problema de severidad error. */
  ok: boolean;
  failures: SabreIssue[];
  warnings: SabreIssue[];
  /**
   * Entitlements de sub-servicio dentro de un 200: la respuesta llega, pero capada. El vendedor
   * lo vería como "no hay datos" si nadie lo sube a la superficie (RNF-13).
   */
  partialUnauthorized: SabreIssue[];
  /**
   * El rechazo es EXACTAMENTE el desenlace parcial que el contrato de la operación declara, y el
   * sobre trae algo que su mapper pueda decidir. Ver el bloque «EL DESENLACE PARCIAL».
   *
   * **No dice que la operación fuese bien.** Dice que el cuerpo es entregable y que quien tiene el
   * vocabulario para leerlo es el mapper, no el clasificador. `ok` sigue siendo `false` y
   * `failures` sigue lleno; quien entregue tiene que hacer viajar las dos cosas.
   *
   * Siempre `false` cuando `ok` es `true` —no hay nada que tolerar— y siempre `false` sin contexto
   * de operación: este eje falla CERRADO.
   */
  partialOutcome: boolean;
  /** El recorrido llegó al final. `false` ⇒ presupuesto o profundidad agotados ⇒ jamás es éxito. */
  exhaustive: boolean;
  /** Nodos visitados. Métrica para recalibrar el presupuesto con tráfico real. */
  nodesVisited: number;
}

/**
 * Severidad heredada del subárbol en el que estamos. `benign` es el interior de un nodo que el
 * contrato declara como éxito (`ApplicationResults.Success[]`) — y **sólo** eso: ver
 * `envelopeKeyKind` y `SABRE_BENIGN_CARRIER_KEYS` para las dos condiciones que lo conceden y para
 * el fondo que impide que se propague sin límite.
 */
type SabreIssueContext = 'neutral' | 'error' | 'warning' | 'benign';

/**
 * Semántica que una clave del sobre declara sobre el valor que cuelga de ella.
 *
 * **Se exporta a propósito**, y no es azúcar de tests: es la lista cerrada sobre la que la guarda
 * anti-recurrencia (`errors.traversal.guard.test.ts`) comprueba que TODA semántica reconocida
 * desciende. Añadir un miembro aquí sin darle un sobre de muestra en esa guarda pone la suite en
 * rojo, que es exactamente lo que no ocurrió en las rondas 3, 4 y 5.
 */
export type SabreEnvelopeKeyKind =
  | 'error'
  | 'warning'
  | 'message'
  | 'status'
  | 'benign'
  | 'neutral';

/**
 * Objeto JSON plano, o `null` si el valor es un array o cualquier otra cosa.
 *
 * **Se exporta a propósito.** Existía una copia byte a byte de esta función dentro del cliente
 * HTTP (`asRecord`) y otra de `sabreEnvelopeString` (`str`) — y la segunda YA HABÍA DERIVADO: la
 * del cliente aceptaba `NaN`/`Infinity` porque le faltaba el `Number.isFinite`. Es el mismo patrón
 * exacto que causó el incidente de la ronda 2, donde una copia vieja de la regla dura corría en
 * producción mientras los tests medían la endurecida. Aquí la deriva es hoy inobservable
 * —`JSON.parse` no produce `NaN` ni `Infinity`, así que ningún cuerpo de Sabre puede llegar a esa
 * rama—, pero un duplicado latente es un duplicado: el sitio para arreglarlo es uno solo.
 */
export function sabreEnvelopeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Escalar del sobre normalizado a texto, o `undefined` si no hay contenido utilizable.
 * `NaN`/`Infinity` NO son contenido: se descartan. Ver la nota de `sabreEnvelopeRecord`.
 */
export function sabreEnvelopeString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `Error_Details`, `errorDetails` y `ERRORDETAILS` son la misma clave para esta regla. */
function normalizeEnvelopeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Lee una casilla de un item de problema **con el mismo criterio de caja con el que se leen las
 * claves del sobre**.
 *
 * El recorrido decide qué es `errors`, `Warning` o `ERROR_DETAILS` con `normalizeEnvelopeToken`,
 * o sea sin distinguir caja ni puntuación. Un nivel más abajo, `declaredIssueSeverity`,
 * `issueFromEnvelopeRecord` y `messageIssue` leían `item['severity']`, `item['code']`… con la
 * clave exacta en minúsculas. Esa asimetría era un DESCUIDO, no una decisión, y tenía un agujero
 * fail-open medible:
 *
 *     {"warnings":[{"Severity":"Error","Code":"ERR.1"}]}
 *
 *   → la `S` mayúscula hacía que el item no declarara severidad, así que heredaba `warning` de la
 *     clave contenedora, `failures` quedaba vacío y el sobre se entregaba como ÉXITO. Es
 *     exactamente la degradación que `worstSeverity` existe para impedir, colada por la caja de
 *     una letra. Sabre mezcla las dos convenciones en el mismo sobre —contenedores en PascalCase
 *     (`ApplicationResults`, `Success`, `SystemSpecificResults`, `Message`) y hojas en camelCase
 *     (`code`, `value`, `type`)—, así que asumir una sola caja para las hojas no tiene apoyo en
 *     ningún contrato.
 *
 * El camino rápido es la lectura exacta, que es la que aciertan todos los sobres reales; el barrido
 * normalizado sólo corre cuando la exacta falla. Con empate gana la primera clave del objeto, que
 * es el orden de inserción de `JSON.parse`: determinista y el mismo que ve el resto del recorrido.
 */
function envelopeIssueField(item: Record<string, unknown>, field: string): unknown {
  const direct = item[field];
  if (direct !== undefined) return direct;
  const wanted = normalizeEnvelopeToken(field);
  for (const key of Object.keys(item)) {
    if (normalizeEnvelopeToken(key) === wanted) return item[key];
  }
  return undefined;
}

/**
 * Claves que declaran problemas. La lista explícita cubre los nombres que no terminan en
 * `Error`/`Warning`; el sufijo cubre los que sí (`applicationErrors`, `processingError`, …).
 *
 * `ErrorDetails`/`WarningDetails` están aquí sólo por completitud defensiva: en los contratos
 * reales de hoteles **no son claves**, son **valores de `code`** dentro de `Message[]`
 * (`get-hotel-avail-v5.0.yml:163` y `help/get-hotel-avail-v4/v4-errors.txt:12`). Ese caso, que es
 * el que ocurre de verdad, lo resuelve `envelopeMessageSeverity` por el prefijo del `code`.
 */
const SABRE_ERROR_KEYS: ReadonlySet<string> = new Set([
  'ERROR',
  'ERRORS',
  'ERRORLIST',
  'ERRORCODE',
  'ERRORCODES',
  'ERRORDETAIL',
  'ERRORDETAILS',
  'ERRORMESSAGE',
  'ERRORMESSAGES',
  'ERRORDESCRIPTION',
  'ERRORINFO',
  'FAULT',
  'FAULTS',
  'SOAPFAULT',
  'FAULTCODE',
  'FAULTSTRING',
  'EXCEPTION',
  'EXCEPTIONS',
]);

const SABRE_WARNING_KEYS: ReadonlySet<string> = new Set([
  'WARNING',
  'WARNINGS',
  'WARNINGLIST',
  'WARNINGDETAIL',
  'WARNINGDETAILS',
  'WARNINGMESSAGE',
  'WARNINGMESSAGES',
]);

/**
 * La única posición que el contrato declara éxito. `Success` es propiedad de `ApplicationResults`
 * y de nada más: `get-hotel-avail-v3.yml:707`, `-v4.yml:919`, `-v5.0.yml:2013`,
 * `get-hotel-details-v2.yml:616`, `get-vehicle-availability-v2.yml:1142`,
 * `hotel-price-check-v4.yml:114` y `-v5.yml:194`. En los 21 contratos no hay un solo `Success`
 * colgando de otro sitio.
 */
const SABRE_BENIGN_PARENT = 'APPLICATIONRESULTS';
const SABRE_BENIGN_KEY = 'SUCCESS';

/**
 * Las claves que TRANSPORTAN el contexto benigno hacia abajo, y son exactamente las que el
 * contrato declara dentro de `Success[]` (`ElementStructure`: `SystemSpecificResults[].Message[]`,
 * `get-hotel-avail-v5.0.yml:2023-2072`). Cualquier otra clave corta el contexto en seco.
 *
 * Esta lista es corta A PROPÓSITO. `ElementStructure` declara además `type`, `timeStamp`,
 * `reference`, `HostCommand`, `ShortText`, `Element`, `RecordID` y `DocURL`, pero ninguno puede
 * contener un `Message[]`: dejarlos fuera no rompe ningún sobre real y quita superficie donde
 * esconder un fallo.
 */
const SABRE_BENIGN_CARRIER_KEYS: ReadonlySet<string> = new Set([
  'SYSTEMSPECIFICRESULTS',
  'MESSAGE',
]);

/**
 * `errorHandlingPolicy` (`booking-management-v1.yml:352,492,566,698`) es campo de **request**, no
 * de respuesta, y además no encaja en ninguna regla de abajo. Se comprueba en el test para que
 * nadie lo convierta en un falso positivo al ampliar la lista.
 *
 * `benign` es el único veredicto que depende del PADRE, y esa es la corrección de la ronda 4. Se
 * concedía por el nombre de la clave suelto: cualquier cosa que normalizara a `SUCCESS` —a
 * cualquier profundidad, bajo cualquier padre— apagaba el recorrido de todo su subárbol. Medido
 * por la puerta pública, `{success:{messages:[{content:'Booking failed'}]}}` se entregaba como
 * reserva confirmada mientras `{wrapper:{messages:[{content:'Booking failed'}]}}` —idéntico salvo
 * el NOMBRE— se rechazaba. Sólo el nombre de una clave separaba una reserva fantasma de un fallo
 * detectado, y eso reabría el bypass 6 de la ronda 1.
 *
 * `SUCCESSES` ya no concede nada: no es clave de ningún contrato, y una clave que el contrato no
 * declara no puede declarar éxito.
 *
 * `benignAllowed` es la corrección de la ronda 7 y va un nivel por encima: la posición
 * `ApplicationResults.Success` sólo puede conceder nada si **el contrato de la operación que se
 * está llamando** declara `ApplicationResults` (ver `SABRE_APPLICATION_RESULTS_PATHS`). Ocho de
 * los 21 contratos lo declaran y los ocho son lecturas; ninguna operación de dinero. Sin este
 * filtro, un `createBooking` podía apagar el recorrido de un subárbol entero con una forma que su
 * propio contrato no menciona en ningún sitio.
 *
 * El sufijo `PROCESSINGSTATUS` no sale de ningún `.yml` —ninguno de los 21 usa esa clave— y es
 * defensa por variante de nombre: `{orderProcessingStatus:'NotProcessed'}` es un fallo declarado y
 * sin el sufijo caería en `neutral`, o sea en éxito. Está fijado por la puerta pública en
 * `errors.operation-context.test.ts`; borrarlo pone la suite en rojo.
 */
function envelopeKeyKind(
  normalized: string,
  parentToken: string | undefined,
  benignAllowed: boolean,
): SabreEnvelopeKeyKind {
  if (SABRE_ERROR_KEYS.has(normalized)) return 'error';
  if (SABRE_WARNING_KEYS.has(normalized)) return 'warning';
  if (normalized.endsWith('ERRORS') || normalized.endsWith('ERROR')) return 'error';
  if (normalized.endsWith('WARNINGS') || normalized.endsWith('WARNING')) return 'warning';
  if (normalized === 'MESSAGE' || normalized === 'MESSAGES') return 'message';
  if (normalized === 'STATUS' || normalized.endsWith('PROCESSINGSTATUS')) return 'status';
  if (benignAllowed && normalized === SABRE_BENIGN_KEY && parentToken === SABRE_BENIGN_PARENT)
    return 'benign';
  return 'neutral';
}

/**
 * `status` de `ApplicationResults`: `Complete | Incomplete | NotProcessed | Unknown`
 * (`get-hotel-avail-v5.0.yml:2005-2012`, idéntico en v4). **`Complete` es el único valor que
 * demuestra que la operación terminó**; los otros tres son fallo.
 *
 * `Incomplete` y `Unknown` se entregaban como éxito con un warning, y ese es el mismo fail-open de
 * siempre visto de lado: en un `createBooking`, «incompleto» es literalmente la reserva a medias y
 * «desconocido» es Sabre admitiendo que ni él sabe si la hizo. Entregar eso como 200 bueno es la
 * reserva fantasma que este fichero existe para no producir.
 *
 * **Dónde cae el coste.** El clasificador no sabe qué operación corre —`classifySabreEnvelope`
 * recibe el sobre y nada más—, así que la decisión es una sola para lectura y escritura. Se elige
 * la de escritura: un `Incomplete` en una búsqueda cuesta un reintento y, si el reintento tampoco
 * completa, el vendedor ve un error en vez de resultados parciales sin avisar de que lo son; un
 * `Incomplete` en una reserva cobrada cuesta un pasajero en tierra. Si el tráfico real demostrara
 * que las búsquedas devuelven `Incomplete` a menudo y que degradar sale mejor ahí, la forma de
 * distinguir es pasar la operación al clasificador (segundo parámetro con el path), NO relajar el
 * literal: relajarlo lo relaja también para el dinero.
 *
 * No se invierte a «todo lo que no sea Complete»: `status` es una clave frecuentísima fuera de
 * `ApplicationResults` (estado de un segmento `HK`, de un pago, de un pasajero) y el recorrido la
 * mira en cualquier posición. Se comparan los tres literales del enum y nada más.
 */
const SABRE_STATUS_NOT_COMPLETE: ReadonlySet<string> = new Set([
  'NOTPROCESSED',
  'INCOMPLETE',
  'UNKNOWN',
]);

/*
 * Dos dialectos conviven: BFM v3/v4/v5 usa `severity ∈ {Info, Warning, Error, Diagnostic, Header}`
 * (`bargain-finder-max-v5.yml:4303-4335`) y Offer Price NDC usa `type ∈ {ERROR, WARNING, INFO}`
 * (`offer-price-ndc-v1.yml:869-905`). Se miran los dos campos a la vez.
 *
 * Se comparan **tokens completos**, no subcadenas. El BFM real manda `type: "DEFAULT"`
 * (`bargain-finder-max-v5.yml:165`) y `"DEFAULT"` contiene `"FAULT"`: con una regex de subcadena,
 * cada búsqueda legítima de vuelos se caía sola. La carga de la prueba invertida sólo funciona si
 * la señal de error es precisa; si no, el equipo la desactiva en una semana y volvemos al agujero.
 */
const SABRE_SEVERITY_ERROR_TOKENS: ReadonlySet<string> = new Set([
  'ERROR',
  'ERRORS',
  'FATAL',
  'FAIL',
  'FAILED',
  'FAILURE',
  'FAULT',
  'SEVERE',
  'CRITICAL',
]);
const SABRE_SEVERITY_WARNING_TOKENS: ReadonlySet<string> = new Set([
  'WARN',
  'WARNING',
  'WARNINGS',
  'CAUTION',
]);
/** Los únicos valores que **demuestran** que un mensaje es inocuo. Lo demás no se presume. */
const SABRE_SEVERITY_BENIGN_TOKENS: ReadonlySet<string> = new Set([
  'INFO',
  'INFORMATION',
  'INFORMATIONAL',
  'DIAGNOSTIC',
  'HEADER',
  'SUCCESS',
  'DEBUG',
  'TRACE',
  'NOTE',
  'NOTICE',
  'COMPLETE',
  'COMPLETED',
  'OK',
]);

function severityTokens(...values: Array<string | undefined>): string[] {
  return values
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => value.toUpperCase().split(/[^A-Z0-9]+/))
    .filter((token) => token.length > 0);
}

// El `code` de los mensajes de hoteles lleva la severidad en el prefijo: `ERR.0161`, `WARN.0788`,
// y los literales `ErrorDetails` / `WarningDetails` (`help/get-hotel-avail-v4/v4-errors.txt:12,49`).
const SABRE_CODE_ERROR_PREFIX = /^(ERR|FAULT|FATAL)/i;
const SABRE_CODE_WARNING_PREFIX = /^WARN/i;

/**
 * Forma de un identificador de código: sin espacios y corto. Es el PRIMERO de los tres filtros de
 * publicación ({@link isPublishableIssueValue}); lo que separa de verdad es la PROSA, porque una
 * frase del proveedor trae espacios y un identificador no.
 *
 * **El techo era 64 y son 96, y el cambio tiene una medición detrás.** Siete tipos de error
 * OFICIALES de Booking Management pasan de 64 caracteres —el más largo,
 * `UNABLE_TO_MODIFY_BOOKING_SPECIAL_SERVICE_TRAVELER_ASSOCIATION_INVALID`, mide 69— y con el techo
 * anterior los siete salían publicados como `FREE_TEXT_REDACTED`: vocabulario cerrado del contrato
 * perdido en el log, un falso positivo que llevaba aquí desde que se escribió la regla. Subirlo se
 * puede porque la longitud ya no es lo que sostiene la protección: eso lo hace ahora
 * {@link isContractWordShaped}, y una tirada larga sin estructura de palabra no pasa por muchos
 * caracteres que quepan. 96 deja 27 de margen sobre el máximo medido.
 */
const SABRE_SAFE_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;

/**
 * Forma de una RUTA DE CAMPO. Es la de arriba más `[` y `]`, y la diferencia no es cosmética.
 *
 * `fieldPath` es el «DÓNDE» del diagnóstico y los contratos 2SG lo publican indexado:
 * `travelers[0].passport`, `fare.programs[0].values`. Con la forma de código a secas los corchetes
 * la tumban y soporte pierde el único dato que le dice qué campo de la request iba mal — un coste
 * caro y evitable, porque una ruta de schema no es contenido del pasajero: la ruta dice `passport`,
 * el número de pasaporte vive en `fieldValue`, que no entra en el issue por nada del mundo.
 *
 * Lo que sostiene la protección sigue intacto y es lo mismo en las dos formas: **sin espacios y
 * corta**. La frase del proveedor («PNR XKCD12 not found for specified ticket SMITH/JOHNMR») no
 * pasa ninguna de las dos, y ésa es la propiedad que fija el test, no la lista de caracteres.
 *
 * Lo que esta forma NO sostiene —y el comentario anterior daba a entender que sí— es la ausencia
 * de PII: `travelers[0].passport` y `AB1234567` pasan las dos igual de bien. Eso lo decide el
 * segundo filtro, {@link isContractWordShaped}.
 */
const SABRE_SAFE_FIELD_PATH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,95}$/;

const SABRE_UNAUTHORIZED_MARK = /UNAUTHORIZED|RESOURCE_RESTRICTED/i;

/**
 * La casilla del issue **traía** algo y ese algo era prosa del proveedor, no un identificador.
 *
 * Existe porque la alternativa —borrar la casilla— pierde información que no es del proveedor: un
 * `code` ausente y un `code` que venía relleno de una frase son dos diagnósticos distintos, y sin
 * marca soporte no puede distinguir «Sabre no mandó código» de «Sabre mandó una frase donde iba el
 * código», que apunta a sitios opuestos (a nuestro parser lo primero, a su plantilla lo segundo).
 *
 * Es vocabulario NUESTRO, cerrado: nunca viaja un solo byte del proveedor dentro. Y pasa
 * `SABRE_SAFE_CODE_SHAPE`, así que la puerta es idempotente.
 */
export const SABRE_ISSUE_FREE_TEXT = 'FREE_TEXT_REDACTED';

/**
 * Lo mismo, pero la prosa contenía la marca de entitlement (`UNAUTHORIZED` /
 * `RESOURCE_RESTRICTED`).
 *
 * No es adorno: `partialUnauthorized` se calcula filtrando `category`/`type` por
 * `SABRE_UNAUTHORIZED_MARK`, y es lo único que convierte «datos capados por suscripción» en un
 * aviso al vendedor en vez de en «no hay vuelos» en pantalla (RNF-13). Redactar a secas mataría
 * esa señal en silencio justo en el caso en que el proveedor interpola su plantilla `%s`. Lo que
 * viaja sigue siendo una constante nuestra: del texto original sólo se conserva el resultado de
 * un predicado booleano, jamás su contenido.
 */
export const SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED = 'FREE_TEXT_REDACTED_UNAUTHORIZED';

/**
 * La casilla traía algo que **no** era prosa —sin espacios y corto— pero tampoco era vocabulario:
 * era un IDENTIFICADOR OPACO. Un localizador, un billete, un pasaporte, un teléfono.
 *
 * Se separa de `FREE_TEXT_REDACTED` porque los dos casos apuntan a sitios distintos y esa
 * distinción es todo lo que le queda a soporte cuando el valor no viaja: `FREE_TEXT_REDACTED`
 * dice «Sabre puso una frase donde iba un identificador» (mirar su plantilla `%s`);
 * `OPAQUE_VALUE_REDACTED` dice «Sabre puso un dato, no una etiqueta» (mirar de qué tercero viene
 * el eco). Es vocabulario NUESTRO y pasa la puerta, así que la puerta es idempotente.
 */
export const SABRE_ISSUE_OPAQUE_VALUE = 'OPAQUE_VALUE_REDACTED';

/**
 * Separadores de un identificador de contrato. `:` y `/` NO están, y ésa es la mitad del filtro:
 * el `clientId` de Sabre (`V1:500001:ZZ1A:AA`) y el nombre de pasajero en formato GDS
 * (`SMITH/JOHNMR`) son exactamente lo que se separa con esos dos, y ninguno de los 655 valores
 * del expediente contiene `:` ni `/` (medido por el corpus de `errors.issue-vocabulary.test.ts`).
 */
const SABRE_ISSUE_SEGMENT_SEPARATOR = /[._\-[\]]+/;

/**
 * Un segmento de PALABRA. Techo 32 contra los 28 del segmento más largo del expediente
 * (`BRANDED_FARE_INVALID_SEGMENT_SELECTION` y compañía).
 */
const SABRE_ISSUE_WORD_SEGMENT = /^[A-Za-z]{1,32}$/;

/**
 * Un segmento NUMÉRICO. El techo de 4 no es redondeo: es el ancho máximo medido en el expediente
 * entero (`ERR.0161`, `WARN.0788`, `ERR.0123`, `ERR.0322`, `ERR.0381`, `ERR.0724`) y a la vez
 * queda por debajo de todo identificador de viaje que importe — EPR 6, localizador 6, teléfono 12,
 * billete 13, PAN 13-19. Cuatro dígitos sueltos no identifican a nadie.
 *
 * Coste explícito: si Sabre publica algún día un código de cinco dígitos, ese código se PUBLICA
 * como `OPAQUE_VALUE_REDACTED` en vez de entero. No cambia el veredicto —la clasificación mira el
 * `code` crudo, ver la nota de `safeIssueField`— y el corpus de `errors.issue-vocabulary.test.ts`
 * extrae la columna `Code` de las tablas de hoteles con ancho de 3 a 6 dígitos PRECISAMENTE para
 * que ese día la suite se ponga roja, que es cuando hay que decidir a mano si se sube el techo.
 */
const SABRE_ISSUE_NUMERIC_SEGMENT = /^[0-9]{1,4}$/;

/**
 * Cuántos segmentos numéricos puede tener un valor. Sin este tope, el ancho de 4 se esquiva
 * troceando: `ref.1989-04-17` es una fecha de nacimiento entera con tres segmentos de dos y cuatro
 * dígitos, y `card.4111-1111-1111-1111` es un PAN con cuatro.
 *
 * El expediente tiene como máximo UNO (`ERR.0161`, `travelers[0].passport`). Se admiten dos por el
 * único caso legítimo que puede pasar de uno: una ruta doblemente indexada del estilo
 * `travelers[0].identityDocuments[0].documentNumber`, que es diagnóstico puro y no lleva dato.
 */
const SABRE_ISSUE_MAX_NUMERIC_SEGMENTS = 2;

/**
 * Un segmento MIXTO (letras y dígitos juntos) sólo se admite si es un acrónimo corto.
 *
 * En los 655 valores del expediente hay **exactamente uno**: `2SG`, el identificador del gateway
 * que encabeza toda la tabla `ERR.2SG.*`. Tres es lo que mide, y cuatro es lo que mide el PCC
 * (`ZZ1A`), que es el identificador de viaje mixto más corto que existe. El techo cae entre los
 * dos a propósito: es la frontera medida, no un número elegido.
 */
const SABRE_ISSUE_ACRONYM_SEGMENT = /^[A-Za-z0-9]{1,3}$/;

/**
 * El valor está compuesto de PALABRAS, que es lo que distingue una etiqueta de contrato de un dato.
 *
 * **La raíz que esto corrige.** La puerta anterior filtraba por FORMA —«sin espacios y corta»— y
 * el comentario que la justificaba decía que así «se conserva el vocabulario cerrado, se pierde la
 * prosa». La suposición de debajo es que lo peligroso siempre trae espacios, y la PII de viajes es
 * justo lo contrario: `AB1234567`, `XKCD12`, `0012345678901`, `573001234567`, `ZZ1A` son cortos y
 * no tienen ni un espacio. Medido por `postJson`, los cuatro huecos del `SabreIssue` publicaban
 * literal cualquiera de ellos.
 *
 * La regla nueva mira la ESTRUCTURA en vez del alfabeto: se trocea por separadores y cada trozo
 * tiene que ser una palabra, un número corto o un acrónimo corto; **al menos uno tiene que ser
 * palabra** y los numéricos no pueden pasar de dos. El vocabulario del contrato está hecho de
 * palabras (`APPLICATION_ERROR`, `BusinessLogic`, `ERR.2SG.SEC.NOT_AUTHORIZED`,
 * `passenger.givenName`); los identificadores de viaje están hechos de dígitos mezclados con
 * letras sin estructura de palabra. Medido por la puerta pública contra los 655 valores del
 * expediente (`help/*error-list*.txt`, la tabla 2SG, los códigos numéricos de hoteles y los
 * `example:` de `category`/`type`/`fieldPath` de los 21 `.yml`): **0 rechazados**.
 *
 * **Lo que esta regla NO puede hacer, dicho sin adornos.** Un apellido escrito sin separador
 * —`SMITHJOHNMR`— es un segmento de letras y sale publicado igual que `TIMEOUT`. No hay forma de
 * distinguirlos sin una lista cerrada, y la lista cerrada no se puede derivar: los 21 contratos
 * declaran `category` y `type` como `type: string` con un `example:`, **sin un solo `enum`** (0 de
 * 21, medido), y sólo Booking Management ya enumera 527 valores en su documentación. Lo que la
 * regla sí elimina es todo identificador de viaje que lleve dígitos o el separador `/` de nombre
 * GDS, que es la forma que tienen los que de verdad circulan.
 */
function isContractWordShaped(value: string): boolean {
  const segments = value.split(SABRE_ISSUE_SEGMENT_SEPARATOR).filter((s) => s.length > 0);
  let words = 0;
  let numbers = 0;
  for (const segment of segments) {
    if (SABRE_ISSUE_WORD_SEGMENT.test(segment)) {
      words += 1;
      continue;
    }
    if (SABRE_ISSUE_NUMERIC_SEGMENT.test(segment)) {
      numbers += 1;
      continue;
    }
    if (SABRE_ISSUE_ACRONYM_SEGMENT.test(segment)) continue;
    return false;
  }
  return words > 0 && numbers <= SABRE_ISSUE_MAX_NUMERIC_SEGMENTS;
}

/**
 * Las pasadas POR FORMA de `redaction.ts` aplicadas al valor del issue: `clientId` `V1:…`, el
 * `secret` `VmpF…`/`VjE6…`, un JWT `eyJ…` y un PAN confirmado por Luhn.
 *
 * Se IMPORTA `redactText`, no se reescribe. Este paquete ya pagó una vez el precio de la segunda
 * copia de una regla (`asRecord`/`str`, ronda 2): la copia débil corrió en producción mientras el
 * original estaba bien. Si `redaction.ts` aprende una forma nueva, esta puerta la aprende el mismo
 * día y sin tocarla.
 *
 * **Hoy esta pasada NO tiene efecto observable, y se deja escrito porque lo contrario sería otro
 * comentario que promete de más.** Medido con sonda de comportamiento: quitarla entera deja la
 * suite en verde. Es un MUTANTE EQUIVALENTE con la tijera estructural en su tamaño actual, no un
 * hueco de test, y el argumento se cierra enumerando qué necesita cada pasada de `redactText` y
 * qué prohíbe {@link isContractWordShaped}:
 *
 *   - `JSON_PAIR` / `FORM_PAIR` / `XML_ELEMENT` / `PROSE_PAIR` exigen `"`, `=`, `<>` o `:`/espacio.
 *     Ninguno es separador ni carácter de segmento: el valor se rechaza antes.
 *   - `SABRE_CLIENT_ID` exige `:`. Igual.
 *   - `SABRE_SECRET_SHAPE` (`VmpF`+8), `JWT_SHAPE` (`eyJ`+6) y `LONG_BASE64_RUN` (32 seguidos)
 *     producen un segmento mixto de 9 caracteres o más; el techo de acrónimo es 3.
 *   - `PAN_CANDIDATE` exige 13-19 dígitos: no caben en un segmento de 4, y trocearlos con `-`
 *     produce cuatro segmentos numéricos, por encima del tope de dos.
 *
 * Se queda por lo que pasa el día que alguien afloje uno de esos techos —que es exactamente el
 * movimiento que hace un falso positivo urgente en producción—: aflojado el techo, la credencial
 * vuelve a colarse por la estructura y esta pasada es lo único que sigue en pie. Ese es su valor, y
 * es todo su valor.
 */
function carriesNoCredentialShape(value: string): boolean {
  return redactText(value) === value;
}

/**
 * Cola de SEVERIDAD de una categoría compuesta. El `/` no es separador de vocabulario en
 * {@link isContractWordShaped} —es la marca de un nombre GDS, `SMITH/JOHNMR`— y esa decisión es
 * la que hay que preservar; lo que esta forma añade es la única excepción que el expediente
 * respalda.
 *
 * Medido sobre `docs/sabre/evidence/specs/` entero: hay 44 valores compuestos y **los 44 acaban
 * en la misma cola** — `CANCELLATION_ERROR/WARNING` (×36), `CHECK_ERROR/WARNING` (×6),
 * `APPLICATION_ERROR/WARNING`, `RS/Warning`. No hay ninguna otra cola, y el `.yml` explica por
 * qué: la cola dice de qué severidad sale la categoría según el `ErrorHandlingPolicy` de la
 * request, no es contenido.
 *
 * **Lo que esto cuesta, dicho entero.** Ensancha la puerta para valores que terminen exactamente
 * en `/WARNING` o `/ERROR`: un nombre GDS cuyo nombre de pila fuese literalmente `WARNING` se
 * publicaría. La cabeza sigue teniendo que pasar los tres filtros, así que `AB1234567/WARNING`,
 * `SMITH/JOHNMR/WARNING` y `XKCD12/ERROR` siguen sin pasar — lo fija el bloque 4 de
 * `errors.category-normalization.test.ts`, y por las seis superficies.
 */
const SABRE_ISSUE_COMPOSITE_SEVERITY = /^(.+)\/(?:WARNING|ERROR)$/i;

/**
 * ¿Puede este valor CRUDO publicarse tal cual en una casilla del `SabreIssue`?
 *
 * Fuente única para los tres caminos que publican (`issueFromEnvelopeRecord`, `messageIssue`,
 * `scalarIssue`). Hasta la ronda 9 la regla vivía en uno solo y los otros dos no la aplicaban; el
 * arreglo de entonces la puso en dos de los tres. Con un predicado y no tres condiciones no queda
 * sitio donde el próximo camino se olvide de pasar por aquí.
 *
 * La estructura se mide sobre la CABEZA de la compuesta y los otros dos filtros sobre el valor
 * ENTERO: la cola de severidad no es contenido, pero tampoco puede servir de coartada para colar
 * una credencial detrás de ella.
 */
function isPublishableIssueValue(raw: string, shape: RegExp): boolean {
  const vocabulary = SABRE_ISSUE_COMPOSITE_SEVERITY.exec(raw)?.[1] ?? raw;
  return shape.test(raw) && isContractWordShaped(vocabulary) && carriesNoCredentialShape(raw);
}

/**
 * La puerta ÚNICA por la que un valor del proveedor entra en una casilla del `SabreIssue`.
 *
 * `SabreIssue` se LOGUEA entero (`toLogMeta`), y esos logs los lee soporte, viajan a
 * monitorización y acaban pegados en tickets. Por eso la regla de `SABRE_SAFE_CODE_SHAPE` —«sólo
 * lo que tiene forma de identificador»— no puede vivir en un solo camino: hasta esta ronda la
 * aplicaba `scalarIssue` y NO la aplicaban los dos caminos de record, así que un
 * `{"code":"PNR XKCD12 not found for specified ticket SMITH/JOHNMR"}` publicaba nombre y
 * localizador en el log. En CO/PE/BR eso es exposición regulatoria, y vendiendo a otras agencias
 * es además contractual.
 *
 * Son TRES filtros en serie y cada uno tapa lo que el anterior no ve
 * ({@link isPublishableIssueValue}):
 *
 *   1. la FORMA (`SABRE_SAFE_CODE_SHAPE`): sin espacios y corta — la prosa;
 *   2. la ESTRUCTURA ({@link isContractWordShaped}): compuesto de palabras — los identificadores
 *      de viaje, que son cortos y sin espacios y por eso se colaban por (1);
 *   3. las pasadas por forma de `redaction.ts` ({@link carriesNoCredentialShape}): credenciales y
 *      PAN, que pueden esconderse dentro de una estructura de palabras impecable.
 *
 * Lo que se conserva y lo que se pierde, escrito entero:
 *
 *   - **Se conserva** todo el vocabulario cerrado de los contratos —`ERR.2SG.SEC.NOT_AUTHORIZED`,
 *     `APPLICATION_ERROR`, `BusinessLogic`, `passenger.givenName`, `ERR.0161`—. Medido contra los
 *     655 valores del expediente: 0 rechazados. El diagnóstico normal no cambia ni un byte.
 *   - **Se conserva** que la casilla venía rellena, y con qué severidad y en qué operación.
 *   - **Se conserva** la marca de entitlement, por el sentinel de arriba, y la conserva **caiga
 *     por el filtro que caiga**: `partialUnauthorized` es lo único que separa «datos capados por
 *     suscripción» de «no hay vuelos» (RNF-13), y esa señal no puede depender de por qué se
 *     redactó.
 *   - **Se pierde** el texto exacto del error cuando el proveedor manda prosa donde el contrato
 *     promete un identificador. Soporte ve `FREE_TEXT_REDACTED` y sabe que hay una frase que no
 *     puede leer desde el log; para leerla hay que ir a la traza de Sabre con el `conversationId`,
 *     que sí viaja. Es el coste aceptado: el `conversationId` es correlación sin PII.
 *   - **Se pierde** el identificador opaco que el proveedor meta en un hueco de vocabulario.
 *     Soporte ve `OPAQUE_VALUE_REDACTED`, que es la señal de que ahí llegó un dato y no una
 *     etiqueta — y esa señal, por sí sola, es el aviso de que hay un eco de tercero que revisar.
 *   - **Se pierde** el desempate por `category` en `classifySabreFailure` cuando la categoría es
 *     prosa (`FREE_TEXT_REDACTED_UNAUTHORIZED` no es el literal `UNAUTHORIZED`). No cambia nada
 *     medible: las 21 categorías del contrato son literales sin espacios y siguen entrando.
 *
 * **Por qué esto es defensa en profundidad y no el parche de una fuga demostrada.** Ningún
 * contrato congelado pone PII en estas cuatro casillas hoy: en Booking Management `type` y
 * `category` son vocabulario. Pero ninguno de los 21 lo DECLARA —cero `enum`, `type: string` con
 * un `example:`— y Sabre es un agregador que hace eco de terceros. «El proveedor sólo manda
 * vocabulario cerrado» es la misma suposición que ya falló cuatro veces en este fichero.
 *
 * La CLASIFICACIÓN no pasa por aquí y no debe: `declaredIssueSeverity` mira el `code` CRUDO para
 * su prefijo (`ERR.0161`), igual que el constructor de `SabreApiError` clasifica sobre el texto
 * crudo antes de redactar. Redactar antes de clasificar convertiría un error reconocido en uno
 * genérico. Se clasifica con lo crudo; se PUBLICA sólo lo redactado.
 */
function safeIssueField(value: unknown, shape: RegExp = SABRE_SAFE_CODE_SHAPE): string | undefined {
  const raw = sabreEnvelopeString(value);
  if (raw === undefined) return undefined;
  if (isPublishableIssueValue(raw, shape)) return raw;
  if (SABRE_UNAUTHORIZED_MARK.test(raw)) return SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED;
  // La forma es lo que separa los dos diagnósticos: si NO la pasa es una frase; si la pasa y aun
  // así no se publica, es un identificador que no es vocabulario.
  return shape.test(raw) ? SABRE_ISSUE_OPAQUE_VALUE : SABRE_ISSUE_FREE_TEXT;
}

/**
 * Las casillas de VOCABULARIO que un item de problema puede traer, normalizadas con
 * {@link normalizeEnvelopeToken} — el mismo criterio de caja y puntuación con el que
 * {@link envelopeIssueField} las lee para construir el `SabreIssue`.
 *
 * Que sea el mismo normalizador no es estética: leer `code` en minúsculas exactas y dejar pasar
 * `Code` es exactamente la asimetría fail-open que la ronda 10 encontró un nivel más abajo. Aquí
 * costaría lo mismo — `{"Code":"AB1234567"}` saldría del filtro sin tocar.
 *
 * La lista no es «las claves que suenan a código»: es exactamente **de dónde saca este paquete un
 * valor que luego publica**. Las cuatro primeras las lee `issueFromEnvelopeRecord` para el
 * `SabreIssue`; `errorCode` y `error` son las dos de las que el carril de transporte saca
 * `SabreApiError.code` (`{status, type, errorCode, timeStamp, message}` de docs/sabre/09 §2.1, y
 * el `error` de OAuth2 RFC 6749 de `/v2/auth/token`). Si el paquete publica ese valor, tiene que
 * publicarlo por la misma puerta en las seis superficies; si no lo publica, no se toca — y ésa es
 * la línea, no una intuición sobre el nombre de la clave.
 */
const SABRE_ISSUE_SLOT_KEYS: ReadonlySet<string> = new Set(
  ['category', 'type', 'code', 'errorCode', 'error', 'fieldPath'].map(normalizeEnvelopeToken),
);

/**
 * Un par `"clave": "valor"` de JSON.
 *
 * **El valor NO lleva tope, y el tope que llevaba era un agujero.** Estaba acotado a 256 caracteres
 * «por si acaso», y el efecto medido fue el contrario del que se buscaba: un valor de casilla más
 * largo que el tope no casa el par, así que la puerta no lo ve y sale ENTERO por el `body` y por el
 * `message`. Un tope que hace que un valor grande se salte el filtro es fail-open, y el valor
 * grande es justo lo que manda quien quiere colar algo. Sin tope, un valor enorme se juzga entero,
 * no pasa la estructura y sale como una marca — que es el lado correcto.
 *
 * No hay riesgo de retroceso catastrófico: las clases de caracteres excluyen el delimitador que las
 * cierra, así que el emparejado es lineal en el tamaño del cuerpo.
 *
 * La CLAVE sí se acota a 64, y ahí el tope no puede abrir nada: las seis claves de
 * {@link SABRE_ISSUE_SLOT_KEYS} miden nueve caracteres o menos, así que un par que se salte el
 * tope tiene por fuerza una clave que no es casilla.
 */
const SABRE_JSON_PAIR = /\x22([^\x22\\]{1,64})\x22(\s*:\s*)\x22([^\x22\\]*)\x22/g;

/**
 * La MISMA puerta de publicación del `SabreIssue`, aplicada a las mismas casillas cuando viajan
 * por la OTRA salida: `error.message` y `error.body`.
 *
 * ## Qué se midió
 *
 * Por `postJson`, con `{"errors":[{"severity":"Error","<casilla>":"<testigo>"}]}` y 14 datos
 * reales de viaje × 4 casillas: **40 de 56 llegaban literales al `message` y las mismas 40 al
 * `body`** — pasaporte, localizador, billete, nombre GDS, teléfono, EPR, PCC, fecha de nacimiento,
 * email y número de viajero frecuente. La ronda 11 cerró ese mismo dato en `issues`, en
 * `toLogMeta()` y en el `LoggerPort`; el mensaje y el cuerpo no pasaban por ninguna puerta de
 * vocabulario, sólo por las pasadas por clave y por forma de `safeBodySummary`. Y el mensaje es
 * justo de donde tira monitorización cuando algo revienta.
 *
 * ## Por qué POR CASILLA y no sobre el texto entero
 *
 * Porque el texto entero ya tiene una política, es deliberada y está medida: `error.body` es el
 * eco diagnóstico del cuerpo y conserva todo lo que las rejillas de `redaction.ts` no tapan
 * —`reason: ABC1`, `errorCode: ERR.2SG.*`, `fieldName: itemId`, un importe, un `404`—. Pasar el
 * cuerpo ENTERO por la puerta de vocabulario se probó y se midió: deja **37 tests en rojo repartidos
 * por 8 ficheros**, y la mayoría son de FALSO POSITIVO, que existen precisamente para fijar que no
 * se tapa de más. Caían un importe, `reason: ABC1`, un número de referencia con guiones, los
 * códigos numéricos de hoteles y hasta nuestro propio literal «respuesta 2xx no parseable como
 * JSON», al que la regla le come el `2xx`. Un error indiagnosticable es un fallo operativo aunque
 * no sea de seguridad.
 *
 * Lo que sí es defendible —y lo que se hace— es la SIMETRÍA: el valor que la puerta del issue no
 * publica tampoco puede salir por el mensaje bajo la misma clave. Ni una regla nueva, ni un
 * segundo criterio: las mismas claves (`SABRE_ISSUE_SLOT_KEYS`), la misma forma por casilla y el
 * mismo `safeIssueField`. Si esa puerta aprende algo, esto lo aprende el mismo día.
 *
 * ## Se aplica al cuerpo CRUDO, antes de resumir
 *
 * Y no al resumen ya cortado, por dos razones medidas: el corte puede partir un valor en dos y
 * dejar media casilla fuera del par (fail-open en el borde), y la puerta tiene que juzgar el valor
 * ENTERO — media cadena puede pasar la estructura que la cadena completa no pasa. Es el mismo
 * motivo por el que `redactLooseText` redacta antes y después de truncar.
 *
 * ## El límite, dicho sin adornos
 *
 * Esto reconoce el dialecto JSON, que es el de los 21 contratos REST y el de todo lo que hoy
 * llega. Una casilla echada en XML/SOAP (`<code>AB1234567</code>`) NO pasa por aquí y sigue
 * saliendo entera en el `body`. No se cierra en este fichero a propósito: los tres dialectos viven
 * en las rejillas de `redaction.ts`, y una cuarta copia del emparejamiento clave-valor aquí es
 * exactamente cómo empiezan a divergir dos reglas en este paquete. El límite está fijado por test
 * (`errors.message-body-gate.test.ts` §4) para que se vea, no para que se olvide.
 */
/**
 * Un TOKEN dentro de un valor que el proveedor ha CONCATENADO: la tirada que hay que juzgar entera.
 *
 * Empieza y acaba en alfanumérico (o `]`, por las rutas indexadas) para que la puntuación de
 * alrededor no arrastre al token: `invalid_client:` se juzga como `invalid_client` y los dos
 * puntos se quedan donde estaban.
 *
 * **Dentro va todo lo que podría ser parte de un dato** —`@` de un email, `+` de un teléfono, `:`
 * de un `clientId`, `/` de un nombre GDS— y sólo separan los caracteres que son ESTRUCTURA y nunca
 * contenido: espacios, comillas, llaves, paréntesis, comas, `=`, `<>`, y las guillas de las marcas
 * de `redaction.ts`. Medido: con el alfabeto de {@link SABRE_SAFE_FIELD_PATH_SHAPE},
 * `juan.perez@agencia.com.co` se parte en `juan.perez` y `agencia.com.co` —los dos vocabulario
 * impecable— y el `@` los volvía a pegar en la salida. Cualquier carácter que la forma no admita
 * tiene que dejar al token ENTERO fuera de la puerta, que es el lado seguro.
 *
 * Las comillas van como `\x22`/`\x27`/`\x60` y no como caracteres: el tokenizador de
 * `errors.traversal.guard.test.ts` no distingue un literal de expresión regular de una cadena, así
 * que una comilla suelta aquí dentro le abre una cadena imaginaria y descuadra el emparejado de
 * llaves con el que mide la guarda anti-recurrencia. Medido: con las comillas literales, ese
 * fichero entero deja de poder cargar.
 */
const SABRE_JOINED_TOKEN = /[A-Za-z0-9](?:[^\s\x22\x27\x60{}()<>,;=!?|*«»\\]*[A-Za-z0-9\]])?/g;

/**
 * Tope del `code` ya filtrado. La sustitución CRECE —un `ZZ1A` de cuatro caracteres sale como un
 * sentinel de veintiuno— y `code` es un campo del proveedor sin longitud declarada en ningún
 * contrato. Un código real no se acerca: la forma que los publica corta en 96.
 */
const SABRE_SAFE_CODE_MAX_CHARS = 512;

/**
 * La misma puerta, aplicada TOKEN A TOKEN al `code`.
 *
 * ## Por qué este campo no se juzga entero
 *
 * Porque Sabre lo CONCATENA. En `/v2/auth/token` el `error` de OAuth2 llega como
 * `invalid_client:V1:{EPR}:{PCC}:{Domain}:{secret}` (docs/sabre/01 §5.3): un literal de la tabla
 * pegado con dos puntos al eco de nuestra propia request. Juzgado entero no pasa la forma y sale
 * como una sola marca — y con él se va `invalid_client`, que es el literal que le dice a soporte
 * por qué el veredicto fue `AUTH_POOL` y no una credencial revocada. Es la diferencia entre tumbar
 * una agencia entera por una saturación temporal y no tumbarla.
 *
 * Troceando, sobrevive lo que es vocabulario y cae lo que no:
 *
 *     invalid_client:«REDACTADO»:«REDACTADO»   → intacto
 *     AB1234567                                → OPAQUE_VALUE_REDACTED
 *
 * ## Por qué el cuerpo no se trata así y este campo sí
 *
 * El cuerpo tiene claves: se sabe qué campo es vocabulario y se juzga ese valor entero, que es
 * exactamente lo que hace la puerta del issue. Aquí no hay clave que acotar —el campo YA viene
 * mezclado— así que la unidad más pequeña que se puede juzgar es el token. En los dos casos el
 * predicado es el mismo `safeIssueField`; lo que cambia es sobre qué se aplica, y cambia por una
 * razón que se puede señalar en el contrato.
 */
function sabreSafeJoinedValue(value: string): string {
  const gated = value.replace(
    SABRE_JOINED_TOKEN,
    (token) =>
      // Fail-closed: `safeIssueField` sólo devuelve `undefined` para un escalar sin contenido, y un
      // token casado nunca lo es; si algún día lo fuera, la marca opaca es el lado seguro.
      safeIssueField(token, SABRE_SAFE_FIELD_PATH_SHAPE) ?? SABRE_ISSUE_OPAQUE_VALUE,
  );
  return gated.length <= SABRE_SAFE_CODE_MAX_CHARS
    ? gated
    : `${gated.slice(0, SABRE_SAFE_CODE_MAX_CHARS)}…`;
}

function sabreSafeIssueSlots(body: string): string {
  return body.replace(SABRE_JSON_PAIR, (whole, key: string, separator: string, value: string) => {
    const slot = normalizeEnvelopeToken(key);
    if (!SABRE_ISSUE_SLOT_KEYS.has(slot)) return whole;
    const shape = slot === 'FIELDPATH' ? SABRE_SAFE_FIELD_PATH_SHAPE : SABRE_SAFE_CODE_SHAPE;
    // Un valor vacío no tiene nada que tapar y `safeIssueField` lo lee como ausencia; se conserva
    // vacío en vez de inventarle un sentinel que diría que el proveedor mandó algo.
    return `"${key}"${separator}"${safeIssueField(value, shape) ?? ''}"`;
  });
}

/**
 * Un valor bajo una clave de problema sólo es inocuo si se puede **demostrar** vacío:
 * ausente, `false`, `0`, cadena en blanco, array vacío u objeto sin claves. Cualquier otro
 * contenido — incluido `errors: ["texto plano"]` — es un problema declarado.
 */
function isProvablyAbsent(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  const record = sabreEnvelopeRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

interface SabreEnvelopeScan {
  readonly verdict: SabreEnvelopeVerdict;
  nodes: number;
  /**
   * El presupuesto se agotó. Es un techo DURO: en cuanto se levanta, los bucles del recorrido
   * dejan de iterar. Sin él, `spend` cortaba la rama pero el bucle del padre seguía recorriendo
   * hermanos —y cada hermano volvía a gastar—, así que el «tope» de 500 000 no acotaba nada: un
   * array de cinco millones de elementos pagaba cinco millones de llamadas.
   */
  aborted: boolean;
  readonly seen: WeakSet<object>;
  /**
   * La operación en curso puede conceder benignidad por `ApplicationResults.Success`. Se resuelve
   * UNA vez al entrar, no por nodo: es propiedad de la llamada, no del sobre, y calcularla dentro
   * del recorrido invitaría a que algún día dependa de lo que se acaba de leer.
   */
  readonly benignAllowed: boolean;
}

function pushIssue(scan: SabreEnvelopeScan, issue: SabreIssue): void {
  (issue.severity === 'error' ? scan.verdict.failures : scan.verdict.warnings).push(issue);
}

function issueCount(scan: SabreEnvelopeScan): number {
  return scan.verdict.failures.length + scan.verdict.warnings.length;
}

/**
 * Issue sin contenido: sabemos que hay un problema y deliberadamente no sabemos qué dice.
 * Es la traducción directa de la carga de la prueba invertida.
 */
function opaqueIssue(severity: 'error' | 'warning'): SabreIssue {
  return { source: 'application', severity, category: SABRE_ISSUE_UNSTRUCTURED };
}

/**
 * `errors: ["…"]` — el problema llega como escalar suelto, sin casillas.
 *
 * Publica por el MISMO predicado que los dos caminos de record ({@link isPublishableIssueValue}) y
 * no por una condición propia: era la tercera copia de la regla, y aquí las segundas copias
 * divergen. Lo que no se puede publicar se descarta entero en vez de sustituirse por un sentinel:
 * a diferencia del camino de record, aquí el issue no tiene ninguna otra casilla que sostenga el
 * diagnóstico, y `UNSTRUCTURED` sin `code` ya dice lo mismo que diría `code: FREE_TEXT_REDACTED`.
 */
function scalarIssue(severity: 'error' | 'warning', value: unknown): SabreIssue {
  const raw = sabreEnvelopeString(value);
  return raw !== undefined && isPublishableIssueValue(raw, SABRE_SAFE_CODE_SHAPE)
    ? { source: 'application', severity, category: SABRE_ISSUE_UNSTRUCTURED, code: raw }
    : opaqueIssue(severity);
}

/**
 * Nunca lleva `description`, `text`, `value` ni `fieldValue`: son texto libre que puede arrastrar
 * datos del pasajero, y esto se loguea (RNF-07).
 *
 * Y tampoco lleva la prosa que el proveedor mete DENTRO de las cuatro casillas de vocabulario:
 * las cuatro pasan por `safeIssueField`, que es la misma forma que `scalarIssue` ya exigía. Dejar
 * fuera `description` pero admitir la misma frase con la etiqueta `code` era protegerse del nombre
 * del campo y no del contenido, que es lo único que importa cuando esto acaba en un ticket.
 */
function issueFromEnvelopeRecord(
  item: Record<string, unknown>,
  severity: 'error' | 'warning',
): SabreIssue | null {
  const category = safeIssueField(envelopeIssueField(item, 'category'));
  const type = safeIssueField(envelopeIssueField(item, 'type'));
  const code = safeIssueField(envelopeIssueField(item, 'code'));
  const fieldPath = safeIssueField(
    envelopeIssueField(item, 'fieldPath'),
    SABRE_SAFE_FIELD_PATH_SHAPE,
  );
  if (category === undefined && type === undefined && code === undefined && fieldPath === undefined)
    return null;
  return {
    source: 'application',
    severity,
    ...(category === undefined ? {} : { category }),
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(fieldPath === undefined ? {} : { fieldPath }),
  };
}

/**
 * Severidad que declara **el propio item**, independiente del contenedor en el que viva.
 * `null` = el item no declara nada reconocible; eso NO es benigno, es "no se sabe".
 *
 * El orden importa y es el histórico: los tokens de `severity`/`type` mandan sobre el prefijo del
 * `code`, y el prefijo manda sobre un token benigno — un `{severity:'Info', code:'ERR.0161'}` de
 * hoteles es un error, porque el `code` es el campo que lleva la severidad de verdad en ese
 * dialecto (`help/get-hotel-avail-v4/v4-errors.txt:12`).
 */
function declaredIssueSeverity(
  item: Record<string, unknown>,
): 'error' | 'warning' | 'benign' | null {
  // Sobre el valor CRUDO, nunca sobre el redactado: aquí se decide el veredicto, y
  // `safeIssueField` es la puerta de PUBLICACIÓN. Ver la nota de `safeIssueField`.
  const declared = severityTokens(
    sabreEnvelopeString(envelopeIssueField(item, 'severity')),
    sabreEnvelopeString(envelopeIssueField(item, 'type')),
  );
  if (declared.some((token) => SABRE_SEVERITY_ERROR_TOKENS.has(token))) return 'error';
  if (declared.some((token) => SABRE_SEVERITY_WARNING_TOKENS.has(token))) return 'warning';

  const code = sabreEnvelopeString(envelopeIssueField(item, 'code')) ?? '';
  if (SABRE_CODE_ERROR_PREFIX.test(code)) return 'error';
  if (SABRE_CODE_WARNING_PREFIX.test(code)) return 'warning';

  if (declared.some((token) => SABRE_SEVERITY_BENIGN_TOKENS.has(token))) return 'benign';
  return null;
}

/** En un conflicto de severidades gana **siempre** la más grave. Degradar es fail-open. */
function worstSeverity(a: 'error' | 'warning', b: 'error' | 'warning'): 'error' | 'warning' {
  return a === 'error' || b === 'error' ? 'error' : 'warning';
}

function envelopeMessageSeverity(
  item: Record<string, unknown>,
  context: SabreIssueContext,
): 'error' | 'warning' | null {
  const declared = declaredIssueSeverity(item);
  if (declared === 'error' || declared === 'warning') return declared;
  if (declared === 'benign') return null;
  if (context === 'benign') return null;
  // Ni el proveedor declaró severidad reconocible ni el contexto la aporta: no se puede demostrar
  // que sea inocuo, así que no lo es.
  return context === 'warning' ? 'warning' : 'error';
}

/**
 * Issue de un item colgado de `message` / `messages`. Mismas casillas y misma puerta que
 * `issueFromEnvelopeRecord`: aquí no hay `fieldPath` porque el dialecto de mensajes no lo declara.
 *
 * No hay `?? item['text']` ni `?? item['value']` y no puede haberlo: el `value` de los mensajes de
 * hoteles es literalmente la frase («Vendor response error», «112 - No Results Available»,
 * `get-hotel-avail-v5.0.yml:159-171`) y en Booking Management es la plantilla `%s` ya interpolada
 * con localizador y nombre.
 *
 * Los DOS `??` están muertos por test, cada uno con el suyo, en
 * `errors.issue-vocabulary.test.ts` §4. El de `text` lo mataba ya
 * `redaction.issue-free-text.test.ts` §4; el de `value` NO lo mataba nadie —el comentario que
 * había aquí afirmaba en pasado que sí, y reintroducirlo dejaba la suite entera en verde
 * publicando el localizador de `{messages:[{type:'ERROR',value:'XKCD12'}]}`—.
 *
 * El caso que lo mata usa un `value` que PASA la puerta de publicación, y tiene que ser así: con
 * un testigo que la puerta ya tapa, el mutante sale como `OPAQUE_VALUE_REDACTED` y el test pasa
 * igual. Un testigo que otra defensa cubre no mata el mutante que dice matar — que es exactamente
 * cómo sobrevivió éste.
 */
function messageIssue(item: Record<string, unknown>, severity: 'error' | 'warning'): SabreIssue {
  const category = safeIssueField(envelopeIssueField(item, 'category'));
  const type = safeIssueField(envelopeIssueField(item, 'type'));
  const code = safeIssueField(envelopeIssueField(item, 'code'));
  return {
    source: 'application',
    severity,
    ...(category === undefined ? {} : { category }),
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  };
}

/**
 * Gasta un nodo del presupuesto. `false` = no hay presupuesto, no se sigue.
 *
 * Levantar `aborted` es lo que convierte el presupuesto en un TECHO DE VERDAD: los dos bucles de
 * `scanNode` lo miran en su CONDICIÓN, así que en cuanto se agota no queda ni una iteración más.
 * Antes sólo se cortaba la rama y el padre seguía recorriendo hermanos, cada uno gastando otra
 * vez; el total de llamadas era el del árbol entero, no el del presupuesto.
 *
 * Aquí NO se vuelve a comprobar `scan.aborted` al entrar, y es deliberado. Sería inalcanzable —los
 * únicos sitios que llaman a `scanNode` son los dos bucles, y los dos ya lo miran— y sobre todo
 * TAPARÍA la medición: con esa comprobación puesta, quitar la condición de cualquiera de los dos
 * bucles deja de tener efecto observable sobre `nodesVisited` y el test del techo duro pasa igual.
 * Dos mecanismos que se enmascaran mutuamente valen menos que uno medible.
 */
function spend(scan: SabreEnvelopeScan): boolean {
  scan.nodes += 1;
  if (scan.nodes > SABRE_ENVELOPE_NODE_BUDGET) {
    scan.aborted = true;
    scan.verdict.exhaustive = false;
    return false;
  }
  return true;
}

/**
 * El fondo del contexto benigno. `benign` sólo vive dentro del subárbol que el contrato declara
 * éxito; en cuanto el recorrido sale de ahí, la carga de la prueba vuelve a estar donde estaba.
 * Degradarlo a `neutral` —y no a `warning`— es lo correcto: `neutral` significa «esto todavía hay
 * que demostrarlo», que es exactamente el estado en el que se entra en cualquier rama nueva.
 */
function demoteBenign(context: SabreIssueContext): SabreIssueContext {
  return context === 'benign' ? 'neutral' : context;
}

/**
 * Toda clave de los 21 contratos de Sabre es ASCII: son identificadores de schema, no datos.
 *
 * Sin esto, `{"еrrors":[{"category":"APPLICATION_ERROR"}]}` con «е» CIRÍLICA (U+0435) pasaba como
 * éxito: la clave se lee `errors` en pantalla y `normalizeEnvelopeToken` —que borra todo lo que no
 * es `[A-Za-z0-9]`— la reduce a `RRORS`, que no coincide con nada y cae en la rama neutral.
 *
 * **Se cubre, y no se documenta como fuera del modelo de amenaza.** El argumento «la respuesta
 * viene de Sabre, no de un atacante» es justo el que ya falló cuatro veces en este paquete: Sabre
 * es un agregador que hace eco de contenido de terceros (`SystemSpecificResults` es literalmente
 * la respuesta del proveedor de fondo), la respuesta viaja por una red que no controlamos, y el
 * modo de fallo no necesita malicia — un proveedor con un encoding roto produce el mismo sobre.
 * Cuesta una comparación por clave y cierra la familia entera, no un carácter concreto.
 *
 * **No se usa NFKC**, y conviene dejarlo escrito porque es el error fácil: NFKC no mapea cirílico
 * a latino. `'е'.normalize('NFKC') === 'е'`. Lo que hace ese mapeo es una tabla de confundibles
 * (UTS #39), que es grande, versionada y con falsos positivos propios. Rechazar la clave por no
 * ser ASCII es más barato, más estable y no depende de una tabla.
 *
 * El veredicto es error y no `exhaustive = false` a propósito: el recorrido SÍ terminó y sí bajó
 * por el subárbol —lo que no puede es afirmar qué declaraba esa clave—, y un issue propio deja
 * eso legible en el log en vez de disfrazarlo de presupuesto agotado.
 */
const SABRE_KEY_NON_ASCII = /[^\x20-\x7E]/;

/* ────────────────────────────────────────────────────────────────────────────
 * ANOTAR ≠ DESCENDER
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Aquí vivía un `switch` con cinco ramas donde CADA rama decidía por su cuenta si bajaba por el
 * subárbol. Cuatro bajaban y una no, y esa asimetría era invisible leyendo el código. El precio
 * fueron cinco rondas de auditoría encontrando **el mismo fallo con otro disfraz**:
 *
 *   - ronda 3 — `case 'message'` llamaba a su handler y hacía `break`: el subárbol de `messages[]`
 *     era invisible.
 *   - ronda 4 — el subárbol sí se recorría, pero `benign` se concedía por NOMBRE de clave y se
 *     propagaba sin fondo.
 *   - ronda 5 — `case 'status'` llamaba a `scanStatusValue` y hacía `break`. Y `scanStatusValue`
 *     sólo sabía leer escalares: con un objeto hacía `sabreEnvelopeString(value) === undefined` y
 *     retornaba en el acto. `{"status":{"errors":[{"category":"APPLICATION_ERROR"}]}}` entraba
 *     como reserva confirmada — y no era un caso sintético:
 *     `get-vehicle-availability-v1.yml:285` declara `Status` como `type: object`.
 *
 * La causa raíz no era ninguno de esos tres casos: era que **descender fuese una decisión de cada
 * rama**. Mientras lo sea, añadir un `case` nuevo —o tocar uno existente— reabre el agujero sin
 * que nada lo impida.
 *
 * Así que la responsabilidad está invertida. El recorrido baja SIEMPRE por todo el árbol; las
 * ramas sólo **anotan** semántica sobre el nodo en el que están y dicen con qué contexto se
 * hereda hacia abajo. Un anotador:
 *
 *   - recibe el nodo y el contexto, y **nada más**: ni `scan`, ni `depth`, ni la función de
 *     recorrido. No puede registrar hallazgos por su cuenta ni puede recursar. No es disciplina,
 *     es la firma;
 *   - devuelve DATOS (`issues` + `context`), que el recorrido aplica.
 *
 * El descenso es una sola llamada, fuera de todo `if`, `case` o `continue`. Si algún día una rama
 * necesitara de verdad no descender, tendrá que ser una excepción EXPLÍCITA y nombrada aquí, con
 * su razón escrita — nunca un `break` silencioso.
 */

/** Lo que un nodo declara POR SÍ MISMO, sin mirar lo que cuelga de él. */
interface SabreEnvelopeAnnotation {
  /** Problemas que la semántica de este nodo declara. Puede estar vacío. */
  readonly issues: readonly SabreIssue[];
  /** Contexto de severidad con el que se recorrerá su subárbol. Anotar no decide SI se baja. */
  readonly context: SabreIssueContext;
}

/** El nodo tal y como lo ve un anotador. Los arrays no llegan aquí: los abre el recorrido. */
interface SabreEnvelopeNode {
  /** El valor crudo. */
  readonly value: unknown;
  /** Objeto plano si lo es; `null` si es escalar (o `null`/`undefined`). */
  readonly record: Record<string, unknown> | null;
  /** Llegó como elemento de un array. Sólo `message` distingue este caso. */
  readonly inArray: boolean;
}

/**
 * Función PURA. Fíjate en lo que NO recibe: `scan` ni `depth`. Sin `scan` no puede tocar el
 * veredicto; sin `depth` no puede llamar al recorrido. Esa es toda la garantía.
 */
type SabreEnvelopeAnnotator = (
  node: SabreEnvelopeNode,
  context: SabreIssueContext,
) => SabreEnvelopeAnnotation;

const SABRE_NO_ISSUES: readonly SabreIssue[] = Object.freeze([]);

/** Ni declara problemas ni cambia el contexto: sólo existe para que el recorrido siga bajando. */
function annotateInert(
  _node: SabreEnvelopeNode,
  context: SabreIssueContext,
): SabreEnvelopeAnnotation {
  return { issues: SABRE_NO_ISSUES, context };
}

/**
 * Nodo colgado de una clave de problema (`errors`, `warnings`, `fault`, `…Error`, …).
 *
 * `container` es la severidad que declara la CLAVE. La que declara el propio item manda sobre
 * ella y, en conflicto, gana la más grave: un `{severity:'Error'}` dentro de `warnings[]` está
 * diciendo que hubo un error, y heredar «warning» de la clave lo entregaba como éxito degradado.
 */
function annotateIssue(
  node: SabreEnvelopeNode,
  container: 'error' | 'warning',
): SabreEnvelopeAnnotation {
  if (node.record === null) {
    // `errors: "boom"` o `errors: ["boom"]`. Sólo lo demostrablemente vacío no es un problema.
    const issues = isProvablyAbsent(node.value)
      ? SABRE_NO_ISSUES
      : [scalarIssue(container, node.value)];
    return { issues, context: container };
  }

  const declared = declaredIssueSeverity(node.record);
  const effective =
    declared === 'error' || declared === 'warning' ? worstSeverity(container, declared) : container;
  const issue = issueFromEnvelopeRecord(node.record, effective);
  if (issue !== null) return { issues: [issue], context: effective };
  // El item declaró severidad pero no trae ni un identificador estructurado (`{severity:'Fatal'}`
  // a secas): se reporta opaco en SU severidad, no en la del contenedor.
  if (declared === 'error' || declared === 'warning')
    return { issues: [opaqueIssue(effective)], context: effective };
  return { issues: SABRE_NO_ISSUES, context: effective };
}

/**
 * Nodo colgado de `message` / `messages`.
 *
 * `message: "texto"` es sólo texto (`offer-price-ndc-v1.yml:876`), no un contenedor de problemas;
 * `messages: ["texto"]` sí lo es. Por eso el escalar mira `inArray`.
 *
 * El contexto con el que se hereda es la severidad del mensaje cuando la declara, y el heredado
 * cuando no. **Nunca `benign`**: que un mensaje sea inocuo dice sólo eso, y no autoriza a dar por
 * buenos sus descendientes — ni siquiera cuando el `benign` lo puso el CONTRATO (`Success[]`).
 */
function annotateMessage(
  node: SabreEnvelopeNode,
  context: SabreIssueContext,
): SabreEnvelopeAnnotation {
  if (node.record === null) {
    const opaque = !node.inArray || isProvablyAbsent(node.value) || context === 'benign';
    const issues = opaque
      ? SABRE_NO_ISSUES
      : [scalarIssue(context === 'warning' ? 'warning' : 'error', node.value)];
    return { issues, context };
  }

  const severity = envelopeMessageSeverity(node.record, context);
  return {
    issues: severity === null ? SABRE_NO_ISSUES : [messageIssue(node.record, severity)],
    context: severity ?? demoteBenign(context),
  };
}

/**
 * Nodo colgado de `status` / `…ProcessingStatus`.
 *
 * Sólo un ESCALAR puede ser el literal del enum. Un objeto o un array no lo son —
 * `get-vehicle-availability-v1.yml:285` declara `Status` como `type: object`— y ese caso no anota
 * nada: el recorrido baja igual y lo que haya dentro se defiende solo. Aquí es donde la ronda 5
 * perdía el subárbol entero.
 */
function annotateStatus(
  node: SabreEnvelopeNode,
  context: SabreIssueContext,
): SabreEnvelopeAnnotation {
  const raw = node.record === null ? sabreEnvelopeString(node.value) : undefined;
  if (raw === undefined) return { issues: SABRE_NO_ISSUES, context };

  const normalized = normalizeEnvelopeToken(raw);
  if (normalized === 'NOTPROCESSED') {
    return {
      issues: [{ source: 'application', severity: 'error', category: SABRE_ISSUE_NOT_PROCESSED }],
      context,
    };
  }
  if (SABRE_STATUS_NOT_COMPLETE.has(normalized)) {
    return {
      issues: [{ source: 'application', severity: 'error', category: `STATUS_${normalized}` }],
      context,
    };
  }
  return { issues: SABRE_NO_ISSUES, context };
}

/**
 * La tabla de anotadores. Es `Record<SabreEnvelopeKeyKind, …>`: el compilador obliga a que toda
 * semántica tenga entrada, y `SABRE_ENVELOPE_KEY_KINDS` se deriva de aquí para que la guarda
 * anti-recurrencia no pueda quedarse mirando una lista rancia.
 */
const SABRE_ENVELOPE_ANNOTATORS: Readonly<Record<SabreEnvelopeKeyKind, SabreEnvelopeAnnotator>> = {
  error: (node) => annotateIssue(node, 'error'),
  warning: (node) => annotateIssue(node, 'warning'),
  message: annotateMessage,
  status: annotateStatus,
  benign: annotateInert,
  neutral: annotateInert,
};

/**
 * Las semánticas que el recorrido reconoce, derivadas de la tabla real y no escritas a mano.
 *
 * **Se exporta para la guarda anti-recurrencia**, que enumera esto y exige a cada una un sobre de
 * muestra con un error enterrado que TIENE que salir rechazado. Una lista escrita a mano se queda
 * atrás en silencio; ésta no puede.
 */
export const SABRE_ENVELOPE_KEY_KINDS: readonly SabreEnvelopeKeyKind[] = Object.freeze(
  Object.keys(SABRE_ENVELOPE_ANNOTATORS) as SabreEnvelopeKeyKind[],
);

/** Posición del nodo dentro del sobre. No es su contenido: es de dónde cuelga. */
interface SabreNodePosition {
  /** Semántica que declara la clave de la que cuelga. */
  readonly kind: SabreEnvelopeKeyKind;
  /**
   * Clave normalizada del padre. Existe para una sola cosa: `benign` lo concede una POSICIÓN del
   * contrato (`ApplicationResults.Success`), no un nombre de clave suelto.
   */
  readonly parentToken: string | undefined;
  /** El nodo llegó como elemento de un array. */
  readonly inArray: boolean;
}

const SABRE_ROOT_POSITION: SabreNodePosition = {
  kind: 'neutral',
  parentToken: undefined,
  inArray: false,
};

/**
 * Recorre **todo** el sobre: objetos, arrays y escalares, a cualquier profundidad. Un array no
 * cambia la posición —`Success: [...]` sigue siendo `Success`—, sólo marca a sus elementos.
 *
 * Estructura, y es lo que hay que conservar:
 *
 *   1. barandillas (profundidad, presupuesto, ciclos);
 *   2. **anotar** — una sola llamada a la tabla de anotadores, que son puros;
 *   3. **descender** — una sola llamada recursiva por clave, fuera de todo condicional.
 *
 * No hay `switch`. No hay rama que pueda saltarse el paso 3.
 */
function scanNode(
  node: unknown,
  context: SabreIssueContext,
  depth: number,
  scan: SabreEnvelopeScan,
  position: SabreNodePosition,
): void {
  if (depth > SABRE_ENVELOPE_MAX_DEPTH) {
    scan.verdict.exhaustive = false;
    return;
  }
  if (!spend(scan)) return;

  if (Array.isArray(node)) {
    if (scan.seen.has(node)) return;
    scan.seen.add(node);
    const inside: SabreNodePosition = { ...position, inArray: true };
    for (let index = 0; index < node.length && !scan.aborted; index += 1) {
      scanNode(node[index], context, depth + 1, scan, inside);
    }
    return;
  }

  const record = sabreEnvelopeRecord(node);
  if (record !== null) {
    if (scan.seen.has(record)) return;
    scan.seen.add(record);
  }

  // ── 2. ANOTAR ───────────────────────────────────────────────────────────────────────────────
  const annotation = SABRE_ENVELOPE_ANNOTATORS[position.kind](
    { value: node, record, inArray: position.inArray },
    context,
  );
  for (const issue of annotation.issues) pushIssue(scan, issue);

  // ── 3. DESCENDER ────────────────────────────────────────────────────────────────────────────
  // Un escalar simplemente no tiene claves; no es una rama que decida no bajar.
  const keys = record === null ? [] : Object.keys(record);
  for (let index = 0; index < keys.length && !scan.aborted; index += 1) {
    const key = keys[index] ?? '';
    const value = record?.[key];

    if (SABRE_KEY_NON_ASCII.test(key)) {
      // Sin `key` ni nada derivado de ella en el issue: una clave es contenido del proveedor y
      // esto se loguea (RNF-07). Se sabe que hay un problema y deliberadamente no qué decía.
      pushIssue(scan, {
        source: 'application',
        severity: 'error',
        category: SABRE_ISSUE_UNINTERPRETABLE_KEY,
      });
    }

    const token = normalizeEnvelopeToken(key);
    const kind = envelopeKeyKind(token, position.parentToken, scan.benignAllowed);
    // `benign` no sobrevive a una clave que el contrato no declara dentro de `Success[]`. Sin este
    // suelo, un solo `success` en cualquier posición apagaba el recorrido de todo su subárbol.
    const inherited =
      annotation.context === 'benign' && !SABRE_BENIGN_CARRIER_KEYS.has(token)
        ? 'neutral'
        : annotation.context;
    // `benign` es el ÚNICO contexto que concede una CLAVE, y lo concede su POSICIÓN en el contrato
    // (`ApplicationResults.Success`), nunca su nombre suelto. Todo lo demás hereda: la severidad de
    // una clave de problema la pone su ANOTADOR (`annotateIssue(node, 'error')`) y baja por
    // `annotation.context`, que ya es la severidad EFECTIVA del item. Escribirla también aquí sería
    // una segunda copia de la misma política, y en este paquete las segundas copias derivan: aquí
    // vivía una tabla `kind → contexto de entrada` cuyas filas `error`/`warning` no las leía nadie.
    const childContext: SabreIssueContext = kind === 'benign' ? 'benign' : inherited;
    const beforeAny = issueCount(scan);
    const beforeFailures = scan.verdict.failures.length;

    scanNode(value, childContext, depth + 1, scan, {
      kind,
      parentToken: token,
      inArray: false,
    });

    // Había contenido bajo una clave de problema y el subárbol no dio cuenta de él: el sobre gana
    // igual. Va DESPUÉS del descenso a propósito — es una anotación sobre lo que el subárbol no
    // supo decir, no un permiso para no mirarlo.
    //
    // RONDA 7 — «dar cuenta» se mide contra la severidad DE LA CLAVE, no contra «salió algún
    // issue». Antes bastaba cualquier issue, y un warning satisfacía a una clave de error. Medido:
    //
    //     {errors: {data: 'x'}}                 → RECHAZADO (opaco de error)
    //     {errors: {warnings: [{category:'X'}]}} → ACEPTADO como reserva confirmada
    //
    // Los dos declaran lo mismo —la clave `errors` trae contenido— y el ACEPTADO es el que además
    // dice explícitamente que hubo un problema. Es la misma inversión fail-open de siempre: el
    // subárbol degradaba a su padre en vez de al revés, cuando la política escrita tres funciones
    // más arriba (`worstSeverity`) dice que en un conflicto de severidades gana la más grave.
    //
    // Una clave de warning se sigue conformando con cualquier issue: un error dentro de `warnings`
    // ya escala por `worstSeverity` y contarlo dos veces no añade nada.
    const accounted =
      kind === 'error'
        ? scan.verdict.failures.length > beforeFailures
        : issueCount(scan) > beforeAny;
    if ((kind === 'error' || kind === 'warning') && !accounted && !isProvablyAbsent(value)) {
      pushIssue(scan, opaqueIssue(kind));
    }
  }
}

/**
 * EL ARRANQUE ÚNICO del recorrido. Todo el que quiera pasar la regla dura por un valor entra por
 * aquí, y por eso sigue habiendo exactamente cuatro sitios en el fichero que nombran `scanNode`:
 * la definición, sus dos recursiones y este arranque.
 *
 * Existe porque hay DOS preguntas que se responden con el mismo recorrido: el veredicto del sobre
 * entero y el del sobre sin su portador de desenlace ({@link isDeclaredPartialOutcome}). La
 * alternativa —un segundo `scanNode(` en el fichero— es una segunda puerta de entrada al recorrido,
 * y una segunda puerta es exactamente cómo la ronda 2 acabó con dos clasificadores, uno de ellos
 * corriendo en producción mientras los tests medían el otro. Una función, un punto de entrada: las
 * dos preguntas no pueden divergir porque son la misma llamada.
 *
 * `benignAllowed` se resuelve FUERA y se pasa: es propiedad de la llamada, no del sobre.
 */
function runEnvelopeScan(payload: unknown, benignAllowed: boolean): SabreEnvelopeScan {
  const verdict: SabreEnvelopeVerdict = {
    ok: false,
    failures: [],
    warnings: [],
    partialUnauthorized: [],
    partialOutcome: false,
    exhaustive: true,
    nodesVisited: 0,
  };
  const scan: SabreEnvelopeScan = {
    verdict,
    nodes: 0,
    aborted: false,
    seen: new WeakSet<object>(),
    benignAllowed,
  };

  scanNode(payload, 'neutral', 0, scan, SABRE_ROOT_POSITION);
  verdict.nodesVisited = scan.nodes;
  return scan;
}

/**
 * La regla dura de éxito (docs/sabre/09 §2.1, RNF-03).
 *
 * Sustituye a la enumeración de formas malas por la carga de la prueba invertida: un sobre es
 * éxito **sólo** si se recorrió entero y no apareció nada con severidad error, venga como
 * `errors[]`, como `errors{}`, como `["texto"]`, dentro de un array, a diez niveles de
 * profundidad, como `messages[]` sin severidad declarada o como `status: NotProcessed`.
 *
 * `context` lleva la ruta de la operación. **Es opcional y su ausencia es la política estricta**:
 * ver el bloque «EL CONTEXTO DE LA OPERACIÓN» para las dos listas cerradas que abre —el cuerpo
 * vacío como éxito declarado y el permiso para conceder benignidad— y para dónde cae el coste.
 */
export function classifySabreEnvelope(
  payload: unknown,
  context: SabreEnvelopeContext = {},
): SabreEnvelopeVerdict {
  const scan = runEnvelopeScan(payload, contractDeclaresApplicationResults(context.path));
  const verdict = scan.verdict;

  // Un `200` que no trae sobre que verificar no es un éxito verificado.
  //
  // Dos formas caen aquí, y por la MISMA razón:
  //
  //  - **No es un sobre**: un escalar JSON (`"OK"`, `true`, `42`) o `null`. No hay estructura por
  //    la que bajar.
  //  - **Es un sobre vacío**: `{}` o `[]`. Hay contenedor y no hay nada dentro.
  //
  // En ambos casos la regla («el recorrido terminó y no apareció nada con severidad error») sale
  // cierta DE VACÍO, y vacuamente cierto no es demostrado benigno — que es exactamente lo que la
  // carga de la prueba invertida existe para impedir. Esta línea antes rechazaba el escalar y
  // aceptaba `{}`, y esa distinción no se sostiene: un `createBooking` que responde `{}` no ha
  // devuelto la reserva que el contrato promete, y confirmarlo es la reserva fantasma otra vez.
  // El coste de equivocarse hacia el otro lado es un reintento.
  //
  // El caso real del `204` y el del cuerpo no parseable los corta el cliente HTTP antes de llegar
  // aquí, así que este carril no le quita el 200 a nadie que sí traiga datos.
  //
  // (La guarda hermana `scan.nodes === 0` que vivía aquí era CÓDIGO MUERTO: `scanNode` gasta al
  // menos un nodo con cualquier payload, incluidos los escalares que sí se rechazan.)
  //
  // RONDA 7 — la única excepción, y es del CONTRATO, no una relajación. Hay una operación cuyo
  // schema de respuesta no declara un solo campo que no sea `errors[]`, así que su éxito no tiene
  // nada que devolver y el contrato publica `{ }` como los tres ejemplos de éxito. Para ESA
  // operación —y sólo cuando quien llama pasa la ruta— el objeto vacío es el éxito declarado.
  //
  // Se exige objeto vacío, no «demostrablemente ausente»: el contrato publica `{ }`, no `[]`. Un
  // array vacío donde el contrato promete un objeto sigue siendo un sobre que no se corresponde
  // con nada, y no hay razón para regalarle el 200. Y un escalar (`"OK"`, `null`) tampoco entra
  // por aquí: `isEnvelopeShaped` lo rechaza antes, para toda operación sin excepción.
  const isEnvelopeShaped = typeof payload === 'object' && payload !== null;
  const record = sabreEnvelopeRecord(payload);
  const emptyObject = record !== null && Object.keys(record).length === 0;
  const emptyIsDeclaredSuccess = emptyObject && contractDeclaresEmptyBodySuccess(context.path);
  if (!isEnvelopeShaped || (isProvablyAbsent(payload) && !emptyIsDeclaredSuccess))
    verdict.exhaustive = false;

  // Un sobre que no se pudo terminar de mirar no es un sobre limpio: es un sobre desconocido.
  if (!verdict.exhaustive && verdict.failures.length === 0) {
    pushIssue(scan, {
      source: 'application',
      severity: 'error',
      category: SABRE_ISSUE_NOT_VERIFIABLE,
    });
  }

  verdict.ok = verdict.exhaustive && verdict.failures.length === 0;
  verdict.partialUnauthorized = [...verdict.failures, ...verdict.warnings].filter((issue) =>
    SABRE_UNAUTHORIZED_MARK.test(`${issue.category ?? ''} ${issue.type ?? ''}`),
  );
  // La segunda pregunta, y sólo cuando la primera ya dijo que no. Ver «EL DESENLACE PARCIAL».
  if (!verdict.ok)
    verdict.partialOutcome = isDeclaredPartialOutcome(payload, context.path, verdict);
  return verdict;
}

/** Config ausente o inválida. No es un fallo del proveedor: no cuenta para el breaker. */
export class SabreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreConfigError';
  }
}
