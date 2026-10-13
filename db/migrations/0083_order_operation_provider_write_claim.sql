-- 0083_order_operation_provider_write_claim.sql
-- Como máximo UNA escritura pendiente en el proveedor por orden y tenant: emitir los tiquetes,
-- modificar la reserva o agregarle servicios.
--
-- Emitir es la primera operación de post-venta que mueve dinero irreversible: un segundo
-- `fulfillFlightTickets` sobre la misma reserva es un segundo juego de tiquetes cobrado por BSP. El
-- pedido corre fuera del request, en la cola de post-venta, y BullMQ olvida el `jobId` de un job
-- terminado (`removeOnComplete`), así que el `jobId` no protege de un doble clic ni de dos pestañas:
-- la garantía es este índice más el write-ahead de la operación (`result.stage = 'sent'` antes de
-- llamar al proveedor; un job que lo encuentra sólo relee la reserva, nunca reemite).
--
-- Es el mismo CAS que 0037 hace para la cancelación, para las escrituras que no son cancelar. Van
-- juntas en un índice y no en uno por tipo porque se pisan entre sí: emitir mientras se agregan
-- servicios, o modificar mientras se emite, deja la reserva y los tiquetes descuadrados. Que una
-- cancelación no corra con una de éstas en curso lo comprueba la API dentro de la transacción del
-- claim de cancelación (`OrdersService`), después de bloquear la fila de la orden.
--
-- `type` es TEXT sin CHECK (0021): los tres tipos son nuevos y no hay filas que sanear. Nada de esta
-- migración nombra a un proveedor.

CREATE UNIQUE INDEX uq_order_operations_pending_provider_write
  ON order_operations (tenant_id, order_id)
  WHERE status = 'pending' AND type IN ('issue', 'modify', 'add-services');

COMMENT ON INDEX uq_order_operations_pending_provider_write IS
  'CAS durable pre-write: como máximo una escritura pendiente en el proveedor (issue, modify, add-services) por orden y tenant. La cancelación tiene el suyo (0037). Ver db/migrations/0083.';
