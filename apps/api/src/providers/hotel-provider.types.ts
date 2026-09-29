import type {
  BoardType,
  HotelFee,
  HotelOffer,
  HotelRatesQuery,
  HotelRoomOccupancy,
  HotelRoompack,
  HotelSearchCriteria,
  Money,
} from '@sales-travel/canonical';
import type {
  HotelBookPort,
  HotelBookResult,
  HotelBookingByClientReferencePort,
  HotelBookingContact,
  HotelBookingReadPort,
  HotelBookingRoomGuests,
  HotelBookingsByDatePort,
  HotelCancelPort,
  HotelPaymentOptionsPort,
  HotelPrebookPort,
  HotelPrebookResult,
  HotelPriceJumpRecoveryPort,
  HotelRateSignal,
  HotelRatesDetailPort,
  HotelSearchPort,
  HotelSuggestPort,
  SearchContext,
} from '@sales-travel/domain';
import type { ProviderCircuitOptions } from '../search/circuit-breaker.service.js';
import type {
  ProviderErrorContext,
  ResolvedProvider,
  SkippedProvider,
  TenantAdapter,
  TenantProviderFactory,
  UnavailableProvider,
} from './provider.types.js';

/**
 * Un adapter de hoteles = los cinco puertos que todo proveedor de hoteles tiene que sostener:
 * disponibilidad, revalidación, reserva, lectura y cancelación.
 *
 * Lo que no todos saben hacer (sugerencias de destino, tarifas de un hotel, medios de pago,
 * salto de precio, lectura por nuestra referencia, reservas por fecha) NO va aquí como método
 * opcional: cada cosa es un puerto aparte y se detecta por la presencia del método con los
 * `supportsHotel*` de abajo. Un `?` en el contrato trasladaría la duda a cada llamador.
 */
export interface HotelProviderAdapter
  extends HotelSearchPort,
    HotelPrebookPort,
    HotelBookPort,
    HotelBookingReadPort,
    HotelCancelPort {}

/**
 * Qué sabe hacer un proveedor de hoteles. Estático por proveedor: sirve para gatear la
 * post-venta sin resolver credenciales.
 *
 * No es `ProviderCapabilities` de vuelos: `pay`, `services` y `reshop` no significan nada en un
 * hotel, y en cambio falta lo que decide si una reserva cuya respuesta no llegó se puede
 * verificar sin reservar dos veces.
 */
export interface HotelProviderCapabilities {
  readonly retrieve: boolean;
  readonly cancel: boolean;
  /**
   * Lee una reserva por la referencia que ENVIAMOS. Es lo único que permite verificar un Book
   * que se cortó antes de devolver el localizador del proveedor.
   */
  readonly retrieveByClientReference: boolean;
  /** Lista las reservas de la cuenta por fecha, para la conciliación diaria. */
  readonly reconcileByDate: boolean;
  /**
   * El proveedor entrega el número de confirmación del hotel (HCN) en la lectura de la reserva, con
   * un SLA que la plataforma sigue (docs/tbo/04 §8; RF-27). No alcanza con `retrieve`: leer una
   * reserva no dice que alguna vez traiga el HCN, y seguir a un proveedor que no lo da sólo gasta
   * lecturas y termina en una tarea de operaciones por un número que nunca iba a llegar. Sin
   * `retrieve` tampoco hay seguimiento: no hay con qué leerlo.
   */
  readonly hcn: boolean;
}

export type HotelProviderCapability = keyof HotelProviderCapabilities;

// ───────────────────────── Cómo se le pregunta a cada proveedor ─────────────────────────

/**
 * En qué espacio de ids viven los destinos y los hoteles del proveedor.
 *
 * - `platform`: los del autocompletado de destinos y los `hotelIds` que escribe el vendedor. Sus
 *   hoteles se buscan en `hotel_inventory.city_id` con el destino tal cual.
 * - `provider`: un espacio propio (`hotel_inventory.provider_city_code`). El destino se traduce
 *   con `hotel_destination_map`, o llega ya como una de sus ciudades cuando el tenant no tiene
 *   autocompletado de la plataforma y las sugerencias salen de su catálogo local
 *   (`<código>:<ciudad>`, docs/tbo/05 §8.5). Un id que escribió el vendedor no le sirve:
 *   mandárselo podría traer OTRO hotel con el mismo número.
 */
export type HotelIdSpace = 'platform' | 'provider';

/**
 * Proveedor cuyo espacio de ids ES el de la plataforma: su autocompletado da el `destinationId`
 * del borde HTTP y su catálogo usa `hotel_inventory.city_id`. Es el `source_provider_code` de las
 * filas de `hotel_destination_map` con que un proveedor de ids propios traduce ese destino a sus
 * ciudades (docs/tbo/05 §8.1).
 */
