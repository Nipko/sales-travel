import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ActivityDetail,
  ActivityOffer,
  ActivityPrice,
  ActivitySummary,
} from '@sales-travel/canonical';
import type {
  ActivityExchangePolicy,
  ActivityHint,
  ActivityReservation,
} from '@sales-travel/despegar-activities';
import type { CancelQuote, CancelReservationResult } from '@sales-travel/despegar-hotels';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { OrdersService, type OrderRow } from '../orders/orders.service.js';
import {
  PricingService,
  applyCascade,
  applyProviderFloor,
  rulesForCurrency,
  toTenantView,
  type ApplicableRule,
  type TenantPricingView,
} from '../pricing/pricing.service.js';
import { KillSwitchStore } from '../provider-enablement/kill-switch.store.js';
import { DespegarActivitiesProviderFactory } from '../providers-despegar/despegar-activities.factory.js';
import { mapActivityBookError } from './activities-errors.js';
import {
  ACTIVITIES_PROVIDER,
  ACTIVITIES_VERTICAL,
  DESPEGAR_ACTIVITIES_CAPABILITIES,
  activitiesGate,
  type ActivitiesOperation,
  type ActivityProviderCapabilities,
} from './activities.capabilities.js';
import type {
  ActivitySearchQuery,
  AvailabilityBody,
  BookBody,
  CancelBody,
  ModalitiesQueryInput,
  PrebookBody,
  ShoppingBody,
} from './activities.schemas.js';

/** Una tarifa con el precio elegido (una moneda) y lo que la agencia la vende. */
export type PricedActivityOffer = ActivityOffer & {
  /** El precio del proveedor en la moneda elegida: base de la cascada. */
  price: ActivityPrice;
  /** Vista de la cascada para ESTE tenant (sin el neto ni el desglose de los ancestros). */
  pricing?: TenantPricingView;
};

export interface ActivitiesStatus {
  enabled: boolean;
  reason?: 'flag-off' | 'kill-switch';
  provider: string;
  capabilities: ActivityProviderCapabilities;
}

export interface ActivityPrebookOutcome {
  prebookId: string;
  expiresAt?: string;
  total?: { amountMinor: number; currency: string };
  exchangePolicies: ActivityExchangePolicy[];
  hints: ActivityHint[];
  /** La cuenta ofrece cuenta corriente para esta tarifa: sin eso no se puede reservar. */
  currentAccountAvailable: boolean;
}

export interface ActivityBookOutcome {
  reservationId: string;
  status: 'SUCCESS' | 'PROCESSING';
  pnr?: string;
  /** `false`: la reserva está hecha en Despegar pero no quedó como orden (quedó el rastro). */
  recorded: boolean;
  orderId?: string;
  saleMinor: number;
  currency: string;
}

export interface ActivityCancelPreviewOutcome {
  reservation: ActivityReservation;
  allowed: boolean;
  disallowedReason?: string;
  refundPolicy?: string;
  quote?: CancelQuote;
}

export const ACTIVITY_RESERVATION_UNRECORDED_EVENT = 'ActivityReservationUnrecorded';

/**
 * Actividades de Despegar/HotelDO: búsqueda, disponibilidad con la cascada de markup de la vertical
 * `activities`, reserva a cuenta corriente y post-venta. Todo detrás de {@link activitiesGate}.
 */
