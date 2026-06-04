-- 0014_network_sales_summary.sql
-- Agregación de red para el consolidador: cuenta orders/quotations por nodo del subárbol.
-- SECURITY DEFINER (corre como owner superuser ⇒ bypassa la RLS de orders/quotations) para
-- poder leer a través de toda la red. La AUTORIZACIÓN se hace en la app (NetworkService
-- gatea con canManageTenant antes de llamar). NO toca las políticas RLS de las tablas
-- operativas, así que las queries normales (own-tenant) siguen aisladas igual.
-- Ver docs/platform/12-modelo-consolidador-y-plan.md §3.5 / §6.

CREATE OR REPLACE FUNCTION network_sales_summary(p_root_tenant_id UUID)
RETURNS TABLE (
  t_id                UUID,
  t_name              TEXT,
  t_type              TEXT,
  t_depth             INT,
  orders_total        BIGINT,
  orders_confirmed    BIGINT,
  quotations_total    BIGINT
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  WITH root AS (SELECT path FROM tenants WHERE id = p_root_tenant_id),
  net AS (
    SELECT t.id, t.name, t.tenant_type, nlevel(t.path) AS depth
    FROM tenants t CROSS JOIN root
    WHERE t.path OPERATOR(public.<@) root.path   -- descendientes-o-igual del root
  )
  SELECT
    n.id,
    n.name,
    n.tenant_type,
    n.depth,
    COALESCE(o.cnt, 0),
    COALESCE(o.confirmed, 0),
    COALESCE(q.cnt, 0)
  FROM net n
  LEFT JOIN (
    SELECT tenant_id,
           count(*)                                                       AS cnt,
           count(*) FILTER (WHERE status IN ('confirmed', 'ticketed'))    AS confirmed
    FROM orders
    GROUP BY tenant_id
  ) o ON o.tenant_id = n.id
  LEFT JOIN (
    SELECT tenant_id, count(*) AS cnt
    FROM quotations
    GROUP BY tenant_id
  ) q ON q.tenant_id = n.id
  ORDER BY n.depth, n.name;
$$;

GRANT EXECUTE ON FUNCTION network_sales_summary(UUID) TO app_user;
