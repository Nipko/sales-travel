import { NotImplementedException } from '@nestjs/common';
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
  HotelBookingRoomGuests,
  HotelBookingView,
  HotelCancelResult,
  HotelPrebookRequest,
  HotelPrebookResult,
  HotelRatesDetailPort,
  SearchContext,
} from '@sales-travel/domain';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import {
  TBO_OFFER_TTL_MS,
  TBO_OPERATIONS,
  TboApiError,
  TboOfferExpiredError,
  TboResponseMappingError,
  checkTboBookGuests,
  classifyTboBookOutcome,
  compareTboRates,
  generateTboBookingReference,
  type TboEnvironment,
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
  HotelContentFetchOptions,
  HotelContentLanguage,
  HotelContentPort,
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
>;

/**
 * Del cliente de contenido estático, sólo `HotelDetails`: es lo único que la API lee en el momento
 * (PR-3.6). El resto del catálogo lo recorre el sync, en otro proceso.
 */
export type TboContentAcl = Pick<TboStaticContentClient, 'getHotelDetails'>;

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
 * Operaciones del contrato de hoteles que este envoltorio todavía no cablea. Cada una sale de la
 * lista cuando su PR la conecta, junto con la capacidad del factory que la anuncia.
 *
 * La cancelación llega con PR-5.1. El Book salió en PR-4.6: sólo lo llama la saga de reserva con
 * órdenes (`hotels/hotel-booking.service.ts`), que persiste el intent con su referencia ANTES
 * (D-TBO-07 A), y `hotels/hotel-booking.guard.test.ts` impide que otra ruta lo alcance.
 */
export const TBO_PENDING_OPERATIONS = ['cancelBooking'] as const;
export type TboPendingOperation = (typeof TBO_PENDING_OPERATIONS)[number];

const OPERATION_LABEL: Readonly<Record<TboPendingOperation, string>> = {
  cancelBooking: 'cancelar la reserva',
};

/**
 * Se pidió a TBO una operación que la integración todavía no tiene. No salió nada hacia TBO.
 *
 * Es la segunda línea de defensa: la capacidad `cancel` del factory, en `false`, frena la
 * post-venta antes. Sin esto, el `undefined is not a function` de un camino no gateado saldría
 * como 500. 501 y no 400: no es un dato mal mandado. El nombre termina en `NotSupportedError` para
 * que la política de cancelaciones lo lea como determinista y previo al envío: no hay nada que
 * conciliar.
 */
export class TboOperationNotSupportedError extends NotImplementedException {
  constructor(readonly operation: TboPendingOperation) {
    super(
      `Todavía no se puede ${OPERATION_LABEL[operation]} con TBO desde la plataforma. Elegí una tarifa de otro proveedor para continuar.`,
    );
    this.name = 'TboOperationNotSupportedError';
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
 * con la comparación contra lo que se mostró (PR-4.5), el Book de la saga con órdenes (PR-4.6) y el
 * contenido de un hotel que el catálogo todavía no tiene (PR-3.6). El resto del contrato existe
 * porque `HotelProviderAdapter` lo exige a todo proveedor, y responde con un error tipado en vez de
 * fingir un resultado: una cancelación inventada es peor que ninguna.
 */
export class TboHotelProviderAdapter
  implements
    HotelProviderAdapter,
    HotelRatesDetailPort,
    HotelBookingByClientReferencePort,
    HotelSearchContextPort,
    HotelRatesContextPort,
    HotelPrebookContextPort,
    HotelBookingContextPort,
    HotelAccountIssuePort,
    HotelContentPort
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

  /** BookingDetail por el localizador de TBO (PR-4.2). */
  getBooking(providerBookingId: string, ctx: SearchContext): Promise<HotelBookingView> {
    return this.#acl.getBooking(providerBookingId, ctx);
  }

  /**
   * BookingDetail por NUESTRA referencia: la única forma de verificar un Book cuya respuesta no
   * llegó (p. 42; RF-21). Un "no la encontré" vuelve como vista `found: false`, no como error.
   */
  getBookingByClientReference(
    bookingReference: string,
    ctx: SearchContext,
  ): Promise<HotelBookingView> {
    return this.#acl.getBookingByClientReference(bookingReference, ctx);
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

  cancelBooking(): Promise<HotelCancelResult> {
    return Promise.reject(new TboOperationNotSupportedError('cancelBooking'));
  }
}
