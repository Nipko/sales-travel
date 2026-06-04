-- 0016_pricing_waterfall.sql
-- Pricing waterfall multinivel del modelo consolidador: aplica las markup_rules de cada
-- nivel del path (consolidador → agencia → sub-agencia) en cascada sobre el neto.
-- SECURITY DEFINER para leer reglas a través de la RLS de markup_rules; la app sólo lo
-- llama para tenants que el usuario puede ver. Ver docs/platform/12 §3.3.
--
-- Semántica (v1): se aplican las reglas activas de ancestros-o-igual al tenant, en orden
-- ancestro→descendiente (por nlevel) y luego por priority. Cada regla se compone sobre el
-- RUNNING total: 'percentage' suma running*(value/10000) (value = %×100, ej 5% = 500),
-- 'fixed' suma value_minor. Devuelve neto, final, markup total y un breakdown por nivel.

CREATE OR REPLACE FUNCTION compute_price_waterfall(
  p_tenant_id UUID,
  p_vertical  TEXT,
  p_net_minor BIGINT
)
RETURNS TABLE (
  net_minor          BIGINT,
  final_minor        BIGINT,
  total_markup_minor BIGINT,
  breakdown          JSONB
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  running NUMERIC := p_net_minor;
  v_add   NUMERIC;
  bd      JSONB := '[]'::jsonb;
  r       RECORD;
BEGIN
  FOR r IN
    SELECT mr.tenant_id, t.name AS tenant_name, nlevel(t.path) AS lvl,
           mr.rule_type, mr.value_minor
    FROM markup_rules mr
    JOIN tenants t   ON t.id   = mr.tenant_id
    JOIN tenants tgt ON tgt.id = p_tenant_id
    WHERE mr.status = 'active'
      AND t.path OPERATOR(public.@>) tgt.path        -- reglas de ancestros-o-igual del tenant
      AND (mr.vertical = p_vertical OR mr.vertical = 'all')
    ORDER BY nlevel(t.path) ASC, mr.priority ASC, mr.id
  LOOP
    IF r.rule_type = 'percentage' THEN
      v_add := round(running * (r.value_minor::numeric / 10000));
    ELSE
      v_add := r.value_minor;
    END IF;
    running := running + v_add;
    bd := bd || jsonb_build_object(
      'tenantId', r.tenant_id,
      'tenantName', r.tenant_name,
      'level', r.lvl,
      'ruleType', r.rule_type,
      'addedMinor', v_add
    );
  END LOOP;

  RETURN QUERY SELECT p_net_minor, running::bigint, (running - p_net_minor)::bigint, bd;
END;
$$;

GRANT EXECUTE ON FUNCTION compute_price_waterfall(UUID, TEXT, BIGINT) TO app_user;
