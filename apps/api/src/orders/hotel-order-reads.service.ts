import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { HotelBookingStatus, HotelBookingView, SearchContext } from '@sales-travel/domain';
import { AuditService } from '../audit/audit.service.js';
import type {
  HcnState,
  HotelOrderSubStatus,
  ProviderStatusSource,
} from '../database/database.types.js';
import { HotelProviderCapabilityError } from '../hotels/hotel-provider-errors.js';
import { planHotelOrderObservation, type HotelOrderPlan } from '../hotels/hotel-order-state.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import type { HotelProviderCapabilities } from '../providers/hotel-provider.types.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  HotelOrderTrackingStore,
  type HotelOrderReadTarget,
  type HotelOrderTrackingRow,
} from './hotel-order-tracking.store.js';
import { hotelOrderEventFields } from './hotel-order-events.js';
import { publicProviderStatus } from './order-events.js';

/**
 * Lecturas de una orden de hotel desde Reservas (docs/tbo/09 PR-5.2; 08 RF-24, RF-26, RF-29;
 * 06 §8 G7).
 *
 * La consulta manual (`POST /orders/:id/retrieve`) de una orden de hotel:
 *
 * 1. lee la orden y su seguimiento con el tenant fijado, ANTES de llamar al proveedor: una orden de
 *    otra agencia no existe aunque las dos reserven con la misma cuenta heredada (RF-29 CA 3);
 * 2. sale con la cuenta con la que se hizo la reserva, no con la vigente del tenant (RF-29 CA 1;
 *    D-TBO-28 A), y sólo si esa cuenta sigue en la red del tenant;
 * 3. lee por el localizador del proveedor con el alcance de post-venta del breaker: frenar las
 *    ventas de un proveedor no impide averiguar en qué quedó una reserva;
 * 4. registra lo que vio en la fila de seguimiento y emite lo que decide la tabla de 04 §6.3
 *    (`planHotelOrderObservation`). Una consulta manual nunca cambia `orders.status`: eso es de la
 *    cancelación y de la conciliación, que tienen sus efectos (retención de cartera, HCN).
 *
 * Además da lo que el controlador de órdenes necesita para las órdenes de hotel: qué operaciones se
 * ofrecen y el seguimiento para la respuesta, sin PII.
 */

/**
 * Qué operaciones de `/orders/:id/*` sabe ejecutar hoy `OrdersService` para una orden de hotel. Se
 * cruza con lo que declara el proveedor. La cancelación enruta por el registry de hoteles desde
 * PR-5.3 (`HotelOrderCancellationService`).
 */
const HOTEL_ORDER_OPERATIONS: Readonly<Pick<ProviderCapabilities, 'retrieve' | 'cancel'>> = {
  retrieve: true,
  cancel: true,
};

/** El seguimiento de una orden de hotel tal como sale por la API: códigos y localizadores. */
export interface PublicHotelOrderTracking {
  /** Subestado de la orden (p. ej. `cancel-requested`); `null` = el estado del proveedor alcanza. */
  readonly subStatus: HotelOrderSubStatus | null;
  /** Código del enum del proveedor, o `'unknown'` si no lo reconocimos. */
  readonly providerStatus: string | null;
  readonly providerStatusAt: string | null;
  readonly providerStatusSource: ProviderStatusSource | null;
  /** Cancelada, con el reembolso del proveedor a la cuenta todavía pendiente. */
  readonly refundAwaited: boolean;
  /** Número de confirmación del hotel (HCN). */
  readonly hotelConfirmationNumber: string | null;
  readonly hcnState: HcnState | null;
}

/** Lo que responde la consulta manual de una orden de hotel. Sin datos de huéspedes. */
export interface HotelOrderReadResult {
  readonly vertical: 'hotels';
  readonly orderId: string;
  readonly found: boolean;
  readonly providerBookingId?: string;
  /** Estado normalizado del contrato neutral. */
  readonly status?: HotelBookingStatus;
  readonly providerStatus?: string;
  readonly refundAwaited: boolean;
  readonly voucherIssued?: boolean;
  readonly hotelConfirmationNumber?: string;
  /** Códigos del proveedor, nunca texto. */
  readonly warnings: readonly string[];
  /** El seguimiento después de registrar esta lectura. */
  readonly tracking: PublicHotelOrderTracking | null;
}

