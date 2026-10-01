import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
import type { HotelDestinationSuggestion } from '@sales-travel/domain';
import type {
  BookResult,
  CancelReservationResult,
  PaymentModality,
  PrebookResult,
  RecoveryResult,
} from '@sales-travel/despegar-hotels';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SalesOperation } from '../auth/decorators/sales-operation.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import {
  BookingPermissionsService,
  type NonRefundableRatesPolicy,
} from '../booking-permissions/booking-permissions.service.js';
import type { NonRefundableRatesPermission } from '../database/database.types.js';
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { SellerRateLimit } from '../throttler/seller-rate-limit.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { DespegarHotelsExceptionFilter } from './despegar-hotels-exception.filter.js';
import {
  DESPEGAR_DIRECT_FLOW_BLOCKED_MESSAGE,
  HotelNonRefundableBlockedError,
} from './hotel-booking-errors.js';
import { HotelBookingService, type HotelBookingSummary } from './hotel-booking.service.js';
import {
  HotelContentService,
  type HotelContentBatchView,
  type HotelContentView,
} from './hotel-content.service.js';
import { HotelPrebookService, type HotelPrebookResponse } from './hotel-prebook.service.js';
import type { HotelSearchCurrencyOptions } from './hotel-search-currency.js';
import type { HotelSearchResponse } from './hotel-search.aggregate.js';
import { HotelsService } from './hotels.service.js';
import {
  CancelBodySchema,
  HotelAvailabilityInputSchema,
  HotelAvailabilityMoreBodySchema,
  HotelBookBodySchema,
  HotelContentBatchBodySchema,
  HotelContentParamsSchema,
  HotelContentQuerySchema,
  HotelDetailInputSchema,
  HotelPrebookBodySchema,
  HotelSuggestQuerySchema,
  PaymentOptionsQuerySchema,
  RecoveryBodySchema,
  isNeutralHotelBook,
  isNeutralHotelPrebook,
  type CancelBody,
  type HotelAvailabilityInput,
  type HotelAvailabilityMoreBody,
  type HotelBookBody,
  type HotelContentBatchBody,
  type HotelContentParams,
  type HotelContentQuery,
  type HotelDetailInput,
  type HotelPrebookBody,
  type HotelSuggestQuery,
  type PaymentOptionsInput,
  type RecoveryBody,
} from './hotels.schemas.js';

/**
 * Sobre de la búsqueda de hoteles tal como sale por HTTP.
 *
 * `showProviderInResults` es lo único que añade sobre `HotelSearchResponse`, y es una decisión
 * de PRESENTACIÓN: dice si la pantalla puede pintar de qué proveedor es cada tarifa. No filtra ni
 * anonimiza nada —`roompacks[].provider` y `providers[]` salen intactos con el ajuste apagado—,
 * porque el PreBook se enruta por `provider.name`. Es la misma regla que el sobre de vuelos
 * (RF-40: "me tiene que mostrar de dónde es").
 */
export interface HotelSearchEnvelope extends HotelSearchResponse {
  showProviderInResults: boolean;
  /**
   * Si la agencia puede reservar tarifas no reembolsables (lo fija quien la financia, 0055). Con
   * `blocked`, la pantalla las muestra como no disponibles para la agencia. También es presentación:
   * no filtra ninguna tarifa, y el PreBook y el Book lo vuelven a decidir. Ausente si no se pudo
   * leer: la búsqueda no se cae por eso.
   */
  nonRefundableRates?: NonRefundableRatesPermission;
}

