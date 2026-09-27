/**
 * Modelo de errores del ACL de TBO (docs/tbo/01 §9; 08 RF-04 y §9 C-04).
 *
 * Una sola clase para todo lo que pasó por el cable (`TboApiError`, con un `kind` cerrado) y una
 * clase por cada fallo que no llegó a TBO o que llegó y no se pudo leer. El motivo de no tener una
 * subclase por código es el de Sabre: llegó a 21 clases y "una clase que faltara en el decorador no
 * da un error de compilación, da un 500" (`apps/api/src/providers-sabre/sabre-exception.filter.ts`).
 * Con un `kind` cerrado, el humanizador de `apps/api` es un `Record<TboFailureKind, …>` y un `kind`
 * nuevo sin mensaje no compila.
 *
 * Ninguna clase guarda cuerpos, cabeceras ni `Status.Description`: el `message` se arma sólo con
 * vocabulario nuestro (path constante, enteros, `kind`, `ruta:código`), porque el filtro global de
 * `apps/api` loguea `exception.message` tal cual. Si hay que investigar, el RQ/RS completo vive en
 * la bóveda de payloads y se localiza por `requestId` (docs/tbo/01 §11.2).
 */

/** Los 14 desenlaces posibles de una llamada que se intentó (docs/tbo/01 §8.3-§8.4 y §9.2). */
export const TBO_FAILURE_KINDS = [
  'TRANSPORT',
  'MALFORMED_RESPONSE',
  'UNKNOWN_CODE',
  'CLIENT_BUG',
  'CREDENTIALS_INVALID',
  'ACCOUNT_BLOCKED',
  'INSUFFICIENT_BALANCE',
  'THROTTLED',
  'UPSTREAM',
  'NO_AVAILABILITY',
  'RATE_UNAVAILABLE',
  'OFFER_EXPIRED',
  'BOOKING_FAILED',
  'CANCEL_FAILED',
] as const;

export type TboFailureKind = (typeof TBO_FAILURE_KINDS)[number];

/**
 * NATURALEZA del fallo, no permiso para repetir una escritura. Si se forzara `NO_RETRY` en los
 * paths de dinero "por seguridad", `classifyCancelThrownFailure` trataría un timeout de `/Cancel`
 * como fallo determinista y cerraría sin conciliar una cancelación que pudo aplicarse
 * (docs/tbo/01 §9.3). La prohibición de repetir Book y Cancel vive en el cliente HTTP.
 */
export type TboRetryNature = 'NO_RETRY' | 'RETRY_BACKOFF';

/** `OPEN_ACCOUNT` abre sólo el circuito de la cuenta resuelta: una BYOC mala no apaga a la red. */
export type TboCircuitEffect = 'COUNT' | 'IGNORE' | 'OPEN_ACCOUNT';

export interface TboFailureClass {
  readonly kind: TboFailureKind;
  readonly retry: TboRetryNature;
  readonly circuit: TboCircuitEffect;
  /** Avisar al dueño de la credencial (propia o del consolidador): 401, 402 y 300. */
  readonly notifyAccountOwner: boolean;
  /** Alerta para nosotros, no para el vendedor: bug propio o respuesta que no entendemos. */
  readonly operatorAlert: boolean;
}

type TboFailurePolicy = { readonly [K in TboFailureKind]: TboFailureClass & { readonly kind: K } };

function policy<K extends TboFailureKind>(
  kind: K,
  retry: TboRetryNature,
  circuit: TboCircuitEffect,
  notifyAccountOwner: boolean,
  operatorAlert: boolean,
): TboFailureClass & { readonly kind: K } {
  return Object.freeze({ kind, retry, circuit, notifyAccountOwner, operatorAlert });
}

/**
 * La política de docs/tbo/01 §8.3-§8.4, una fila por `kind`. El tipo mapeado obliga a que cada
 * clave tenga su fila y a que el `kind` de la fila sea el de la clave: no hay forma de que un
 * `TboApiError` lleve una política que contradiga su propio `kind`.
 *
 * `MALFORMED_RESPONSE` se reintenta como `UPSTREAM` (§8.4) aunque además alerte: el cuerpo roto
 * de una lectura suele ser un proxy intermedio, no un contrato cambiado.
 */
