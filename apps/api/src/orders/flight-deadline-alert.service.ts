import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { BrandingService } from '../branding/branding.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { ticketingDeadlineAlertEmailHtml } from '../mail/templates.js';
import { isTestSelectedOffer } from '../providers/provider-environment.js';
import {
  deadlineAlertClock,
  dueDeadlineAlert,
  flightRouteOf,
  passengerFirstNames,
  reservasLink,
  type DeadlineAlertThreshold,
} from './flight-deadline-alert.plan.js';
import { FlightDeadlineAlertStore, type DueDeadlineAlert } from './flight-deadline-alert.store.js';
import { ORDER_EVENTS } from './order-events.js';
import { countryTimeZone } from './ticketing-deadline-clock.js';

/** Lo que dejó el barrido de UN tenant. */
export interface DeadlineAlertSweepReport {
  /** Órdenes con plazo dentro de las 24 h y algún aviso pendiente. */
  examined: number;
  /** Avisos marcados (columna de 0084 + `domain_event`). */
  alerted: number;
  /** De ésos, cuántos salieron por correo. */
  mailed: number;
  /** Marcados sin correo: el vendedor ya no está activo, no hay transporte o el envío falló. */
  unmailed: number;
  /** No tocaba todavía, u otra corrida o una lectura se adelantó. */
  skipped: number;
  /** El CAS falló por la base: la orden se vuelve a mirar en la próxima corrida. */
  failed: number;
}

export function emptyDeadlineAlertReport(): DeadlineAlertSweepReport {
  return { examined: 0, alerted: 0, mailed: 0, unmailed: 0, skipped: 0, failed: 0 };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : 'UnknownError';
}

/**
 * El aviso de que vence el plazo de emisión de una reserva de vuelo confirmada y sin tiquete
 * (SAB-14). Lo ejecuta el barrido de post-venta cada 15 minutos, tenant por tenant.
 *
 * A las 24 h y a las 2 h del plazo: un `OrderTicketingDeadlineApproaching` y un correo al vendedor
 * que hizo la reserva. Uno por orden, umbral e instante del plazo: el CAS de 0084 marca la columna
 * en la misma transacción que el evento, antes del correo. La reserva no se cancela sola: cuando
 * vence, la aerolínea la cancela y la próxima lectura lo refleja.
 *
 * Una reserva de prueba también avisa —es un aviso interno, no al pasajero—, marcada como prueba.
 *
 * Neutral de proveedor: lee el instante que dejó la lectura de la reserva (0082/0084).
 */
@Injectable()
export class FlightDeadlineAlertService {
  private readonly logger = new Logger('FlightDeadlineAlert');

  constructor(
    private readonly store: FlightDeadlineAlertStore,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly branding: BrandingService,
  ) {}

  async sweepTenant(tenantId: string, now: number = Date.now()): Promise<DeadlineAlertSweepReport> {
    const report = emptyDeadlineAlertReport();
    const due = await this.store.listDue(tenantId, new Date(now));
    for (const order of due) {
      report.examined += 1;
      const threshold = dueDeadlineAlert(order, now);
      if (threshold === null) {
        report.skipped += 1;
        continue;
      }
      const testContent = isTestSelectedOffer(order.selectedOffer);
      let claimed: boolean;
      try {
        claimed = await this.store.claim(
          tenantId,
          order.orderId,
          threshold,
          order.deadlineAt,
          new Date(now),
          (trx) =>
            this.audit.emitWithin(trx, {
              eventType: ORDER_EVENTS.ticketingDeadlineApproaching,
              tenantId,
              aggregateType: 'order',
              aggregateId: order.orderId,
              payload: {
                provider: order.provider,
                threshold,
                deadlineAt: order.deadlineAt.toISOString(),
                deadlineZone: order.deadlineZone,
                testContent,
                walletHold: order.walletHold,
              },
            }),
        );
      } catch (error) {
        report.failed += 1;
        this.logger.warn(
          `flights.deadline_alert.claim_failed tenant=${tenantId} order=${order.orderId} threshold=${threshold} error=${errorName(error)}`,
        );
        continue;
      }
      if (!claimed) {
        report.skipped += 1;
        continue;
      }
      report.alerted += 1;
      const mailed = await this.notify(tenantId, order, threshold, now, testContent);
      if (mailed) report.mailed += 1;
      else report.unmailed += 1;
      this.logger.log(
        `flights.deadline_alert tenant=${tenantId} order=${order.orderId} provider=${order.provider} threshold=${threshold} mailed=${String(mailed)} test=${String(testContent)}`,
      );
    }
    return report;
  }

  /** El correo al vendedor. Nunca lanza: el aviso ya quedó marcado y en `domain_events`. */
  private async notify(
    tenantId: string,
    order: DueDeadlineAlert,
    threshold: DeadlineAlertThreshold,
    now: number,
    testContent: boolean,
  ): Promise<boolean> {
    try {
      const recipient = await this.store.recipientFor(tenantId, order.userId);
      if (recipient.email === null) return false;
      const brand = await this.branding.resolve(tenantId);
      const { route, departureDate } = flightRouteOf(order.searchCriteria);
      const mail = ticketingDeadlineAlertEmailHtml({
        orderNumber: order.orderNumber,
        pnr: order.pnr,
        threshold,
        route,
        departureDate,
        firstNames: passengerFirstNames(order.passengers),
        clock: deadlineAlertClock({
          at: order.deadlineAt,
          now,
          officeTimeZone: order.officeTimeZone,
          agencyTimeZone: countryTimeZone(recipient.countryCode) ?? null,
        }),
        walletHeld: order.walletHold !== null,
        link: reservasLink(order.orderId, process.env['APP_WEB_URL']),
        brand,
        testContent,
      });
      return await this.mailer.sendToTenant(tenantId, {
        to: recipient.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
    } catch (error) {
      this.logger.warn(
        `flights.deadline_alert.mail_failed tenant=${tenantId} order=${order.orderId} threshold=${threshold} error=${errorName(error)}`,
      );
      return false;
    }
  }
}