export const PLATFORM_ID_SPACE_PROVIDER = 'despegar-hotels';

/**
 * Con qué criterio se eligen, de su catálogo, los hoteles que se le piden al proveedor cuando el
 * destino tiene más de los que caben en una búsqueda.
 *
 * - `hotel_id`: determinista y sin criterio comercial. Es el de Despegar, que no se cambia sin
 *   telemetría (docs/tbo/09 PR-0.5).
 * - `relevance`: primero los de más estrellas, los que no las informan al final y el id como
 *   desempate (docs/tbo/02 §4.3; D-TBO-17 A). Con cientos de hoteles en una ciudad, el orden por
 *   id dejaba fuera a los que el vendedor más busca.
 */
export type HotelCatalogOrder = 'hotel_id' | 'relevance';

/**
 * Topes de ocupación del PROVEEDOR, más estrechos que los del borde HTTP. Un campo ausente
 * significa que el proveedor acepta lo mismo que el borde.
 */
export interface HotelOccupancyLimits {
  readonly maxRooms?: number;
  readonly maxAdultsPerRoom?: number;
  readonly maxChildrenPerRoom?: number;
  readonly maxChildAge?: number;
}

/**
 * Lo que el servicio de búsqueda necesita saber de un proveedor ANTES de llamarlo. Estático por
 * proveedor, como las capacidades: se lee sin tocar credenciales.
 */
export interface HotelSearchProfile {
  readonly idSpace: HotelIdSpace;
  /** Cuántos hoteles de su catálogo se le piden, como mucho, por búsqueda. */
  readonly maxHotelsPerSearch: number;
  readonly catalogOrder: HotelCatalogOrder;
  readonly occupancy?: HotelOccupancyLimits;
  /**
   * Tarifa según la nacionalidad del pasajero principal (TBO, p. 10): sin ella en la búsqueda, el
   * proveedor queda fuera con motivo y los demás buscan. Ausente, no la necesita.
   */
  readonly requiresGuestNationality?: boolean;
  /**
   * Su disponibilidad no trae nombre, estrellas, dirección ni coordenadas (TBO, pp. 13-15): el
   * servicio los completa desde SU fila de `hotel_inventory`, sólo donde el proveedor no los
   * informó. Ausente, el proveedor los trae y el catálogo no se consulta para eso.
   */
  readonly contentFromCatalog?: boolean;
  /**
   * Dominios (y sus subdominios) desde los que el proveedor sirve las fotos de sus hoteles. Sólo
   * una foto de estos dominios, por `https`, sale en los resultados, y por el proxy de imágenes
   * propio (`/api/hotels/images/…`), nunca enlazada directo. Ausente, sus fotos no se muestran en
   * los resultados.
   */
  readonly imageHosts?: readonly string[];
}

/**
 * Contrato del factory de un proveedor de hoteles: `TenantProviderFactory` con las capacidades
 * de hoteles y SIN `forTenant`.
 *
 * `forTenant` queda fuera porque el registry no lo usa —resuelve con `resolveForTenant`, que es
 * lo que dice de dónde salieron las credenciales—. El de Despegar lo conserva para las rutas de
 * reserva que todavía hablan sus DTOs (`DespegarHotelReservationsService`); exigirlo aquí
 * obligaría a cada proveedor nuevo a exponer su ACL concreto.
 */
export interface HotelProviderFactory
  extends Pick<
    TenantProviderFactory<HotelProviderAdapter>,
    'code' | 'defaultCallPolicy' | 'resolveForTenant'
  > {
  /**
   * Literal y no `ProviderVertical`: un factory de vuelos en la lista de hoteles es un error de
   * cableado y tiene que serlo en compilación.
   */
  readonly vertical: 'hotels';
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
  /**
   * El adapter con la cuenta con la que se hizo UNA orden (`orders.provider_account_id`), para su
   * post-venta: no la vigente del tenant, que puede ser otra si la agencia cambió de cuenta
   * (RF-29; D-TBO-28 A). La orden se lee con el tenant fijado y la cuenta tiene que seguir en su red.
   *
   * Opcional: un proveedor cuyas reservas no pasan por órdenes (Despegar, D-TBO-08 A) no lo
   * necesita, y el registry no inventa un reemplazo.
   *
   * Lanza `NotFoundException` si la cuenta de la orden ya no está disponible para el tenant.
   */
  resolveForOrder?(tenantId: string, orderId: string): Promise<TenantAdapter<HotelProviderAdapter>>;
  /**
   * El adapter con UNA cuenta propia del tenant dueño, por id: la conciliación lee las reservas de
   * la cuenta entera, no las de un tenant (docs/tbo/04 §9.2). Pasa por las mismas puertas que la
   * venta. Opcional: sólo lo implementa quien declara `reconcileByDate`.
   *
   * Lanza `NotFoundException` si no es una cuenta activa de ese tenant.
   */
  resolveForAccount?(
    ownerTenantId: string,
    accountId: string,
  ): Promise<TenantAdapter<HotelProviderAdapter>>;
  /**
   * Como el de `TenantProviderFactory`, más lo que sabe quien llama: con una cuenta heredada el
   * mensaje de una credencial rechazada va dirigido al consolidador, no a la agencia. Un factory
   * que no lo necesita lo ignora.
   */
  humanizeError(err: unknown, context?: ProviderErrorContext): string;
}