export const TBO_FAILURE_POLICY: TboFailurePolicy = Object.freeze({
  TRANSPORT: policy('TRANSPORT', 'RETRY_BACKOFF', 'COUNT', false, false),
  MALFORMED_RESPONSE: policy('MALFORMED_RESPONSE', 'RETRY_BACKOFF', 'COUNT', false, true),
  UNKNOWN_CODE: policy('UNKNOWN_CODE', 'NO_RETRY', 'IGNORE', false, true),
  CLIENT_BUG: policy('CLIENT_BUG', 'NO_RETRY', 'IGNORE', false, true),
  CREDENTIALS_INVALID: policy('CREDENTIALS_INVALID', 'NO_RETRY', 'OPEN_ACCOUNT', true, false),
  ACCOUNT_BLOCKED: policy('ACCOUNT_BLOCKED', 'NO_RETRY', 'OPEN_ACCOUNT', true, true),
  INSUFFICIENT_BALANCE: policy('INSUFFICIENT_BALANCE', 'NO_RETRY', 'IGNORE', true, false),
  // El 429 va al limitador de la cuenta, no al breaker (§7.2).
  THROTTLED: policy('THROTTLED', 'RETRY_BACKOFF', 'IGNORE', false, false),
  UPSTREAM: policy('UPSTREAM', 'RETRY_BACKOFF', 'COUNT', false, false),
  NO_AVAILABILITY: policy('NO_AVAILABILITY', 'NO_RETRY', 'IGNORE', false, false),
  RATE_UNAVAILABLE: policy('RATE_UNAVAILABLE', 'NO_RETRY', 'IGNORE', false, false),
  OFFER_EXPIRED: policy('OFFER_EXPIRED', 'NO_RETRY', 'IGNORE', false, false),
  BOOKING_FAILED: policy('BOOKING_FAILED', 'NO_RETRY', 'IGNORE', false, false),
  CANCEL_FAILED: policy('CANCEL_FAILED', 'NO_RETRY', 'IGNORE', false, false),
});

/** Lo único que un filtro o un logger puede sacar de un error de TBO. */
export type TboErrorLogMeta = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>;

/**
 * Raíz común para que el filtro de `apps/api` loguee `toLogMeta()` y nada más, sea cual sea la
 * clase. Es abstracta: nadie lanza un `TboError` a secas.
 */
export abstract class TboError extends Error {
  abstract toLogMeta(): TboErrorLogMeta;
}

/**
 * Un path sin query ni fragmento. El `path` llega de `TBO_OPERATIONS`, que no los tiene; el recorte
 * es la red por si alguien pasa una URL armada, que es donde se cuelan los datos.
 */
function bareOperationPath(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? '';
}

export interface TboApiErrorInit {
  /** HTTP de transporte; `0` si no hubo respuesta (red, DNS, timeout local). */
  readonly status: number;
  /** `Status.Code` del cuerpo, sólo si lo hubo y era legible. */
  readonly tboCode?: number;
  /** Path de la operación tal como está en `TBO_OPERATIONS`. */
  readonly path: string;
  readonly kind: TboFailureKind;
  /** Generado por nosotros para cada llamada; nunca viaja a TBO (docs/tbo/01 §4). */
  readonly requestId: string;
  readonly timedOut?: boolean;
}

/**
 * Todo desenlace que no sea éxito tras intentar la llamada.
 *
 * `status` y `tboCode` van separados porque TBO informa el resultado en `Status.Code` dentro del
 * cuerpo y el PDF no dice qué HTTP lo acompaña (p. 8-10). Mezclados, un HTTP 200 con `Code: 479`
 * sería indistinguible de un 4xx de transporte, y `cancel-retry-policy.ts` lo cerraría como
 * determinista por la regla del 4xx sin releer la reserva (08 RF-04 CA-1).
 */
export class TboApiError extends TboError {
  readonly status: number;
  readonly tboCode: number | undefined;
  readonly path: string;
  readonly failure: TboFailureClass;
  readonly requestId: string;
  readonly timedOut: boolean;

