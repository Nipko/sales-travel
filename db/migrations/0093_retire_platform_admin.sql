-- 0093_retire_platform_admin.sql
-- `platform_admin` deja de dar acceso (founder 2026-11-05, docs/platform/16 H7).
--
-- El rol está retirado desde D7 B: ni la API ni la web lo asignan y SuperadminGuard lo deja fuera de
-- la consola. Pero varias funciones de la base todavía lo contaban como administrador (leer las
-- memberships y el audit log de una red, el CRM del nodo, la bóveda de payloads de proveedor) y
-- alguna membership vieja podía seguir activa. Si alguien necesita ese acceso, se le da superadmin
-- supervisado desde Plataforma → Superadmins.
--
--   1. toda membership `platform_admin` que no esté quitada pasa a quitada (0067). El trigger de
--      0092 deja un db.direct_change por cada una: se ve en Plataforma → Actividad › Superadmins;
--   2. las funciones que lo contaban dejan de hacerlo. Las que no se tocan (anuncios, 0079) sólo lo
--      miran sobre memberships activas, y ya no queda ninguna.
--
-- El tipo `Role` y el CHECK de memberships lo siguen aceptando: hay filas quitadas con ese rol y su
-- historia sigue en la auditoría.
--
-- search_path = pg_catalog, public, pg_temp (posterior a 0060: ver
-- apps/api/src/database/migrations-search-path.test.ts).

-- ============================================================================
-- 1. Las memberships que quedaban
-- ============================================================================
UPDATE memberships
   SET status = 'removed',
       removed_at = now()
 WHERE role = 'platform_admin'
   AND status <> 'removed';

-- ============================================================================
-- 2. Las funciones que lo contaban como administrador
-- ============================================================================
CREATE OR REPLACE FUNCTION can_read_membership(target_tenant_id uuid) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.tenants admin_t  ON admin_t.id  = m.tenant_id
    JOIN public.tenants target_t ON target_t.id = target_tenant_id
    WHERE m.user_id::text = current_setting('app.current_user_id', true)
      AND m.status = 'active'
      AND (
        m.role = 'superadmin'
        OR (
          m.role IN ('consolidator_admin', 'tenant_admin', 'agency_admin', 'admin')
          AND admin_t.path OPERATOR(public.@>) target_t.path
        )
      )
  );
$$;

COMMENT ON FUNCTION can_read_membership(uuid) IS
  'Predicado genérico de subárbol: ¿el usuario de app.current_user_id administra el tenant dado o alguno de sus ancestros? Lo comparten memberships (0020), user_invitations (0028) y domain_events (0029). Sin platform_admin desde 0093.';

CREATE OR REPLACE FUNCTION is_admin_of_current_tenant() RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id::text   = current_setting('app.current_user_id', true)
      AND m.tenant_id::text = current_setting('app.current_tenant_id', true)
      AND m.status = 'active'
      AND m.role IN ('superadmin', 'consolidator_admin', 'tenant_admin', 'agency_admin', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION can_read_provider_payloads(p_owner_tenant_id uuid) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.tenants reader_t ON reader_t.id = m.tenant_id
    JOIN public.tenants owner_t  ON owner_t.id  = p_owner_tenant_id
    WHERE m.user_id::text = current_setting('app.current_user_id', true)
      AND m.status = 'active'
      AND (
        m.role = 'superadmin'
        OR (
          m.role IN ('consolidator_admin')
          AND reader_t.path OPERATOR(public.@>) owner_t.path
        )
      )
  );
$$;