export interface ResolvedHotelProvider
  extends Omit<ResolvedProvider<HotelProviderAdapter>, 'capabilities'> {
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
  /** Lo que el factory declaró para el breaker; se pasa tal cual en cada llamada al adapter. */
  readonly circuit?: ProviderCircuitOptions;
  /** Tenant dueño de la cuenta con que sale el adapter (ver `TenantAdapter`). */
  readonly accountOwnerTenantId?: string;
}

/** Lo que el registry necesita de una orden para resolver su post-venta. */
export interface HotelOrderProviderRef {
  readonly orderId: string;
  /** `orders.provider`. */
  readonly provider: string;
  /** `orders.provider_account_id`; `null` en órdenes que no la guardaron. */
  readonly providerAccountId: string | null;
}

/** Una cuenta de proveedor, para lo que se hace por cuenta y no por tenant (la conciliación). */
export interface HotelProviderAccountRef {
  /** `provider_accounts.provider_code`. */
  readonly provider: string;
  /** `provider_accounts.id`, propia del tenant dueño. */
  readonly accountId: string;
}

/** Un proveedor conocido por la plataforma, sin resolver credenciales de nadie. */
export interface HotelProviderRegistration {
  readonly code: string;
  readonly searchProfile: HotelSearchProfile;
}

export interface HotelProviderResolution {
  /** Proveedores llamables, en orden ESTABLE (alfabético por code). */
  readonly active: ResolvedHotelProvider[];
  /** Habilitados pero no llamados en esta búsqueda, con el motivo. */
  readonly skipped: SkippedProvider[];
  /** Conocidos por la plataforma pero no resolubles para este tenant, con el motivo. */
  readonly unavailable: UnavailableProvider[];
}

/** Token DI del listado de factories de hoteles. Sumar un proveedor = una línea en el módulo. */
export const HOTEL_PROVIDER_FACTORIES = 'HOTEL_PROVIDER_FACTORIES';

/**
 * Token DI de la habilitación por tenant de los proveedores de hoteles. Es otro token que el de
 * vuelos a propósito: cada uno lleva su variable de entorno legado, y activar por entorno un
 * proveedor de vuelos para una agencia no puede encender uno de hoteles, que factura distinto.
 */
export const HOTEL_PROVIDER_FLAGS = 'HOTEL_PROVIDER_FLAGS';

// ───────────────────────── Contexto de búsqueda en el servidor (RF-08) ─────────────────────────

/**
 * Huella de la cuenta con la que un adapter sale al proveedor: id de la cuenta y su versión,
 * NUNCA el secreto. Al reservar se compara con la de la búsqueda: si la credencial rotó, o la
 * agencia pasó de heredada a propia, la tarifa se buscó con otra cuenta y se vuelve a buscar.
 */
export interface HotelProviderAccountFingerprint {
  readonly accountId: string;
  /** `provider_accounts.updated_at` en ISO 8601: cambia al rotar la credencial. */
  readonly updatedAt: string;
}

/**
 * Lo que la reserva de UNA tarifa necesita reenviar al proveedor y el navegador no puede aportar.
 * En TBO: `HotelCode`, `BookingCode` y el literal de `TotalFare` (docs/tbo/02 §9.3).
 */
export interface HotelSearchPackContext {
  readonly hotelId: string;
  /** El mismo `provider.offerRef` del roompack. */
  readonly offerRef: string;
  /**
   * El total tal como lo escribió el proveedor. El Book de TBO lo reenvía y no puede ser una
   * reconstrucción desde unidades menores (02 §8.3).
   */
  readonly totalText: string;
  readonly currency: string;
}