  constructor(init: TboApiErrorInit) {
    const path = bareOperationPath(init.path);
    super(`TBO ${path} http=${init.status} code=${init.tboCode ?? '-'} [${init.kind}]`);
    this.name = 'TboApiError';
    this.status = init.status;
    this.tboCode = init.tboCode;
    this.path = path;
    this.failure = TBO_FAILURE_POLICY[init.kind];
    this.requestId = init.requestId;
    this.timedOut = init.timedOut ?? false;
  }

  get kind(): TboFailureKind {
    return this.failure.kind;
  }

  get retryable(): boolean {
    return this.failure.retry !== 'NO_RETRY';
  }

  /** Lista blanca de docs/tbo/01 §11.1. */
  toLogMeta(): TboErrorLogMeta {
    return {
      errorClass: this.name,
      path: this.path,
      status: this.status,
      ...(this.tboCode === undefined ? {} : { tboCode: this.tboCode }),
      kind: this.failure.kind,
      retry: this.failure.retry,
      circuit: this.failure.circuit,
      timedOut: this.timedOut,
      requestId: this.requestId,
    };
  }
}

/**
 * Configuración de la cuenta inválida según el esquema. `issues` son `ruta:código` y nunca
 * valores, como `parseSabreConfig`: una contraseña rechazada no puede acabar en un stack trace.
 * No es un fallo del proveedor y no cuenta para el breaker.
 */
export class TboConfigError extends TboError {
  constructor(readonly issues: readonly string[]) {
    super(`config de TBO inválida (${issues.length > 0 ? issues.join(', ') : 'sin detalle'})`);
    this.name = 'TboConfigError';
  }

  toLogMeta(): TboErrorLogMeta {
    return { errorClass: this.name, issues: this.issues };
  }
}

/**
 * La última puerta antes del cable: sin credenciales usables el proveedor queda AUSENTE, nunca en
 * un modo alternativo. Sólo lleva NOMBRES de campo, igual que `LatamCredentialsMissingError`.
 */
export class TboCredentialsMissingError extends TboError {
  constructor(readonly missing: readonly string[]) {
    super(`no se puede llamar a TBO sin credenciales usables (faltan: ${missing.join(', ')})`);
    this.name = 'TboCredentialsMissingError';
  }

  toLogMeta(): TboErrorLogMeta {
    return { errorClass: this.name, missing: this.missing };
  }
}

/**
 * Por qué se cortó un body antes del cable. `PAYMENT_MODE` y `CARD_DATA` son la guarda D1: sólo
 * `PaymentMode: "Limit"` y ninguna clave de tarjeta, a cualquier profundidad (docs/tbo/01 §10.5).
 * `NOT_ELIGIBLE` es una búsqueda que TBO no admite (más de 4 niños por habitación, sin nacionalidad
 * del huésped líder): el servicio debía dejar a TBO fuera con motivo antes de pedir el body, y el
 * builder se niega en vez de truncar la ocupación o inventar la nacionalidad (08 RF-05 CA-2, RF-06).
 */
export type TboRequestBuildReason = 'SCHEMA' | 'PAYMENT_MODE' | 'CARD_DATA' | 'NOT_ELIGIBLE';

/**
 * El body de salida no pasó su esquema o violó D1. Nada salió hacia TBO, por eso el nombre termina
 * en `BuildError`: el clasificador de cancelaciones lo trata como determinista y previo al write.
 */
export class TboRequestBuildError extends TboError {
  readonly path: string;

  constructor(
    path: string,
    readonly reason: TboRequestBuildReason,
    readonly issues: readonly string[] = [],
  ) {
    const bare = bareOperationPath(path);
    super(
      `TBO ${bare}: request rechazada antes del envío [${reason}]` +
        (issues.length > 0 ? ` (${issues.join(', ')})` : ''),
    );
    this.name = 'TboRequestBuildError';
    this.path = bare;
  }

  toLogMeta(): TboErrorLogMeta {
    return { errorClass: this.name, path: this.path, reason: this.reason, issues: this.issues };
  }
}

/**
 * Por qué una llamada válida no se despachó. `QUEUE_TIMEOUT`: el limitador de la cuenta no tuvo
 * cupo dentro del plazo (docs/tbo/01 §7.2 punto 5); `ABORTED`: el llamador abortó mientras
 * esperaba cupo; `DEADLINE`: un lote de Search no llegó a salir porque al deadline único de la
 * búsqueda ya no le quedaba el mínimo que TBO necesita para responder (02 §4.3 punto 2). Lo
 * decide el adapter, no el limitador.
 */
