import type { ActivityDetail, ActivityOffer, ActivitySummary } from '@sales-travel/canonical';
import {
  buildBookBody,
  buildCancelBody,
  buildCancelQuoteBody,
  buildPaymentOptionsQuery,
  DespegarCancelNotAllowedError,
  DespegarHttpClient,
  DespegarReservationNotFoundError,
  mapBookResult,
  mapCancelAllowance,
  mapCancelQuote,
  mapCancelResult,
  mapPaymentOptions,
  type BookResult,
  type CancelAllowance,
  type CancelQuote,
  type CancelReason,
  type CancelReservationResult,
  type DespegarHttpDeps,
  type PaymentModality,
} from '@sales-travel/despegar-hotels';
import {
  buildActivityPrebookBody,
  mapActivityPrebook,
  mapActivityReservations,
  toActivityBookRequest,
} from './booking/mappers';
import {
  ACTIVITIES_API_PREFIX,
  isOrlandoPark,
  SHOPPING_WINDOW_DAYS,
  type DespegarActivitiesConfig,
} from './config';
import { buildDistribution } from './search/common';
import {
  mapActivitySuggestions,
  mapAvailability,
  mapDiscovery,
  mapModalities,
  mapShopping,
} from './search/mappers';
import type {
  ActivityBookRequest,
  ActivityLanguage,
  ActivityPrebook,
  ActivityReservation,
  ActivitySuggestion,
  AvailabilityQuery,
  DiscoveryQuery,
  ModalitiesQuery,
  ShoppingPark,
  ShoppingQuery,
} from './types';

export * from './config';
export * from './types';
export { buildDistribution, hourLabel, mapCancellation, mapPrices } from './search/common';
export {
  mapActivitySuggestions,
  mapAvailability,
  mapDiscovery,
  mapModalities,
  mapShopping,
} from './search/mappers';
export {
  absoluteVoucherUrl,
  buildActivityPrebookBody,
  mapActivityPrebook,
  mapActivityReservations,
  toActivityBookRequest,
} from './booking/mappers';

/** Código del proveedor en el registro de capacidades, la orden y la bóveda de payloads. */
export const DESPEGAR_ACTIVITIES_PROVIDER_CODE = 'despegar-activities';

/** Rechazo propio del ACL antes de llamar a Despegar (un parque que `/shopping` no acepta…). */
export class DespegarActivitiesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DespegarActivitiesInputError';
  }
}

export interface ActivityCancelPreview {
  reservation: ActivityReservation;
  allowance: CancelAllowance;
  quote?: CancelQuote;
}

/** El día `days` después de `from` (YYYY-MM-DD), en UTC. */
function addDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Adapter Despegar/HotelDO Activities v3 (Anti-Corruption Layer). Expone:
 *   búsqueda   → discover / getModalities / getAvailability (una fecha) / shopping (Orlando)
 *   reserva    → prebook → getPaymentOptions → book (cuenta corriente) → getBookStatus
 *   post-venta → findReservation / previewCancellation → cancelReservation (los tres pasos)
 *
 * Reusa el cliente HTTP de hoteles (misma clave, mismo host, misma bóveda) y los mappers de las
 * rutas COMPARTIDAS de `/v3` (payments, book, cancelación). Lo propio de actividades se mapea
 * aquí. Los DTOs de Despegar no salen de este paquete: sólo tipos canónicos.
 */
export class DespegarActivitiesAdapter {
  private readonly http: DespegarHttpClient;

