import { Injectable } from '@nestjs/common';
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

/**
 * Audit log append-only (`domain_events`). Registra acciones sensibles para trazabilidad.
 * `emit` es best-effort: un fallo de auditoría NUNCA debe romper la operación de negocio.
 */
@Injectable()
export class AuditService {
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
          meta: JSON.stringify({ requestId: ctx?.requestId ?? null }),
        })
        .execute();
    } catch (err) {
      // No propagar: la auditoría no debe tumbar la acción principal.
      console.warn(`[audit] failed to emit ${event.eventType}:`, (err as Error).message);
    }
  }
}
