-- 0038_order_create_idempotency.sql
-- La creación de una reserva es un write externo: una clave durable evita que dos requests
-- equivalentes creen dos PNR mientras el primero está pendiente, confirmado o incierto.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS create_request_key TEXT NULL;

-- Cierra la ventana entre el saneamiento legacy y ambos índices.
LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_create_request_key
  ON orders (tenant_id, create_request_key)
  WHERE create_request_key IS NOT NULL;

COMMENT ON COLUMN orders.create_request_key IS
  'Clave durable de idempotencia del create: q:<quotation UUID> o c:<client UUID>. Se libera sólo tras FAILED explícito.';

COMMENT ON INDEX uq_orders_create_request_key IS
  'Como máximo un intent de creación activo por tenant y clave externa.';

-- MAX(order_number)+1 sólo es seguro si todos los writers toman el lock del tenant. El índice es
-- la última defensa frente a una regresión o un writer legacy que omita ese lock.
-- Conserva la fila más antigua de cada número duplicado y asigna a las restantes números nuevos
-- contiguos a partir del MAX actual del tenant.
WITH ranked AS (
  SELECT id,
         tenant_id,
         order_number,
         created_at,
         row_number() OVER (
           PARTITION BY tenant_id, order_number
           ORDER BY created_at ASC, id ASC
         ) AS duplicate_rank,
         max(order_number) OVER (PARTITION BY tenant_id) AS tenant_max
    FROM orders
),
renumbered AS (
  SELECT id,
         tenant_max + row_number() OVER (
           PARTITION BY tenant_id
           ORDER BY order_number ASC, created_at ASC, id ASC
         ) AS new_order_number
    FROM ranked
   WHERE duplicate_rank > 1
)
UPDATE orders AS target
   SET order_number = renumbered.new_order_number
  FROM renumbered
 WHERE target.id = renumbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_tenant_order_number
  ON orders (tenant_id, order_number);

COMMENT ON INDEX uq_orders_tenant_order_number IS
  'El número visible de reserva es único dentro de cada tenant.';
