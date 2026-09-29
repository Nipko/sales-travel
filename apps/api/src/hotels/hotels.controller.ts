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
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { DespegarHotelsExceptionFilter } from './despegar-hotels-exception.filter.js';
import { HotelBookingService, type HotelBookingSummary } from './hotel-booking.service.js';
import { HotelContentService, type HotelContentView } from './hotel-content.service.js';
import { HotelPrebookService, type HotelPrebookResponse } from './hotel-prebook.service.js';
import type { HotelSearchResponse } from './hotel-search.aggregate.js';
import { HotelsService } from './hotels.service.js';
import {
  CancelBodySchema,
  HotelAvailabilityInputSchema,
  HotelBookBodySchema,
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
  type HotelBookBody,
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

  /** El sobre CRECE, no cambia: `hotels` sigue igual y se suman `providers` y el booleano. */
  @SalesOperation()
  @Post('availability')
  async availability(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelAvailabilityInputSchema)) body: HotelAvailabilityInput,
  ): Promise<HotelSearchEnvelope> {
    const tenantId = await this.tenant(userId);

    // El ajuste se resuelve en cada petición y fuera del servicio de búsqueda, como en vuelos:
    // si algún día la búsqueda se cachea, el vendedor no puede seguir viendo la etiqueta vieja
    // después de que el administrador la cambió. Un fallo al resolverlo responde `false`.
    const [result, showProviderInResults] = await Promise.all([
      this.hotels.searchAvailability(tenantId, body),
      this.disclosure.effective(tenantId),
    ]);

    return { ...result, showProviderInResults };
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
   * contenido responde la ficha sin imágenes, no un error; en otro idioma, lo dice `lang`.
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

  // ───────────────────────── Reserva ─────────────────────────

  /**
   * Cuerpo neutral `{ providerCode, offerRef, searchId }`: se enruta por el proveedor de la tarifa
   * y se revalida con el contexto de su búsqueda, con snapshot en el servidor (PR-4.5). El cuerpo
   * de Despegar (`choiceId`) sigue yendo a su flujo de siempre, con su respuesta tal cual.
   */
  @SalesOperation()
  @Post('prebook')
  async prebook(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelPrebookBodySchema)) body: HotelPrebookBody,
  ): Promise<HotelPrebookResponse | PrebookResult> {
    const tenantId = await this.tenant(userId);
    if (isNeutralHotelPrebook(body)) return this.prebooks.prebook(tenantId, body, userId);
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
  @Post('book')
  async book(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelBookBodySchema)) body: HotelBookBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<HotelBookingSummary | BookResult> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.tenant(userId);
    if (!isNeutralHotelBook(body)) return this.reservations.book(tenantId, body);

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

  private async tenant(userId: string | undefined): Promise<string> {
    if (!userId) throw new ForbiddenException();
    return this.activeTenant.resolve(userId);
  }
}