  constructor(
    private readonly cfg: DespegarActivitiesConfig,
    deps: DespegarHttpDeps = {},
  ) {
    this.http = new DespegarHttpClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }, deps);
  }

  // ───────────────────────── Búsqueda ─────────────────────────

  /** Autocomplete de POIs. Devuelve ids de POI, no el IATA que pide discovery. */
  async suggest(hint: string, locale = 'es_AR'): Promise<ActivitySuggestion[]> {
    const raw = await this.http.get<unknown>(
      '/suggestions/activities',
      { hint, locale },
      'activitiesSuggestions',
    );
    return mapActivitySuggestions(raw);
  }

  /** Tickets y tours de un destino (código IATA de la ciudad). */
  async discover(q: DiscoveryQuery): Promise<ActivitySummary[]> {
    const raw = await this.http.get<unknown>(
      `${ACTIVITIES_API_PREFIX}/discovery`,
      {
        destination: q.destination.toUpperCase(),
        site: this.site(q.site),
        language: this.lang(q.language),
      },
      'activitiesDiscovery',
    );
    return mapDiscovery(raw);
  }

  /** Ficha y modalidades. `language` va en MAYÚSCULAS aquí (`ES|PT|EN`), según la referencia. */
  async getModalities(q: ModalitiesQuery): Promise<ActivityDetail> {
    const range = q.from && q.to ? { from: q.from, to: q.to } : {};
    const raw = await this.http.get<unknown>(
      `${ACTIVITIES_API_PREFIX}/modalities`,
      {
        id: q.id,
        site: this.site(q.site),
        language: this.lang(q.language).toUpperCase(),
        ...range,
      },
      'activitiesModalities',
    );
    return mapModalities(raw, q.id);
  }

  /**
   * Precio final y `choice_id` de UNA fecha. `undefined` si la respuesta no trae tarifa. `schedule`
   * va como texto `HH:mm`, como el ejemplo de la referencia (está tipado number; sin verificar).
   */
  async getAvailability(q: AvailabilityQuery): Promise<ActivityOffer | undefined> {
    const raw = await this.http.get<unknown>(
      `${ACTIVITIES_API_PREFIX}/availability`,
      {
        id: q.id,
        modality: q.modality,
        date: q.date,
        site: this.site(q.site),
        language: this.lang(q.language),
        distribution: buildDistribution(q.participants),
        schedule: q.schedule,
        additionals: q.additional,
      },
      'activitiesAvailability',
    );
    return mapAvailability(raw, {
      activityId: q.id,
      modalityId: q.modality,
      date: q.date,
      requested: q.participants,
    });
  }

  /** Parques de Orlando: todas las modalidades × días de una ventana de hasta 7 días. */
  async shopping(q: ShoppingQuery): Promise<ShoppingPark[]> {
    const park = q.park.toUpperCase();
    if (!isOrlandoPark(park)) {
      throw new DespegarActivitiesInputError(
        `«${q.park}» no es un parque de Orlando que Despegar venda por shopping.`,
      );
    }
    const maxTo = addDays(q.from, SHOPPING_WINDOW_DAYS - 1);
    const to = q.to && q.to < maxTo ? q.to : maxTo;
    const raw = await this.http.get<unknown>(
      `${ACTIVITIES_API_PREFIX}/shopping`,
      {
        id: park,
        site: this.site(q.site).toUpperCase(),
        language: this.lang(q.language),
        from: q.from,
        to,
        distribution: buildDistribution(q.participants),
        modalities: q.modalities?.length ? q.modalities.join(',') : undefined,
      },
      'activitiesShopping',
    );
    return mapShopping(raw, q.participants);
  }

  // ───────────────────────── Reserva ─────────────────────────

  /** Revalida la tarifa y trae políticas de cambio y hints. 410 `PRODUCT_GONE` → tarifa vencida. */
  async prebook(choiceId: string, lang?: ActivityLanguage): Promise<ActivityPrebook> {
    const raw = await this.http.post<unknown>(
      '/prebook',
      buildActivityPrebookBody(choiceId, this.lang(lang)),
      {},
      'activitiesPrebook',
    );
    return mapActivityPrebook(raw);
  }

  async getPaymentOptions(prebookId: string): Promise<PaymentModality[]> {
    const raw = await this.http.get<Parameters<typeof mapPaymentOptions>[0]>(
      '/payments',
      buildPaymentOptionsQuery({ prebookId }),
      'activitiesPayments',
    );
    return mapPaymentOptions(raw);
  }

  /**
   * Reserva a CUENTA CORRIENTE. Quien llama verifica antes en `/payments` que la cuenta la ofrezca
   * (sin eso el book falla con un error de pago que se lee peor). ERROR/PROCESSING llegan con
   * HTTP 200: quien llama mira `status`.
   */
  async book(req: ActivityBookRequest): Promise<BookResult> {
    const raw = await this.http.post<Parameters<typeof mapBookResult>[0]>(
      '/book',
      buildBookBody(toActivityBookRequest(req, this.cfg.invoice)),
      {},
      'activitiesBook',
    );
    return mapBookResult(raw);
  }

  async getBookStatus(reservationId: string): Promise<BookResult> {
    const raw = await this.http.get<Parameters<typeof mapBookResult>[0]>(
      `/book/${encodeURIComponent(reservationId)}`,
      {},
      'activitiesBookStatus',
    );
    return mapBookResult(raw);
  }

  // ───────────────────────── Post-venta ─────────────────────────

  /** El producto TICKET/TOUR de una reserva del book (con el voucher de HotelDO, si vino). */
  async findReservation(reservationId: string): Promise<ActivityReservation | undefined> {
    const raw = await this.http.get<unknown>(
      '/reservations',
      { reservation_id: reservationId },
      'activitiesReservations',
    );
    return mapActivityReservations(raw, this.cfg.baseUrl)[0];
  }

  /** Pasos 1 y 2 de la cancelación, sin cancelar: lo que el vendedor ve antes de confirmar. */
  async previewCancellation(reservationId: string): Promise<ActivityCancelPreview> {
    const reservation = await this.findReservation(reservationId);
    if (reservation === undefined) throw new DespegarReservationNotFoundError();
    const allowance = mapCancelAllowance(
      await this.http.get(
        `/reservations/${encodeURIComponent(reservation.productId)}/cancels/allowance`,
        {},
        'activitiesCancelAllowance',
      ),
      reservation.productId,
    );
    if (allowance.allowance !== 'ALLOWED' || reservation.transactionId === undefined) {
      return { reservation, allowance };
    }
    const quote = mapCancelQuote(
      await this.http.post(
        '/reservations/cancels/quote',
        buildCancelQuoteBody(reservation.transactionId),
        {},
        'activitiesCancelQuote',
      ),
      reservation.productId,
    );
    return { reservation, allowance, quote };
  }

  /**
   * Cancela la actividad entera (todos los participantes: Despegar no admite cancelaciones
   * individuales) en los tres pasos. Irreversible. Si el paso 1 no lo permite, lanza
   * {@link DespegarCancelNotAllowedError} sin cancelar nada.
   */
  async cancelReservation(
    reservationId: string,
    reason: CancelReason = 'OTHER',
  ): Promise<CancelReservationResult> {
    const preview = await this.previewCancellation(reservationId);
    if (preview.allowance.allowance !== 'ALLOWED') {
      throw new DespegarCancelNotAllowedError(preview.allowance);
    }
    const result = mapCancelResult(
      await this.http.post(
        `/reservations/${encodeURIComponent(preview.reservation.productId)}/cancels`,
        buildCancelBody(reason),
        {},
        'activitiesCancel',
      ),
    );
    return preview.quote === undefined ? result : { ...result, quote: preview.quote };
  }

  private site(site?: string): string {
    return (site ?? this.cfg.site).toLowerCase();
  }

  private lang(lang?: ActivityLanguage): ActivityLanguage {
    return lang ?? this.cfg.language ?? 'es';
  }
}
