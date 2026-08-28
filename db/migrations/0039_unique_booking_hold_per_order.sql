-- Un orderId sólo puede originar un BOOKING_HOLD. La liberación se registra como un asiento
-- positivo separado; el hold original no se reescribe y conserva monto/actor/fecha para auditoría.
--
-- lower(reference_id) protege también valores UUID legacy con casing distinto. Si una instalación
-- antigua ya tiene duplicados que sólo difieren en casing, la creación falla de forma visible en
-- vez de escoger uno y alterar saldos financieros silenciosamente. Esos casos deben conciliarse
-- antes de reintentar la migración.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_transactions_one_booking_hold_per_order
  ON portfolio_transactions(lower(reference_id))
  WHERE transaction_type = 'BOOKING_HOLD' AND reference_id IS NOT NULL;

COMMENT ON INDEX uq_portfolio_transactions_one_booking_hold_per_order IS
  'Impide más de un BOOKING_HOLD por orderId normalizado, incluso bajo concurrencia.';