export type TboDispatchRejectionReason = 'QUEUE_TIMEOUT' | 'ABORTED' | 'DEADLINE';

/**
 * La llamada se rechazó en NUESTRO lado, antes del cable: no salió ningún byte hacia TBO.
 *
 * No es un `TboApiError` porque no hubo intento, y no es un `TboRequestBuildError` porque el body
 * era válido. El nombre termina en `RejectedError` a propósito: `cancel-retry-policy.ts` lo lee como
 * determinista y previo al write, así que un Cancel que no llegó a salir no queda `UNVERIFIED` ni
 * pide conciliar (08 RF-04 CA-5). En Search, el adapter lo convierte en un lote degradado con
 * motivo visible en vez de encolarlo más allá del presupuesto de la búsqueda (RNF-13).
 */
export class TboDispatchRejectedError extends TboError {
  readonly path: string;

  constructor(
    path: string,
    readonly reason: TboDispatchRejectionReason,
    readonly waitedMs: number,
  ) {
    const bare = bareOperationPath(path);
    super(`TBO ${bare}: llamada no despachada [${reason}] tras ${waitedMs} ms`);
    this.name = 'TboDispatchRejectedError';
    this.path = bare;
  }

  toLogMeta(): TboErrorLogMeta {
    return {
      errorClass: this.name,
      path: this.path,
      reason: this.reason,
      waitedMs: this.waitedMs,
    };
  }
}

/**
 * La ventana de 30 minutos entre Search y Book venció en nuestro reloj (`searchSentAt + 27 min`,
 * docs/tbo/01 §6.3). Se lanza SIN llamar a TBO: misma experiencia que un 315, sin gastar QPS ni
 * arriesgar un Book tardío.
 */
export class TboOfferExpiredError extends TboError {
  constructor(readonly expiresAt: string) {
    super(`la oferta de TBO venció en ${expiresAt}; hay que volver a buscar`);
    this.name = 'TboOfferExpiredError';
  }

  toLogMeta(): TboErrorLogMeta {
    return { errorClass: this.name, expiresAt: this.expiresAt };
  }
}

/**
 * `Status.Code` 200 con un cuerpo que no cumple el esquema de la operación. TBO respondió; lo que
 * falló es nuestra lectura. `issues` son `ruta:código` de Zod, sin valores.
 */
export class TboResponseMappingError extends TboError {
  readonly path: string;

  constructor(
    path: string,
    readonly issues: readonly string[],
    readonly requestId?: string,
  ) {
    const bare = bareOperationPath(path);
    super(
      `TBO ${bare}: respuesta ilegible (${issues.length > 0 ? issues.join(', ') : 'sin detalle'})`,
    );
    this.name = 'TboResponseMappingError';
    this.path = bare;
  }

  toLogMeta(): TboErrorLogMeta {
    return {
      errorClass: this.name,
      path: this.path,
      issues: this.issues,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
    };
  }
}

/**
 * La misma lectura fallida, pero en `/Cancel`. Existe sólo por su NOMBRE: `cancel-retry-policy.ts`
 * reconoce `/Cancel(?:Booking)?MappingError$/` como "post-write sin desenlace demostrado" y pide
 * conciliar (`UNVERIFIED`). Con el nombre de la clase madre caería en la regla genérica de
 * `MappingError` y cerraría como fallida una cancelación que TBO pudo aplicar (docs/tbo/01 §9.3).
 */
export class TboCancelMappingError extends TboResponseMappingError {
  constructor(path: string, issues: readonly string[], requestId?: string) {
    super(path, issues, requestId);
    this.name = 'TboCancelMappingError';
  }
}

/**
 * `/Cancel` salió y la respuesta no fue `200` ni `479`: un código de otra operación (`201`, `207`,
 * `300`, `315`, `405`), uno de la cuenta (`400`, `401`, `402`), un `500`, un `429`, un timeout, la
 * red o un HTTP de error sin envelope. El contrato sólo define el `200` y el `479` para Cancel
 * (p. 9, 42), así que ninguno de éstos prueba que TBO NO haya cancelado: si se cerrara como fallida
 * y TBO sí canceló, la orden volvería a confirmada con la habitación liberada (HARD-1).
 *
 * Es un `TboApiError` para que el breaker, el log y el humanizador sigan leyendo el `kind`, el
 * `status` y el `tboCode` de lo que pasó; lo que cambia es el NOMBRE, que
 * `cancel-retry-policy.ts` reconoce antes que la naturaleza `NO_RETRY` del `kind` y deja la
 * cancelación `UNVERIFIED`: se relee la reserva (`verify-cancellation`) y nunca se reenvía.
 */
