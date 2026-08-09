import { Injectable, Logger } from '@nestjs/common';
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
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import {
  PricingService,
  applyCascade,
  toTenantView,
  type TenantPricingView,
} from '../pricing/pricing.service.js';
import type {
  CarSearchInput,
  CarSelectionInput,
  ConfirmInput,
  DailyReportInput,
  FindOfficesInput,
  RatesInput,
} from './cars.schemas.js';

const VERTICAL = 'cars';

/**
 * Pricing acotado al tenant que consulta. Sin neto ni desglose por ancestro: le
 * revelarian a la agencia cuanto gana el consolidador sobre ella.
 */
export type CarPricing = TenantPricingView;

export type PricedCarOffer = CarOffer & { pricing?: CarPricing };
export type PricedCarSelection = CarSelection & { pricing?: CarPricing };

@Injectable()
export class CarsService {
  private readonly logger = new Logger(CarsService.name);

  constructor(
    private readonly factory: AgentCarsProviderFactory,
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  async suggest(tenantId: string, q: string, lang?: string): Promise<CarLocation[]> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.suggest({ query: q, ...(lang && { lang }) });
  }

  async findOffices(tenantId: string, input: FindOfficesInput): Promise<CarOffice[]> {
    const adapter = await this.factory.forTenant(tenantId);
    const source = await this.resolveSource(tenantId, input.source);
    const q: FindOfficesQuery = { distance: input.distance };
    if (source) q.source = source;
    if (input.lat !== undefined) q.lat = input.lat;
    if (input.lng !== undefined) q.lng = input.lng;
    if (input.cityCode) q.cityCode = input.cityCode;
    if (input.companyCode) q.companyCode = input.companyCode;
    return adapter.findOffices(q);
  }

  async getRates(tenantId: string, input: RatesInput): Promise<RateType[]> {
    const adapter = await this.factory.forTenant(tenantId);
    const source = await this.resolveSource(tenantId, input.source);
    const q: RatesQuery = { country: input.country };
    if (source) q.source = source;
    if (input.language) q.language = input.language;
    return adapter.getRates(q);
  }

  async getMatrix(tenantId: string, input: CarSearchInput): Promise<PricedCarOffer[]> {
    const adapter = await this.factory.forTenant(tenantId);
    const source = await this.resolveSource(tenantId, input.source);
    const offers = await adapter.getMatrix(this.toSearchQuery(input, source));
    return this.withPricing(offers, tenantId);
  }

  async getSelection(tenantId: string, input: CarSelectionInput): Promise<PricedCarSelection> {
    const adapter = await this.factory.forTenant(tenantId);
    const source = await this.resolveSource(tenantId, input.source);
    const q: CarSelectionQuery = {
      ...this.toSearchQuery(input, source),
      companyCode: input.companyCode,
      sippCode: input.sippCode,
    };
    if (input.ccrc) q.ccrc = input.ccrc;
    if (input.coupon) q.coupon = input.coupon;
    if (input.tp) q.tp = input.tp;
    const selection = await adapter.getSelection(q);
    const [priced] = await this.withPricing([selection], tenantId);
    return priced ?? selection;
  }

