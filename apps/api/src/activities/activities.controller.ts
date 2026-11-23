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
import type { ActivityDetail, ActivitySummary } from '@sales-travel/canonical';
import type { ActivityReservation } from '@sales-travel/despegar-activities';
import type { CancelReservationResult } from '@sales-travel/despegar-hotels';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SalesOperation } from '../auth/decorators/sales-operation.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { DespegarActivitiesExceptionFilter } from './activities-exception.filter.js';
import {
  ActivityIdParamSchema,
  ActivitySearchQuerySchema,
  AvailabilityBodySchema,
  BookBodySchema,
  CancelBodySchema,
  ModalitiesQuerySchema,
  PrebookBodySchema,
  ReservationIdParamSchema,
  ShoppingBodySchema,
  type ActivitySearchQuery,
  type AvailabilityBody,
  type BookBody,
  type CancelBody,
  type ModalitiesQueryInput,
  type PrebookBody,
  type ShoppingBody,
} from './activities.schemas.js';
import {
  ActivitiesService,
  type ActivitiesStatus,
  type ActivityBookOutcome,
  type ActivityCancelPreviewOutcome,
  type ActivityPrebookOutcome,
  type PricedActivityOffer,
} from './activities.service.js';

/** Actividades (tickets y tours) de Despegar/HotelDO. docs/despegar/03-actividades-api.md. */
@Roles(...SELLING_ROLES)
@Controller('activities')
@UseFilters(DespegarActivitiesExceptionFilter)
export class ActivitiesController {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  /** Si está encendido y qué sabe hacer. La web lo usa para mostrar la sección o el aviso. */
  @Get('status')
  status(): ActivitiesStatus {
    return this.activities.status();
  }

  @SalesOperation()
  @Get('search')
  async search(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(ActivitySearchQuerySchema)) query: ActivitySearchQuery,
  ): Promise<{ activities: ActivitySummary[] }> {
    const tenantId = await this.tenant(userId);
    return { activities: await this.activities.search(tenantId, query) };
  }

  @SalesOperation()
  @Get(':id/modalities')
  async modalities(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(ActivityIdParamSchema)) id: string,
    @Query(new ZodValidationPipe(ModalitiesQuerySchema)) query: ModalitiesQueryInput,
  ): Promise<ActivityDetail> {
    const tenantId = await this.tenant(userId);
    return this.activities.modalities(tenantId, id, query);
  }

  @SalesOperation()
  @Post('availability')
  async availability(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(AvailabilityBodySchema)) body: AvailabilityBody,
  ): Promise<{ offer: PricedActivityOffer }> {
    const tenantId = await this.tenant(userId);
    return { offer: await this.activities.availability(tenantId, body) };
  }

  @SalesOperation()
  @Post('shopping')
  async shopping(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ShoppingBodySchema)) body: ShoppingBody,
  ) {
    const tenantId = await this.tenant(userId);
    return { parks: await this.activities.shopping(tenantId, body) };
  }

  @SalesOperation()
  @Post('prebook')
  async prebook(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(PrebookBodySchema)) body: PrebookBody,
  ): Promise<ActivityPrebookOutcome> {
    const tenantId = await this.tenant(userId);
    return this.activities.prebook(tenantId, body);
  }

  @SalesOperation()
  @Post('book')
  async book(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(BookBodySchema)) body: BookBody,
  ): Promise<ActivityBookOutcome> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.tenant(userId);
    return this.activities.book(tenantId, userId, body);
  }

  @Get('reservations/:reservationId')
  async reservation(
    @CurrentUser() userId: string | undefined,
    @Param('reservationId', new ZodValidationPipe(ReservationIdParamSchema)) reservationId: string,
  ): Promise<ActivityReservation> {
    const tenantId = await this.tenant(userId);
    return this.activities.reservation(tenantId, reservationId);
  }

  @Post('reservations/:reservationId/cancel-preview')
  async cancelPreview(
    @CurrentUser() userId: string | undefined,
    @Param('reservationId', new ZodValidationPipe(ReservationIdParamSchema)) reservationId: string,
  ): Promise<ActivityCancelPreviewOutcome> {
    const tenantId = await this.tenant(userId);
    return this.activities.previewCancellation(tenantId, reservationId);
  }

  @Post('reservations/:reservationId/cancel')
  async cancel(
    @CurrentUser() userId: string | undefined,
    @Param('reservationId', new ZodValidationPipe(ReservationIdParamSchema)) reservationId: string,
    @Body(new ZodValidationPipe(CancelBodySchema)) body: CancelBody,
  ): Promise<CancelReservationResult> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.tenant(userId);
    return this.activities.cancel(tenantId, userId, reservationId, body);
  }

  private async tenant(userId: string | undefined): Promise<string> {
    if (!userId) throw new ForbiddenException();
    return this.activeTenant.resolve(userId);
  }
}
