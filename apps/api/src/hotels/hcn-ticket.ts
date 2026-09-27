import { sql, type Transaction } from 'kysely';
import type { DB, ProviderStatusSource } from '../database/database.types.js';

/**
 * El cierre automático de la tarea de operaciones `hcn-ticket` (docs/tbo/04 §8.6; 08 RF-27).
 *
 * La tarea existe para que una persona consiga el HCN por el canal comercial. Pierde su objeto en
 * dos casos, y en los dos se cierra en la MISMA transacción que lo registra, para que un fallo
 * entre las dos escrituras no deje una sin la otra:
 *
 * - `hcn-received`: el número llega después por cualquier lectura de la reserva (la consulta
 *   manual, la conciliación, la cancelación o el propio seguimiento). Nadie persigue un número que
 *   la plataforma ya tiene.
 * - `order-cancelled`: la orden pasa a `cancelled` (la cancelación, su verificación o la
 *   conciliación). Una reserva cancelada no va a tener HCN, y la tarea abierta mandaría a alguien a
 *   pedirle al proveedor el número de una reserva que ya no existe.
 *
 * La tarea no se borra ni se reescribe: pasa a `success` y a su `result` se le agrega
 * `resolution`, con el motivo, qué lectura lo decidió y cuándo. Lo que la abrió (`reason`,
 * prioridad, localizadores) queda como estaba. El HCN no se copia: vive en la fila de seguimiento.
 * Sólo se tocan las tareas `pending`: repetir el cierre no cambia nada.
 */

/** Por qué se cerró sola. Vocabulario cerrado, como el `reason` con que se abrió. */
export const HCN_TICKET_RESOLUTION_REASONS = ['hcn-received', 'order-cancelled'] as const;
export type HcnTicketResolutionReason = (typeof HCN_TICKET_RESOLUTION_REASONS)[number];

export interface HcnTicketResolution {
  readonly reason: HcnTicketResolutionReason;
  /** Qué lectura o camino lo decidió: la que trajo el HCN, o el que cerró la orden. */
  readonly source: ProviderStatusSource;
  /** Epoch ms de esa observación. */
  readonly at: number;
}

/**
 * Cierra las tareas `hcn-ticket` pendientes de la orden, dentro de `trx` (que ya tiene el tenant
 * fijado). Devuelve cuántas cerró; `0` es lo normal: casi ninguna orden llega a tener la tarea.
 *
 * Quien llama la ejecuta DESPUÉS de escribir la fila de seguimiento: esa escritura toma el lock de
 * la fila, así que una tarea que el seguimiento abrió en paralelo ya está confirmada cuando este
 * UPDATE toma su foto, y se cierra también.
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