/** Lo que una búsqueda deja en el servidor además de las ofertas. */
export interface HotelSearchContextData {
  /** Id NUESTRO de la búsqueda: única clave que viaja en `provider.raw` de cada pack. */
  readonly searchId: string;
  /** Epoch en ms en que salió el Search: el reloj de la oferta arranca aquí (RF-09). */
  readonly searchSentAt: number;
  /** Epoch en ms hasta el que el proveedor sostiene las tarifas: el TTL del contexto. */
  readonly expiresAt: number;
  readonly packs: readonly HotelSearchPackContext[];
}

export interface HotelSearchWithContext extends HotelSearchContextData {
  readonly offers: HotelOffer[];
  /**
   * Presente si parte de los hoteles pedidos no se consultó o su consulta falló, y otra parte sí
   * respondió (RF-14 CA-3): las ofertas son las de lo que respondió. `cause` es el error del primer
   * tramo que no aportó, para humanizarlo como cualquier fallo del proveedor. Sin esto, un lote
   * caído se vería como "no hay más hoteles" (RNF-13).
   */
  readonly partial?: { readonly cause: unknown };
}

export interface HotelRatesWithContext extends HotelSearchContextData {
  readonly offer: HotelOffer;
}

/**
 * Un proveedor cuya reserva depende de lo que dejó su búsqueda (RF-08): el PreBook de TBO recibe
 * sólo el `BookingCode` y el Book no lleva fechas, edades ni nacionalidad (pp. 19, 32-34). Sin
 * este registro del lado del servidor, la ocupación y el importe que llegan al proveedor los
 * pondría el navegador.
 */
export interface HotelSearchContextPort {
  readonly searchAccount: HotelProviderAccountFingerprint;
  searchAvailabilityWithContext(
    criteria: HotelSearchCriteria,
    ctx: SearchContext,
  ): Promise<HotelSearchWithContext>;
}

/**
 * Igual que `HotelSearchContextPort`, para el detalle de un hotel: un proveedor cuyo detalle es
 * otra búsqueda emite tarifas nuevas, y la que se reserva es la del detalle.
 */
export interface HotelRatesContextPort {
  readonly searchAccount: HotelProviderAccountFingerprint;
  getHotelRatesWithContext(
    query: HotelRatesQuery,
    ctx: SearchContext,
  ): Promise<HotelRatesWithContext>;
}

// ───────────────────────── PreBook con contexto (RF-15) ─────────────────────────

/**
 * Lo que la búsqueda MOSTRÓ de una tarifa y la primera comparación de precio (C1) tiene que
 * sostener: neto, moneda, si es reembolsable, régimen y cargos a pagar en el hotel (docs/tbo/03
 * §2.9; 08 RF-15). El servicio lo toma del roompack neutral al guardar el contexto: es lo que vio
 * el vendedor, no lo que el ACL quiera repetir en el PreBook.
 */
export interface HotelSearchRateFacts {
  readonly total: Money;
  readonly refundable: boolean;
  readonly board: BoardType;
  readonly mealTypeRaw?: string;
  readonly atPropertyCharges: readonly HotelFee[];
}

/**
 * La tarifa que el vendedor aceptó en un PreBook, tal como quedó en el servidor: la base de la
 * segunda comparación (C2), justo antes del Book.
 */
export interface HotelAcceptedRate {
  /** El literal del total del PreBook: lo que el Book reenvía. */
  readonly totalText: string;
  readonly roompack: HotelRoompack;
  readonly signals: readonly HotelRateSignal[];
  /** Huella del texto saneado de las condiciones de la tarifa. */
  readonly rateConditionsHash: string;
}

/** Contra qué se compara lo que devuelve el PreBook. */
export type HotelRateBaseline =
  | {
      readonly stage: 'C1';
      /** El literal del total de la búsqueda. */
      readonly totalText: string;
      readonly seen: HotelSearchRateFacts;
    }
  | { readonly stage: 'C2'; readonly accepted: HotelAcceptedRate };

/**
 * Qué revalidar. Todo sale del contexto de búsqueda del servidor (RF-08), nunca del navegador: el
 * hotel y la ocupación que el PreBook no recibe pero su respuesta tiene que cumplir, y el instante
 * del Search del que sale el vencimiento.
 */
export interface HotelPrebookContextRequest {
  readonly searchId: string;
  readonly hotelId: string;
  /** La referencia reservable que se revalida (en TBO, el `BookingCode`). */
  readonly offerRef: string;
  /** Epoch en ms del envío del Search que emitió la tarifa (RF-09). */
  readonly searchSentAt: number;
  /** En el orden del Search. */
  readonly rooms: readonly HotelRoomOccupancy[];
  readonly baseline: HotelRateBaseline;
}

