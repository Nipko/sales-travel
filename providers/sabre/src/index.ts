// ACL de Sabre (docs/sabre/11-plan-implementacion.md §6).
//
// El paquete está marcado `experimental` (version y campo propio en package.json) y no se
// desmarca hasta tener el fixture de vuelo nocturno con cambio de día: es el único caso que
// los tres ejemplos oficiales de BFM no cubren (§6.4).

export * from './config';
export * from './errors';
export { deriveSabreSecret, SabreTokenService } from './auth/token.service';
export type {
  SabreFetch,
  SabreSecretInput,
  SabreTokenProvider,
  SabreTokenServiceDeps,
} from './auth/token.service';
// `classifySabreEnvelope` y `SabreEnvelopeVerdict` NO se listan aquí: llegan por el `export *`
// de './errors', que es su único hogar. Listarlos desde el cliente HTTP fue lo que publicó la
// copia débil de la regla dura —el export explícito gana al `export *`— mientras los tests
// medían la endurecida. Ver la cabecera de './http/sabre-http.client'.
export {
  isNonIdempotentSabrePath,
  SABRE_NON_IDEMPOTENT_PATHS,
  SabreHttpClient,
} from './http/sabre-http.client';
export type { SabreHttpDeps, SabreRequestOptions, SabreResult } from './http/sabre-http.client';
export { REDACTED, redactMeta, redactText, redactValue, safeBodySummary } from './redaction';
// Aparte y en una línea: `redaction.single-path-rule.test.ts` sólo reconoce un re-export de una línea.
export { redactDocument } from './redaction';
export {
  SABRE_BAGGAGE_REQUEST,
  SABRE_BFM_VERSION,
  SABRE_CABIN_BY_CANONICAL,
  SABRE_CABIN_PREFER_LEVEL,
  SABRE_COMPANY_CODE_TRAVEL_AGENCY,
  SABRE_DATA_SOURCES,
  SABRE_DEFAULT_ITINERARY_TIER,
  SABRE_TIER_CAPACITY,
  defaultNumTripsFor,
  SABRE_ITINERARY_TIERS,
  SABRE_PTC,
  SABRE_REQUESTOR_ID,
  SABRE_REQUESTOR_ID_TYPE,
  SABRE_SHOP_PATH,
  SABRE_VOLUNTARY_CHANGES,
  SabreShopOptionsSchema,
  buildSabreShopRequest,
} from './shop/request.builder';
export type {
  SabreAirLowFareSearchRq,
  SabreCabinCode,
  SabreCabinPref,
  SabreItineraryTier,
  SabreOriginDestinationInformation,
  SabrePassengerTypeQuantity,
  SabrePos,
  SabrePosSource,
  SabrePtc,
  SabreRequestorId,
  SabreShopOptions,
  SabreShopRequest,
  SabreShopTpaExtensions,
  SabreTravelPreferences,
  SabreTravelerInfoSummary,
} from './shop/request.builder';
export {
  SABRE_ATPCO_OFFER_TTL_SECONDS,
  SABRE_DEFAULT_CONTENT_SOURCE,
  SABRE_PROVIDER_NAME,
  SabreGroupedItineraryResponseSchema,
  SabreShopMappingError,
  addDaysToIsoDate,
  canonicalPaxType,
  mapSabreShopResponse,
  resolveOfferExpiry,
} from './shop/response.mapper';
export type {
  SabreMapWarning,
  SabreMapWarningCode,
  SabreOfferExpiry,
  SabreShopMapContext,
  SabreShopMapResult,
} from './shop/response.mapper';
// `./fixtures` ya no existe. Publicaba `buildMockOffers` —un constructor de `Offer[]`
// sintéticas con la misma forma canónica que una tarifa real— y era lo que el modo mock
// devolvía cuando faltaba una credencial. No se movió a un directorio de tests: sus únicos
// consumidores eran ese modo y los tests DEL modo. Los fixtures que sí quedan son los JSON de
// `src/__fixtures__` (respuestas de Sabre para los mappers), que no fabrican ofertas: las
// mapean.
export { SabreFlightSearchAdapter, countWarningsByCode } from './sabre-flight-search.adapter';
export type { SabreFlightSearchDeps } from './sabre-flight-search.adapter';

// ---------------------------------------------------------------------------------------------
// Fase 2.b / Fase 3 — price, create, get y cancel
//
// Cada módulo se exporta con `export *` salvo donde hay AMBIGÜEDAD real, y ahí se resuelve
// nombrando. Un `export *` ambiguo no es un error de estilo: TypeScript lo reporta (ts2308) y,
// peor, el consumidor se queda sin el símbolo. Ver la nota sobre `SABRE_STATUS_NAMES` más abajo.
//
// `src/dist-surface.guard.test.ts` exige que TODO `.ts` de `src/` que no sea test sea alcanzable
// desde aquí, y `src/index.surface.test.ts` que lo que se re-exporta sea EL MISMO objeto que el
// módulo define, no una copia. Los dos guards existen porque este paquete ya publicó una vez una
// copia rancia de una regla mientras los tests medían la buena.
// ---------------------------------------------------------------------------------------------

export * from './indices';
export * from './booking/airline-requirements';
export * from './booking/create.request.builder';
export * from './booking/get.request.builder';
export * from './booking/get.response.mapper';
export * from './booking/cancel.request.builder';
export * from './booking/cancel.response.mapper';
export * from './price/request.builder';
export * from './price/response.mapper';
export * from './flight-check/request.builder';
export * from './flight-check/response.mapper';