  async getRateDetail(tenantId: string, q: RateDetailQuery): Promise<CarRateDetail> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.getRateDetail(q);
  }

  // ───────────────────────── Reserva ─────────────────────────

  async book(tenantId: string, userId: string, input: ConfirmInput): Promise<CarBookResult> {
    const adapter = await this.factory.forTenant(tenantId);
    // El proveedor SIEMPRE recibe el neto (input.total). El precio de venta (con la cascada de
    // markup) se calcula aparte y se guarda en la orden — nunca se le manda al proveedor.
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

    const result = await adapter.confirm(req);

    // La reserva YA ocurrió: persistirla NO debe poder tumbarla. Cualquier fallo de persistencia o
    // auditoría se loguea y se traga; el cliente igual recibe el CarBookResult.
    try {
      await this.persistOrder(tenantId, userId, input, result);
    } catch (err) {
      this.logger.error(
        `[cars] reserva ${result.confirmationCode} confirmada pero falló su persistencia:`,
        (err as Error).message,
      );
    }

    return result;
  }

  /**
   * Persiste la reserva de auto como fila `orders` (provider='agent-cars') y emite el domain event.
   * `total_amount` es el precio de VENTA: aplica el pricing waterfall del consolidador sobre el neto
   * (input.total). El neto enviado al proveedor no se toca.
   */
  private async persistOrder(
    tenantId: string,
    userId: string,
    input: ConfirmInput,
    result: CarBookResult,
  ): Promise<void> {
    const netTotalMinor = Math.round(input.total * 100);
    const waterfall = await this.pricing.computeWaterfall(tenantId, VERTICAL, netTotalMinor);
    const status = result.status === 'confirmed' ? 'confirmed' : 'pending';
    const rateAmount = Money.fromMajor(input.total, input.currency);

    const order = await this.orders.recordExternalOrder(tenantId, userId, {
      provider: 'agent-cars',
      providerOrderId: result.confirmationCode,
      status,
      searchCriteria: {
        vertical: VERTICAL,
        pickUpLocation: input.pickUpLocation,
        dropOffLocation: input.dropOffLocation,
        pickUpDate: input.pickUpDate,
        dropOffDate: input.dropOffDate,
        pickUpHour: input.pickUpHour,
        dropOffHour: input.dropOffHour,
      },
      selectedOffer: {
        // Nombres legibles si el cliente los envió (de la selección); si no, el código como fallback.
        category: input.category ?? result.sippCode,
        carModel: input.carModel ?? result.sippCode,
        companyName: input.companyName ?? input.companyCode,
        sippCode: result.sippCode,
        companyCode: input.companyCode,
        rateAmount,
        pricing: {
          finalMinor: waterfall.finalMinor,
          netMinor: waterfall.netMinor,
          totalMarkupMinor: waterfall.totalMarkupMinor,
          currency: input.currency,
        },
      },
      passengers: [{ givenName: input.firstName, surname: input.lastName, paxType: 'DRIVER' }],
      contactInfo: { email: input.email },
      totalAmountMinor: waterfall.finalMinor,
      currency: input.currency,
    });

    await this.audit.emit({
      eventType: 'CarReservationCreated',
      tenantId,
      actorUserId: userId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: {
        provider: 'agent-cars',
        confirmationCode: result.confirmationCode,
        status,
        totalMinor: waterfall.finalMinor,
        currency: input.currency,
      },
    });
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
   * Adjunta el pricing waterfall del consolidador a cada oferta (vertical 'cars'). El neto del
   * proveedor (`rateAmount`/`base`/`tax`) NO se muta — se sigue reservando al neto; `pricing.finalMinor`
   * es el precio de venta. Sin reglas aplicables, devuelve las ofertas sin tocar (precio = neto).
   */
  private async withPricing<T extends CarOffer>(
    offers: T[],
    tenantId: string,
  ): Promise<(T & { pricing?: CarPricing })[]> {
    const rules = await this.pricing.getApplicableRules(tenantId, VERTICAL);
    if (rules.length === 0) return offers;
    return offers.map((o) => {
      return {
        ...o,
        pricing: toTenantView(
          applyCascade(o.rateAmount.amountMinor, rules),
          tenantId,
          o.rateAmount.currency,
        ),
      };
    });
  }

  /**
   * Resuelve el país de origen (source) que AgentCars EXIGE en matrix/selection/rates:
   *   source explícito del request → país del tenant (country_code) → (el adapter cae a cfg.sourceCountry).
   * AgentCars rechaza con HTTP 412 "Source Country cannot be blank" si queda vacío, así que el
   * país del tenant (cargado al crear la agencia) sirve de fallback robusto sin depender del env.
   */
  private async resolveSource(tenantId: string, explicit?: string): Promise<string | undefined> {
    if (explicit) return explicit;
    const t = await this.db.db
      .selectFrom('tenants')
      .select(['country_code'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    return t?.country_code ?? undefined;
  }

  /**
   * Arma el CarSearchQuery canónico. `country` (destino) lo exige el schema; `source` (origen) ya
   * viene resuelto por resolveSource(). La validación de coordenadas para ciudad la hizo el schema.
   */
  private toSearchQuery(input: CarSearchInput, source?: string): CarSearchQuery {
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
    if (source) q.source = source;
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
}
