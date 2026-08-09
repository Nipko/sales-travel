-- 0034_crm_tasks_dedup_and_pii.sql
-- Lo que le faltaba al CRM para ser usable por una agencia de viajes de verdad.

-- ============================================================================
-- 1. Tareas y recordatorios
-- ============================================================================
-- No existía NINGÚN mecanismo de seguimiento: una oportunidad podía quedarse meses en
-- "Cotización enviada" sin que nadie se enterara. Para una agencia, el seguimiento ES
-- el trabajo — la venta se pierde por no llamar a tiempo, no por no cotizar.
CREATE TABLE crm_tasks (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opportunity_id UUID         REFERENCES crm_opportunities(id) ON DELETE CASCADE,
  customer_id    UUID         REFERENCES customers(id) ON DELETE CASCADE,
  assigned_user_id UUID       REFERENCES users(id) ON DELETE SET NULL,
  title          TEXT         NOT NULL,
  notes          TEXT,
  kind           TEXT         NOT NULL DEFAULT 'FOLLOW_UP'
                              CHECK (kind IN ('FOLLOW_UP','CALL','QUOTE_EXPIRY','TRAVEL_START',
                                              'POST_TRAVEL','BIRTHDAY','DOCUMENT_EXPIRY','OTHER')),
  due_at         TIMESTAMPTZ  NOT NULL,
  completed_at   TIMESTAMPTZ,
  created_by_user_id UUID     REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Camino caliente: "mis tareas vencidas o de hoy".
CREATE INDEX idx_crm_tasks_pending ON crm_tasks(tenant_id, assigned_user_id, due_at)
  WHERE completed_at IS NULL;
CREATE INDEX idx_crm_tasks_opportunity ON crm_tasks(opportunity_id);

CREATE TRIGGER crm_tasks_set_updated_at
  BEFORE UPDATE ON crm_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE crm_tasks IS
  'Tareas y recordatorios del pipeline. due_at vencido = acción pendiente. Ver db/migrations/0034.';

-- Mismo criterio que las oportunidades (0031): un vendedor ve sus tareas y las sin
-- asignar; el admin del nodo ve todas.
ALTER TABLE crm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_tasks FORCE  ROW LEVEL SECURITY;

CREATE POLICY crm_tasks_isolation ON crm_tasks
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    AND (
      is_admin_of_current_tenant()
      OR assigned_user_id IS NULL
      OR assigned_user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_tasks TO app_user;

-- ============================================================================
-- 2. Deduplicación de clientes
-- ============================================================================
-- Nada impedía cargar al mismo viajero dos veces dentro de la misma agencia: se
-- duplicaban el historial, las preferencias y los documentos, y el vendedor terminaba
-- llamando a una ficha vacía. El blind index de 0018 ya permite comparar por igualdad
-- sin descifrar; sólo faltaba imponer la unicidad.
--
-- Se limita al TENANT: dos agencias distintas de la red pueden tener al mismo viajero
-- como cliente propio, y unificarlos filtraría la cartera de una a la otra.
--
-- Las filas legacy con document_number_hash NULL quedan fuera del índice (parcial), así
-- que la migración no falla con datos previos al cifrado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_unique_document
  ON customers(tenant_id, document_type, document_number_hash)
  WHERE document_number_hash IS NOT NULL;

COMMENT ON INDEX idx_customers_unique_document IS
  'Un documento por tenant. Parcial: excluye filas legacy sin blind index. Ver db/migrations/0034.';

-- ============================================================================
-- 3. PII de los acompañantes
-- ============================================================================
-- customer_passengers guardaba el documento EN CLARO, mientras que la tabla `customers`
-- lo cifra desde 0018. Incoherente y peor: el acompañante suele ser un menor de edad.
-- Mismo tratamiento que el titular — cifrado + blind index.
ALTER TABLE customer_passengers
  ADD COLUMN IF NOT EXISTS document_number_enc  BYTEA,
  ADD COLUMN IF NOT EXISTS document_number_hash TEXT;

ALTER TABLE customer_passengers ALTER COLUMN document_number DROP NOT NULL;

COMMENT ON COLUMN customer_passengers.document_number_enc  IS 'Documento cifrado (AES-256-GCM). NUNCA loguear ni exponer el blob.';
COMMENT ON COLUMN customer_passengers.document_number_hash IS 'Blind index (HMAC) para lookup por igualdad sin descifrar.';
COMMENT ON COLUMN customer_passengers.document_number      IS 'DEPRECADO: sólo filas legacy. Las nuevas guardan el documento cifrado.';

-- ============================================================================
-- 4. Reasignación de cartera
-- ============================================================================
-- Al dar de baja a un vendedor, sus oportunidades y tareas quedaban asignadas a un
-- usuario suspendido: invisibles para el resto del equipo por la RLS por vendedor de
-- 0031, o sea que la cartera se perdía de vista justo cuando había que atenderla.
--
-- SECURITY DEFINER porque tiene que alcanzar filas del vendedor saliente, que el
-- llamador no necesariamente ve. La autorización se valida en la aplicación antes.
CREATE OR REPLACE FUNCTION reassign_portfolio(
  p_tenant_id UUID,
  p_from_user UUID,
  p_to_user   UUID
) RETURNS TABLE (opportunities integer, tasks integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  opp_count  integer;
  task_count integer;
BEGIN
  UPDATE crm_opportunities
     SET assigned_user_id = p_to_user
   WHERE tenant_id = p_tenant_id
     AND assigned_user_id = p_from_user;
  GET DIAGNOSTICS opp_count = ROW_COUNT;

  UPDATE crm_tasks
     SET assigned_user_id = p_to_user
   WHERE tenant_id = p_tenant_id
     AND assigned_user_id = p_from_user
     AND completed_at IS NULL;
  GET DIAGNOSTICS task_count = ROW_COUNT;

  RETURN QUERY SELECT opp_count, task_count;
END;
$$;

COMMENT ON FUNCTION reassign_portfolio(UUID, UUID, UUID) IS
  'Traspasa oportunidades y tareas pendientes de un vendedor a otro dentro del mismo tenant. La autorización se valida en la app.';

GRANT EXECUTE ON FUNCTION reassign_portfolio(UUID, UUID, UUID) TO app_user;
