-- 0062_password_reset_required.sql
-- Forzar a una persona a elegir una contraseña nueva antes de volver a ingresar.
--
-- Qué resuelve: doc 14 dejó pendiente el "restablecimiento forzado". Un admin que sospecha que la
-- contraseña de alguien de su equipo está comprometida podía cerrarle las sesiones o enviarle un
-- enlace, pero la contraseña vieja seguía sirviendo para entrar hasta que la persona la cambiara.
-- Ahora el admin la marca desde Equipo: se cierran sus sesiones, le llega el enlace a su correo y el
-- login la rechaza (403 PASSWORD_RESET_REQUIRED) hasta que elija una contraseña nueva. Nadie elige
-- la contraseña por ella (sólo invitación, doc 14).
--
-- La marca la pone la API (PasswordResetService.requireReset) y la limpian el canje del enlace y el
-- cambio de contraseña autenticado, en el mismo UPDATE que fija la contraseña nueva. Mientras está,
-- SessionService.validate tampoco acepta ninguna sesión de la persona: un login que pasó la
-- contraseña justo antes de la marca no deja una sesión viva.
--
-- `users` no tiene RLS (identidad global, 0001): no hacen falta políticas nuevas.
--
-- `user_admin_overview` (0055) suma la columna `password_reset_required` para que Equipo muestre
-- "Cambio de contraseña pendiente". Cambiar las columnas que devuelve una función exige borrarla y
-- crearla de nuevo; la API vieja la consulta por nombre de columna, así que la migración puede
-- correr antes que la API nueva (deploy.yml migra antes de desplegar). Va con el search_path
-- endurecido de 0060 y los mismos permisos que le dio 0055.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_reset_required_at TIMESTAMPTZ;

COMMENT ON COLUMN users.password_reset_required_at IS
  'Desde cuándo la persona tiene que elegir una contraseña nueva antes de volver a ingresar (0062). La pone un admin desde Equipo; la limpian el canje del enlace de restablecimiento y el cambio de contraseña. Mientras no es NULL, el login responde 403 PASSWORD_RESET_REQUIRED y ninguna sesión suya es válida.';

DROP FUNCTION IF EXISTS user_admin_overview(UUID);

CREATE FUNCTION user_admin_overview(p_tenant UUID)
RETURNS TABLE (
  user_id                  UUID,
  last_login_at            TIMESTAMPTZ,
  mfa_enabled              BOOLEAN,
  locked_until             TIMESTAMPTZ,
  active_sessions          INTEGER,
  password_reset_required  BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH root AS (
    SELECT path FROM tenants WHERE id = p_tenant
  ),
  subtree AS (
    SELECT t.id
      FROM tenants t
      CROSS JOIN root
     WHERE t.path OPERATOR(public.<@) root.path   -- descendientes de p_tenant, él incluido
  ),
  team AS (
    SELECT DISTINCT m.user_id
      FROM memberships m
      JOIN subtree st ON st.id = m.tenant_id
  )
  SELECT u.id,
         u.last_login_at,
         u.mfa_enabled_at IS NOT NULL,
         CASE WHEN u.locked_until > now() THEN u.locked_until END,
         (SELECT count(*)::int
            FROM sessions s
            JOIN subtree st ON st.id = s.tenant_id
           WHERE s.user_id = u.id
             AND s.revoked_at IS NULL
             AND s.expires_at > now()
             AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'),
         u.password_reset_required_at IS NOT NULL
    FROM team
    JOIN users u ON u.id = team.user_id;
$$;

COMMENT ON FUNCTION user_admin_overview(UUID) IS
  'Por cada usuario con membership en el subárbol de p_tenant: último login, si tiene MFA activo, hasta cuándo está bloqueado (NULL si no lo está), cuántas sesiones vivas tiene en ese subárbol y si tiene que elegir una contraseña nueva antes de ingresar (0062). La app valida canManageTenant(p_tenant) ANTES. Ver db/migrations/0055 y 0062.';

-- Las funciones nacen ejecutables por PUBLIC; ésta pasa por encima de la RLS de sessions.
REVOKE ALL ON FUNCTION user_admin_overview(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_admin_overview(UUID) TO app_user;
