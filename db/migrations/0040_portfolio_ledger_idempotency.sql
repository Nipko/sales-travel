-- Idempotencia durable para writes de saldo iniciados por HTTP. NULL conserva movimientos legacy
-- y asientos internos que tienen su propia clave natural (orderId).
ALTER TABLE portfolio_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- Una clave representa una sola acción financiera dentro de la cartera. No se puede reciclar una
-- clave de depósito como retiro ni cambiar el monto después de una respuesta incierta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_transactions_idempotency_key
  ON portfolio_transactions(portfolio_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- El hold queda intacto. Esta segunda clave garantiza que reintentar después del COMMIT de la
-- liberación no vuelva a acreditar el balance. lower() cubre UUID legacy en mayúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_transactions_one_booking_release_per_order
  ON portfolio_transactions(lower(reference_id))
  WHERE transaction_type = 'BOOKING_RELEASED' AND reference_id IS NOT NULL;

COMMENT ON COLUMN portfolio_transactions.idempotency_key IS
  'Idempotency-Key UUID de la acción HTTP; NULL para movimientos internos/legacy.';

COMMENT ON INDEX uq_portfolio_transactions_one_booking_release_per_order IS
  'Impide acreditar dos veces la liberación de un BOOKING_HOLD por orderId normalizado.';
