import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CANCEL_UNVERIFIED_MESSAGE, CANCEL_UNVERIFIED_POLICY } from './cancel-retry-policy.js';
import { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import type { HotelCancelTrackingWrite } from './hotel-order-cancellation.store.js';
import { ORDER_EVENTS } from './order-events.js';
import { StaleCancelClaimStore, type StaleCancelClaim } from './stale-cancel-claim.store.js';

/**
 * Los claims de cancelación que un proceso dejó en vuelo al morir (HARD-1).
 *
 * El claim (`order_operations` `cancel` en `pending`, 0037) se toma ANTES de llamar al proveedor y
 * lo cierra la propia cancelación al terminar. Si el proceso muere en el medio —un deploy, un OOM,
 * la cancelación de hotel que siguió después de responder "Cancelación en curso"— nadie lo cierra:
 * la orden queda `pending` y toda cancelación nueva choca con él, sin que ninguna persona se entere.
 *
 * Vencido el umbral, el barrido lo cierra como `UNVERIFIED`, exactamente el estado que deja un
 * timeout del write: no se sabe si el proveedor lo aplicó, así que NUNCA se vuelve a mandar. Se
 * escala a una persona y, en hoteles, además se abre `verify-cancellation`, que relee la reserva y
 * la cierra en la dirección segura (PV-B).
 *
 * **Vuelos y autos** tienen la misma limitación y el mismo remedio es seguro para ellos: el cierre
 * no manda nada al proveedor y deja la orden `pending` con la operación `UNVERIFIED`, que es lo que
 * ya deja un timeout de su write y lo que su cola humana sabe conciliar. Lo único que no tienen es
 * la lectura automática (`verify-cancellation` es de hoteles): les queda el escalado.
 *
 * Si el dueño del claim sigue vivo y termina después del corte, su cierre choca con el CAS de la
 * operación (`status = 'pending'`) y no escribe nada: lo que el proveedor contestó lo recupera la
 * verificación (hoteles) o la persona (el resto). Por eso el umbral está muy por encima de lo que
 * dura una cancelación.
 */

/**
 * Cuánto puede estar en vuelo un claim antes de darlo por perdido. Una cancelación de TBO en el peor
 * caso —tres lecturas previas de 30 s con su cupo, el Cancel de 60 s con el suyo y la lectura
 * posterior— ronda los 6 minutos; las de vuelos (LATAM, Sabre), menos. 15 minutos deja el doble de
 * margen y coincide con la cadencia del barrido: un claim perdido se escala entre 15 y 30 minutos
 * después de tomado.
 */
export const STALE_CANCEL_CLAIM_MS = 15 * 60_000;

/** Cuántos claims de un tenant revisa el barrido por corrida: el resto, en la siguiente. */
export const STALE_CANCEL_CLAIM_SWEEP_LIMIT = 25;

export interface StaleCancelClaimSweepReport {
  examined: number;
  /** Vencidos: la operación quedó `UNVERIFIED` y se escaló. */
  expired: number;
  /** El claim terminó (o lo tomó otro) entre la lectura y el cierre: no se escribió nada. */
  skipped: number;
  failed: number;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

@Injectable()
export class StaleCancelClaimService {
  private readonly logger = new Logger(StaleCancelClaimService.name);

  constructor(
    private readonly store: StaleCancelClaimStore,
    private readonly audit: AuditService,
    private readonly hotels: HotelOrderCancellationService,
  ) {}

  /** Los claims vencidos de un tenant. Uno que falla no frena a los demás. */
  async sweepTenant(
    tenantId: string,
    now: number = Date.now(),
  ): Promise<StaleCancelClaimSweepReport> {
    const claimedBefore = now - STALE_CANCEL_CLAIM_MS;
    const stale = await this.store.listStale(tenantId, {
      claimedBefore,
      limit: STALE_CANCEL_CLAIM_SWEEP_LIMIT,
    });
    const report: StaleCancelClaimSweepReport = { examined: 0, expired: 0, skipped: 0, failed: 0 };
    for (const claim of stale) {
      report.examined += 1;
      try {
        report[(await this.expire(tenantId, claim, claimedBefore, now)) ? 'expired' : 'skipped'] +=
          1;
      } catch (err) {
        report.failed += 1;
        this.logger.warn(
          `orders.cancel.stale_claim_failed provider=${claim.provider} order=${claim.orderId} error=${errorName(err)}`,
        );
      }
    }
    return report;
  }

  private async expire(
    tenantId: string,
    claim: StaleCancelClaim,
    claimedBefore: number,
    now: number,
  ): Promise<boolean> {
    const hotel = this.hotels.handles(claim.provider);
    const tracking: HotelCancelTrackingWrite | undefined = hotel
      ? this.hotels.thrownTracking(CANCEL_UNVERIFIED_POLICY, now)
      : undefined;
    const vertical = hotel ? { vertical: 'hotels', verifyScheduled: true } : {};
    const expired = await this.store.expire(
      tenantId,
      claim,
      {
        claimedBefore,
        lastError: CANCEL_UNVERIFIED_MESSAGE,
        result: {
          ...vertical,
          staleClaim: true,
          status: 'failed',
          ...CANCEL_UNVERIFIED_POLICY,
          ...(claim.priorStatus === undefined ? {} : { priorOrderStatus: claim.priorStatus }),
        },
      },
      tracking === undefined
        ? undefined
        : (trx) => this.hotels.writeTracking(trx, tenantId, claim.orderId, tracking),
    );
    if (!expired) return false;

    const actorUserId = claim.actorUserId ?? claim.userId;
    const base = { provider: claim.provider, ...vertical, staleClaim: true };
    await this.audit.emit({
      eventType: ORDER_EVENTS.cancelled,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: claim.orderId,
      payload: {
        ...base,
        success: false,
        outcome: CANCEL_UNVERIFIED_POLICY.outcome,
        retryable: false,
        reconciliationRequired: true,
      },
    });
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: claim.orderId,
      payload: {
        ...base,
        reason: 'cancellation-unverified',
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
    if (tracking !== undefined) {
      await this.hotels.afterThrow(
        tenantId,
        { id: claim.orderId, provider: claim.provider },
        tracking,
        actorUserId,
      );
    }
    this.logger.warn(
      `orders.cancel.stale_claim_expired provider=${claim.provider} order=${claim.orderId}`,
    );
    return true;
  }
}
