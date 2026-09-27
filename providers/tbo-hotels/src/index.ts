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
  TboCancelOutcomeUnknownError,
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

// Búsqueda, detalle de un hotel, PreBook, Book, BookingDetail, Cancel y BookingDetailsbasedondate por
// los puertos neutrales (PR-1.5, PR-4.1, PR-4.2, PR-5.1): la salida del paquete hacia el factory de
// `apps/api`. Los tipos del reporte son nuestros; el sobre crudo no sale.
export { TBO_SEARCH_BATCHING_LIMITS, TboHotelsAdapter } from './tbo-hotels.adapter';
export type {
  TboBookProviderOptions,
  TboBookQuery,
  TboBookReply,
  TboBookReplyDiagnostics,
  TboBookReplySummary,
  TboBookReport,
  TboBookedHotel,
  TboBookedRoomSummary,
  TboBookingByDate,
  TboBookingDetailDiagnostics,
  TboBookingDetailMapping,
  TboBookingDetailPurpose,
  TboBookingDetailQuery,
  TboBookingDetailReport,
  TboBookingDetailSummary,
  TboBookingDetailWarning,
  TboBookingLookup,
  TboBookingsByDateDiagnostics,
  TboBookingsByDateMapping,
  TboBookingsByDateQuery,
  TboBookingsByDateReport,
  TboCancelQuery,
  TboCancelReading,
  TboCancelReport,
  TboHotelRatesReport,
  TboHotelRejection,
  TboHotelsAdapterOptions,
  TboPackRejection,
  TboPrebookDiagnostics,
  TboPrebookMapping,
  TboPrebookProviderOptions,
  TboPrebookQuery,
  TboPrebookReport,
  TboPrebookWarning,
  TboSearchBatchReport,
  TboSearchBatchStatus,
  TboSearchBatching,
  TboSearchDiagnostics,
  TboSearchPackContext,
  TboSearchReport,
  TboVoucherStatus,
} from './tbo-hotels.adapter';

// PreBook (PR-4.1): lo que el servidor necesita para decidir con lo que devuelve el adapter. La
// comparación C1/C2 es pura y sobre tipos neutrales; la huella se recalcula desde el snapshot
// persistido. El builder, el esquema, el saneo de `RateConditions` y el mapper trabajan con el JSON
// crudo de TBO y no salen: fuera se leen las condiciones ya saneadas.
export {
  TBO_RATE_CONDITION_CHANGES,
  TBO_REPRICE_OUTCOMES,
  compareTboRates,
} from './prebook/compare';
export type {
  TboPriceDirection,
  TboRateConditionChange,
  TboRateSnapshot,
  TboRepriceComparison,
  TboRepriceOutcome,
  TboRepriceStage,
} from './prebook/compare';
export { tboRateConditionsHash } from './prebook/rate-conditions';
export { TBO_PREBOOK_WARNINGS } from './prebook/response.mapper';

// Book y referencias de reserva (PR-4.2): lo que la saga de `apps/api` necesita ANTES del Book
// —generar y persistir la referencia (RF-19) y validar los huéspedes contra la ocupación para
// responder 400 sin insertar el intent (RF-18)— y DESPUÉS —clasificar lo que el Book lanzó con la
// misma regla que el adapter aplica a un `200` (03 §3.9)—. El builder, el esquema y el mapper
// trabajan con el JSON crudo de TBO y no salen.
export {
  TBO_BOOKING_REFERENCE_ALPHABET,
  TBO_BOOKING_REFERENCE_PATTERN,
  TBO_CONFIRMATION_NUMBER_PATTERN,
  generateTboBookingReference,
  isTboBookingReference,
  isTboConfirmationNumber,
  tboBookingReferenceEnvironment,
} from './booking/booking-reference';
export type { TboRandomBytes } from './booking/booking-reference';
export {
  TBO_BOOK_LIMITS,
  TBO_GUEST_TITLES,
  checkTboBookGuests,
} from './booking/book.request.builder';
export type {
  TboBookGuest,
  TboGuestCheck,
  TboGuestTitle,
  TboNameRejection,
} from './booking/book.request.builder';
export { TBO_BOOK_OUTCOME_REASONS, classifyTboBookOutcome } from './booking/classify-book-outcome';
export type {
  TboBookClassification,
  TboBookExpectation,
  TboBookObservation,
  TboBookOutcome,
  TboBookOutcomeReason,
} from './booking/classify-book-outcome';

// BookingDetail (PR-4.2): el vocabulario de lo que devuelve el adapter. El estado ya sale
// normalizado en la vista; el valor crudo se lee como código con esta lista.
export { TBO_BOOKING_STATUSES } from './detail/booking-status';
export { TBO_BOOKING_DETAIL_WARNINGS } from './detail/response.mapper';

// Cancel (PR-5.1): el vocabulario cerrado del resultado, para que `apps/api` lo humanice y registre.
// El builder, el esquema y el mapper de `/Cancel` trabajan con el JSON crudo y no salen; las dos
// funciones de decisión las aplica el adapter, y fuera se lee su resultado.
export {
  TBO_CANCEL_ERRORS,
  TBO_CANCEL_SKIP_REASONS,
  TBO_CANCEL_WARNINGS,
} from './cancel/cancel-decision';
export type {
  TboCancelError,
  TboCancelSkipReason,
  TboCancelWarning,
} from './cancel/cancel-decision';

// BookingDetailsbasedondate (PR-5.1): el tope de una ventana y el partidor de rangos que usa la
// conciliación para el tramo B (04 §9.3). El builder, el esquema y el mapper no salen.
export {
  TBO_BOOKINGS_BY_DATE_MAX_DAYS,
  splitTboBookingDateRange,
} from './reports/booking-by-date.request.builder';
export type { TboBookingDateWindow } from './reports/booking-by-date.request.builder';

// Contenido estático (PR-3.1): el cliente del sync de catálogo, sin métodos de venta (06 §4.2), y
// los tipos ya normalizados que devuelve. Los builders, los esquemas y los mappers trabajan con el
// JSON crudo de TBO y no salen; el saneador de HTML se aplica dentro del cliente, al ingerir.
export { TBO_STATIC_TIMEOUTS_MS, TboStaticContentClient } from './tbo-static-content.client';
export type {
  TboCityHotelsQuery,
  TboCityHotelsResult,
  TboCityListResult,
  TboCountryListResult,
  TboHotelCodeListResult,
  TboHotelDetailsResult,
  TboStaticCall,
  TboStaticCallOptions,
  TboStaticContentOptions,
  TboStaticOperation,
} from './tbo-static-content.client';

export { TBO_CONTENT_LANGUAGES } from './static/content.types';
export type {
  TboCatalogHotel,
  TboCity,
  TboCityHotelsMapping,
  TboCityListMapping,
  TboContentLanguage,
  TboContentSection,
  TboContentSource,
  TboCountry,
  TboCountryListMapping,
  TboGeoPoint,
  TboHotelCodeListMapping,
  TboHotelContent,
  TboHotelDetailsMapping,
  TboStaticDiagnostics,
  TboStaticNote,
  TboStaticRejection,
} from './static/content.types';

// El lote de HotelDetails lo parte el sync (E4): necesita el techo y el tamaño por defecto.
export { TBO_HOTEL_DETAILS_LIMITS } from './static/hotel-details.request.builder';
