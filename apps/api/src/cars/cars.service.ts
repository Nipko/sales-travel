import { ForbiddenException, Injectable } from '@nestjs/common';
import { Money } from '@sales-travel/canonical';
import type {
  CancelQuery,
  CancelResult,
  CarBookResult,
  CarLocation,
  CarOffer,
  CarOffice,
  CarRateDetail,
  CarReservation,
  CarSearchQuery,
  CarSelection,
  CarSelectionQuery,
  ConfirmCarRequest,
  DailyReportEntry,
  FindOfficesQuery,
  MyReservationQuery,
  RateDetailQuery,
  RatesQuery,
  ReleaseQuery,
  ReleaseResult,
  RateType,
} from '@sales-travel/agent-cars';
import { DatabaseService } from '../database/database.service.js';
import { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type {
  CarSearchInput,
  CarSelectionInput,
  ConfirmInput,
  DailyReportInput,
  FindOfficesInput,
  RatesInput,
} from './cars.schemas.js';

@Injectable()
export class CarsService {
  constructor(
    private readonly factory: AgentCarsProviderFactory,
    private readonly db: DatabaseService,
  ) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  async suggest(tenantId: string, q: string, lang?: string): Promise<CarLocation[]> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.suggest({ query: q, ...(lang && { lang }) });
  }

  async findOffices(tenantId: string, input: FindOfficesInput): Promise<CarOffice[]> {
    const adapter = await this.factory.forTenant(tenantId);
    // source es opcional: si no llega, el adapter usa el sourceCountry de la cuenta BYOC.
    const q: FindOfficesQuery = { distance: input.distance };
    if (input.source) q.source = input.source;
    if (input.lat !== undefined) q.lat = input.lat;
    if (input.lng !== undefined) q.lng = input.lng;
    if (input.cityCode) q.cityCode = input.cityCode;
    if (input.companyCode) q.companyCode = input.companyCode;
    return adapter.findOffices(q);
  }

  async getRates(tenantId: string, input: RatesInput): Promise<RateType[]> {
    const adapter = await this.factory.forTenant(tenantId);
    const q: RatesQuery = { country: input.country };
    if (input.source) q.source = input.source;
    if (input.language) q.language = input.language;
    return adapter.getRates(q);
  }

  async getMatrix(tenantId: string, input: CarSearchInput): Promise<CarOffer[]> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.getMatrix(this.toSearchQuery(input));
  }

  async getSelection(tenantId: string, input: CarSelectionInput): Promise<CarSelection> {
    const adapter = await this.factory.forTenant(tenantId);
    const q: CarSelectionQuery = {
      ...this.toSearchQuery(input),
      companyCode: input.companyCode,
      sippCode: input.sippCode,
    };
    if (input.ccrc) q.ccrc = input.ccrc;
    if (input.coupon) q.coupon = input.coupon;
    if (input.tp) q.tp = input.tp;
    return adapter.getSelection(q);
  }

  async getRateDetail(tenantId: string, q: RateDetailQuery): Promise<CarRateDetail> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.getRateDetail(q);
  }

  // ───────────────────────── Reserva ─────────────────────────

  async book(tenantId: string, input: ConfirmInput): Promise<CarBookResult> {
    const adapter = await this.factory.forTenant(tenantId);
    const req: ConfirmCarRequest = {
      uniqid: input.uniqid,
      paymentType: input.paymentType,
      rateType: input.rateType,
      companyCode: input.companyCode,
      sippCode: input.sippCode,
      pickUpLocation: input.pickUpLocation,
      dropOffLocation: input.dropOffLocation,
      pickUpDate: input.pickUpDate,
      dropOffDate: input.dropOffDate,
      pickUpHour: input.pickUpHour,
      dropOffHour: input.dropOffHour,
      pickUpAddress: input.pickUpAddress,
      dropOffAddress: input.dropOffAddress,
      firstName: input.firstName,
      lastName: input.lastName,
      age: input.age,
      email: input.email,
      realBase: Money.fromMajor(input.realBase, input.currency),
      realTax: Money.fromMajor(input.realTax, input.currency),
      total: Money.fromMajor(input.total, input.currency),
    };
    if (input.ccrc) req.ccrc = input.ccrc;
    if (input.cdCode) req.cdCode = input.cdCode;
    if (input.pcCode) req.pcCode = input.pcCode;
    if (input.extras) req.extras = input.extras;
    if (input.flightNumber) req.flightNumber = input.flightNumber;
    if (input.frequentFlyer) req.frequentFlyer = input.frequentFlyer;
    if (input.membershipNumber) req.membershipNumber = input.membershipNumber;
    if (input.onHold !== undefined) req.onHold = input.onHold;
    if (input.language) req.language = input.language;
    return adapter.confirm(req);
  }

  async myReservation(tenantId: string, q: MyReservationQuery): Promise<CarReservation> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.myReservation(q);
  }

  async cancel(tenantId: string, q: CancelQuery): Promise<CancelResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.cancel(q);
  }

  async release(tenantId: string, q: ReleaseQuery): Promise<ReleaseResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.release(q);
  }

  async getDailyReport(tenantId: string, input: DailyReportInput): Promise<DailyReportEntry[]> {
    const adapter = await this.factory.forTenant(tenantId);
    const q: { date?: string; language?: string } = {};
    if (input.date) q.date = input.date;
    if (input.language) q.language = input.language;
    return adapter.getDailyReport(q);
  }

  // ───────────────────────── Helpers ─────────────────────────

  /**
   * Arma el CarSearchQuery canónico. `country` (destino) es requerido por el schema. `source`
   * (origen) es opcional: si el cliente no lo envía, el adapter usa el sourceCountry de la cuenta
   * BYOC del tenant. La validación de coordenadas para búsqueda por ciudad ya la hizo el schema.
   */
  private toSearchQuery(input: CarSearchInput): CarSearchQuery {
    const q: CarSearchQuery = {
      pickUpLocation: input.pickUpLocation,
      dropOffLocation: input.dropOffLocation,
      pickUpDate: input.pickUpDate,
      dropOffDate: input.dropOffDate,
      pickUpHour: input.pickUpHour,
      dropOffHour: input.dropOffHour,
      rateType: input.rateType,
      country: input.country,
    };
    if (input.source) q.source = input.source;
    if (input.paymentType) q.paymentType = input.paymentType;
    if (input.companyCode) q.companyCode = input.companyCode;
    if (input.cdCode) q.cdCode = input.cdCode;
    if (input.pcCode) q.pcCode = input.pcCode;
    if (input.language) q.language = input.language;
    if (input.lat !== undefined) q.lat = input.lat;
    if (input.lng !== undefined) q.lng = input.lng;
    if (input.latDropOff !== undefined) q.latDropOff = input.latDropOff;
    if (input.lngDropOff !== undefined) q.lngDropOff = input.lngDropOff;
    return q;
  }

  /**
   * Sprint 0: el primer tenant activo del usuario es el "tenant actual" (igual que SearchController).
   * Cuando exista /auth/switch-tenant, esto leerá un claim del JWT.
   */
  async resolveActiveTenant(userId: string): Promise<string> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select(['tenant_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('user has no active membership');
      return row.tenant_id;
    });
  }
}
