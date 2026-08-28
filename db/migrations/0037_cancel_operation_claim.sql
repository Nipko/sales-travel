-- 0037_cancel_operation_claim.sql
-- Una cancelación es un write externo no idempotente. Antes de tocar el proveedor debe existir
-- exactamente un claim durable; un segundo request no puede crear otro mientras el primero esté
-- pending (incluido un proceso que cayó y dejó el desenlace sin verificar).

-- El runner aplica cada archivo en una transacción. Este lock cierra la ventana entre sanear
-- datos legacy y crear el índice: ninguna escritura puede introducir otro duplicado en medio.
LOCK TABLE order_operations IN SHARE ROW EXCLUSIVE MODE;

-- La migración tolera duplicados legacy. Conserva pendiente sólo el claim más reciente; los
-- demás quedan UNVERIFIED/no-retryable para revisión humana (nunca se borran ni se habilitan).
WITH ranked_pending AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, order_id
           ORDER BY created_at DESC, id DESC
         ) AS claim_rank
    FROM order_operations
   WHERE type = 'cancel' AND status = 'pending'
)
UPDATE order_operations AS operation
   SET status = 'failed',
       last_error = 'Claim duplicado legacy; requiere conciliación.',
       result = jsonb_build_object(
         'status', 'failed',
         'outcome', 'UNVERIFIED',
         'retryable', false,
         'reconciliationRequired', true,
         'reason', 'duplicate-pending-claim-migrated'
       )
  FROM ranked_pending AS ranked
 WHERE operation.id = ranked.id
   AND ranked.claim_rank > 1;

CREATE UNIQUE INDEX uq_order_operations_pending_cancel
  ON order_operations (tenant_id, order_id)
  WHERE type = 'cancel' AND status = 'pending';

COMMENT ON INDEX uq_order_operations_pending_cancel IS
  'CAS durable pre-write: como máximo una cancelación pendiente por orden y tenant.';
