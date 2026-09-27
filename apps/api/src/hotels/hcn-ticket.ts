import { sql, type Transaction } from 'kysely';
import type { DB, ProviderStatusSource } from '../database/database.types.js';

/**
 * El cierre automático de la tarea de operaciones `hcn-ticket` (docs/tbo/04 §8.6; 08 RF-27).
 *
 * La tarea existe para que una persona consiga el HCN por el canal comercial. Si el número llega
 * después por cualquier lectura de la reserva (la consulta manual, la conciliación, la
 * cancelación o el propio seguimiento), la tarea pierde su objeto: se cierra en la MISMA
 * transacción que guarda el HCN. Así nadie persigue un número que la plataforma ya tiene, y un
 * fallo entre las dos escrituras no deja una sin la otra.
 *
 * La tarea no se borra ni se reescribe: pasa a `success` y a su `result` se le agrega
 * `resolution`, con el motivo, quién leyó el HCN y cuándo. Lo que la abrió (`reason`, prioridad,
 * localizadores) queda como estaba. El HCN no se copia: vive en la fila de seguimiento.
 */

/** Por qué se cerró sola. Vocabulario cerrado, como el `reason` con que se abrió. */
export const HCN_TICKET_RESOLUTION_REASONS = ['hcn-received'] as const;
export type HcnTicketResolutionReason = (typeof HCN_TICKET_RESOLUTION_REASONS)[number];

export interface HcnTicketResolution {
  readonly reason: HcnTicketResolutionReason;
  /** Qué lectura trajo el HCN. */
  readonly source: ProviderStatusSource;
  /** Epoch ms de esa lectura. */
  readonly at: number;
}

/**
 * Cierra las tareas `hcn-ticket` pendientes de la orden, dentro de `trx` (que ya tiene el tenant
 * fijado). Devuelve cuántas cerró; `0` es lo normal: casi ningún HCN llega con la tarea abierta.
 */
export async function resolvePendingHcnTickets(
  trx: Transaction<DB>,
  tenantId: string,
  orderId: string,
  resolution: HcnTicketResolution,
): Promise<number> {
  const patch = JSON.stringify({
    resolution: {
      by: 'system',
      reason: resolution.reason,
      source: resolution.source,
      at: new Date(resolution.at).toISOString(),
    },
  });
  const result = await trx
    .updateTable('order_operations')
    .set({ status: 'success', result: sql`order_operations.result || ${patch}::jsonb` })
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('type', '=', 'hcn-ticket')
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
