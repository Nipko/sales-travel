-- 0088_latam_order_status_repair.sql
-- Repara el estado de las órdenes de LATAM NDC que quedaron con el código crudo de LATAM.
--
-- El pago de LATAM (`/order/change/payment`) responde con el estado de la orden en su vocabulario:
-- OPENED (sin pago o pago en proceso), FROZEN (pago rechazado) y CLOSED (pagada y emitida). El ACL lo
-- devolvía tal cual y `orders.service.payOrder` lo guardaba en `orders.status`, que no tiene CHECK.
-- Una orden emitida quedaba en 'CLOSED' y para el resto de la plataforma —que compara contra
-- 'ticketed'— seguía sin emitir: se ofrecía «Cancelar» y no aparecía la postventa.
--
-- Desde esta versión el ACL traduce el estado y el servicio sólo acepta 'confirmed' o 'ticketed'
-- (docs/latam-ndc/01-estado-y-plan.md, H-01). Esto corrige las filas que ya se escribieron.
-- Idempotente: una segunda pasada no encuentra filas.

UPDATE orders
   SET status = 'ticketed'
 WHERE provider = 'latam-ndc'
   AND upper(status) = 'CLOSED';

UPDATE orders
   SET status = 'confirmed'
 WHERE provider = 'latam-ndc'
   AND upper(status) IN ('OPENED', 'FROZEN');
