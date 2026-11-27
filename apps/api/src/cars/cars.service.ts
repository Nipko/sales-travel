import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { GovernancePaymentsService } from '../governance/governance-payments.service.js';
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
import { OrdersService, type OrderRow } from '../orders/orders.service.js';
import { sql } from 'kysely';
import { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import {
  PricingService,
  applyCascade,
  toTenantView,
  type TenantPricingView,
} from '../pricing/pricing.service.js';
import { CarSelectionStore, sameMoney, type StoredCarSelection } from './car-selection.store.js';
import type {
  CarSearchInput,
  CarSelectionInput,
  ConfirmInput,
  DailyReportInput,
  FindOfficesInput,
  RatesInput,
} from './cars.schemas.js';

const VERTICAL = 'cars';
const PROVIDER = 'agent-cars';

/**
 * Pricing acotado al tenant que consulta. Sin neto ni desglose por ancestro: le
 * revelarian a la agencia cuanto gana el consolidador sobre ella.
 */
export type CarPricing = TenantPricingView;

/**
 * La reserva confirmada en AgentCars y si quedó como orden. `recorded: false` es una reserva viva
 * que todavía no está en Reservas: el panel muestra el código con un aviso (A4 de la auditoría 19).
 */
export type CarBookOutcome = CarBookResult & { recorded: boolean };

/** Rastro durable de una reserva confirmada que no se pudo guardar como orden. */
export const CAR_RESERVATION_UNRECORDED_EVENT = 'CarReservationUnrecorded';

/** Pausas entre los intentos de guardar la orden (3 intentos, ~1,25 s en total). */
const PERSIST_RETRY_DELAYS_MS = [250, 1000] as const;

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
    /** Gobierno de proveedores y formas de pago (0089). Opcional para los dobles de las suites. */
    @Optional() private readonly governance?: GovernancePaymentsService,
    /** El neto de cada selección, para que el Book no lo tome del cliente (AUT-05). */
    @Optional() private readonly selections: CarSelectionStore = new CarSelectionStore(),
  ) {}

  /** AgentCars no pasa por los registries: su habilitación la mira el servicio (0089). */
  private async assertCarsEnabled(tenantId: string): Promise<void> {
    if (this.governance && !(await this.governance.isEnabled(tenantId, 'agent-cars', ''))) {
      throw new ForbiddenException(
        'AgentCars no está habilitado para tu agencia. Pide al administrador de la plataforma que lo habilite.',
      );
    }
  }

  // ───────────────────────── Búsqueda ─────────────────────────

  async suggest(tenantId: string, q: string, lang?: string): Promise<CarLocation[]> {
    await this.assertCarsEnabled(tenantId);
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
    await this.assertCarsEnabled(tenantId);
    const adapter = await this.factory.forTenant(tenantId);
    const source = await this.resolveSource(tenantId, input.source);
    const offers = await adapter.getMatrix(this.toSearchQuery(input, source));
    return this.withPricing(offers, tenantId);
  }

  async getSelection(tenantId: string, input: CarSelectionInput): Promise<PricedCarSelection> {
    await this.assertCarsEnabled(tenantId);
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
    await this.selections.remember(tenantId, selection);
    const [priced] = await this.withPricing([selection], tenantId);
    return priced ?? selection;
  }

  async getRateDetail(tenantId: string, q: RateDetailQuery): Promise<CarRateDetail> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.getRateDetail(q);
  }

  // ───────────────────────── Reserva ─────────────────────────

  async book(tenantId: string, userId: string, input: ConfirmInput): Promise<CarBookOutcome> {
    await this.assertCarsEnabled(tenantId);
    if (this.governance) {
      await this.governance.assertEnabled(
        tenantId,
        'agent-cars',
        input.paymentType === 'pod' ? 'pay_at_destination' : 'prepaid',
      );
    }
    const quoted = await this.quotedNet(tenantId, input);
    const adapter = await this.factory.forTenant(tenantId);
    // El proveedor SIEMPRE recibe el neto de la selección, el que AgentCars cotizó y esta API
    // guardó (AUT-05). El precio de venta (con la cascada de markup) se calcula aparte y se guarda
    // en la orden — nunca se le manda al proveedor.
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
      realBase: quoted.base,
      realTax: quoted.tax,
      total: quoted.rateAmount,
    };
    if (input.ccrc) req.ccrc = input.ccrc;
    if (input.rateIdentifier) req.rateIdentifier = input.rateIdentifier;
    if (input.cdCode) req.cdCode = input.cdCode;
    if (input.pcCode) req.pcCode = input.pcCode;
    if (input.extras) req.extras = input.extras;
    if (input.flightNumber) req.flightNumber = input.flightNumber;
    if (input.frequentFlyer) req.frequentFlyer = input.frequentFlyer;
    if (input.membershipNumber) req.membershipNumber = input.membershipNumber;
    if (input.onHold !== undefined) req.onHold = input.onHold;
    if (input.language) req.language = input.language;

    const result = await adapter.confirm(req);
    await this.selections.forget(tenantId, input.uniqid);

    // La reserva YA ocurrió: persistirla NO debe poder tumbarla. Se reintenta; si igual no entra,
    // queda un rastro durable y el vendedor recibe el código con el aviso, nunca un error genérico.
    const recorded = await this.persistWithRetry(tenantId, userId, input, result);
    return { ...result, recorded };
  }

  /**
   * El neto con el que se reserva: el de la selección guardada para esa sesión, no el del cuerpo.
   * El cuerpo todavía lo trae (el panel lo muestra y lo manda); si no coincide con el cotizado, la
   * reserva se frena con 409 en vez de mandar a AgentCars, a la orden y a la cartera un número que
   * el proveedor no dio.
   */
  private async quotedNet(tenantId: string, input: ConfirmInput): Promise<StoredCarSelection> {
    const quoted = await this.selections.recall(tenantId, input.uniqid);
    if (!quoted) {
      throw new ConflictException({
        error: 'Conflict',
        message: 'La selección del auto venció. Vuelve a elegirlo para ver el precio vigente.',
        reason: 'CAR_SELECTION_EXPIRED',
      });
    }
    if (quoted.companyCode !== input.companyCode || quoted.sippCode !== input.sippCode) {
      throw new ConflictException({
        error: 'Conflict',
        message: 'La reserva no corresponde al auto elegido. Vuelve a elegirlo.',
        reason: 'CAR_SELECTION_MISMATCH',
      });
    }
    const sent = {
      base: Money.fromMajor(input.realBase, input.currency),
      tax: Money.fromMajor(input.realTax, input.currency),
      rateAmount: Money.fromMajor(input.total, input.currency),
    };
    if (
      !sameMoney(sent.base, quoted.base) ||
      !sameMoney(sent.tax, quoted.tax) ||
      !sameMoney(sent.rateAmount, quoted.rateAmount)
    ) {
      throw new ConflictException({
        error: 'Conflict',
        message: 'El precio no coincide con el que cotizó la arrendadora. Vuelve a elegir el auto.',
        reason: 'CAR_PRICE_MISMATCH',
        quoted: { base: quoted.base, tax: quoted.tax, total: quoted.rateAmount },
      });
    }
    return quoted;
  }

  /**
   * Reintenta `persistOrder` (la inserción es transaccional: un intento fallido no deja nada). Si
   * los intentos se agotan, emite `CarReservationUnrecorded` con el código para que operaciones la
   * dé de alta a mano. Sin nombre ni correo del conductor: el panel de red lo ve cualquier admin.
   */
  private async persistWithRetry(
    tenantId: string,
    userId: string,
    input: ConfirmInput,
    result: CarBookResult,
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= PERSIST_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await this.sleep(PERSIST_RETRY_DELAYS_MS[attempt - 1] ?? 0);
      try {
        await this.persistOrder(tenantId, userId, input, result);
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger.error(
      `[cars] reserva ${result.confirmationCode} confirmada pero no quedó como orden tras ${
        PERSIST_RETRY_DELAYS_MS.length + 1
      } intentos: ${reason}`,
    );
    await this.audit.emit({
      eventType: CAR_RESERVATION_UNRECORDED_EVENT,
      tenantId,
      actorUserId: userId,
      aggregateType: 'car_reservation',
      aggregateId: result.confirmationCode,
      payload: {
        provider: PROVIDER,
        confirmationCode: result.confirmationCode,
        status: result.status,
        companyCode: input.companyCode,
        sippCode: result.sippCode,
        pickUpLocation: input.pickUpLocation,
        pickUpDate: input.pickUpDate,
        dropOffDate: input.dropOffDate,
        netTotalMinor: Math.round(input.total * 100),
        currency: input.currency,
        paymentType: input.paymentType,
        attempts: PERSIST_RETRY_DELAYS_MS.length + 1,
      },
    });
    return false;
  }

  /** Espera entre reintentos; las suites la reemplazan para no dormir. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        // El reparto que informó la arrendadora: base y lo que se cobra en el mostrador (`tax`),
        // para que el detalle de la reserva lo muestre igual que el checkout.
        base: Money.fromMajor(input.realBase, input.currency),
        tax: Money.fromMajor(input.realTax, input.currency),
        paymentType: input.paymentType,
        ...(input.counterCharges?.length
          ? {
              counterCharges: input.counterCharges.map((charge) => ({
                name: charge.name,
                amount: Money.fromMajor(charge.amount, input.currency),
              })),
            }
          : {}),
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

  /**
   * La gestión por apellido + código (consultar, cancelar, activar) sólo vale para reservas de la
   * agencia. Las sub-agencias heredan la cuenta de AgentCars del consolidador: sin esto, con el
   * apellido y el código de una reserva ajena se leía su voucher o se la cancelaba.
   */
  private async ownedOrder(tenantId: string, confirmationCode: string): Promise<OrderRow> {
    const order = await this.orders.findByProviderOrderId(tenantId, PROVIDER, confirmationCode);
    if (!order?.provider_order_id) {
      throw new NotFoundException(
        'No encontramos esa reserva entre las de tu agencia. Revisa el código de confirmación.',
      );
    }
    return order;
  }

  async myReservation(tenantId: string, q: MyReservationQuery): Promise<CarReservation> {
    await this.ownedOrder(tenantId, q.confirmationCode);
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.myReservation(q);
  }

  /**
   * Cancela por la misma vía que «Reservas»: la orden pasa a cancelada, queda la operación y su
   * auditoría, y una cancelación ya hecha o en duda no se vuelve a mandar. Antes iba directo al
   * proveedor y la orden seguía «confirmada» en Reservas y en los reportes.
   */
  async cancel(tenantId: string, userId: string, q: CancelQuery): Promise<CancelResult> {
    const order = await this.ownedOrder(tenantId, q.confirmationCode);
    const providerOrderId = order.provider_order_id ?? q.confirmationCode;
    const { result } = await this.orders.cancelOrder(tenantId, order.id, providerOrderId, userId);
    return {
      success: result.success,
      confirmationCode: providerOrderId,
      ...(result.error ? { message: result.error } : {}),
    };
  }

  async release(tenantId: string, q: ReleaseQuery): Promise<ReleaseResult> {
    await this.ownedOrder(tenantId, q.referenceCode);
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.release(q);
  }

  async getDailyReport(tenantId: string, input: DailyReportInput): Promise<DailyReportEntry[]> {
    const adapter = await this.factory.forTenant(tenantId);
    const q: { date?: string; language?: string } = {};
    if (input.date) q.date = input.date;
    if (input.language) q.language = input.language;
    const [entries, owns] = await Promise.all([
      adapter.getDailyReport(q),
      this.factory.ownsAccount(tenantId),
    ]);
    if (owns) return entries;
    // Cuenta compartida: sólo las reservas que la agencia tiene como órdenes.
    const mine = await this.ownedCodes(
      tenantId,
      entries.map((e) => e.confirmationCode),
    );
    return entries.filter((e) => mine.has(e.confirmationCode.trim().toUpperCase()));
  }

  private async ownedCodes(tenantId: string, codes: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    if (wanted.length === 0) return new Set();
    const rows = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('orders')
        .select('provider_order_id')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', PROVIDER)
        .where(sql<string>`upper(provider_order_id)`, 'in', wanted)
        .execute(),
    );
    return new Set(rows.map((r) => String(r.provider_order_id).toUpperCase()));
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
