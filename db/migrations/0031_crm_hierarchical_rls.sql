-- 0031_crm_hierarchical_rls.sql
-- Visibilidad del CRM acorde al modelo consolidador.
--
-- Las policies de 0024 son igualdad plana de tenant_id, así que dentro de una agencia
-- TODOS ven TODO: `assigned_user_id` existe pero no filtra nada, y un vendedor podía
-- leer —y mover— las oportunidades de sus compañeros, con el nombre del cliente, el
-- destino y el valor estimado de cada una. En una agencia con varios vendedores eso es
-- la cartera de todos a la vista de cualquiera.
--
-- Regla nueva:
--   · admin del nodo (cualquier rol administrativo) → ve todas las del tenant activo
--   · vendedor / cliente_final                     → sólo las propias y las sin asignar
--     (assigned_user_id IS NULL es la cola del agente IA, que es de la agencia)

-- ============================================================================
-- ¿El usuario del request administra el tenant ACTIVO?
-- ============================================================================
-- SECURITY DEFINER para poder consultar memberships sin re-disparar su propia RLS,
-- mismo patrón que is_admin_user() (0013) y can_read_membership() (0020). A diferencia
-- de aquéllas, ésta se ancla al tenant activo: un tenant_admin de otra agencia no es
-- admin acá.
CREATE OR REPLACE FUNCTION is_admin_of_current_tenant() RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id::text   = current_setting('app.current_user_id', true)
      AND m.tenant_id::text = current_setting('app.current_tenant_id', true)
      AND m.status = 'active'
      AND m.role IN ('superadmin', 'platform_admin', 'consolidator_admin',
                     'tenant_admin', 'agency_admin', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION is_admin_of_current_tenant() TO app_user;

-- ============================================================================
-- Oportunidades
-- ============================================================================
DROP POLICY IF EXISTS crm_opportunities_tenant_isolation ON crm_opportunities;

CREATE POLICY crm_opportunities_tenant_isolation ON crm_opportunities
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    AND (
      is_admin_of_current_tenant()
      OR assigned_user_id IS NULL
      OR assigned_user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    AND (
      is_admin_of_current_tenant()
      OR assigned_user_id IS NULL
      OR assigned_user_id::text = current_setting('app.current_user_id', true)
    )
  );

COMMENT ON POLICY crm_opportunities_tenant_isolation ON crm_opportunities IS
  'Aislamiento por tenant + por vendedor: un no-admin sólo ve sus oportunidades y la cola sin asignar. El WITH CHECK replica la condición para que nadie cree ni reasigne una fila que después no podría ver.';

-- ============================================================================
-- Interacciones
-- ============================================================================
-- Mismo criterio, resuelto por la oportunidad asociada: el historial de conversación de
-- un cliente ajeno es tan sensible como la oportunidad en sí. Las interacciones sin
-- oportunidad (notas sueltas de un cliente) quedan visibles para todo el tenant, que es
-- el comportamiento actual y no revela pipeline de nadie.
DROP POLICY IF EXISTS crm_interactions_tenant_isolation ON crm_interactions;

CREATE POLICY crm_interactions_tenant_isolation ON crm_interactions
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    AND (
      is_admin_of_current_tenant()
      OR opportunity_id IS NULL
      OR EXISTS (
        SELECT 1 FROM crm_opportunities o
        WHERE o.id = crm_interactions.opportunity_id
          AND (
            o.assigned_user_id IS NULL
            OR o.assigned_user_id::text = current_setting('app.current_user_id', true)
          )
      )
    )
  )
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- Enums del CRM: de VARCHAR libre a CHECK
-- ============================================================================
-- 0024 documentó los valores válidos en un comentario y nada más, así que `stage` y
-- `source_channel` aceptaban cualquier cadena. Una etapa inexistente no rompe nada
-- visiblemente: la oportunidad simplemente deja de aparecer en el Kanban, que sólo
-- renderiza las columnas conocidas. Se normalizan primero los valores fuera de rango
-- —a la etapa inicial y al canal manual— para que la migración no falle con datos sucios.
UPDATE crm_opportunities SET stage = 'LEAD_UNASSIGNED'
 WHERE stage NOT IN ('AI_HANDLING','LEAD_UNASSIGNED','QUALIFIED_LEAD','QUOTE_SENT',
                     'NEGOTIATION','BOOKING_CONFIRMED','IN_TRAVEL',
                     'POST_TRAVEL_COMPLETED','CLOSED_LOST');

UPDATE crm_opportunities SET source_channel = 'MANUAL'
 WHERE source_channel NOT IN ('WHATSAPP','WEB_B2B','WEB_B2C','MANUAL');

ALTER TABLE crm_opportunities
  ADD CONSTRAINT crm_opportunities_stage_check CHECK (stage IN (
    'AI_HANDLING','LEAD_UNASSIGNED','QUALIFIED_LEAD','QUOTE_SENT','NEGOTIATION',
    'BOOKING_CONFIRMED','IN_TRAVEL','POST_TRAVEL_COMPLETED','CLOSED_LOST'
  )),
  ADD CONSTRAINT crm_opportunities_channel_check CHECK (source_channel IN (
    'WHATSAPP','WEB_B2B','WEB_B2C','MANUAL'
  ));

ALTER TABLE crm_interactions
  ADD CONSTRAINT crm_interactions_channel_check CHECK (channel IN (
    'WHATSAPP','VOICE_CALL','EMAIL','INTERNAL_NOTE','AI_SYSTEM_EVENT'
  )),
  ADD CONSTRAINT crm_interactions_direction_check CHECK (direction IN (
    'INBOUND','OUTBOUND','INTERNAL'
  ));
