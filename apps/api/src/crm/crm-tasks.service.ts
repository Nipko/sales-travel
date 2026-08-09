import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { currentContext } from '../request-context/request-context.js';
import type { CrmTaskKind } from './crm.schemas.js';

export interface CrmTaskRow {
  id: string;
  tenant_id: string;
  opportunity_id: string | null;
  customer_id: string | null;
  assigned_user_id: string | null;
  title: string;
  notes: string | null;
  kind: CrmTaskKind;
  due_at: Date;
  completed_at: Date | null;
  created_at: Date;
}

export interface CreateTaskInput {
  opportunityId?: string | null;
  customerId?: string | null;
  assignedUserId?: string | null;
  title: string;
  notes?: string | null;
  kind?: CrmTaskKind;
  dueAt: string | Date;
}

/**
 * Tareas y recordatorios del pipeline.
 *
 * El CRM no tenía ningún mecanismo de seguimiento: una oportunidad podía quedarse meses
 * en "Cotización enviada" sin que nadie se enterara. Para una agencia el seguimiento ES
 * el trabajo — la venta se pierde por no llamar a tiempo, no por no cotizar.
 */
@Injectable()
export class CrmTasksService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, input: CreateTaskInput): Promise<CrmTaskRow> {
    const userId = currentContext()?.userId ?? null;
    return this.db.withRequestContext({ userId: userId ?? undefined, tenantId }, async (trx) => {
      const row = await trx
        .insertInto('crm_tasks')
        .values({
          tenant_id: tenantId,
          opportunity_id: input.opportunityId ?? null,
          customer_id: input.customerId ?? null,
          // Sin destinatario explícito, la tarea es de quien la crea: una tarea sin
          // dueño no la mira nadie.
          assigned_user_id: input.assignedUserId ?? userId,
          title: input.title,
          notes: input.notes ?? null,
          kind: input.kind ?? 'FOLLOW_UP',
          due_at: new Date(input.dueAt),
          created_by_user_id: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row;
    });
  }

  /**
   * Tareas pendientes ordenadas por vencimiento: primero lo vencido.
   * La RLS ya acota a las propias si el usuario no es admin del nodo.
   */
  async listPending(tenantId: string, limit = 50): Promise<CrmTaskRow[]> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const rows = await trx
        .selectFrom('crm_tasks')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('completed_at', 'is', null)
        .orderBy('due_at')
        .limit(Math.min(200, Math.max(1, limit)))
        .execute();
      return rows;
    });
  }

  async complete(tenantId: string, taskId: string): Promise<CrmTaskRow | undefined> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const row = await trx
        .updateTable('crm_tasks')
        .set({ completed_at: new Date() })
        .where('id', '=', taskId)
        .where('tenant_id', '=', tenantId)
        .returningAll()
        .executeTakeFirst();
      return row;
    });
  }

  /**
   * Traspasa la cartera de un vendedor a otro.
   *
   * Al dar de baja a alguien, sus oportunidades y tareas quedaban asignadas a un usuario
   * suspendido: invisibles para el resto del equipo por la RLS por vendedor, o sea que la
   * cartera se perdía de vista justo cuando había que atenderla.
   */
  async reassignPortfolio(
    tenantId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<{ opportunities: number; tasks: number }> {
    const res = await sql<{ opportunities: number; tasks: number }>`
      SELECT * FROM reassign_portfolio(${tenantId}::uuid, ${fromUserId}::uuid, ${toUserId}::uuid)
    `.execute(this.db.db);
    return res.rows[0] ?? { opportunities: 0, tasks: 0 };
  }
}
