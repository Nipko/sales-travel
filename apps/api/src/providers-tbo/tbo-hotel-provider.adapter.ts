import type {
  HotelOffer,
  HotelRatesQuery,
  HotelRoompack,
  HotelSearchCriteria,
} from '@sales-travel/canonical';
import type {
  HotelBookRequest,
  HotelBookResult,
  HotelBookingByClientReferencePort,
  HotelBookingDateRange,
  HotelBookingReadOptions,
  HotelBookingRoomGuests,
  HotelBookingSummary,
  HotelBookingView,
  HotelBookingsByDatePort,
  HotelBookingsByDateResult,
  HotelCancelRequestOptions,
  HotelCancelRequest,
  HotelCancelResult,
  HotelPrebookRequest,
  HotelPrebookResult,
  HotelRatesDetailPort,
  SearchContext,
} from '@sales-travel/domain';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import {
  TBO_BOOKINGS_BY_DATE_MAX_DAYS,
  TBO_HOTEL_DETAILS_LIMITS,
  TBO_OFFER_TTL_MS,
  TBO_OPERATIONS,
  TboApiError,
  TboOfferExpiredError,
  TboResponseMappingError,
  checkTboBookGuests,
  classifyTboBookOutcome,
  compareTboRates,
  generateTboBookingReference,
  resolveTboHotelDetails,
  tboHotelContentHash,
  type TboBookingByDate,
  type TboCatalogHotel,
  type TboEnvironment,
  type TboHotelContent,
  type TboHotelsAdapter,
  type TboRateSnapshot,
  type TboSearchPackContext,
  type TboSearchReport,
  type TboStaticContentClient,
} from '@sales-travel/tbo-hotels';
import type {
  HotelAccountIssuePort,
  HotelBookContextRequest,
  HotelBookFailure,
  HotelBookWithContext,
  HotelBookingContextPort,
  HotelCatalogRecord,
  HotelCityCatalog,
  HotelCityCatalogPort,
  HotelContentBatch,
  HotelContentBatchPort,
  HotelContentFetchOptions,
  HotelContentLanguage,
  HotelContentPort,
  HotelContentRecord,
  HotelGuestCheck,
  HotelOfferInvalidation,
  HotelPrebookContextPort,
  HotelPrebookContextRequest,
  HotelPrebookWithContext,
  HotelProviderAccountFingerprint,
  HotelProviderAccountIssue,
  HotelProviderAdapter,
  HotelProviderContent,
  HotelRateBaseline,
  HotelRatesContextPort,
  HotelRatesWithContext,
  HotelSearchContextData,
  HotelSearchContextPort,
  HotelSearchPackContext,
  HotelSearchWithContext,
} from '../providers/hotel-provider.types.js';

/** La superficie del ACL que este envoltorio usa, y nada más: el resto se suma con su PR. */
export type TboHotelsAcl = Pick<
  TboHotelsAdapter,
  | 'accountRef'
  | 'searchAvailability'
  | 'getHotelRates'
  | 'searchAvailabilityReport'
  | 'getHotelRatesReport'
  | 'getBooking'
  | 'getBookingByClientReference'
  | 'prebook'
  | 'prebookReport'
  | 'book'
  | 'bookReport'
  | 'cancelBooking'
  | 'listBookingsByDateReport'
>;

/**
 * Del cliente de contenido estático, `HotelDetails` (la ficha y las fotos de los resultados) y
 * `TBOHotelCodeList` (los hoteles de una ciudad que el catálogo todavía no tiene). El resto del
 * catálogo lo recorre el sync, en otro proceso.
 */
export type TboContentAcl = Pick<TboStaticContentClient, 'getHotelDetails' | 'listCityHotels'>;

/**
 * Intentos de las lecturas de catálogo bajo demanda: uno más que la ficha, porque nadie las espera
 * mirando (las fotos llegan en segundo plano) o el vendedor ya está esperando la búsqueda entera, y
 * un `500` suelto de TBO no debería dejarlas sin datos. El plazo total lo pone quien llama.
 */
const CATALOG_MAX_ATTEMPTS = 2;

