import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { BrandingService } from '../branding/branding.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { ticketingDeadlineAlertEmailHtml } from '../mail/templates.js';
import { isTestSelectedOffer } from '../providers/provider-environment.js';
import {
  DEADLINE_ALERT_MAX_ATTEMPTS,
  deadlineAlertClock,
  dueDeadlineAlert,
  flightRouteOf,
  passengerFirstNames,
  reservasLink,
} from './flight-deadline-alert.plan.js';
import {
  FlightDeadlineAlertStore,
  type DeadlineAlertClaim,
  type DueDeadlineAlert,
} from './flight-deadline-alert.store.js';
import { ORDER_EVENTS } from './order-events.js';
import { countryTimeZone } from './ticketing-deadline-clock.js';

/** Lo que dejó el barrido de UN tenant. */
export interface DeadlineAlertSweepReport {
  /** Órdenes con plazo dentro de las 24 h y algún aviso pendiente. */
  examined: number;
  /** Avisos tomados con el CAS de 0084 en esta corrida. */
  claimed: number;
  /** De ésos, cuántos salieron por correo (y se cerraron con su `domain_event`). */
  mailed: number;
  /** Cerrados sin correo: el vendedor ya no está activo, o se agotaron los intentos. */
  unmailed: number;
  /** El correo falló y el aviso se soltó: la próxima corrida lo reintenta (0085). */
  retrying: number;
  /** No tocaba todavía, u otra corrida o una lectura se adelantó. */
  skipped: number;
  /** El CAS, la liberación o el cierre fallaron por la base. */
  failed: number;
}

export function emptyDeadlineAlertReport(): DeadlineAlertSweepReport {
  return {
    examined: 0,
    claimed: 0,
    mailed: 0,
    unmailed: 0,
    retrying: 0,
    skipped: 0,
    failed: 0,
  };
}

/** Cómo terminó el correo de un aviso. */
type NotifyOutcome = 'mailed' | 'no-recipient' | 'mail-failed';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : 'UnknownError';
}

/**
 * El aviso de que vence el plazo de emisión de una reserva de vuelo confirmada y sin tiquete
 * (SAB-14). Lo ejecuta el barrido de post-venta cada 15 minutos, tenant por tenant.
 *
 * A las 24 h y a las 2 h del plazo: un correo al vendedor que hizo la reserva y un
 * `OrderTicketingDeadlineApproaching`. A lo sumo un correo por orden, umbral e instante del plazo:
 * el CAS de 0084 toma el aviso ANTES del correo y la marca es el candado, así que ninguna otra
 * corrida ni réplica lo manda mientras tanto. Si el correo sale —o no hay a quién escribirle— el
 * aviso se cierra con su evento; si falla, se suelta y la próxima corrida lo reintenta, hasta
 * {@link DEADLINE_ALERT_MAX_ATTEMPTS} intentos (0085). Un proceso que muere entre tomarlo y
 * cerrarlo lo deja tomado: ese correo se puede perder, nunca duplicar; la pantalla lo sigue
 * mostrando.
 *
 * La reserva no se cancela sola: cuando vence, la aerolínea la cancela y la próxima lectura lo
 * refleja. Una reserva de prueba también avisa —es un aviso interno, no al pasajero—, marcada como
 * prueba.
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
      let claim: DeadlineAlertClaim | null;
      try {
        claim = await this.store.claim(
          tenantId,
          order.orderId,
          threshold,
          order.deadlineAt,
          new Date(now),
        );
      } catch (error) {
        report.failed += 1;
        this.logger.warn(
          `flights.deadline_alert.claim_failed tenant=${tenantId} order=${order.orderId} threshold=${threshold} error=${errorName(error)}`,
        );
        continue;
      }
      if (claim === null) {
        report.skipped += 1;
        continue;
      }
      report.claimed += 1;
      const testContent = isTestSelectedOffer(order.selectedOffer);
      const outcome = await this.notify(tenantId, order, claim, now, testContent);
      const attempt = claim.failures + 1;

      if (outcome === 'mail-failed' && attempt < DEADLINE_ALERT_MAX_ATTEMPTS) {
        try {
          await this.store.release(tenantId, order.orderId, claim);
          report.retrying += 1;
        } catch (error) {
          // La marca queda tomada: este aviso ya no sale por correo. La pantalla lo sigue mostrando.
          report.failed += 1;
          this.logger.warn(
            `flights.deadline_alert.release_failed tenant=${tenantId} order=${order.orderId} threshold=${threshold} error=${errorName(error)}`,
          );
        }
        this.logger.warn(
          `flights.deadline_alert.mail_retry tenant=${tenantId} order=${order.orderId} threshold=${threshold} attempt=${attempt}`,
        );
        continue;
      }

      try {
        await this.store.settle(tenantId, order.orderId, claim, outcome === 'mail-failed', (trx) =>
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
              outcome,
              attempts: attempt,
            },
          }),
        );
      } catch (error) {
        report.failed += 1;
        this.logger.warn(
          `flights.deadline_alert.settle_failed tenant=${tenantId} order=${order.orderId} threshold=${threshold} outcome=${outcome} error=${errorName(error)}`,
        );
      }
      if (outcome === 'mailed') report.mailed += 1;
      else report.unmailed += 1;
      this.logger.log(
        `flights.deadline_alert tenant=${tenantId} order=${order.orderId} provider=${order.provider} threshold=${threshold} outcome=${outcome} attempt=${attempt} test=${String(testContent)}`,
      );
    }
    return report;
  }

  /**
   * El correo al vendedor. Nunca lanza. `no-recipient` es definitivo (no hay a quién escribirle);
   * `mail-failed` —el envío, el transporte o una lectura que falló— se puede reintentar.
   */
  private async notify(
    tenantId: string,
    order: DueDeadlineAlert,
    claim: DeadlineAlertClaim,
    now: number,
    testContent: boolean,
  ): Promise<NotifyOutcome> {
    try {
      const recipient = await this.store.recipientFor(tenantId, order.userId);
      if (recipient.email === null) return 'no-recipient';
      const brand = await this.branding.resolve(tenantId);
      const { route, departureDate } = flightRouteOf(order.searchCriteria);
      const mail = ticketingDeadlineAlertEmailHtml({
        orderNumber: order.orderNumber,
        pnr: order.pnr,
        threshold: claim.threshold,
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
      const sent = await this.mailer.sendToTenant(tenantId, {
        to: recipient.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      return sent ? 'mailed' : 'mail-failed';
    } catch (error) {
      this.logger.warn(
        `flights.deadline_alert.mail_failed tenant=${tenantId} order=${order.orderId} threshold=${claim.threshold} error=${errorName(error)}`,
      );
      return 'mail-failed';
    }
  }
}
