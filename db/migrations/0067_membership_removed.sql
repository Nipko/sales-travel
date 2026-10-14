-- 0067_membership_removed.sql
-- Quitar a una persona de un nodo: baja blanda con historial (USR-11, founder D2 = A).
--
-- Qué resuelve: para que alguien dejara de trabajar en un nodo, lo único que había era suspenderle la
-- membership, y las filas suspendidas se iban apilando en Equipo para siempre. Ahora un admin la
-- quita (POST /admin/memberships/remove): la membership pasa a 'removed', desaparece de Equipo y la
-- persona pierde el acceso a ese nodo en el acto, pero la fila queda. No se borra nada: sus reservas,
-- sus movimientos de cartera y su rastro en domain_events siguen apuntando a la misma cuenta y a la
-- misma membership. Para volver, sólo una invitación nueva: al aceptarla se reactiva ESTA fila (la
-- UNIQUE (tenant_id, user_id) de 0001 no deja crear otra), con el rol de la invitación.
--
-- Por qué basta con un estado más: todos los predicados de la base y de la API que dan acceso o
-- potestad miran `status = 'active'` (RLS de memberships 0020, is_admin_user 0013,
-- is_admin_of_current_tenant 0031, can_read_provider_payloads 0043, can_manage_provider_enablement
-- 0048, el mover nodos 0051/0060, las carteras 0052, revoke_user_sessions_for_tenant e
-- invitation_backing 0056, las funciones de 0063-0065, SessionService.validate, NetworkService), así
-- que 'removed' ya no da nada, como 'suspended'. Se revisaron todos: ninguno usa `<> 'suspended'`.
-- Lo que miraba memberships SIN filtrar el estado, porque "tener una membership" alcanzaba, ahora
-- descarta las quitadas:
--
--   - user_admin_overview (0055, 0062): el equipo del subárbol para Equipo;
--   - admin_user_security (0064): la seguridad de la persona sólo responde a quien administra un nodo
--     donde ella SIGUE estando (la API ya lo autoriza antes; esto es el respaldo).
--
-- En la API se filtran igual la lista de Equipo, /me/memberships, la ficha, el soporte, el directorio
-- de la plataforma y el conteo de usuarios de Gestión de Agencias. El historial no: la Actividad de
-- la red sigue nombrando a quien se quitó, porque su rastro es justamente lo que se conserva.
--
-- `removed_at` y `removed_by` dicen cuándo y quién; el CHECK los ata al estado para que una fila no
-- quede "quitada" sin fecha ni con fecha estando activa. `removed_by` se pone en NULL si se borra la
-- cuenta del admin, como `invited_by`.
--
-- Corre como el dueño de la base: la RLS FORCE de memberships no la frena.

-- ============================================================================
-- 1. El estado y cuándo y quién
-- ============================================================================
-- El CHECK de 0001 se creó sin nombre: se busca el que restringe `status` y se reemplaza.
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.memberships'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%status%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%removed_at%'
  LOOP
    EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('active', 'suspended', 'invited', 'removed'));

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_removed_consistent
  CHECK ((status = 'removed') = (removed_at IS NOT NULL));

COMMENT ON COLUMN memberships.removed_at IS
  'Desde cuándo la persona ya no forma parte del nodo (status = removed, 0067). NULL en cualquier otro estado. La limpia aceptar una invitación nueva, que reactiva esta misma fila.';
COMMENT ON COLUMN memberships.removed_by IS
  'Quién la quitó del nodo (0067). NULL si no está quitada o si se borró la cuenta de ese admin.';

-- ============================================================================
-- 2. Equipo: el subárbol sin las memberships quitadas
-- ============================================================================
-- Mismas columnas que en 0062: CREATE OR REPLACE alcanza. Sólo cambia el CTE `team`.
CREATE OR REPLACE FUNCTION user_admin_overview(p_tenant UUID)
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
     WHERE m.status <> 'removed'                  -- quitadas del nodo (0067): ya no son del equipo
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
  'Por cada usuario con membership no quitada en el subárbol de p_tenant: último login, si tiene MFA activo, hasta cuándo está bloqueado (NULL si no lo está), cuántas sesiones vivas tiene en ese subárbol y si tiene que elegir una contraseña nueva antes de ingresar (0062). La app valida canManageTenant(p_tenant) ANTES. Ver db/migrations/0055, 0062 y 0067.';

REVOKE ALL ON FUNCTION user_admin_overview(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_admin_overview(UUID) TO app_user;

-- ============================================================================
-- 3. La seguridad de una persona: sólo a quien la administra donde todavía está
-- ============================================================================
-- Igual que en 0064 salvo la última condición: una membership quitada ya no ata a la persona al
-- nodo, así que no le abre su seguridad al admin de ese nodo.
CREATE OR REPLACE FUNCTION admin_user_security(p_user UUID)
RETURNS TABLE (
  mfa_enabled_at          TIMESTAMPTZ,
  recovery_codes_left     INTEGER,
  trusted_devices_active  INTEGER,
  password_changed_at     TIMESTAMPTZ,
  failed_login_attempts   INTEGER,
  locked_until            TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.mfa_enabled_at,
         (SELECT count(*)::int
            FROM mfa_recovery_codes c
           WHERE c.user_id = u.id
             AND c.used_at IS NULL),
         (SELECT count(*)::int
            FROM trusted_devices d
           WHERE d.user_id = u.id
             AND d.revoked_at IS NULL
             AND d.expires_at > now()
             AND d.created_at > COALESCE(u.password_changed_at, '-infinity'::timestamptz)
             AND d.created_at > COALESCE(u.mfa_enabled_at, '-infinity'::timestamptz)),
         u.password_changed_at,
         u.failed_login_attempts,
         CASE WHEN u.locked_until > now() THEN u.locked_until END
    FROM users u
   WHERE u.id = p_user
     AND (
       u.id::text = current_setting('app.current_user_id', true)
       OR EXISTS (
         SELECT 1
           FROM memberships m
          WHERE m.user_id::text = current_setting('app.current_user_id', true)
            AND m.role = 'superadmin'
            AND m.status = 'active'
       )
       OR EXISTS (
         SELECT 1
           FROM memberships tm
          WHERE tm.user_id = u.id
            AND tm.status <> 'removed'
            AND can_read_membership(tm.tenant_id)
       )
     );
$$;

COMMENT ON FUNCTION admin_user_security(UUID) IS
  'Seguridad de p_user para quien lo administra: desde cuándo tiene 2FA, cuántos códigos de recuperación sin usar y cuántos equipos de confianza válidos le quedan, último cambio de contraseña, intentos fallidos y hasta cuándo está bloqueado (NULL si no lo está). Nunca hashes ni secretos. La app autoriza ANTES; además no devuelve filas salvo a la propia persona, a un superadmin o a quien administra algún nodo donde p_user tiene una membership no quitada (0067). Ver db/migrations/0064 y 0067.';

REVOKE ALL ON FUNCTION admin_user_security(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_user_security(UUID) TO app_user;
