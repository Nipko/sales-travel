import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../database/database.types.js';

export interface CrmReferences {
  customerId?: string | null;
  opportunityId?: string | null;
  packageQuotationId?: string | null;
  orderId?: string | null;
  assignedUserId?: string | null;
}

/**
 * Lo que una fila del CRM (oportunidad, interacción, tarea) o un paquete referencia tiene que ser
 * del nodo activo. Las FK de esas columnas apuntan a la tabla sin mirar el tenant (`REFERENCES
 * customers(id)`), y la base las valida por encima de la RLS: sin esta comprobación una agencia
 * podía colgar notas, tareas u oportunidades del cliente de otra (QA-H-31).
 *
 * Corre dentro de la transacción del pedido, con su contexto de RLS: «visible» quiere decir lo
 * mismo que en un GET. Un id ajeno se responde igual que uno inexistente, para no confirmar que
 * existe en otra agencia.
 */
export async function assertCrmReferences(
  trx: Transaction<DB>,
  tenantId: string,
  refs: CrmReferences,
): Promise<void> {
  const fields: { field: string; message: string }[] = [];
  const visible = async (
    table: 'customers' | 'crm_opportunities' | 'package_quotations' | 'orders',
    id: string,
  ) =>
    (await trx.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst()) !==
    undefined;

  if (refs.customerId && !(await visible('customers', refs.customerId)))
    fields.push({ field: 'customerId', message: 'El cliente no existe en esta agencia.' });
  if (refs.opportunityId && !(await visible('crm_opportunities', refs.opportunityId)))
    fields.push({ field: 'opportunityId', message: 'La oportunidad no existe en esta agencia.' });
  if (refs.packageQuotationId && !(await visible('package_quotations', refs.packageQuotationId)))
    fields.push({ field: 'packageQuotationId', message: 'El paquete no existe en esta agencia.' });
  if (refs.orderId && !(await visible('orders', refs.orderId)))
    fields.push({ field: 'orderId', message: 'La reserva no existe en esta agencia.' });
  if (refs.assignedUserId) {
    const miembro = await trx
      .selectFrom('memberships')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', refs.assignedUserId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!miembro)
      fields.push({
        field: 'assignedUserId',
        message: 'Esa persona no es parte del equipo de esta agencia.',
      });
  }

  if (fields.length > 0)
    throw new BadRequestException({
      error: 'Bad Request',
      message: fields.map((f) => f.message).join(' '),
      reason: 'FOREIGN_REFERENCE',
      fields,
    });
}

/**
 * Un vendedor sólo se asigna a sí mismo o deja la oportunidad en la cola: la RLS de 0031 rechaza el
 * resto, y sin esta comprobación el rechazo salía como 500. Asignar a otro es de un admin del nodo.
 */
export async function assertCanAssign(
  trx: Transaction<DB>,
  actorUserId: string | undefined,
  assignedUserId: string | null | undefined,
): Promise<void> {
  if (!assignedUserId || assignedUserId === actorUserId) return;
  const { rows } = await sql<{ admin: boolean }>`
    SELECT is_admin_of_current_tenant() AS admin
  `.execute(trx);
  if (rows[0]?.admin === true) return;
  throw new ForbiddenException({
    error: 'Forbidden',
    message: 'Sólo un administrador de la agencia asigna oportunidades a otra persona.',
    reason: 'CRM_ASSIGN_REQUIRES_ADMIN',
  });
}
