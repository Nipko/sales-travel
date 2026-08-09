import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { currentContext } from '../request-context/request-context.js';

export interface AuditEvent {
  eventType: string;
  tenantId?: string | null;
  actorUserId?: string | null;
  aggregateType?: string;
  aggregateId?: string;
  /** NUNCA incluir secretos/credenciales/PII sensible. */
  payload?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  occurredAt: Date;
  eventType: string;
  tenantId: string | null;
  tenantName: string | null;
  actorEmail: string | null;
  aggregateType: string | null;
  payload: Record<string, unknown>;
}

/**
 * Audit log append-only (`domain_events`). Registra acciones sensibles para trazabilidad.
 * `emit` es best-effort: un fallo de auditoría NUNCA debe romper la operación de negocio.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  async emit(event: AuditEvent): Promise<void> {
    try {
      const ctx = currentContext();
      await this.db.db
        .insertInto('domain_events')
        .values({
          tenant_id: event.tenantId ?? ctx?.tenantId ?? null,
          actor_user_id: event.actorUserId ?? ctx?.userId ?? null,
          event_type: event.eventType,
          aggregate_type: event.aggregateType ?? null,
          aggregate_id: event.aggregateId ?? null,
          payload: JSON.stringify(event.payload ?? {}),
          meta: JSON.stringify({
            requestId: ctx?.requestId ?? null,
            // Sin IP ni user-agent, un audit log de seguridad no sirve para investigar
            // un incidente: no se puede distinguir el acceso legítimo del robado.
            ip: ctx?.ip ?? null,
            userAgent: ctx?.userAgent ?? null,
            sessionId: ctx?.sessionId ?? null,
          }),
        })
        .execute();
    } catch (err) {
      // No propagar: la auditoría no debe tumbar la acción principal.
      this.logger.warn(`no se pudo registrar ${event.eventType}: ${(err as Error).message}`);
    }
  }

  /**
   * Eventos recientes de toda la red bajo `rootTenantId` (subárbol por path). La AUTORIZACIÓN
   * (que el usuario gestione el root) se valida en el controlador antes de llamar.
   */
  async networkAudit(rootTenantId: string, limit = 50): Promise<AuditEntry[]> {
    const lim = Math.min(200, Math.max(1, Math.trunc(limit)));
    const ctx = currentContext();
    const query = sql<{
      id: string;
      occurred_at: Date;
      event_type: string;
      tenant_id: string | null;
      tenant_name: string | null;
      actor_email: string | null;
      aggregate_type: string | null;
      payload: unknown;
    }>`
      SELECT e.id, e.occurred_at, e.event_type, e.tenant_id,
             t.name AS tenant_name, u.email AS actor_email, e.aggregate_type, e.payload
      FROM domain_events e
      JOIN tenants t    ON t.id   = e.tenant_id
      JOIN tenants root ON root.id = ${rootTenantId}::uuid
      LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE t.path OPERATOR(public.<@) root.path
      ORDER BY e.occurred_at DESC
      LIMIT ${lim}
    `;

    // Desde 0029_rls_hardening, domain_events tiene RLS por subárbol
    // (domain_events_subtree_read), que se evalúa contra app.current_user_id. Sin
    // contexto de request esta consulta devolvería cero filas EN SILENCIO en vez de
    // fallar, así que setear el GUC es obligatorio, no una optimización.
    const res = await this.db.withRequestContext(
      { userId: ctx?.userId, tenantId: rootTenantId },
      (trx) => query.execute(trx),
    );

    return res.rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      eventType: r.event_type,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      actorEmail: r.actor_email,
      aggregateType: r.aggregate_type,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }
}