@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(
    private readonly factory: DespegarActivitiesProviderFactory,
    private readonly pricing: PricingService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly db: DatabaseService,
    @Optional() private readonly killSwitches?: KillSwitchStore,
  ) {}

  status(): ActivitiesStatus {
    const gate = activitiesGate('sale', this.killSwitches?.panelLevel(ACTIVITIES_PROVIDER));
    return {
      enabled: gate.enabled,
      ...(gate.enabled ? {} : { reason: gate.reason }),
      provider: ACTIVITIES_PROVIDER,
      capabilities: DESPEGAR_ACTIVITIES_CAPABILITIES,
    };
  }

  private assertEnabled(op: ActivitiesOperation): void {
    const gate = activitiesGate(op, this.killSwitches?.panelLevel(ACTIVITIES_PROVIDER));
    if (gate.enabled) return;
    throw new ServiceUnavailableException(
      gate.reason === 'kill-switch'
        ? 'Las actividades de Despegar están apagadas por operaciones. Prueba más tarde.'
        : 'Las actividades de Despegar todavía no están habilitadas en la plataforma.',
    );
  }

  // ───────────────────────── Búsqueda ─────────────────────────

  async search(tenantId: string, q: ActivitySearchQuery): Promise<ActivitySummary[]> {
    this.assertEnabled('sale');
    const { adapter, site } = await this.resolve(tenantId);
    return adapter.discover({
      destination: q.destination,
      site,
      ...(q.language ? { language: q.language } : {}),
    });
  }

  async modalities(tenantId: string, id: string, q: ModalitiesQueryInput): Promise<ActivityDetail> {
    this.assertEnabled('sale');
    const { adapter, site } = await this.resolve(tenantId);
    return adapter.getModalities({
      id,
      site,
      ...(q.from && q.to ? { from: q.from, to: q.to } : {}),
      ...(q.language ? { language: q.language } : {}),
    });
  }

  async availability(tenantId: string, b: AvailabilityBody): Promise<PricedActivityOffer> {
    this.assertEnabled('sale');
    const { adapter, site } = await this.resolve(tenantId);
    const offer = await adapter.getAvailability({
      id: b.activityId,
      modality: b.modalityId,
      date: b.date,
      participants: b.participants,
      site,
      ...(b.schedule ? { schedule: b.schedule } : {}),
      ...(b.additional ? { additional: b.additional } : {}),
      ...(b.language ? { language: b.language } : {}),
    });
    if (!offer) {
      throw new NotFoundException(
        'No hay disponibilidad para esa fecha o esos participantes. Prueba otra fecha u otra modalidad.',
      );
    }
    const [priced] = await this.withPricing(tenantId, [offer], b.currency);
    return priced!;
  }

  async shopping(
    tenantId: string,
    b: ShoppingBody,
  ): Promise<{ id: string; name: string; images: string[]; offers: PricedActivityOffer[] }[]> {
    this.assertEnabled('sale');
    const { adapter, site } = await this.resolve(tenantId);
    const parks = await adapter.shopping({
      park: b.park,
      from: b.from,
      participants: b.participants,
      site,
      ...(b.to ? { to: b.to } : {}),
      ...(b.modalities ? { modalities: b.modalities } : {}),
      ...(b.language ? { language: b.language } : {}),
    });
    const out = [];
    for (const p of parks) {
      out.push({
        id: p.id,
        name: p.name,
        images: p.images,
        offers: await this.withPricing(tenantId, p.offers, b.currency),
      });
    }
    return out;
  }

  // ───────────────────────── Reserva ─────────────────────────

  async prebook(tenantId: string, b: PrebookBody): Promise<ActivityPrebookOutcome> {
    this.assertEnabled('sale');
    const { adapter } = await this.resolve(tenantId);
    const prebook = await adapter.prebook(b.choiceId, b.language);
    const options = await adapter.getPaymentOptions(prebook.prebookId);
    const currentAccountAvailable = options.some((m) =>
      m.options.some((o) => o.optionType === 'CURRENT_ACCOUNT'),
    );
    return {
      prebookId: prebook.prebookId,
      exchangePolicies: prebook.exchangePolicies,
      hints: prebook.hints,
      currentAccountAvailable,
      ...(prebook.expiresAt ? { expiresAt: prebook.expiresAt } : {}),
      ...(prebook.total ? { total: prebook.total } : {}),
    };
  }

  /**
   * Reserva a cuenta corriente. La orden guarda el precio de VENTA (cascada `activities` sobre el
   * neto que vio el vendedor); a Despegar no se le manda ningún precio: cobra el del prebook.
   */
  async book(tenantId: string, userId: string, b: BookBody): Promise<ActivityBookOutcome> {
    this.assertEnabled('sale');
    const { adapter, accountId } = await this.resolve(tenantId);
    const options = await adapter.getPaymentOptions(b.prebookId);
    if (!options.some((m) => m.options.some((o) => o.optionType === 'CURRENT_ACCOUNT'))) {
      throw new HttpException(
        'La cuenta de Despegar no ofrece cuenta corriente para esta actividad. No se reservó nada.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const externalBookingReference = `ST-ACT-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const result = await adapter.book({
      prebookId: b.prebookId,
      externalBookingReference,
      contact: {
        email: b.contact.email,
        ...(b.contact.phone
          ? {
              phones: [
                {
                  countryCode: b.contact.phone.countryCode,
                  number: b.contact.phone.number,
                  type: 'MOBILE' as const,
                  ...(b.contact.phone.areaCode ? { areaCode: b.contact.phone.areaCode } : {}),
                },
              ],
            }
          : {}),
      },
      travelers: b.travelers.map((t) => ({
        firstName: t.firstName,
        lastName: t.lastName,
        birthDate: t.birthDate,
        ...(t.nationality ? { nationality: t.nationality } : {}),
        ...(t.gender ? { gender: t.gender } : {}),
        ...(t.identification ? { identification: t.identification } : {}),
      })),
    });
    if (result.status === 'ERROR' || result.reservationId === '') {
      const mapped = mapActivityBookError(result.subStatus);
      throw new HttpException(
        {
          statusCode: mapped.status,
          message: mapped.message,
          ...(result.subStatus ? { providerCode: result.subStatus } : {}),
        },
        mapped.status,
      );
    }

    const rules = await this.rulesFor(tenantId, b.offer.currency);
    const waterfall = applyProviderFloor(
      applyCascade(b.offer.netMinor, rules),
      undefined,
      tenantId,
    );
    const pnr = result.products.find((p) => p.pnr)?.pnr;
    const status = result.status === 'SUCCESS' ? 'confirmed' : 'pending';
    let recorded = false;
    let orderId: string | undefined;
    try {
      const order = await this.orders.recordExternalOrder(tenantId, userId, {
        provider: ACTIVITIES_PROVIDER,
        providerOrderId: result.reservationId,
        status,
        searchCriteria: {
          vertical: ACTIVITIES_VERTICAL,
          activityId: b.offer.activityId,
          date: b.offer.date,
          participants: b.travelers.length,
        },
        selectedOffer: {
          ...b.offer,
          pnr,
          externalBookingReference,
          providerAccountId: accountId,
          pricing: {
            netMinor: waterfall.netMinor,
            finalMinor: waterfall.finalMinor,
            totalMarkupMinor: waterfall.totalMarkupMinor,
            currency: b.offer.currency,
          },
        },
        passengers: b.travelers.map((t) => ({
          givenName: t.firstName,
          surname: t.lastName,
          birthDate: t.birthDate,
        })),
        contactInfo: { email: b.contact.email },
        totalAmountMinor: waterfall.finalMinor,
        currency: b.offer.currency,
      });
      recorded = true;
      orderId = order.id;
    } catch (err) {
      this.logger.error(
        `[activities] reserva ${result.reservationId} hecha en Despegar pero no quedó como orden: ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
    }
    await this.audit.emit({
      eventType: recorded ? 'ActivityReservationCreated' : ACTIVITY_RESERVATION_UNRECORDED_EVENT,
      tenantId,
      actorUserId: userId,
      aggregateType: recorded ? 'order' : 'activity_reservation',
      aggregateId: orderId ?? result.reservationId,
      payload: {
        provider: ACTIVITIES_PROVIDER,
        reservationId: result.reservationId,
        status: result.status,
        activityId: b.offer.activityId,
        date: b.offer.date,
        participants: b.travelers.length,
        saleMinor: waterfall.finalMinor,
        currency: b.offer.currency,
      },
    });
    return {
      reservationId: result.reservationId,
      status: result.status,
      recorded,
      saleMinor: waterfall.finalMinor,
      currency: b.offer.currency,
      ...(pnr ? { pnr } : {}),
      ...(orderId ? { orderId } : {}),
    };
  }

  // ───────────────────────── Post-venta ─────────────────────────

  async reservation(tenantId: string, reservationId: string): Promise<ActivityReservation> {
    this.assertEnabled('read');
    await this.ownedOrder(tenantId, reservationId);
    const { adapter } = await this.resolve(tenantId);
    const found = await adapter.findReservation(reservationId);
    if (!found) {
      throw new NotFoundException(
        'Despegar todavía no muestra esta reserva. La post-venta está disponible un minuto después de confirmar.',
      );
    }
    return found;
  }

  async previewCancellation(
    tenantId: string,
    reservationId: string,
  ): Promise<ActivityCancelPreviewOutcome> {
    this.assertEnabled('read');
    await this.ownedOrder(tenantId, reservationId);
    const { adapter } = await this.resolve(tenantId);
    const preview = await adapter.previewCancellation(reservationId);
    return {
      reservation: preview.reservation,
      allowed: preview.allowance.allowance === 'ALLOWED',
      ...(preview.allowance.disallowedReason
        ? { disallowedReason: preview.allowance.disallowedReason }
        : {}),
      ...(preview.allowance.refundPolicy ? { refundPolicy: preview.allowance.refundPolicy } : {}),
      ...(preview.quote ? { quote: preview.quote } : {}),
    };
  }

  /** Cancela TODOS los participantes (Despegar no admite parciales). Irreversible. */
  async cancel(
    tenantId: string,
    userId: string,
    reservationId: string,
    b: CancelBody,
  ): Promise<CancelReservationResult> {
    this.assertEnabled('read');
    const order = await this.ownedOrder(tenantId, reservationId);
    if (order.status === 'cancelled') {
      throw new HttpException('Esta reserva ya está cancelada.', HttpStatus.CONFLICT);
    }
    const { adapter } = await this.resolve(tenantId);
    const result = await adapter.cancelReservation(reservationId, b.reason);
    await this.db.withTenant(tenantId, (trx) =>
      trx
        .updateTable('orders')
        .set({ status: 'cancelled' })
        .where('id', '=', order.id)
        .where('tenant_id', '=', tenantId)
        .execute(),
    );
    await this.audit.emit({
      eventType: 'ActivityReservationCancelled',
      tenantId,
      actorUserId: userId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: {
        provider: ACTIVITIES_PROVIDER,
        reservationId,
        reason: b.reason,
        ...(result.flowId ? { flowId: result.flowId } : {}),
      },
    });
    return result;
  }

  // ───────────────────────── Helpers ─────────────────────────

  /**
   * Las reservas por código sólo valen para órdenes de la agencia: la cuenta de Despegar puede ser
   * heredada del consolidador, y con un código ajeno se leería o cancelaría la reserva de otra.
   */
  private async ownedOrder(tenantId: string, reservationId: string): Promise<OrderRow> {
    const order = await this.orders.findByProviderOrderId(
      tenantId,
      ACTIVITIES_PROVIDER,
      reservationId,
    );
    if (!order) {
      throw new NotFoundException(
        'No encontramos esa reserva de actividad entre las de tu agencia. Revisa el código.',
      );
    }
    return order;
  }

  private async resolve(tenantId: string) {
    const resolved = await this.factory.forTenant(tenantId);
    const site = resolved.site ?? (await this.tenantCountry(tenantId)) ?? 'br';
    return { ...resolved, site: site.toLowerCase() };
  }

  private async tenantCountry(tenantId: string): Promise<string | undefined> {
    const t = await this.db.db
      .selectFrom('tenants')
      .select(['country_code'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    const c = t?.country_code;
    return typeof c === 'string' && /^[A-Za-z]{2}$/.test(c) ? c : undefined;
  }

  private async homeCurrency(tenantId: string): Promise<string | undefined> {
    const row = await this.db.db
      .selectFrom('tenants')
      .select('default_currency')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    const raw = row?.default_currency;
    if (typeof raw !== 'string') return undefined;
    const code = raw.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : undefined;
  }

  private async rulesFor(tenantId: string, currency: string): Promise<ApplicableRule[]> {
    const rules = await this.pricing.getApplicableRules(tenantId, ACTIVITIES_VERTICAL);
    return rulesForCurrency(rules, currency, await this.homeCurrency(tenantId));
  }

  /**
   * Elige el precio de cada tarifa y le aplica la cascada `activities`. Despegar no informa un piso
   * de venta para actividades: `applyProviderFloor` queda sin piso (ver capacidades).
   */
  private async withPricing(
    tenantId: string,
    offers: readonly ActivityOffer[],
    requested?: string,
  ): Promise<PricedActivityOffer[]> {
    if (offers.length === 0) return [];
    const [allRules, home] = await Promise.all([
      this.pricing.getApplicableRules(tenantId, ACTIVITIES_VERTICAL),
      this.homeCurrency(tenantId),
    ]);
    return offers.map((o) => {
      const price = pickPrice(o.prices, requested, home);
      const rules = rulesForCurrency(allRules, price.currency, home);
      if (rules.length === 0) return { ...o, price };
      const w = applyProviderFloor(
        applyCascade(price.gross.amountMinor, rules),
        undefined,
        tenantId,
      );
      return { ...o, price, pricing: toTenantView(w, tenantId, price.currency) };
    });
  }
}

/**
 * La moneda del precio: la pedida si el proveedor la da; si no, la de la agencia; si no, la local
 * (no USD); si no, la primera. La plataforma no convierte monedas.
 */
export function pickPrice(
  prices: readonly ActivityPrice[],
  requested: string | undefined,
  home: string | undefined,
): ActivityPrice {
  const by = (c: string | undefined) =>
    c === undefined ? undefined : prices.find((p) => p.currency === c.toUpperCase());
  return by(requested) ?? by(home) ?? prices.find((p) => p.currency !== 'USD') ?? prices[0]!;
}
