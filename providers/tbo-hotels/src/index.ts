// ACL de TBO Holidays Hotels (docs/tbo/09-plan-implementacion.md §7).
//
// Superficie EXPLÍCITA, sin `export *`: lo que no está nombrado aquí no existe fuera del paquete.
// `src/internal/**` no se publica a propósito, y los tipos crudos de TBO tampoco (08 RF-07 CA-6).
// `src/index.surface.test.ts` comprueba que cada nombre es el MISMO objeto que define su módulo,
// que no se cuela nada más y que este archivo no declara nada propio.

export {
  TBO_BASE_URLS,
  TBO_ENVIRONMENTS,
  TBO_REDACTED,
  TBO_REQUIRED_CREDENTIAL_FIELDS,
  TBO_TEST_HOST,
  TboHotelsConfigSchema,
  TboSecret,
  hasUsableTboCredentials,
  missingTboCredentials,
  parseTboConfig,
  requireUsableTboConfig,
} from './config';
export type {
  TboEnvironment,
  TboHotelsConfig,
  TboHotelsConfigInput,
  TboRequiredCredentialField,
  TboUsableConfig,
} from './config';

export {
  TBO_ERROR_CLASSES,
  TBO_FAILURE_KINDS,
  TBO_FAILURE_POLICY,
  TboApiError,
  TboCancelMappingError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
} from './errors';
export type {
  TboApiErrorInit,
  TboCircuitEffect,
  TboDispatchRejectionReason,
  TboErrorLogMeta,
  TboFailureClass,
  TboFailureKind,
  TboRequestBuildReason,
  TboRetryNature,
} from './errors';

// El cliente HTTP se publica para el adapter de `apps/api` y para el arnés de certificación
// (PR-1.6). `./http/status-envelope` NO: es la única regla que decide éxito o error, y una segunda
// puerta a ella es cómo Sabre terminó midiendo una copia mientras producción ejecutaba otra.
export {
  TBO_OPERATIONS,
  TBO_SEARCH_RESPONSE_TIME_S,
  TBO_SEARCH_TIMEOUT_CEILING_MS,
  TBO_SEARCH_TIMEOUT_MARGIN_MS,
  isTboMoneyPath,
  tboSearchTimeoutMs,
} from './http/operations';
export type { TboHttpMethod, TboLane, TboOperationName, TboOperationSpec } from './http/operations';

export {
  TBO_MAX_BACKOFF_MS,
  TBO_MIN_BACKOFF_MS,
  TBO_MIN_RETRY_WINDOW_MS,
  TboHttpClient,
  tboAccountRef,
  tboBackoffDelayMs,
} from './http/tbo-http.client';
export type {
  TboAccountContext,
  TboCredentialSource,
  TboFetch,
  TboHttpDeps,
  TboHttpResult,
  TboPayloadRecord,
  TboPayloadVault,
  TboSendOptions,
} from './http/tbo-http.client';

export { TBO_LIMITER_DEFAULTS, TboInMemoryRateLimiter } from './http/limiter';
export type {
  TboLaneQuota,
  TboLimiterGrant,
  TboLimiterOptions,
  TboLimiterPermit,
  TboLimiterRequest,
  TboRateLimiter,
} from './http/limiter';

export { redactTboPayload } from './redaction';

// El código con que cada roompack dice de dónde es (RF-40) y con que el registry lo enruta.
export { TBO_HOTELS_PROVIDER_CODE } from './provider-code';

// Search (PR-1.4). Sólo lo neutral: los topes y la elegibilidad que el servicio necesita para
// dejar a TBO fuera con motivo, y la ventana de la oferta. El builder, el esquema y el mapper
// trabajan con tipos crudos de TBO y los usa el adapter del propio paquete (08 RF-07 CA-6).
export {
  TBO_EMPTY_CHILDREN_AGES,
  TBO_SEARCH_LIMITS,
  checkTboSearchEligibility,
} from './search/search.request.builder';
export type {
  TboEmptyChildrenAges,
  TboSearchEligibility,
  TboSearchIneligibility,
} from './search/search.request.builder';

export {
  TBO_OFFER_SAFETY_MARGIN_MS,
  TBO_OFFER_TTL_MS,
  TBO_SEARCH_TO_BOOK_WINDOW_MS,
  tboOfferExpiresAt,
} from './search/offer-window';

// Búsqueda y detalle de un hotel por los puertos neutrales (PR-1.5): la salida del paquete hacia el
// factory de `apps/api`. Los tipos del reporte son nuestros; el sobre crudo no sale.
export { TBO_SEARCH_BATCHING_LIMITS, TboHotelsAdapter } from './tbo-hotels.adapter';
export type {
  TboHotelRatesReport,
  TboHotelRejection,
  TboHotelsAdapterOptions,
  TboPackRejection,
  TboSearchBatchReport,
  TboSearchBatchStatus,
  TboSearchBatching,
  TboSearchDiagnostics,
  TboSearchPackContext,
  TboSearchReport,
} from './tbo-hotels.adapter';
