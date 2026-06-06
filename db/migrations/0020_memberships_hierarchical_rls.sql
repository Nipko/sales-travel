-- 0020_memberships_hierarchical_rls.sql
-- RLS JERÁRQUICA para memberships (defense-in-depth del modelo consolidador).
--
-- Problema: la policy memberships_admin_read (0008/0009) usaba is_admin_user(), que dejaba a
-- CUALQUIER admin (tenant_admin/admin de cualquier nodo) hacer SELECT de TODAS las memberships de
-- TODA la base — fuga cross-red. Los endpoints ya estaban gateados en app-layer (canManageTenant /
-- assertSuperadmin), pero la garantía no estaba en la DB.
--
-- Fix: reemplazar esa policy por una acotada al SUBÁRBOL del admin por `path` (ltree), espejo de
-- NetworkService.canManageTenant: un admin sólo ve memberships de su nodo y descendientes; el
-- superadmin ve todo. Las ESCRITURAS siguen gobernadas por memberships_tenant_isolation (FOR ALL,
-- WITH CHECK tenant_id = current_tenant_id), sin cambios — así no se toca login/register/changeRole.
--
-- SECURITY DEFINER (owner = postgres, superuser) evita recursión: las sub-consultas a
-- memberships/tenants dentro de la función NO re-disparan RLS (mismo patrón que is_admin_user).

CREATE OR REPLACE FUNCTION can_read_membership(target_tenant_id uuid) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships m
    JOIN tenants admin_t  ON admin_t.id  = m.tenant_id
    JOIN tenants target_t ON target_t.id = target_tenant_id
    WHERE m.user_id::text = current_setting('app.current_user_id', true)
      AND m.status = 'active'
      AND (
        m.role = 'superadmin'
        OR (
          m.role IN ('platform_admin', 'consolidator_admin', 'tenant_admin', 'agency_admin', 'admin')
          AND admin_t.path OPERATOR(public.@>) target_t.path
        )
      )
  );
$$;

GRANT EXECUTE ON FUNCTION can_read_membership(uuid) TO app_user;

-- Reemplaza la policy de lectura amplia por la jerárquica (FOR SELECT).
DROP POLICY IF EXISTS memberships_admin_read ON memberships;
CREATE POLICY memberships_admin_read ON memberships
  FOR SELECT
  USING (can_read_membership(tenant_id));