/** Una fila de `hotel_content` con la huella del ACL: la misma con que la escribe el sync. */
function contentRecordOf(content: TboHotelContent): HotelContentRecord {
  return {
    hotelId: content.hotelId,
    lang: content.lang,
    source: content.source,
    name: content.name,
    descriptionHtml: content.descriptionHtml,
    sections: content.sections.map(({ label, text }) => ({ label, text })),
    facilities: [...content.facilities],
    attractionsHtml: content.attractionsHtml,
    images: [...content.images],
    phone: content.phone,
    websiteUrl: content.websiteUrl,
    checkInTime: content.checkInTime,
    checkOutTime: content.checkOutTime,
    contentHash: tboHotelContentHash(content),
  };
}

function catalogRecordOf(hotel: TboCatalogHotel): HotelCatalogRecord {
  return {
    hotelId: hotel.hotelId,
    name: hotel.name,
    stars: hotel.stars,
    location: hotel.location === null ? null : { lat: hotel.location.lat, lng: hotel.location.lng },
    address: hotel.address,
    zipcode: hotel.zipcode,
    countryCode: hotel.countryCode,
  };
}

/**
 * Se pidió contenido a un envoltorio armado sin cliente de contenido. El factory siempre lo pasa:
 * esto sólo lo ve un armado a mano. No salió nada hacia TBO.
 */
export class TboContentClientMissingError extends Error {
  constructor() {
    super('el envoltorio de TBO se construyó sin cliente de contenido');
    this.name = 'TboContentClientMissingError';
  }
}

/**
 * Lo que el servidor guarda de un Search de TBO (RF-08), en el vocabulario neutral: `HotelCode`,
 * `BookingCode` y el literal de `TotalFare` de cada pack, y el vencimiento de la oferta
 * (`searchSentAt + 27 min`, RF-09), que es el TTL del contexto.
 */
function contextOf(report: Omit<TboSearchReport, 'offers'>): HotelSearchContextData {
  return {
    searchId: report.searchId,
    searchSentAt: report.searchSentAt,
    expiresAt: report.searchSentAt + TBO_OFFER_TTL_MS,
    packs: report.packs.map(
      (p: TboSearchPackContext): HotelSearchPackContext => ({
        hotelId: p.hotelCode,
        offerRef: p.bookingCode,
        totalText: p.totalFare,
        currency: p.currency,
      }),
    ),
  };
}

const PREBOOK_PATH = TBO_OPERATIONS.prebook.path;

/**
 * Una fila de `BookingDetailsbasedondate` en el vocabulario neutral. `ClientReferenceNumber` pasa
 * como nuestra referencia de reserva: es el `ClientReferenceId` del Book, que para nosotros es la
 * misma `BookingReferenceId` (INFERIDO, PV-31; Q-58). La conciliación no concluye una ausencia con
 * esa equivalencia sin haberla visto antes en la misma cuenta.
 */
function bookingByDateSummary(b: TboBookingByDate): HotelBookingSummary {
  return {
    providerBookingId: b.confirmationNumber,
    bookingDate: b.bookingDate,
    ...(b.clientReferenceNumber === undefined ? {} : { bookingReference: b.clientReferenceNumber }),
    ...(b.status === undefined ? {} : { status: b.status }),
    ...(b.providerStatus === undefined ? {} : { providerStatus: b.providerStatus }),
    ...(b.refundAwaited === true ? { refundAwaited: true } : {}),
    ...(b.checkIn === undefined ? {} : { checkinDate: b.checkIn }),
    ...(b.checkOut === undefined ? {} : { checkoutDate: b.checkOut }),
    ...(b.hotelCode === undefined ? {} : { hotelId: b.hotelCode }),
    ...(b.bookingPrice === undefined ? {} : { total: { ...b.bookingPrice } }),
    ...(b.agentMarkup === undefined ? {} : { agencyCommission: { ...b.agentMarkup } }),
    ...(b.currency === undefined ? {} : { currency: b.currency }),
    ...(b.agencyName === undefined ? {} : { agencyName: b.agencyName }),
    ...(b.bookingId === undefined ? {} : { providerRecordId: b.bookingId }),
  };
}

/**
 * La tarifa de la búsqueda como lectura comparable (C1). El contexto guarda sólo lo que C1 mira
 * (`compare.ts`: total, moneda, reembolsable, régimen y cargos en el hotel) y no el pack entero,
 * que multiplicaría la memoria de cada búsqueda; el resto del pack se toma del PreBook para que lo
 * que C1 no mira no cuente como cambio.
 */