const OPERATION = 'la consulta de la reserva';

export function hotelOrderCapabilities(declared: HotelProviderCapabilities): ProviderCapabilities {
  return {
    retrieve: declared.retrieve && HOTEL_ORDER_OPERATIONS.retrieve,
    cancel: declared.cancel && HOTEL_ORDER_OPERATIONS.cancel,
    pay: false,
    services: false,
    reshop: false,
  };
}

export function publicHotelOrderTracking(row: HotelOrderTrackingRow): PublicHotelOrderTracking {
  return {
    subStatus: row.subStatus,
    // Un estado que no reconocimos se queda en la fila para operaciones; afuera sale `unknown`.
    providerStatus:
      row.providerStatus === null
        ? null
        : publicProviderStatus(row.providerStatus, row.subStatus !== 'unknown'),
    providerStatusAt: row.providerStatusAt?.toISOString() ?? null,
    providerStatusSource: row.providerStatusSource,
    refundAwaited: row.refundAwaited,
    hotelConfirmationNumber: row.hcn,
    hcnState: row.hcnState,
  };
}

@Injectable()
export class HotelOrderReadsService {
  private readonly logger = new Logger(HotelOrderReadsService.name);

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly store: HotelOrderTrackingStore,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
  ) {}

  /** `orders.provider` es un proveedor de hoteles: su post-venta pasa por aquí. */
  handles(provider: string): boolean {
    return this.registry.capabilitiesOf(provider) !== undefined;
  }

  /** Operaciones de la orden, o `undefined` si el proveedor no es de hoteles. */
  capabilitiesOf(provider: string): ProviderCapabilities | undefined {
    const declared = this.registry.capabilitiesOf(provider);
    return declared === undefined ? undefined : hotelOrderCapabilities(declared);
  }

  /** El seguimiento público de las órdenes que lo tienen, leído con el tenant fijado. */
  async trackingOf(
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<Map<string, PublicHotelOrderTracking>> {
    const rows = await this.store.listTracking(tenantId, orderIds);
    return new Map([...rows].map(([id, row]) => [id, publicHotelOrderTracking(row)]));
  }

  /**
   * La consulta manual. Lanza lo que lanza el proveedor (el filtro de su ACL lo traduce) y
   * {@link ProviderOrderAccountUnavailableError} si la cuenta de la reserva ya no está disponible.
   */
  async retrieve(
    tenantId: string,
    orderId: string,
    actorUserId?: string,
  ): Promise<HotelOrderReadResult> {
    const target = await this.store.findReadTarget(tenantId, orderId);
    if (target?.providerOrderId === null || target?.providerOrderId === undefined) {
      throw new NotFoundException('La reserva no existe o no tiene localizador.');
    }
    const locator = target.providerOrderId;

    const provider = await this.registry.forOrder(tenantId, {
      orderId: target.orderId,
      provider: target.provider,
      providerAccountId: target.providerAccountId,
    });
    if (!provider.capabilities.retrieve) {
      throw new HotelProviderCapabilityError(provider.code, OPERATION);
    }

    const ctx: SearchContext = { tenantId, requestId: target.orderId };
    // Una persona espera la respuesta: sin propósito saldría por el cupo de fondo, detrás de los
    // jobs (04 §9.5 punto 5, PV-41).
    const view = await withProviderPayloadScope({ tenantId, orderId: target.orderId }, () =>
      this.breaker.execute(
        provider.code,
        () => provider.adapter.getBooking(locator, ctx, { purpose: 'interactive' }),
        { ...provider.circuit, scope: 'post-sale' },
      ),
    );

    const plan = planHotelOrderObservation(target.snapshot, {
      kind: 'read',
      source: 'retrieve',
      read: view,
    });
    if (await this.record(tenantId, target, plan)) {
      await this.emit(tenantId, target, plan, view, actorUserId);
      this.logActions(target, plan);
    } else {
      // Otro camino escribió después de que se leyó la orden: el plan salió de una foto vieja, y
      // sus avisos (un R3 sobre una orden que la cancelación acaba de cerrar) serían falsos.
      this.logger.warn(
        `hotels.retrieve.stale-read provider=${target.provider} order=${target.orderId}`,
      );
    }

    const tracking = (await this.store.listTracking(tenantId, [target.orderId])).get(
      target.orderId,
    );
    return {
      vertical: 'hotels',
      orderId: target.orderId,
      found: view.found,
      ...(view.providerBookingId === undefined
        ? {}
        : { providerBookingId: view.providerBookingId }),
      ...(view.status === undefined ? {} : { status: view.status }),
      ...(view.providerStatus === undefined
        ? {}
        : {
            providerStatus: publicProviderStatus(
              view.providerStatus,
              view.status !== undefined && view.status !== 'UNKNOWN',
            ),
          }),
      refundAwaited: view.refundAwaited === true,
      ...(view.voucherIssued === undefined ? {} : { voucherIssued: view.voucherIssued }),
      ...(view.hotelConfirmationNumber === undefined
        ? {}
        : { hotelConfirmationNumber: view.hotelConfirmationNumber }),
      warnings: [...view.warnings],
      tracking: tracking === undefined ? null : publicHotelOrderTracking(tracking),
    };
  }

  /**
   * Sólo el seguimiento: la consulta manual no mueve `orders.status` (ver la tabla). `false` = la
   * fila cambió desde que se leyó la orden y la lectura no se registró.
   */
  private async record(
    tenantId: string,
    target: HotelOrderReadTarget,
    plan: HotelOrderPlan,
  ): Promise<boolean> {
    if (plan.record === undefined && plan.subStatus === 'keep' && plan.hcn === undefined) {
      return true;
    }
    const { subStatus, providerStatus, hcn, hcnState } = target.snapshot;
    return this.store.recordRead(tenantId, target.orderId, {
      source: 'retrieve',
      at: Date.now(),
      ...(plan.record === undefined ? {} : { record: plan.record }),
      ...(plan.subStatus === 'keep' ? {} : { subStatus: plan.subStatus }),
      ...(plan.hcn === undefined ? {} : { hcn: plan.hcn }),
      expected: { subStatus, providerStatus, hcn, hcnState },
    });
  }

  /** Sin nombres, email ni texto del proveedor: códigos, localizadores y la cuenta por su id. */
  private async emit(
    tenantId: string,
    target: HotelOrderReadTarget,
    plan: HotelOrderPlan,
    view: HotelBookingView,
    actorUserId: string | undefined,
  ): Promise<void> {
    const base = {
      provider: target.provider,
      vertical: 'hotels',
      source: 'retrieve',
      providerBookingId: target.providerOrderId,
      ...(target.bookingReference === null ? {} : { bookingReference: target.bookingReference }),
    };
    for (const event of plan.events) {
      await this.audit.emit({
        eventType: event.type,
        tenantId,
        actorUserId: actorUserId ?? target.userId,
        aggregateType: 'order',
        aggregateId: target.orderId,
        payload: {
          ...base,
          ...hotelOrderEventFields(event, {
            providerAccountId: target.providerAccountId,
            providerOrderId: target.providerOrderId,
            view,
          }),
        },
      });
    }
  }

  /** Lo que necesita una persona queda en el log con el id de la orden y códigos, nada más. */
  private logActions(target: HotelOrderReadTarget, plan: HotelOrderPlan): void {
    for (const action of plan.actions) {
      if (
        action === 'human-review' ||
        action === 'urgent-human-review' ||
        action === 'voucher-alert'
      ) {
        this.logger.warn(
          `hotels.retrieve.${action} provider=${target.provider} order=${target.orderId}`,
        );
      }
    }
  }
}