export class TboCancelOutcomeUnknownError extends TboApiError {
  constructor(init: TboApiErrorInit) {
    super(init);
    this.name = 'TboCancelOutcomeUnknownError';
  }

  static from(error: TboApiError): TboCancelOutcomeUnknownError {
    return new TboCancelOutcomeUnknownError({
      status: error.status,
      ...(error.tboCode === undefined ? {} : { tboCode: error.tboCode }),
      path: error.path,
      kind: error.kind,
      requestId: error.requestId,
      timedOut: error.timedOut,
    });
  }
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

/**
 * La cuenta de TBO cotiza en una moneda cuyo exponente ISO 4217 no es 2 (KWD, CLP, …). `Money`
 * asume dos decimales y esas tarifas saldrían escaladas por 10 o por 100 sin que nadie lo note
 * (docs/tbo/02 §8.3 punto 3). TBO queda no disponible para ESA cuenta con este motivo, y lo que
 * se pide es un perfil en USD u otra moneda de dos decimales (D-TBO-15 A; 08 RF-07 CA-4).
 *
 * No es un fallo del proveedor: la respuesta fue válida, lo que no alcanza es nuestro `Money`. Por
 * eso no es un `TboApiError` y no tiene `kind` que el breaker pueda contar.
 */
export class TboUnsupportedCurrencyError extends TboError {
  readonly currencies: readonly string[];

  constructor(currencies: readonly string[]) {
    // Los códigos vienen de una respuesta de TBO: sólo pasa lo que tiene forma ISO, porque el
    // filtro global de `apps/api` loguea el `message` tal cual.
    const clean = [...new Set(currencies.filter((code) => ISO_CURRENCY.test(code)))].sort();
    super(
      `la cuenta de TBO cotiza en ${clean.length > 0 ? clean.join(', ') : 'una moneda'} sin dos ` +
        'decimales; hace falta un perfil en USD u otra moneda de dos decimales',
    );
    this.name = 'TboUnsupportedCurrencyError';
    this.currencies = clean;
  }

  toLogMeta(): TboErrorLogMeta {
    return { errorClass: this.name, currencies: this.currencies };
  }
}

/**
 * La tarifa trae la condición "sold only with an airline ticket as part of a package" (p. 25, 30)
 * y se intentó reservar como hotel suelto. Hoy no hay reservas de paquete que vinculen vuelo y
 * hotel, así que en la práctica la tarifa no se vende (docs/tbo/03 §2.11, D-TBO-22 A).
 */
export class TboPackageOnlyRateError extends TboError {
  readonly restriction = 'PACKAGE_WITH_FLIGHT_ONLY';

  constructor() {
    super('la tarifa de TBO sólo se vende en un paquete con aéreo (PACKAGE_WITH_FLIGHT_ONLY)');
    this.name = 'TboPackageOnlyRateError';
  }

  toLogMeta(): TboErrorLogMeta {
    return { errorClass: this.name, restriction: this.restriction };
  }
}

/**
 * Todas las clases que el paquete lanza, en una sola lista para el `@Catch(...)` del filtro de
 * `apps/api`. Es la lección de `SABRE_THROWN_CLASSES`: una clase olvidada en el decorador no falla
 * al compilar, sale como 500 genérico. `index.surface.test.ts` comprueba que la lista está completa.
 */
export const TBO_ERROR_CLASSES = Object.freeze([
  TboApiError,
  TboConfigError,
  TboCredentialsMissingError,
  TboRequestBuildError,
  TboDispatchRejectedError,
  TboOfferExpiredError,
  TboResponseMappingError,
  TboCancelMappingError,
  TboCancelOutcomeUnknownError,
  TboUnsupportedCurrencyError,
  TboPackageOnlyRateError,
] as const);
