-- 0017_applicable_markup_rules.sql
-- Devuelve las reglas de markup aplicables a un tenant para un vertical, ordenadas
-- ancestro→descendiente (igual que compute_price_waterfall). Permite a la capa de
-- búsqueda traer las reglas UNA vez y aplicar la cascada en JS a cada oferta (perf).
-- SECURITY DEFINER para leer a través de la RLS de markup_rules. Ver docs/platform/12 §3.3.

CREATE OR REPLACE FUNCTION applicable_markup_rules(p_tenant_id UUID, p_vertical TEXT)
RETURNS TABLE (
  tenant_id   UUID,
  tenant_name TEXT,
  lvl         INT,
  rule_type   TEXT,
  value_minor BIGINT
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT mr.tenant_id, t.name, nlevel(t.path), mr.rule_type, mr.value_minor
  FROM markup_rules mr
  JOIN tenants t   ON t.id   = mr.tenant_id
  JOIN tenants tgt ON tgt.id = p_tenant_id
  WHERE mr.status = 'active'
    AND t.path OPERATOR(public.@>) tgt.path
    AND (mr.vertical = p_vertical OR mr.vertical = 'all')
  ORDER BY nlevel(t.path) ASC, mr.priority ASC, mr.id;
$$;

GRANT EXECUTE ON FUNCTION applicable_markup_rules(UUID, TEXT) TO app_user;