export type HotelRepriceStage = HotelRateBaseline['stage'];

/** Resultado de comparar dos lecturas de la misma tarifa (03 §2.9 regla 2). */
export type HotelRepriceOutcome = 'UNCHANGED' | 'DECREASED' | 'INCREASED' | 'CONDITIONS_CHANGED';

/** Dirección del precio. `NOT_COMPARABLE` cuando cambió la moneda. */
export type HotelPriceDirection = 'SAME' | 'DOWN' | 'UP' | 'NOT_COMPARABLE';

/** Qué condición cambió. Vocabulario cerrado: el evento y la web razonan por código, no por texto. */
export type HotelRateConditionChange =
  | 'CURRENCY'
  | 'REFUNDABLE'
  | 'MEAL_TYPE'
  | 'AT_PROPERTY_CHARGES'
  | 'CANCEL_POLICIES'
  | 'SIGNALS'
  | 'RATE_CONDITIONS';

export interface HotelRepriceComparison {
  readonly stage: HotelRepriceStage;
  readonly outcome: HotelRepriceOutcome;
  readonly price: HotelPriceDirection;
  readonly changes: readonly HotelRateConditionChange[];
  /** Netos del proveedor en unidades menores: sin texto del proveedor (va a `domain_events`). */
  readonly previousTotal: Money;
  readonly currentTotal: Money;
}

