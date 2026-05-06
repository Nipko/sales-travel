-- 0009_fix_memberships_admin_policy.sql
-- Fixes infinite recursion in memberships_admin_read policy from 0008.
-- The original policy's USING clause queried memberships itself, triggering
-- the same policy evaluation → infinite loop.
-- Fix: use a SECURITY DEFINER function that bypasses RLS when checking admin role.

DROP POLICY IF EXISTS memberships_admin_read ON memberships;

CREATE OR REPLACE FUNCTION is_admin_user() RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id::text = current_setting('app.current_user_id', true)
      AND status = 'active'
      AND role IN ('superadmin', 'tenant_admin', 'admin')
  );
$$;

CREATE POLICY memberships_admin_read ON memberships
  FOR SELECT
  USING (is_admin_user());
