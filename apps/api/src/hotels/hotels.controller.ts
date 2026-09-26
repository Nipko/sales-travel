import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
import type { HotelDestinationSuggestion } from '@sales-travel/domain';
import type {
  BookRequest,
  BookResult,
  CancelReservationResult,
  PaymentModality,
  PrebookQuery,
  PrebookResult,
  RecoveryResult,
} from '@sales-travel/despegar-hotels';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { DespegarHotelsExceptionFilter } from './despegar-hotels-exception.filter.js';
import type { HotelSearchResponse } from './hotel-search.aggregate.js';
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

  @Post('detail')
  async detail(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HotelDetailInputSchema)) body: HotelDetailInput,
  ): Promise<HotelOffer> {
    const tenantId = await this.tenant(userId);
    return this.hotels.getHotelDetail(tenantId, body);
  }

  // ───────────────────────── Reserva (flujo de Despegar) ─────────────────────────

  @Post('prebook')
  async prebook(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(PrebookSchema)) body: PrebookQuery,
  ): Promise<PrebookResult> {
    const tenantId = await this.tenant(userId);
    return this.reservations.prebook(tenantId, body);
  }

  @Get('payments')
  async payments(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(PaymentOptionsQuerySchema)) query: PaymentOptionsInput,
  ): Promise<{ modalities: PaymentModality[] }> {
    const tenantId = await this.tenant(userId);
    return { modalities: await this.reservations.getPaymentOptions(tenantId, query) };
  }

  @Post('book')
  async book(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(BookSchema)) body: BookRequest,
  ): Promise<BookResult> {
    const tenantId = await this.tenant(userId);
    return this.reservations.book(tenantId, body);
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
