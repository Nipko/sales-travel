-- 0025_role_escalation_guard.sql
-- Defensa en profundidad contra la escalada a superadmin global.
--
-- Contexto: el CHECK de 0013_consolidator_roles.sql:23-32 acepta 'superadmin' y
-- 'platform_admin' en CUALQUIER tenant. NetworkService.isSuperadmin() busca el rol
-- superadmin en cualquier nodo (sin filtrar por tenant), así que una membership
-- superadmin colgada de una sub-agencia cualquiera concede acceso global a la
-- plataforma: listar todos los tenants, administrar redes ajenas y leer/escribir las
-- credenciales BYOC de cualquier nodo.
--
-- La validación Zod en AdminController (apps/api/src/tenants/dto.ts, ASSIGNABLE_ROLES)
-- cierra la vía conocida, pero es una defensa en un solo punto: cualquier endpoint
-- futuro que inserte memberships sin esa lista reabre el agujero. Este trigger mueve
-- el invariante a la base de datos, donde no depende de que cada controller lo recuerde.
--
-- Regla: los roles de plataforma sólo pueden existir en un tenant con
-- tenant_type = 'platform'.

CREATE OR REPLACE FUNCTION enforce_platform_role_scope() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
AS $$
DECLARE
  target_type TEXT;
BEGIN
  IF NEW.role NOT IN ('superadmin', 'platform_admin') THEN
    RETURN NEW;
  END IF;

  SELECT tenant_type INTO target_type FROM tenants WHERE id = NEW.tenant_id;

  IF target_type IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION
      'role % is a platform-wide role and cannot be granted on a tenant of type % (tenant %)',
      NEW.role, COALESCE(target_type, '<unknown>'), NEW.tenant_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memberships_platform_role_scope ON memberships;
CREATE TRIGGER memberships_platform_role_scope
  BEFORE INSERT OR UPDATE OF role, tenant_id ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION enforce_platform_role_scope();

-- Backfill defensivo: NO borra nada. Sólo emite un WARNING por cada membership
-- preexistente que viole la regla, para revisarla a mano antes de que el trigger
-- empiece a rechazar sus futuras actualizaciones.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT m.id, m.user_id, m.role, m.tenant_id, t.tenant_type, t.slug
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.role IN ('superadmin', 'platform_admin')
      AND t.tenant_type IS DISTINCT FROM 'platform'
  LOOP
    RAISE WARNING
      'REVISAR: membership % (user %) tiene rol % sobre el tenant % (%, tipo %) que no es de plataforma',
      r.id, r.user_id, r.role, r.tenant_id, r.slug, r.tenant_type;
  END LOOP;
END $$;

COMMENT ON FUNCTION enforce_platform_role_scope() IS
  'Impide que los roles globales superadmin/platform_admin se concedan fuera del tenant de tipo platform. Ver db/migrations/0025_role_escalation_guard.sql.';
