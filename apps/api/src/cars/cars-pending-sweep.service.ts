import { Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { OrderStatus } from '../database/database.types.js';
import { GovernancePaymentsService } from '../governance/governance-payments.service.js';
import { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { classifyCarReservationStatus } from './car-reservation-status.js';

const PROVIDER = 'agent-cars';

/** Lo que el barrido escribe cuando una reserva en espera se resuelve en AgentCars. */
export const CAR_RESERVATION_EVENTS = {
  /** La arrendadora confirmó una reserva en espera / on request: la orden pasa a `confirmed`. */
  confirmed: 'CarReservationConfirmed',
  /** Se canceló o venció en AgentCars (p. ej. en espera sin activar): la orden pasa a `cancelled`. */
  cancelled: 'CarReservationCancelled',
  /** La arrendadora no la aceptó: la orden pasa a `failed`. */
  rejected: 'CarReservationRejected',
} as const;

/**
 * Hasta cuándo se sigue mirando una orden pendiente. Una reserva en espera puede hacerse meses antes
 * del retiro, así que el límite no es sólo la antigüedad: también se deja de mirar cuando el retiro
 * ya pasó hace unos días (ahí AgentCars ya la resolvió o ya no importa).
 */
export const CAR_PENDING_MAX_AGE_DAYS = 120;
export const CAR_PENDING_PICKUP_GRACE_DAYS = 3;
/** Órdenes por tenant y corrida: un tenant con muchas no acapara el proveedor. */
export const CAR_PENDING_PER_TENANT_LIMIT = 50;
/** Pausa entre lecturas al proveedor: una a la vez y espaciadas, para no tumbar AgentCars. */
export const CAR_PENDING_CALL_GAP_MS = 500;

const DAY_MS = 24 * 60 * 60_000;

export interface CarPendingSweepReport {
  tenants: number;
  tenantsFailed: number;
  examined: number;
  confirmed: number;
  cancelled: number;
  rejected: number;
  /** Sigue en espera, o el estado no se entendió: la orden no se toca. */
  unchanged: number;
  /** La lectura al proveedor falló (no encontrada, red, credencial): se reintenta en la próxima. */
  failed: number;
}

interface PendingCarOrder {
  id: string;
  user_id: string;
  provider_order_id: string | null;
  passengers: unknown;
  search_criteria: unknown;
}

/**
 * Barrido de las órdenes de autos que quedaron `pending` (en espera / on request, A3 de
 * docs/platform/19). Lee cada una en AgentCars con la credencial del tenant (la que resuelve el
 * factory: la propia o la heredada del consolidador) y, si se resolvió, mueve la orden y emite el
 * domain event. Una lectura a la vez con pausa entre ellas; un tenant que falla no frena a los demás.
 *
 * `orders` tiene RLS forzada: se recorren los tenants (sin RLS) y cada uno se lee con `withTenant`,
 * como el barrido de post-venta. Cada escritura es un CAS sobre `status = 'pending'`: dos corridas a
 * la vez, o una cancelación manual en medio, no se pisan.
 */
@Injectable()
export class CarsPendingSweepService {
  private readonly logger = new Logger('CarsPendingSweep');

  constructor(
    private readonly db: DatabaseService,
    private readonly factory: AgentCarsProviderFactory,
    private readonly audit: AuditService,
    @Optional() private readonly governance?: GovernancePaymentsService,
  ) {}

  async sweep(now: number = Date.now()): Promise<CarPendingSweepReport> {
    const report: CarPendingSweepReport = {
      tenants: 0,
      tenantsFailed: 0,
      examined: 0,
      confirmed: 0,
      cancelled: 0,
      rejected: 0,
      unchanged: 0,
      failed: 0,
    };
    const tenants = await this.db.db.selectFrom('tenants').select('id').orderBy('id').execute();
    report.tenants = tenants.length;
    for (const { id } of tenants) {
      try {
        await this.sweepTenant(id, now, report);
      } catch (err) {
        report.tenantsFailed += 1;
        this.logger.warn(`cars.pending_sweep.tenant_failed tenant=${id} error=${errorName(err)}`);
      }
    }
    this.logger.log(
      `cars.pending_sweep examined=${report.examined} confirmed=${report.confirmed} cancelled=${report.cancelled} rejected=${report.rejected} unchanged=${report.unchanged} failed=${report.failed} tenantsFailed=${report.tenantsFailed}`,
    );
    return report;
  }

  async sweepTenant(tenantId: string, now: number, report: CarPendingSweepReport): Promise<void> {
    const since = new Date(now - CAR_PENDING_MAX_AGE_DAYS * DAY_MS);
    const pending = (await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('orders')
        .select(['id', 'user_id', 'provider_order_id', 'passengers', 'search_criteria'])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', PROVIDER)
        .where('status', '=', 'pending')
        .where(sql<Date>`created_at`, '>=', since)
        .orderBy('created_at', 'asc')
        .limit(CAR_PENDING_PER_TENANT_LIMIT)
        .execute(),
    )) as PendingCarOrder[];
    const due = pending.filter((o) => stillWorthChecking(o, now));
    if (due.length === 0) return;

    // Con el proveedor apagado para el tenant (kill-switch / gobierno), ni siquiera se lee.
    if (this.governance && !(await this.governance.isEnabled(tenantId, PROVIDER, ''))) return;

    const adapter = await this.factory.forTenant(tenantId);
    let first = true;
    for (const order of due) {
      const code = order.provider_order_id?.trim();
      const lastName = driverSurname(order.passengers);
      if (!code || !lastName) continue;
      if (!first) await this.pause(CAR_PENDING_CALL_GAP_MS);
      first = false;
      report.examined += 1;

      let providerStatus: string;
      try {
        providerStatus = (await adapter.myReservation({ lastName, confirmationCode: code })).status;
      } catch (err) {
        report.failed += 1;
        this.logger.warn(
          `cars.pending_sweep.read_failed tenant=${tenantId} order=${order.id} error=${errorName(err)}`,
        );
        continue;
      }

      const outcome = classifyCarReservationStatus(providerStatus);
      if (outcome === 'pending' || outcome === 'unknown') {
        report.unchanged += 1;
        continue;
      }
      const next: OrderStatus =
        outcome === 'confirmed' ? 'confirmed' : outcome === 'cancelled' ? 'cancelled' : 'failed';
      const moved = await this.db.withTenant(tenantId, (trx) =>
        trx
          .updateTable('orders')
          .set({ status: next })
          .where('id', '=', order.id)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst(),
      );
      // Otro (una cancelación manual, otra corrida) ya la movió: no se repite el evento.
      if (!moved) {
        report.unchanged += 1;
        continue;
      }
      report[outcome] += 1;
      await this.audit.emit({
        eventType: CAR_RESERVATION_EVENTS[outcome],
        tenantId,
        actorUserId: null,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          provider: PROVIDER,
          confirmationCode: code,
          previous: 'pending',
          current: next,
          providerStatus: providerStatus.slice(0, 60),
          source: 'pending-sweep',
        },
      });
    }
  }

  /** Protegido para que las suites no duerman. */
  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function stillWorthChecking(order: PendingCarOrder, now: number): boolean {
  const criteria = asRecord(order.search_criteria);
  const pickUp = typeof criteria?.['pickUpDate'] === 'string' ? criteria['pickUpDate'] : '';
  const at = Date.parse(`${pickUp}T00:00:00Z`);
  // Sin fecha legible se sigue mirando: el límite de antigüedad igual la saca.
  if (Number.isNaN(at)) return true;
  return at + CAR_PENDING_PICKUP_GRACE_DAYS * DAY_MS >= now;
}

function driverSurname(passengers: unknown): string | undefined {
  let parsed = passengers;
  if (typeof passengers === 'string') {
    try {
      parsed = JSON.parse(passengers) as unknown;
    } catch {
      return undefined;
    }
  }
  const list: unknown[] = Array.isArray(parsed) ? parsed : [];
  const first = asRecord(list[0]);
  const surname = first?.['surname'];
  return typeof surname === 'string' && surname.trim() ? surname.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}
