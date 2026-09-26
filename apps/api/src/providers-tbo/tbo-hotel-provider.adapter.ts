import { NotImplementedException } from '@nestjs/common';
import type { HotelOffer, HotelRatesQuery, HotelSearchCriteria } from '@sales-travel/canonical';
import type {
  HotelBookResult,
  HotelBookingByClientReferencePort,
  HotelBookingView,
  HotelCancelResult,
  HotelPrebookResult,
  HotelRatesDetailPort,
  SearchContext,
} from '@sales-travel/domain';
import {
  TBO_OFFER_TTL_MS,
  type TboHotelsAdapter,
  type TboSearchPackContext,
  type TboSearchReport,
} from '@sales-travel/tbo-hotels';
import type {
  HotelProviderAccountFingerprint,
  HotelProviderAdapter,
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
>;

/**
 * Operaciones del contrato de hoteles que este envoltorio todavía no cablea. Cada una sale de la
 * lista cuando su PR la conecta, junto con la capacidad del factory que la anuncia.
 *
 * PreBook y Book ya existen en el ACL (PR-4.1, PR-4.2) y aun así siguen aquí: los conecta el
 * servidor en PR-4.5 y PR-4.6, con el contexto de la búsqueda y la orden con intent ANTES del Book
 * (D-TBO-07 A). Delegarlos antes dejaría un camino que reserva en TBO sin orden que lo respalde.
 * La cancelación llega con PR-5.1.
 */
export const TBO_PENDING_OPERATIONS = ['prebook', 'book', 'cancelBooking'] as const;
export type TboPendingOperation = (typeof TBO_PENDING_OPERATIONS)[number];

const OPERATION_LABEL: Readonly<Record<TboPendingOperation, string>> = {
  prebook: 'revalidar la tarifa',
  book: 'reservar',
  cancelBooking: 'cancelar la reserva',
};

/**
 * Se pidió a TBO una operación que la integración todavía no tiene. No salió nada hacia TBO.
 *
 * Es la segunda línea de defensa: la capacidad `cancel` del factory, en `false`, frena la
 * post-venta antes, y el PreBook de una tarifa TBO no se ofrece hasta PR-4.5. Sin
 * esto, el `undefined is not a function` de un camino no gateado saldría como 500. 501 y no 400:
 * no es un dato mal mandado. El nombre termina en `NotSupportedError` para que la política de
 * cancelaciones lo lea como determinista y previo al envío: no hay nada que conciliar.
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

/**
 * El ACL de TBO detrás del contrato neutral de hoteles, que es lo que entrega el factory al
 * registry.
 *
 * Delega búsqueda y detalle de un hotel (PR-1.5), y los expone también con su contexto (PR-2.3):
 * PreBook y Book reenvían el `BookingCode` y el `TotalFare` de la búsqueda, y el Book no lleva
 * fechas, edades ni nacionalidad, así que eso queda en el servidor y no lo pone el navegador.
 * Delega también la lectura de una reserva, por localizador o por nuestra referencia (PR-4.2). El
 * resto del contrato existe porque `HotelProviderAdapter` lo exige a todo proveedor, y responde
 * con un error tipado en vez de fingir un resultado: una revalidación o una cancelación inventadas
 * son peores que ninguna.
 */
export class TboHotelProviderAdapter
  implements
    HotelProviderAdapter,
    HotelRatesDetailPort,
    HotelBookingByClientReferencePort,
    HotelSearchContextPort,
    HotelRatesContextPort
{
  // Campos `#`: un adapter volcado a un log no arrastra el ACL ni nada de la cuenta.
  readonly #acl: TboHotelsAcl;
  readonly #account: HotelProviderAccountFingerprint;

  /**
   * @param account huella de la cuenta de la bóveda con que se construyó el ACL (id y
   *   `updatedAt`, nunca el secreto): queda en el contexto de cada búsqueda y el Book la compara.
   */
  constructor(acl: TboHotelsAcl, account: HotelProviderAccountFingerprint) {
    this.#acl = acl;
    this.#account = { accountId: account.accountId, updatedAt: account.updatedAt };
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

  prebook(): Promise<HotelPrebookResult> {
    return Promise.reject(new TboOperationNotSupportedError('prebook'));
  }

  book(): Promise<HotelBookResult> {
    return Promise.reject(new TboOperationNotSupportedError('book'));
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

  cancelBooking(): Promise<HotelCancelResult> {
    return Promise.reject(new TboOperationNotSupportedError('cancelBooking'));
  }
}