@Roles(...SELLING_ROLES)
@Controller('hotels')
@UseFilters(DespegarHotelsExceptionFilter, TboHotelsExceptionFilter)
export class HotelsController {
  constructor(
    private readonly hotels: HotelsService,
    private readonly reservations: DespegarHotelReservationsService,
    private readonly activeTenant: ActiveTenantService,
    private readonly disclosure: ProviderDisclosureService,
    private readonly prebooks: HotelPrebookService,
    private readonly bookings: HotelBookingService,
    private readonly hotelContent: HotelContentService,
    private readonly permissions: BookingPermissionsService,
  ) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  @Get('suggestions')
  async suggestions(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(HotelSuggestQuerySchema)) query: HotelSuggestQuery,
  ): Promise<{ items: HotelDestinationSuggestion[] }> {
    const tenantId = await this.tenant(userId);
    return { items: await this.hotels.suggest(tenantId, query.q, query.locale) };
  }

  /** Las monedas del selector de la búsqueda: la de la agencia, elegida por defecto, y USD. */
  @Get('currencies')
  async currencies(@CurrentUser() userId: string | undefined): Promise<HotelSearchCurrencyOptions> {
    const tenantId = await this.tenant(userId);
    return this.hotels.searchCurrencies(tenantId);
  }

  /** El sobre CRECE, no cambia: `hotels` sigue igual y se suman `providers` y el booleano. */
  @SalesOperation()
  @Post('availability')
  async availability(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelAvailabilityInputSchema)) body: HotelAvailabilityInput,
  ): Promise<HotelSearchEnvelope> {
    const tenantId = await this.tenant(userId);
    return this.envelope(tenantId, this.hotels.searchAvailability(tenantId, body));
  }

  /**
   * El tramo siguiente de una búsqueda por destino (docs/tbo/02 §4.4): el mismo sobre, con sólo
   * los hoteles de ese tramo y `paging` al día. El cuerpo es `{ sessionId, page }`: la búsqueda la
   * guardó el servidor con el primer tramo. Es otra búsqueda con precio, y cuenta en la cuota.
   */
  @SalesOperation()
  @Post('availability/more')
  async availabilityMore(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelAvailabilityMoreBodySchema)) body: HotelAvailabilityMoreBody,
  ): Promise<HotelSearchEnvelope> {
    const tenantId = await this.tenant(userId);
    return this.envelope(tenantId, this.hotels.searchMoreAvailability(tenantId, body));
  }

  /**
   * Lo que la agencia activa puede reservar, para marcar las tarifas en el detalle de un hotel:
   * hoy, si puede reservar tarifas no reembolsables y si el bloqueo es suyo o de un nivel de arriba.
   * Es presentación: el PreBook y el Book lo vuelven a decidir.
   */
  @Get('booking-permissions')
  async bookingPermissions(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ nonRefundableRates: NonRefundableRatesPolicy }> {
    const tenantId = await this.tenant(userId);
    return { nonRefundableRates: await this.permissions.nonRefundableRates(tenantId) };
  }

  @SalesOperation()
  @Post('detail')
  async detail(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelDetailInputSchema)) body: HotelDetailInput,
  ): Promise<HotelOffer> {
    const tenantId = await this.tenant(userId);
    return this.hotels.getHotelDetail(tenantId, body);
  }

  /**
   * Ficha de un hotel de UN proveedor: descripción, servicios, imágenes y horarios (PR-3.6). Sin
   * contenido responde la ficha sin imágenes, no un error; en otro idioma, lo dicen `lang` y
   * `langFallback`.
   */
  @Get('content/:providerCode/:hotelId')
  async content(
    @CurrentUser() userId: string | undefined,
    @Param(new ZodValidationPipe(HotelContentParamsSchema)) params: HotelContentParams,
    @Query(new ZodValidationPipe(HotelContentQuerySchema)) query: HotelContentQuery,
  ): Promise<HotelContentView> {
    const tenantId = await this.tenant(userId);
    return this.hotelContent.getContent(tenantId, { ...params, lang: query.lang });
  }

  /**
   * Fotos de una pantalla de resultados, en segundo plano (estrategia de fotos del 2026-09-29): lo
   * que el catálogo ya tiene sale al instante y lo que falta se trae del proveedor en lotes, se
   * guarda y se devuelve; lo que no llega a tiempo sale `pending` con `retryAfterMs`. Nunca es un
   * error por falta de fotos: un hotel sin foto sale `none`.
   *
   * `POST` y no `GET` porque la lista de hoteles no cabe con holgura en una URL. No es una venta ni
   * gasta cuota de búsqueda: sólo lee contenido estático por el cupo de fondo de la cuenta.
   */
  @Post('content/batch')
  async contentBatch(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelContentBatchBodySchema)) body: HotelContentBatchBody,
  ): Promise<HotelContentBatchView> {
    const tenantId = await this.tenant(userId);
    return this.hotelContent.getContentBatch(tenantId, { lang: body.lang, hotels: body.hotels });
  }

  // ───────────────────────── Reserva ─────────────────────────

  /**
   * Cuerpo neutral `{ providerCode, offerRef, searchId }`: se enruta por el proveedor de la tarifa
   * y se revalida con el contexto de su búsqueda, con snapshot en el servidor (PR-4.5). El cuerpo
   * de Despegar (`choiceId`) sigue yendo a su flujo de siempre, con su respuesta tal cual.
   */
  // Cada PreBook lee las carteras de la red y cada Book bloquea la del nivel más alto: un tope por
  // vendedor acota el abuso sobre la cartera caliente de un consolidador (0060). Por vendedor y no
  // por IP: web-b2b llama desde su servidor, así que por IP sería un único cupo para todos.
  @SalesOperation()
  @SellerRateLimit({ bucket: 'hotels-prebook', limit: 60, ttlMs: 60_000 })
  @Post('prebook')
  async prebook(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelPrebookBodySchema)) body: HotelPrebookBody,
  ): Promise<HotelPrebookResponse | PrebookResult> {
    const tenantId = await this.tenant(userId);
    if (isNeutralHotelPrebook(body)) return this.prebooks.prebook(tenantId, body, userId);
    await this.assertDespegarDirectSaleAllowed(tenantId);
    return this.reservations.prebook(tenantId, body);
  }

  /**
   * Cuerpo neutral `{ providerCode, prebookRef, acceptedTotal, atPropertyAcknowledged, rooms,
   * contact }` con `Idempotency-Key`: reserva con orden detrás, abierta ANTES del Book (PR-4.6).
   * Responde `201` con la orden si la saga terminó y `202` si sigue o se está verificando; la web
   * consulta `GET /orders/:id`. El cuerpo de Despegar (`prebookId`) sigue con su flujo de siempre y
   * su respuesta tal cual (D-TBO-08 A).
   */
  @SalesOperation()
  @SellerRateLimit({ bucket: 'hotels-book', limit: 30, ttlMs: 60_000 })
  @Post('book')
  async book(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelBookBodySchema)) body: HotelBookBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<HotelBookingSummary | BookResult> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.tenant(userId);
    if (!isNeutralHotelBook(body)) {
      await this.assertDespegarDirectSaleAllowed(tenantId);
      return this.reservations.book(tenantId, body);
    }

    const { httpStatus, body: summary } = await this.bookings.book(
      tenantId,
      userId,
      idempotencyKey,
      body,
    );
    res?.status(httpStatus);
    return summary;
  }

  // ───────────────────────── Reserva (flujo de Despegar) ─────────────────────────

  @SalesOperation()
  @Get('payments')
  async payments(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(PaymentOptionsQuerySchema)) query: PaymentOptionsInput,
  ): Promise<{ modalities: PaymentModality[] }> {
    const tenantId = await this.tenant(userId);
    return { modalities: await this.reservations.getPaymentOptions(tenantId, query) };
  }

  @Get('reservations/:id')
  async getReservation(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<BookResult> {
    const tenantId = await this.tenant(userId);
    return this.reservations.getReservation(tenantId, id);
  }

  @Post('reservations/:id/cancel')
  async cancel(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelBodySchema)) body: CancelBody,
  ): Promise<CancelReservationResult> {
    const tenantId = await this.tenant(userId);
    return this.reservations.cancelReservation(tenantId, {
      reservationId: id,
      reason: body.reason,
    });
  }

  @SalesOperation()
  @Post('reservations/:id/recovery')
  async recovery(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RecoveryBodySchema)) body: RecoveryBody,
  ): Promise<RecoveryResult> {
    const tenantId = await this.tenant(userId);
    return this.reservations.recoverBooking(tenantId, {
      reservationId: id,
      messageType: body.messageType,
      confirmations: body.confirmations,
      testCase: body.testCase,
    });
  }

  /**
   * El PreBook y el Book directos de Despegar no traen la política de cancelación: no se puede saber
   * si la tarifa es no reembolsable. Con las no reembolsables bloqueadas para la agencia (0055) no se
   * usan, y un fallo al leer el permiso sube: no se reserva sin saberlo. Así la API directa no es
   * una puerta para vender lo que quien financia a la agencia bloqueó.
   */
  private async assertDespegarDirectSaleAllowed(tenantId: string): Promise<void> {
    const policy = await this.permissions.nonRefundableRates(tenantId);
    if (policy.effective === 'blocked') {
      throw new HotelNonRefundableBlockedError(DESPEGAR_DIRECT_FLOW_BLOCKED_MESSAGE);
    }
  }

  /**
   * El sobre de una búsqueda o de un tramo. El ajuste se resuelve en cada petición y fuera del
   * servicio de búsqueda, como en vuelos: si algún día la búsqueda se cachea, el vendedor no puede
   * seguir viendo la etiqueta vieja después de que el administrador la cambió. Un fallo al
   * resolverlo responde `false`.
   */
  private async envelope(
    tenantId: string,
    search: Promise<HotelSearchResponse>,
  ): Promise<HotelSearchEnvelope> {
    const [result, showProviderInResults, permission] = await Promise.all([
      search,
      this.disclosure.effective(tenantId),
      this.nonRefundableRatesOrUndefined(tenantId),
    ]);
    return {
      ...result,
      showProviderInResults,
      ...(permission === undefined ? {} : { nonRefundableRates: permission.effective }),
    };
  }

  /** El permiso para el sobre de la búsqueda: si no se puede leer, se omite y la búsqueda sigue. */
  private async nonRefundableRatesOrUndefined(
    tenantId: string,
  ): Promise<NonRefundableRatesPolicy | undefined> {
    try {
      return await this.permissions.nonRefundableRates(tenantId);
    } catch {
      return undefined;
    }
  }

  private async tenant(userId: string | undefined): Promise<string> {
    if (!userId) throw new ForbiddenException();
    return this.activeTenant.resolve(userId);
  }
}