function searchedRate(
  baseline: Extract<HotelRateBaseline, { stage: 'C1' }>,
  current: HotelRoompack,
): TboRateSnapshot {
  const { seen } = baseline;
  const { mealTypeRaw: _prebookMeal, ...rest } = current;
  return {
    totalFare: baseline.totalText,
    roompack: {
      ...rest,
      ...(seen.mealTypeRaw === undefined ? {} : { mealTypeRaw: seen.mealTypeRaw }),
      board: seen.board,
      price: { ...current.price, total: { ...seen.total } },
      cancellation: { ...current.cancellation, refundable: seen.refundable },
      atPropertyCharges: [...seen.atPropertyCharges],
    },
  };
}

function baselineRate(baseline: HotelRateBaseline, current: HotelRoompack): TboRateSnapshot {
  if (baseline.stage === 'C1') return searchedRate(baseline, current);
  const { accepted } = baseline;
  return {
    totalFare: accepted.totalText,
    roompack: accepted.roompack,
    signals: accepted.signals,
    rateConditionsHash: accepted.rateConditionsHash,
  };
}

/**
 * El ACL de TBO detrás del contrato neutral de hoteles, que es lo que entrega el factory al
 * registry.
 *
 * Delega búsqueda y detalle de un hotel (PR-1.5), y los expone también con su contexto (PR-2.3):
 * PreBook y Book reenvían el `BookingCode` y el `TotalFare` de la búsqueda, y el Book no lleva
 * fechas, edades ni nacionalidad, así que eso queda en el servidor y no lo pone el navegador.
 * Delega la lectura de una reserva, por localizador o por nuestra referencia (PR-4.2), el PreBook
 * con la comparación contra lo que se mostró (PR-4.5), el Book de la saga con órdenes (PR-4.6), el
 * contenido de un hotel que el catálogo todavía no tiene (PR-3.6), por lotes para guardarlo (las
 * fotos de los resultados), los hoteles de una ciudad que el catálogo tiene vacía, la cancelación
 * (PR-5.1) y las reservas de la cuenta por fecha de creación, que lee la conciliación diaria
 * (PR-5.5).
 */