// `./booking/create.response.mapper` va nombrado y NO con `export *`.
//
// `SABRE_STATUS_NAMES` y `SabreStatusName` están declarados —con el mismo valor— en los dos
// mappers de booking. Dos declaraciones distintas con el mismo nombre hacen ambiguo el `export *`:
// el símbolo desaparece de la superficie pública. Se publica el de `get.response.mapper`, que es
// el que además trae `SABRE_STATUS_CANCELLED` colgando del mismo tipo, y el de creación se omite
// aquí a propósito. Son el mismo vocabulario del contrato (`StatusNameEnum`, `:9204-9222`); si
// algún día dejaran de serlo, `index.surface.test.ts` se pone rojo y hay que renombrar uno.
export {
  SABRE_ACL_ISSUE_CATEGORY,
  SABRE_CONFIRMED_STATUS_CODES,
  SABRE_CREATE_RETURNS_BOOKING_SIGNATURE,
  SABRE_PENDING_STATUS_CODES,
  SABRE_REJECTED_STATUS_CODES,
  SABRE_WAITLIST_STATUS_CODES,
  SABRE_WARNING_ERROR_CATEGORY,
  SabreCreateBookingMapError,
  SabreCreateBookingResponseSchema,
  classifyItemStatus,
  mapSabreCreateBookingResponse,
  resolveOutcome,
} from './booking/create.response.mapper';
export type {
  SabreCreateBookingMapped,
  SabreCreateBookingResponse,
} from './booking/create.response.mapper';

// ---------------------------------------------------------------------------------------------
// Adapters: los tres puertos del dominio que Sabre implementa a partir de esta fase.
// ---------------------------------------------------------------------------------------------

export * from './sabre-offer-price.adapter';
export * from './sabre-flight-check.adapter';
export * from './sabre-order-create.adapter';
export * from './sabre-order-manage.adapter';

// ---------------------------------------------------------------------------------------------
// Mapa de asientos — Get Seats v3, carril de agencia (SAB-15)
//
// Bloque propio y al final a propósito: los tres módulos se publican con `export *` y todos sus
// nombres llevan el prefijo `SabreGetSeats`/`SABRE_GETSEATS_`/`SabreSeatMap`, así que no pueden
// volver ambiguo ningún símbolo de arriba.
// ---------------------------------------------------------------------------------------------

export * from './seats/getseats.request.builder';
export * from './seats/getseats.response.mapper';
export * from './sabre-seat-map.adapter';

// ---------------------------------------------------------------------------------------------
// Ancillares ATPCO — Stateless Ancillaries 1.0 (SAB-19)
//
// Bloque propio y al final, como el de asientos: los siete módulos se publican con `export *` y
// todos sus nombres llevan `SabreAncillar`, `SABRE_ANCILLAR` o `sabreAncillar`, así que
// no pueden volver ambiguo ningún símbolo de arriba.
// ---------------------------------------------------------------------------------------------

export * from './ancillaries/shop.request.builder';
export * from './ancillaries/shop.response.mapper';
export * from './ancillaries/add.request.builder';
export * from './ancillaries/add.response.mapper';
export * from './ancillaries/remove.request.builder';
export * from './ancillaries/remove.response.mapper';
export * from './sabre-ancillary.adapter';

// ---------------------------------------------------------------------------------------------
// Estado de tiquetes y EMD (SAB-05)
//
// Bloque propio y al final, como los de arriba: sus nombres llevan `SABRE_TICKET_STATUS_`,
// `SabreDocument` o `sabreDocument`/`classifySabreTicket`, así que no vuelven ambiguo nada.
// ---------------------------------------------------------------------------------------------

export * from './ticketing/document-status';

// ---------------------------------------------------------------------------------------------
// Política de emisión al reservar (SAB-06)
//
// Bloque propio y al final: sus nombres llevan `SABRE_BOOKING_TICKETING_`, `SABRE_TICKETING_`,
// `SabreTicketing*`, `planSabreTicketingPolicy` o `isSabrePccTimeZone`, distintos de los
// `SABRE_TICKETING_POLICIES`/`SabreTicketingPolicy` del builder, así que no vuelven ambiguo nada.
// ---------------------------------------------------------------------------------------------

export * from './booking/ticketing-policy';

// ---------------------------------------------------------------------------------------------
// Emisión de tiquetes — fulfillFlightTickets sin tarjeta (SAB-07)
//
// Bloque propio y al final: los nombres llevan `SabreFulfill`, `SABRE_FULFILL_`, `sabreFulfill`,
// `SabreTicketing*` distintos de los de la política de emisión (`SabreTicketingAdapter*`,
// `SabreTicketingNotSentError`, `SabreTicketingRefusal`, `SabreTicketingDeps`), `sabreTicketCoverage`
// o `sabreCanonicalJson`/`sabreBodyDigest`, así que no vuelven ambiguo nada de arriba.
// ---------------------------------------------------------------------------------------------

export * from './canonical-json';
export * from './ticketing/fulfill.request.builder';
export * from './ticketing/fulfill.response.mapper';
export * from './sabre-ticketing.adapter';

// ---------------------------------------------------------------------------------------------
// Datos de los pasajeros de una reserva hecha — modifyBooking (SAB-25, RF-17)
//
// Bloque propio y al final: los nombres llevan `SabreModify`, `SABRE_MODIFY_`, `SabreTraveler*`,
// `sabreTravel*`, `SABRE_DOCUMENT_TYPE_BY_`, `SABRE_FREQUENT_FLYER_` o son funciones con «Travelers»
// en el nombre, así que no vuelven ambiguo nada de arriba. El adapter sigue siendo
// `SabreOrderManageAdapter`, ya publicado arriba.
// ---------------------------------------------------------------------------------------------

export * from './booking/modify.request.builder';
export * from './booking/modify.response.mapper';
