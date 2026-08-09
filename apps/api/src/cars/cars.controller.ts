import { Body, Controller, ForbiddenException, Get, Post, Query, UseFilters } from '@nestjs/common';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import type {
  CancelResult,
  CarBookResult,
  CarLocation,
  CarOffice,
  CarRateDetail,
  CarReservation,
  DailyReportEntry,
  RateType,
  ReleaseResult,
} from '@sales-travel/agent-cars';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { CarsService, type PricedCarOffer, type PricedCarSelection } from './cars.service.js';
import { AgentCarsExceptionFilter } from './agent-cars-exception.filter.js';
import {
  CancelBodySchema,
  CarSearchInputSchema,
  CarSelectionInputSchema,
  CarSuggestQuerySchema,
  ConfirmInputSchema,
  DailyReportQuerySchema,
  FindOfficesQuerySchema,
  MyReservationBodySchema,
  RateDetailQuerySchema,
  RatesQuerySchema,
  ReleaseBodySchema,
  type CancelBody,
  type CarSearchInput,
  type CarSelectionInput,
  type CarSuggestQuery,
  type ConfirmInput,
  type DailyReportInput,
  type FindOfficesInput,
  type MyReservationBody,
  type RateDetailInput,
  type RatesInput,
  type ReleaseBody,
} from './cars.schemas.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('cars')
@UseFilters(AgentCarsExceptionFilter)
export class CarsController {
  constructor(
    private readonly cars: CarsService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  @Get('suggestions')
  async suggestions(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(CarSuggestQuerySchema)) query: CarSuggestQuery,
  ): Promise<{ items: CarLocation[] }> {
    const tenantId = await this.tenant(userId);
    return { items: await this.cars.suggest(tenantId, query.q, query.lang) };
  }

  @Get('offices')
  async offices(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(FindOfficesQuerySchema)) query: FindOfficesInput,
  ): Promise<{ offices: CarOffice[] }> {
    const tenantId = await this.tenant(userId);
    return { offices: await this.cars.findOffices(tenantId, query) };
  }

  @Get('rates')
  async rates(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(RatesQuerySchema)) query: RatesInput,
  ): Promise<{ rates: RateType[] }> {
    const tenantId = await this.tenant(userId);
    return { rates: await this.cars.getRates(tenantId, query) };
  }

  @Post('search')
  async search(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CarSearchInputSchema)) body: CarSearchInput,
  ): Promise<{ cars: PricedCarOffer[] }> {
    const tenantId = await this.tenant(userId);
    return { cars: await this.cars.getMatrix(tenantId, body) };
  }

  @Post('selection')
  async selection(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CarSelectionInputSchema)) body: CarSelectionInput,
  ): Promise<PricedCarSelection> {
    const tenantId = await this.tenant(userId);
    return this.cars.getSelection(tenantId, body);
  }

  @Get('rate-detail')
  async rateDetail(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(RateDetailQuerySchema)) query: RateDetailInput,
  ): Promise<CarRateDetail> {
    const tenantId = await this.tenant(userId);
    return this.cars.getRateDetail(tenantId, query);
  }

  // ───────────────────────── Reserva ─────────────────────────

  @Post('book')
  async book(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ConfirmInputSchema)) body: ConfirmInput,
  ): Promise<CarBookResult> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.tenant(userId);
    return this.cars.book(tenantId, userId, body);
  }

  @Post('reservation')
  async reservation(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MyReservationBodySchema)) body: MyReservationBody,
  ): Promise<CarReservation> {
    const tenantId = await this.tenant(userId);
    return this.cars.myReservation(tenantId, body);
  }

  @Post('reservations/cancel')
  async cancel(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CancelBodySchema)) body: CancelBody,
  ): Promise<CancelResult> {
    const tenantId = await this.tenant(userId);
    return this.cars.cancel(tenantId, body);
  }

  @Post('reservations/release')
  async release(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ReleaseBodySchema)) body: ReleaseBody,
  ): Promise<ReleaseResult> {
    const tenantId = await this.tenant(userId);
    return this.cars.release(tenantId, body);
  }

  @Get('daily-report')
  async dailyReport(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(DailyReportQuerySchema)) query: DailyReportInput,
  ): Promise<{ entries: DailyReportEntry[] }> {
    const tenantId = await this.tenant(userId);
    return { entries: await this.cars.getDailyReport(tenantId, query) };
  }

  private async tenant(userId: string | undefined): Promise<string> {
    if (!userId) throw new ForbiddenException();
    return this.activeTenant.resolve(userId);
  }
}
