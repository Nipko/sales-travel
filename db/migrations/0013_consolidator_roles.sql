-- 0013_consolidator_roles.sql
-- Roles del modelo consolidador: consolidator_admin (gestiona su red) y agency_admin.
-- Amplía el CHECK de memberships.role sin tocar los datos existentes.
-- Ver docs/platform/12-modelo-consolidador-y-plan.md §3.4.

-- Drop dinámico del/los CHECK existentes sobre `role` (el nombre auto-generado puede
-- variar), para no dejar dos constraints en conflicto que bloqueen los nuevos roles.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'memberships'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN (
    'superadmin',
    'platform_admin',
    'consolidator_admin',
    'tenant_admin',
    'agency_admin',
    'admin',
    'vendedor',
    'cliente_final'
  ));

-- is_admin_user() (policy memberships_admin_read) debe reconocer los nuevos roles admin.
CREATE OR REPLACE FUNCTION is_admin_user() RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id::text = current_setting('app.current_user_id', true)
      AND status = 'active'
      AND role IN ('superadmin', 'platform_admin', 'consolidator_admin',
                   'tenant_admin', 'agency_admin', 'admin')
  );
$$;
