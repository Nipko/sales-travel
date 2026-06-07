import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import type {
  BookRequest,
  BookResult,
  CancelReservationResult,
  GeoSuggestion,
  HotelOffer,
  PaymentModality,
  PrebookQuery,
  PrebookResult,
  RecoveryResult,
} from '@sales-travel/despegar-hotels';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { currentTenantId } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { HotelsService } from './hotels.service.js';
import {
  BookSchema,
  CancelBodySchema,
  HotelAvailabilityInputSchema,
  HotelDetailInputSchema,
  HotelSuggestQuerySchema,
  PaymentOptionsQuerySchema,
  PrebookSchema,
  RecoveryBodySchema,
  type CancelBody,
  type HotelAvailabilityInput,
  type HotelDetailInput,
  type HotelSuggestQuery,
  type PaymentOptionsInput,
  type RecoveryBody,
} from './hotels.schemas.js';

@Controller('hotels')
export class HotelsController {
  constructor(private readonly hotels: HotelsService) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  @Get('suggestions')
  async suggestions(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(HotelSuggestQuerySchema)) query: HotelSuggestQuery,
  ): Promise<{ items: GeoSuggestion[] }> {
    const tenantId = await this.tenant(userId);
    return { items: await this.hotels.suggest(tenantId, query.q, query.locale) };
  }

  @Post('availability')
  async availability(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelAvailabilityInputSchema)) body: HotelAvailabilityInput,
  ): Promise<{ hotels: HotelOffer[] }> {
    const tenantId = await this.tenant(userId);
    return { hotels: await this.hotels.searchAvailability(tenantId, body) };
  }

  @Post('detail')
  async detail(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelDetailInputSchema)) body: HotelDetailInput,
  ): Promise<HotelOffer> {
    const tenantId = await this.tenant(userId);
    return this.hotels.getHotelDetail(tenantId, body);
  }

  // ───────────────────────── Reserva ─────────────────────────

  @Post('prebook')
  async prebook(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(PrebookSchema)) body: PrebookQuery,
  ): Promise<PrebookResult> {
    const tenantId = await this.tenant(userId);
    return this.hotels.prebook(tenantId, body);
  }

  @Get('payments')
  async payments(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(PaymentOptionsQuerySchema)) query: PaymentOptionsInput,
  ): Promise<{ modalities: PaymentModality[] }> {
    const tenantId = await this.tenant(userId);
    return { modalities: await this.hotels.getPaymentOptions(tenantId, query) };
  }

  @Post('book')
  async book(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(BookSchema)) body: BookRequest,
  ): Promise<BookResult> {
    const tenantId = await this.tenant(userId);
    return this.hotels.book(tenantId, body);
  }

  @Get('reservations/:id')
  async getReservation(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<BookResult> {
    const tenantId = await this.tenant(userId);
    return this.hotels.getReservation(tenantId, id);
  }

  @Post('reservations/:id/cancel')
  async cancel(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelBodySchema)) body: CancelBody,
  ): Promise<CancelReservationResult> {
    const tenantId = await this.tenant(userId);
    return this.hotels.cancelReservation(tenantId, { reservationId: id, reason: body.reason });
  }

  @Post('reservations/:id/recovery')
  async recovery(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RecoveryBodySchema)) body: RecoveryBody,
  ): Promise<RecoveryResult> {
    const tenantId = await this.tenant(userId);
    return this.hotels.recoverBooking(tenantId, {
      reservationId: id,
      messageType: body.messageType,
      confirmations: body.confirmations,
      testCase: body.testCase,
    });
  }

  private async tenant(userId: string | undefined): Promise<string> {
    if (!userId) throw new ForbiddenException();
    return currentTenantId() ?? (await this.hotels.resolveActiveTenant(userId));
  }
}
