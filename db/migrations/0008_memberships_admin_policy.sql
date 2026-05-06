-- 0008_memberships_admin_policy.sql
-- Permite a usuarios con rol admin/superadmin/tenant_admin ver TODAS las memberships.
-- Necesario para el panel de admin que lista usuarios cross-tenant.
-- PostgreSQL combina políticas con OR, convive con memberships_tenant_isolation y memberships_self.

CREATE POLICY memberships_admin_read ON memberships
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.user_id::text = current_setting('app.current_user_id', true)
        AND m2.status = 'active'
        AND m2.role IN ('superadmin', 'tenant_admin', 'admin')
    )
  );