export interface HotelPrebookWithContext {
  /** La tarifa revalidada, con las políticas que el proveedor da por finales. */
  readonly result: HotelPrebookResult & { readonly roompack: HotelRoompack };
  /**
   * Lo que el Book reenvía: la referencia y el literal del total DE ESTE PreBook, que pueden no
   * ser los de la búsqueda (Q-30).
   */
  readonly pack: HotelSearchPackContext;
  /** Huella del texto saneado de las condiciones, para la comparación C2. */
  readonly rateConditionsHash: string;
  readonly comparison: HotelRepriceComparison;
  /** El de la llamada, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly requestId?: string;
}

/**
 * Qué deja inservible un error del PreBook: la tarifa (ya no está disponible) o la búsqueda entera
 * (la sesión del proveedor venció, TBO `315`).
 */
export type HotelOfferInvalidation = 'offer' | 'search';

/**
 * Un proveedor cuyo PreBook se arma con el contexto de su búsqueda y se compara contra lo que se
 * mostró (TBO). Lo que significan sus errores para esa búsqueda lo dice el propio proveedor: el
 * servicio no conoce sus códigos.
 */
export interface HotelPrebookContextPort {
  readonly searchAccount: HotelProviderAccountFingerprint;
  prebookWithContext(
    request: HotelPrebookContextRequest,
    ctx: SearchContext,
  ): Promise<HotelPrebookWithContext>;
  /** `undefined`: el error no dice nada de la tarifa ni de la búsqueda (red, cuenta, breaker). */
  offerInvalidatedBy(err: unknown): HotelOfferInvalidation | undefined;
}

// ───────────────────────── Book con contexto (RF-18 a RF-20) ─────────────────────────

/** Un huésped tal como sale al proveedor: lo que la orden guarda como "enviado" (RF-18). */
export interface HotelGuestSent {
  readonly title: 'Mr' | 'Mrs' | 'Ms';
  readonly firstName: string;
  readonly lastName: string;
  readonly paxType: 'ADT' | 'CHD';
}

/**
 * Los huéspedes contra la ocupación de la búsqueda, con las reglas del proveedor. `issues` son
 * `ruta:código` en el vocabulario de la entrada (`rooms.1.guests.0.lastName:too_short`), nunca
 * valores: son nombres de personas.
 */
export type HotelGuestCheck =
  | { readonly ok: true; readonly rooms: readonly (readonly HotelGuestSent[])[] }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Qué reservar. Todo sale del intent ya persistido y del PreBook de revalidación (C2), nunca del
 * navegador (RF-20): la referencia de la tarifa y el literal del total son los de ese PreBook, la
 * ocupación es la del Search y la referencia de reserva se escribió en la orden antes de llamar.
 */
export interface HotelBookContextRequest {
  /** `pack.offerRef` del PreBook de revalidación (Q-30). */
  readonly offerRef: string;
  /** `pack.totalText` del PreBook de revalidación: el literal, no una reconstrucción (CK-11). */
  readonly totalText: string;
  /** La referencia NUESTRA que ya está en `orders.provider_booking_ref`. */
  readonly bookingReference: string;
  /** Epoch en ms del envío del Search que emitió la tarifa (RF-09). */
  readonly searchSentAt: number;
  /** Ocupación del Search, en su orden. */
  readonly occupancy: readonly HotelRoomOccupancy[];
  /** Huéspedes por habitación, en el orden de `occupancy`. */
  readonly rooms: readonly HotelBookingRoomGuests[];
  /** El contacto que viaja al proveedor (D-TBO-23 A: el operativo de la agencia). */
  readonly contact: HotelBookingContact;
}

/**
 * Lo que el proveedor respondió a un Book que NO lanzó: `CONFIRMED` o un desenlace que hay que
 * verificar leyendo. Un rechazo del proveedor se LANZA, para que el breaker lo cuente; quien llama
 * lo traduce con {@link HotelBookingContextPort.bookFailureOf}.
 */
export interface HotelBookWithContext {
  readonly result: HotelBookResult;
  /** Motivo en el vocabulario cerrado del proveedor (`confirmed`, `missing-confirmation-number`…). */
  readonly reason: string;
  /** El de la llamada, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly requestId?: string;
}

/**
 * Qué significa un error que lanzó el Book (docs/tbo/03 §3.9).
 *
 * - `FAILED` con `dispatched: true`: el proveedor dijo que no reservó nada. Se libera la clave.
 * - `FAILED` con `dispatched: false`: no salió ningún byte (rechazo local antes del cable).
 * - `UNCERTAIN`: puede haber reserva del otro lado. Se verifica leyendo, nunca reintentando.
 */
export interface HotelBookFailure {
  readonly outcome: 'FAILED' | 'UNCERTAIN';
  /** Vocabulario cerrado del proveedor: viaja a `domain_events` y a `provider_raw`. */
  readonly reason: string;
  readonly dispatched: boolean;
  /** Código del proveedor, como texto, si lo hubo. */
  readonly providerStatus?: string;
  /** Nombre de la clase del error, nunca su mensaje. */
  readonly errorClass?: string;
}

/**
 * Un proveedor cuyo Book sale con lo que su búsqueda y su PreBook dejaron en el servidor, con una
 * referencia nuestra que se persiste ANTES de llamar (D-TBO-07 A; RF-19). Es lo que exige la saga
 * de reserva con órdenes: un proveedor sin este puerto no reserva por ella (Despegar sigue con su
 * flujo propio, D-TBO-08 A).
 */
export interface HotelBookingContextPort {
  readonly searchAccount: HotelProviderAccountFingerprint;
  /** Una referencia nueva para UN request de Book (RF-19): nunca se reutiliza. */
  newBookingReference(): string;
  /** Huéspedes contra la ocupación, con las reglas del proveedor, sin llamarlo (RF-18). */
  checkBookingGuests(
    rooms: readonly HotelBookingRoomGuests[],
    occupancy: readonly HotelRoomOccupancy[],
  ): HotelGuestCheck;
  /** UN intento: el reintento de un Book puede reservar dos veces (03 §4.4). */
  bookWithContext(
    request: HotelBookContextRequest,
    ctx: SearchContext,
  ): Promise<HotelBookWithContext>;
  bookFailureOf(err: unknown): HotelBookFailure;
}

// ───────────────────────── Problemas de la cuenta (RF-23) ─────────────────────────

/**
 * Un rechazo del proveedor que no es de la tarifa ni de la reserva sino de la CUENTA con que se
 * opera, y que sólo su dueño puede resolver (docs/tbo/03 §6): sin saldo o crédito para la reserva
 * (TBO `300`) o bloqueada por el proveedor (TBO `402`). Vocabulario cerrado: viaja a
 * `domain_events`.
 */
export type HotelProviderAccountIssue = 'insufficient-balance' | 'agent-blocked';

/**
 * Un proveedor que sabe decir si un error suyo es un problema de la cuenta. Con una cuenta
 * heredada, la agencia que vende no puede arreglarlo ni debe ver el saldo de la cuenta: el aviso
 * va a su dueño.
 */
export interface HotelAccountIssuePort {
  /** `undefined`: el error no dice nada de la cuenta. */
  accountIssueOf(err: unknown): HotelProviderAccountIssue | undefined;
}

// ───────────────────────── Contenido de un hotel bajo demanda (PR-3.6) ─────────────────────────

/** Idiomas de contenido: los de `hotel_content.lang` (0041) y `LanguageCodeSchema`. */
export const HOTEL_CONTENT_LANGUAGES = ['es', 'pt', 'en'] as const;
export type HotelContentLanguage = (typeof HOTEL_CONTENT_LANGUAGES)[number];

/** Una sección `Etiqueta : texto` de la descripción, en texto plano. */
export interface HotelContentSection {
  readonly label: string;
  readonly text: string;
}

/**
 * Contenido de UN hotel en UN idioma, leído del proveedor en el momento: las columnas de
 * `hotel_content` más lo que el proveedor dice del hotel. `null` o lista vacía = no lo informó.
 * El HTML llega saneado con lista blanca por el ACL, y quien lo muestra lo verifica igual.
 */
export interface HotelProviderContent {
  readonly hotelId: string;
  readonly lang: HotelContentLanguage;
  readonly name: string | null;
  readonly stars: number | null;
  readonly address: string | null;
  readonly zipcode: string | null;
  readonly countryCode: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly descriptionHtml: string | null;
  readonly sections: readonly HotelContentSection[];
  /** Sólo los servicios disponibles: uno negado ("… – no") no está. */
  readonly facilities: readonly string[];
  readonly attractionsHtml: string | null;
  readonly images: readonly string[];
  readonly phone: string | null;
  readonly websiteUrl: string | null;
  /** `HH:mm`. */
  readonly checkInTime: string | null;
  readonly checkOutTime: string | null;
}

export interface HotelContentFetchOptions {
  /** Plazo de la llamada; sólo acorta el del proveedor. Del otro lado hay un vendedor esperando. */
  readonly timeoutMs: number;
  /** Corta la espera entera, cola del limitador incluida. */
  readonly signal?: AbortSignal;
}

/**
 * Un proveedor cuyo contenido estático se puede pedir para UN hotel cuando el catálogo todavía no
 * lo tiene (TBO `HotelDetails`, docs/tbo/05 §6.3). Es una lectura: el puerto no escribe nada. Lo
 * que se guarda en el catálogo pasa por {@link HotelContentBatchPort}, con la huella del sync.
 */
export interface HotelContentPort {
  /** `null`: el proveedor respondió, pero sin ese hotel. */
  fetchHotelContent(
    hotelId: string,
    lang: HotelContentLanguage,
    ctx: SearchContext,
    options: HotelContentFetchOptions,
  ): Promise<HotelProviderContent | null>;
}

// ───────────────────────── Catálogo bajo demanda: fotos y ciudades ─────────────────────────

/** Qué llamada produjo una fila de `hotel_content` (0041). */
export type HotelContentSource = 'details' | 'listing';

/**
 * Una fila de `hotel_content` lista para guardar: sus columnas con los nombres del contrato, más la
 * huella con que la escribe el sync del MISMO proveedor. Con otra huella, el sync vería "cambió" en
 * cada fila que el API guardó y la reescribiría entera en su próxima pasada.
 */
export interface HotelContentRecord {
  readonly hotelId: string;
  readonly lang: HotelContentLanguage;
  readonly source: HotelContentSource;
  readonly name: string | null;
  /** Saneado por el ACL con su lista blanca; la base lo vuelve a comprobar al guardar. */
  readonly descriptionHtml: string | null;
  readonly sections: readonly HotelContentSection[];
  readonly facilities: readonly string[];
  readonly attractionsHtml: string | null;
  /** URLs absolutas `https`. */
  readonly images: readonly string[];
  readonly phone: string | null;
  readonly websiteUrl: string | null;
  /** `HH:mm`. */
  readonly checkInTime: string | null;
  readonly checkOutTime: string | null;
  /** `content_hash` (SHA-256 en hexadecimal). */
  readonly contentHash: string;
}

/** Lo que el proveedor respondió a un lote de contenido. */
export interface HotelContentBatch {
  readonly contents: readonly HotelContentRecord[];
  /** Pedidos que no volvieron: el proveedor no tiene contenido de ese hotel (o no lo conoce). */
  readonly missingHotelIds: readonly string[];
}

/**
 * Un proveedor cuyo contenido se pide por lotes para GUARDARLO en el catálogo (TBO `HotelDetails`,
 * de a 10): las fotos de los resultados de una búsqueda aparecen a medida que llegan.
 */
export interface HotelContentBatchPort {
  /** Códigos por llamada. */
  readonly contentBatchSize: number;
  fetchHotelContents(
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    ctx: SearchContext,
    options: HotelContentFetchOptions,
  ): Promise<HotelContentBatch>;
}

/** Un hotel del catálogo de una ciudad: las columnas de `hotel_inventory` que llena el proveedor. */
export interface HotelCatalogRecord {
  readonly hotelId: string;
  readonly name: string | null;
  readonly stars: number | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly address: string | null;
  readonly zipcode: string | null;
  /** ISO2. */
  readonly countryCode: string | null;
}

/** Los hoteles de UNA ciudad del proveedor, con el texto que llega de paso (`listing`). */
export interface HotelCityCatalog {
  readonly hotels: readonly HotelCatalogRecord[];
  readonly listingContents: readonly HotelContentRecord[];
  /** Hoteles que el ACL descartó por ilegibles. */
  readonly unreadable: number;
}

/**
 * Un proveedor que lista los hoteles de una ciudad suya (TBO `TBOHotelCodeList`): la primera vez que
 * se busca una ciudad que el catálogo tiene sin hoteles, el API los trae y los guarda (05 §8.5).
 * Una ciudad sin hoteles vuelve con la lista vacía, no con un error.
 */
export interface HotelCityCatalogPort {
  listCityCatalog(
    cityCode: string,
    countryCode: string | undefined,
    ctx: SearchContext,
    options: HotelContentFetchOptions,
  ): Promise<HotelCityCatalog>;
}

// ───────────────────────── Capacidades opcionales, por presencia ─────────────────────────
//
// Mismo criterio que `supportsAuditedCreate` en vuelos: el registry entrega
// `HotelProviderAdapter`, y preguntar por la clase concreta de un proveedor es el
// `if (provider === 'x')` que el registry existe para quitar.

/**
 * El nombre se tipa contra el puerto: con un `string` suelto, una errata o un renombre del
 * puerto dejaría la guarda en `false` para siempre, y el saga no vería una verificación que el
 * adapter sí sabe hacer.
 */
function hasMethod<TPort extends object>(adapter: object, name: keyof TPort & string): boolean {
  return typeof (adapter as Record<string, unknown>)[name] === 'function';
}

export function supportsHotelSuggest<T extends object>(
  adapter: T,
): adapter is T & HotelSuggestPort {
  return hasMethod<HotelSuggestPort>(adapter, 'suggestDestinations');
}

export function supportsHotelRatesDetail<T extends object>(
  adapter: T,
): adapter is T & HotelRatesDetailPort {
  return hasMethod<HotelRatesDetailPort>(adapter, 'getHotelRates');
}

export function supportsHotelPaymentOptions<T extends object>(
  adapter: T,
): adapter is T & HotelPaymentOptionsPort {
  return hasMethod<HotelPaymentOptionsPort>(adapter, 'getPaymentOptions');
}

export function supportsHotelPriceJumpRecovery<T extends object>(
  adapter: T,
): adapter is T & HotelPriceJumpRecoveryPort {
  return hasMethod<HotelPriceJumpRecoveryPort>(adapter, 'confirmPriceJump');
}

export function supportsHotelBookingByClientReference<T extends object>(
  adapter: T,
): adapter is T & HotelBookingByClientReferencePort {
  return hasMethod<HotelBookingByClientReferencePort>(adapter, 'getBookingByClientReference');
}

export function supportsHotelBookingsByDate<T extends object>(
  adapter: T,
): adapter is T & HotelBookingsByDatePort {
  return hasMethod<HotelBookingsByDatePort>(adapter, 'listBookingsByDate');
}

export function supportsHotelSearchContext<T extends object>(
  adapter: T,
): adapter is T & HotelSearchContextPort {
  return hasMethod<HotelSearchContextPort>(adapter, 'searchAvailabilityWithContext');
}

export function supportsHotelRatesContext<T extends object>(
  adapter: T,
): adapter is T & HotelRatesContextPort {
  return hasMethod<HotelRatesContextPort>(adapter, 'getHotelRatesWithContext');
}

export function supportsHotelPrebookContext<T extends object>(
  adapter: T,
): adapter is T & HotelPrebookContextPort {
  return hasMethod<HotelPrebookContextPort>(adapter, 'prebookWithContext');
}

export function supportsHotelBookingContext<T extends object>(
  adapter: T,
): adapter is T & HotelBookingContextPort {
  return hasMethod<HotelBookingContextPort>(adapter, 'bookWithContext');
}

export function supportsHotelAccountIssues<T extends object>(
  adapter: T,
): adapter is T & HotelAccountIssuePort {
  return hasMethod<HotelAccountIssuePort>(adapter, 'accountIssueOf');
}

export function supportsHotelContent<T extends object>(
  adapter: T,
): adapter is T & HotelContentPort {
  return hasMethod<HotelContentPort>(adapter, 'fetchHotelContent');
}

export function supportsHotelContentBatch<T extends object>(
  adapter: T,
): adapter is T & HotelContentBatchPort {
  return hasMethod<HotelContentBatchPort>(adapter, 'fetchHotelContents');
}

export function supportsHotelCityCatalog<T extends object>(
  adapter: T,
): adapter is T & HotelCityCatalogPort {
  return hasMethod<HotelCityCatalogPort>(adapter, 'listCityCatalog');
}