export class TboHotelProviderAdapter
  implements
    HotelProviderAdapter,
    HotelRatesDetailPort,
    HotelBookingByClientReferencePort,
    HotelBookingsByDatePort,
    HotelSearchContextPort,
    HotelRatesContextPort,
    HotelPrebookContextPort,
    HotelBookingContextPort,
    HotelAccountIssuePort,
    HotelContentPort,
    HotelContentBatchPort,
    HotelCityCatalogPort
{
  // Campos `#`: un adapter volcado a un log no arrastra el ACL ni nada de la cuenta.
  readonly #acl: TboHotelsAcl;
  readonly #account: HotelProviderAccountFingerprint;
  readonly #environment: TboEnvironment;
  readonly #content: TboContentAcl | undefined;

  /**
   * @param account huella de la cuenta de la bóveda con que se construyó el ACL (id y
   *   `updatedAt`, nunca el secreto): queda en el contexto de cada búsqueda y el Book la compara.
   * @param environment el de la cuenta: va escrito en cada referencia de reserva, y el ACL se niega
   *   a mandar una referencia de producción por la cuenta de test o al revés.
   * @param content el cliente de contenido de la MISMA cuenta, para `HotelDetails` bajo demanda.
   */
  constructor(
    acl: TboHotelsAcl,
    account: HotelProviderAccountFingerprint,
    environment: TboEnvironment,
    content?: TboContentAcl,
  ) {
    this.#acl = acl;
    this.#account = { accountId: account.accountId, updatedAt: account.updatedAt };
    this.#environment = environment;
    this.#content = content;
  }

  /** Huella de la cuenta (dueño + usuario, digerida): la clave del circuito por cuenta. */
  get accountRef(): string {
    return this.#acl.accountRef;
  }

  /** Con qué cuenta de la bóveda sale este adapter. Una copia: nadie la cambia desde afuera. */
  get searchAccount(): HotelProviderAccountFingerprint {
    return { ...this.#account };
  }

  searchAvailability(criteria: HotelSearchCriteria, ctx: SearchContext): Promise<HotelOffer[]> {
    return this.#acl.searchAvailability(criteria, ctx);
  }

  /**
   * Un lote que falló o no salió deja la búsqueda `partial` sin lanzar (el ACL sólo lanza si no
   * respondió ninguno): se pasa con el error tipado de ese lote para que el vendedor vea que falta
   * algo y por qué (RF-14 CA-3).
   */
  async searchAvailabilityWithContext(
    criteria: HotelSearchCriteria,
    ctx: SearchContext,
  ): Promise<HotelSearchWithContext> {
    const report = await this.#acl.searchAvailabilityReport(criteria, ctx);
    const found = { ...contextOf(report), offers: report.offers };
    if (!report.partial) return found;
    return {
      ...found,
      partial: { cause: report.batches.find((b) => b.error !== undefined)?.error },
    };
  }

  /** Detalle de un hotel (D-TBO-19 A): un Search de un solo código con la respuesta detallada. */
  getHotelRates(query: HotelRatesQuery, ctx: SearchContext): Promise<HotelOffer> {
    return this.#acl.getHotelRates(query, ctx);
  }

  /** El detalle emite `BookingCode` nuevos (02 §6.2): el pack que se reserva es el del detalle. */
  async getHotelRatesWithContext(
    query: HotelRatesQuery,
    ctx: SearchContext,
  ): Promise<HotelRatesWithContext> {
    const report = await this.#acl.getHotelRatesReport(query, ctx);
    return { ...contextOf(report), offer: report.offer };
  }

  /**
   * El puerto neutral, tal cual al ACL: sin `searchSentAt`, ni el hotel y la ocupación en
   * `providerOptions`, el ACL se niega antes del cable. El servidor usa {@link prebookWithContext}.
   */
  prebook(request: HotelPrebookRequest, ctx: SearchContext): Promise<HotelPrebookResult> {
    return this.#acl.prebook(request, ctx);
  }

  /**
   * PreBook con `PaymentMode: "Limit"` armado con el contexto de la búsqueda y comparado contra la
   * base que manda el servidor: lo que mostró la búsqueda (C1) o lo que el vendedor aceptó (C2). La
   * comparación es la del ACL (`compareTboRates`), decimal exacta sobre el literal de `TotalFare`.
   */
  async prebookWithContext(
    request: HotelPrebookContextRequest,
    ctx: SearchContext,
  ): Promise<HotelPrebookWithContext> {
    const report = await this.#acl.prebookReport(
      {
        hotelCode: request.hotelId,
        bookingCode: request.offerRef,
        searchId: request.searchId,
        searchSentAt: request.searchSentAt,
        rooms: request.rooms,
      },
      ctx,
    );
    const { roompack } = report.result;
    if (roompack === undefined) {
      // El mapper del ACL siempre lo arma; sin él no hay nada que comparar ni que aceptar.
      throw new TboResponseMappingError(
        PREBOOK_PATH,
        ['result.roompack:missing'],
        report.requestId,
      );
    }
    const current: TboRateSnapshot = {
      totalFare: report.pack.totalFare,
      roompack,
      signals: report.result.signals,
      rateConditionsHash: report.rateConditionsHash,
    };
    return {
      result: { ...report.result, roompack },
      pack: {
        hotelId: report.pack.hotelCode,
        offerRef: report.pack.bookingCode,
        totalText: report.pack.totalFare,
        currency: report.pack.currency,
      },
      rateConditionsHash: report.rateConditionsHash,
      comparison: compareTboRates(
        request.baseline.stage,
        baselineRate(request.baseline, roompack),
        current,
      ),
      requestId: report.requestId,
    };
  }

  /**
   * `315`, o la ventana vencida en nuestro reloj, deja inservible la búsqueda entera: la sesión de
   * TBO venció para todos sus `BookingCode` (RF-09 CA-2). `201` y `207`, sólo esa tarifa (RF-15
   * CA-4).
   */
  offerInvalidatedBy(err: unknown): HotelOfferInvalidation | undefined {
    if (err instanceof TboOfferExpiredError) return 'search';
    if (!(err instanceof TboApiError)) return undefined;
    if (err.kind === 'OFFER_EXPIRED') return 'search';
    if (err.kind === 'RATE_UNAVAILABLE' || err.kind === 'NO_AVAILABILITY') return 'offer';
    return undefined;
  }

  /**
   * `300` y `402` son de la cuenta, no de la tarifa (docs/tbo/03 §6): con `Limit` la reserva se
   * carga al crédito del titular, y un bloqueo de TBO frena a todas las agencias que la heredan.
   * Sólo lo que TBO respondió: el rechazo de nuestro breaker no dice nada de la cuenta.
   */
  accountIssueOf(err: unknown): HotelProviderAccountIssue | undefined {
    if (!(err instanceof TboApiError)) return undefined;
    if (err.kind === 'INSUFFICIENT_BALANCE') return 'insufficient-balance';
    if (err.kind === 'ACCOUNT_BLOCKED') return 'agent-blocked';
    return undefined;
  }

  /**
   * El puerto neutral, tal cual al ACL: sin el literal del `TotalFare`, el instante del Search y la
   * ocupación en `providerOptions`, el ACL se niega antes del cable. El servidor usa
   * {@link bookWithContext}, desde la saga con órdenes.
   */
  book(request: HotelBookRequest, ctx: SearchContext): Promise<HotelBookResult> {
    return this.#acl.book(request, ctx);
  }

  /** `ST` + entorno de la cuenta + 17 caracteres aleatorios (RF-19). */
  newBookingReference(): string {
    return generateTboBookingReference(this.#environment);
  }

  /** La misma regla con la que el builder del Book se niega a armar el cuerpo (RF-18). */
  checkBookingGuests(
    rooms: readonly HotelBookingRoomGuests[],
    occupancy: readonly HotelRoomOccupancy[],
  ): HotelGuestCheck {
    const check = checkTboBookGuests(rooms, occupancy);
    if (!check.ok) return { ok: false, issues: [...check.issues] };
    return {
      ok: true,
      rooms: check.rooms.map((room) =>
        room.map(({ title, firstName, lastName, paxType }) => ({
          title,
          firstName,
          lastName,
          paxType,
        })),
      ),
    };
  }

  /**
   * Book con `PaymentMode: "Limit"`, UN intento y 120 s (BK-07). Con `200` devuelve `CONFIRMED` o
   * `UNCERTAIN` según `classifyTboBookOutcome`; un rechazo de TBO se lanza tal cual, para que el
   * breaker lo vea, y {@link bookFailureOf} dice qué significa.
   */
  async bookWithContext(
    request: HotelBookContextRequest,
    ctx: SearchContext,
  ): Promise<HotelBookWithContext> {
    const report = await this.#acl.bookReport(
      {
        bookingCode: request.offerRef,
        totalFare: request.totalText,
        bookingReferenceId: request.bookingReference,
        searchSentAt: request.searchSentAt,
        occupancy: request.occupancy,
        rooms: request.rooms,
        contact: request.contact,
      },
      ctx,
    );
    return {
      result: report.result,
      reason: report.classification.reason,
      requestId: report.requestId,
    };
  }

  /**
   * La tabla de 03 §3.9 sobre lo que lanzó el Book: sólo el `Status.Code` del cuerpo prueba un
   * rechazo, un rechazo local antes del cable es `FAILED` sin envío y todo lo demás es incierto.
   */
  bookFailureOf(err: unknown): HotelBookFailure {
    // La referencia esperada sólo se usa con una respuesta leída, que aquí no hay.
    const c = classifyTboBookOutcome({ kind: 'threw', error: err }, { clientReferenceId: '' });
    return {
      outcome: c.outcome === 'FAILED' ? 'FAILED' : 'UNCERTAIN',
      reason: c.reason,
      dispatched: c.dispatched,
      ...(c.tboCode === undefined ? {} : { providerStatus: String(c.tboCode) }),
      ...(c.errorClass === undefined ? {} : { errorClass: c.errorClass }),
    };
  }

  /**
   * BookingDetail por el localizador de TBO (PR-4.2). El propósito elige el cupo del limitador de
   * la cuenta: un job no le quita capacidad al vendedor (04 §9.5 punto 5, PV-41).
   */
  getBooking(
    providerBookingId: string,
    ctx: SearchContext,
    options?: HotelBookingReadOptions,
  ): Promise<HotelBookingView> {
    return this.#acl.getBooking(providerBookingId, ctx, options);
  }

  /**
   * BookingDetail por NUESTRA referencia: la única forma de verificar un Book cuya respuesta no
   * llegó (p. 42; RF-21). Un "no la encontré" vuelve como vista `found: false`, no como error.
   */
  getBookingByClientReference(
    bookingReference: string,
    ctx: SearchContext,
    options?: HotelBookingReadOptions,
  ): Promise<HotelBookingView> {
    return this.#acl.getBookingByClientReference(bookingReference, ctx, options);
  }

  /**
   * `HotelDetails` de UN código en UN idioma (docs/tbo/05 §6.3, E4 bajo demanda). Un solo intento:
   * del otro lado hay un vendedor esperando, y el sync reintenta por su cuenta con los hoteles que
   * siguen sin contenido. Lo que sale ya pasó por el saneador y el filtro `https` del ACL.
   */
  async fetchHotelContent(
    hotelId: string,
    lang: HotelContentLanguage,
    _ctx: SearchContext,
    options: HotelContentFetchOptions,
  ): Promise<HotelProviderContent | null> {
    const content = this.#content;
    if (content === undefined) throw new TboContentClientMissingError();
    const found = await content.getHotelDetails([hotelId], lang, {
      timeoutMs: options.timeoutMs,
      maxAttempts: 1,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const text = found.contents.find((c) => c.hotelId === hotelId);
    const hotel = found.hotels.find((h) => h.hotelId === hotelId);
    if (text === undefined && hotel === undefined) return null;
    return {
      hotelId,
      lang,
      name: hotel?.name ?? text?.name ?? null,
      stars: hotel?.stars ?? null,
      address: hotel?.address ?? null,
      zipcode: hotel?.zipcode ?? null,
      countryCode: hotel?.countryCode ?? null,
      location: hotel?.location ?? null,
      descriptionHtml: text?.descriptionHtml ?? null,
      sections: text?.sections.map(({ label, text: body }) => ({ label, text: body })) ?? [],
      facilities: [...(text?.facilities ?? [])],
      attractionsHtml: text?.attractionsHtml ?? null,
      images: [...(text?.images ?? [])],
      phone: text?.phone ?? null,
      websiteUrl: text?.websiteUrl ?? null,
      checkInTime: text?.checkInTime ?? null,
      checkOutTime: text?.checkOutTime ?? null,
    };
  }

  /** Lote de HotelDetails: 10 por defecto, nunca más de 13 (05 §10; Q-62). */
  get contentBatchSize(): number {
    return TBO_HOTEL_DETAILS_LIMITS.defaultBatchSize;
  }

  /**
   * `HotelDetails` de un lote en UN idioma, para GUARDARLO en el catálogo (fotos de los resultados):
   * cada contenido sale como fila de `hotel_content` con la huella del ACL, la misma del sync. Por
   * el cupo de fondo del limitador de la cuenta, como todo el contenido estático. Un lote de más de
   * 13 códigos no sale: el builder del ACL lo rechaza antes del cable.
   *
   * El lote se resuelve con `resolveTboHotelDetails` del ACL (docs/tbo/05 CE-23): lo que no vino en
   * el idioma pedido se pide en inglés y vuelve como filas `en`; un lote que TBO contesta vacío
   * entero se parte, con el tope por lote del ACL y el cupo por minuto de `allowExtraCall`, para
   * encontrar los que sí tienen contenido. Lo confirmado sin contenido (en el idioma pedido y en
   * inglés) sale en `missingHotelIds`, lo que quedó sin respuesta en `unresolvedHotelIds`, y lo que
   * TBO no confirmó (`unconfirmed` del ACL) en ninguna de las dos. Si la PRIMERA llamada falla, se
   * lanza su error tal cual, como antes; un fallo de las siguientes sólo deja sus hoteles sin
   * resolver. Las de aislamiento van con UN intento: partir contra un TBO que falla sólo multiplica
   * llamadas en el cupo de fondo, y lo que no alcanzó se vuelve a pedir en unos minutos.
   */
  async fetchHotelContents(
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    _ctx: SearchContext,
    options: HotelContentFetchOptions,
  ): Promise<HotelContentBatch> {
    const content = this.#content;
    if (content === undefined) throw new TboContentClientMissingError();
    const call = {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const resolution = await resolveTboHotelDetails<unknown>(
      hotelIds,
      lang,
      (codes, callLang, purpose) =>
        content
          .getHotelDetails(codes, callLang, {
            ...call,
            maxAttempts: purpose === 'isolation' ? 1 : CATALOG_MAX_ATTEMPTS,
          })
          .then(
            (result) => ({ ok: true as const, result }),
            (failure: unknown) => ({ ok: false as const, failure }),
          ),
      options.allowExtraCall === undefined ? {} : { allowIsolationCall: options.allowExtraCall },
    );
    if ('primaryFailure' in resolution) throw resolution.primaryFailure;
    const { primary, fallback, isolation } = resolution.calls;
    return {
      contents: resolution.contents.map(contentRecordOf),
      missingHotelIds: [...resolution.withoutContent],
      unresolvedHotelIds: [...resolution.unresolved],
      calls: { total: primary + fallback + isolation, fallback, isolation },
      diagnostics: {
        batchBreakers: resolution.batchBreakers.length,
        untrustedResponses: resolution.untrustedResponses,
      },
    };
  }

  /**
   * `TBOHotelCodeList` de UNA ciudad (p. 65): sus hoteles y el texto en inglés que llega de paso,
   * para cargarla la primera vez que se busca (05 §8.5). Una ciudad sin hoteles ("No Hotels Found"
   * rápido, 01 §8.5) vuelve con la lista vacía; uno lento es el plazo de TBO vencido y se lanza.
   */
  async listCityCatalog(
    cityCode: string,
    countryCode: string | undefined,
    _ctx: SearchContext,
    options: HotelContentFetchOptions,
  ): Promise<HotelCityCatalog> {
    const content = this.#content;
    if (content === undefined) throw new TboContentClientMissingError();
    const found = await content.listCityHotels(
      cityCode,
      countryCode === undefined ? {} : { countryCode },
      {
        timeoutMs: options.timeoutMs,
        maxAttempts: CATALOG_MAX_ATTEMPTS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return {
      hotels: found.hotels.map(catalogRecordOf),
      listingContents: found.listingContents.map(contentRecordOf),
      unreadable: found.diagnostics.rejected.ITEM_SCHEMA ?? 0,
    };
  }

  /**
   * La cancelación del ACL (PR-5.1; docs/tbo/04 §4.4): lectura previa, `POST /Cancel` con UN
   * intento y lectura posterior. `success` dice si quedó pedida y `bookingStatus` si quedó cancelada
   * o sólo en curso; un `479` vuelve como `success: false`, y lo que no prueba si TBO aplicó el write
   * se lanza tal cual, con path `/Cancel`, para que la política de cancelaciones lo deje
   * `UNVERIFIED`. Nada se reenvuelve aquí: un error con otro nombre cambiaría esa clasificación.
   *
   * La cuenta es la de este envoltorio: quien lo arma para la post-venta tiene que hacerlo con la
   * que creó la reserva (RF-29; D-TBO-28 A). `options.purpose` elige el cupo de la lectura previa.
   */
  cancelBooking(
    request: HotelCancelRequest,
    ctx: SearchContext,
    options?: HotelCancelRequestOptions,
  ): Promise<HotelCancelResult> {
    return this.#acl.cancelBooking(request, ctx, options);
  }

  /** "Maximum of 60 days (about 2 months)" (p. 62): la conciliación parte los rangos más largos. */
  get maxBookingDateWindowDays(): number {
    return TBO_BOOKINGS_BY_DATE_MAX_DAYS;
  }

  /**
   * `BookingDetailsbasedondate` de UNA ventana (PR-5.5; docs/tbo/04 §9; 08 RF-28). El ACL la
   * devuelve entera o lanza: una ventana de más de 60 días no sale, y una respuesta que no es un
   * `200` legible, o con una fila fuera de la ventana, nunca vuelve como "no hay reservas". Lo que
   * lance pasa tal cual: la conciliación descarta la corrida entera.
   *
   * La cuenta es la de este envoltorio y el listado es de toda la cuenta: quien lo pide lo reparte
   * entre las órdenes de cada agencia y nunca se lo muestra entero a una (RNF-06 punto 5).
   */
  async listBookingsByDate(
    range: HotelBookingDateRange,
    ctx: SearchContext,
  ): Promise<HotelBookingsByDateResult> {
    const report = await this.#acl.listBookingsByDateReport(
      { fromDate: range.from, toDate: range.to },
      ctx,
    );
    return {
      range: { from: report.window.fromDate, to: report.window.toDate },
      bookings: report.bookings.map(bookingByDateSummary),
    };
  }
}
