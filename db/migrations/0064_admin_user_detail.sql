-- 0064_admin_user_detail.sql
-- La ficha de una persona para quien la administra: cada sesión abierta y el estado de su seguridad.
--
-- Qué resuelve: Equipo y el directorio de la plataforma mostraban de cada persona sólo un resumen
-- (último ingreso, 2FA sí o no, bloqueo, cuántas sesiones). Para dar soporte con datos reales hace
-- falta ver cada sesión abierta (equipo, IP, nodo, última actividad) y poder cerrar una sola, y saber
-- cuántos códigos de recuperación y equipos de confianza le quedan. Las tres tablas tienen RLS por
-- usuario (sessions 0026, mfa_recovery_codes 0027, trusted_devices 0055): sin estas funciones
-- SECURITY DEFINER un admin no puede leer las de otro.
--
-- No autorizan: la API decide ANTES quién puede llamarlas (MemberDetailService: administrar el nodo
-- de la ruta y que la persona tenga una membership en su subárbol, o ser superadmin), igual que las
-- DEFINER de 0055. Como 0063, además no devuelven nada a quien no podría verlo aunque la API lo
-- olvide: `admin_user_sessions` sin raíz sólo responde a un superadmin y con raíz sólo a quien
-- administra esa raíz (can_read_membership, el predicado de la RLS de memberships); la seguridad,
-- sólo a la propia persona, a un superadmin o a quien administra algún nodo donde ella tiene
-- membership.
--
-- Nunca devuelven hashes de tokens, secretos de MFA ni contraseñas: de los códigos y los equipos,
-- sólo cuántos hay. La IP y el navegador de cada sesión sí, como la vista de puestos (0055).
--
-- "Viva" es lo mismo que en user_admin_overview (0055) y en el cupo de puestos: no revocada, no
-- vencida y dentro de su inactividad. Un equipo de confianza cuenta si de verdad le ahorra el
-- segundo factor (TrustedDeviceService): no revocado, no vencido y posterior al último cambio de
-- contraseña y al último enrolamiento de MFA.

CREATE OR REPLACE FUNCTION admin_user_sessions(p_user UUID, p_root UUID)
RETURNS TABLE (
  id              UUID,
  tenant_id       UUID,
  tenant_name     TEXT,
  issued_at       TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  ip              TEXT,
  user_agent      TEXT,
  mfa_verified    BOOLEAN,
  seat_tenant_id  UUID
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.id,
         s.tenant_id,
         t.name,
         s.issued_at,
         s.last_seen_at,
         s.expires_at,
         host(s.ip),   -- `ip::text` agregaría la máscara ("203.0.113.7/32")
         s.user_agent,
         s.mfa_verified_at IS NOT NULL,
         s.seat_tenant_id
    FROM sessions s
    LEFT JOIN tenants t ON t.id = s.tenant_id
   WHERE s.user_id = p_user
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'
     AND CASE
           WHEN p_root IS NULL THEN EXISTS (
             SELECT 1
               FROM memberships m
              WHERE m.user_id::text = current_setting('app.current_user_id', true)
                AND m.role = 'superadmin'
                AND m.status = 'active'
           )
           ELSE can_read_membership(p_root)
                AND t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = p_root)
         END
   ORDER BY s.last_seen_at DESC, s.id;
$$;

COMMENT ON FUNCTION admin_user_sessions(UUID, UUID) IS
  'Sesiones vivas (no revocadas, no vencidas, dentro de su inactividad) de p_user con su nodo, IP, navegador, si pasaron el segundo factor y el cupo que consumen; con p_root, sólo las abiertas en su subárbol; con NULL, todas (sólo superadmin). La app autoriza ANTES (administrar p_root y que p_user tenga membership en su subárbol, o superadmin); además no devuelve filas si app.current_user_id no administra p_root (can_read_membership) o, sin raíz, no es superadmin. Ver db/migrations/0064.';

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
            AND can_read_membership(tm.tenant_id)
       )
     );
$$;

COMMENT ON FUNCTION admin_user_security(UUID) IS
  'Seguridad de p_user para quien lo administra: desde cuándo tiene 2FA, cuántos códigos de recuperación sin usar y cuántos equipos de confianza válidos le quedan, último cambio de contraseña, intentos fallidos y hasta cuándo está bloqueado (NULL si no lo está). Nunca hashes ni secretos. La app autoriza ANTES; además no devuelve filas salvo a la propia persona, a un superadmin o a quien administra algún nodo donde p_user tiene membership. Ver db/migrations/0064.';

-- Las funciones nacen ejecutables por PUBLIC; éstas pasan por encima de la RLS por usuario.
REVOKE ALL ON FUNCTION admin_user_sessions(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_user_security(UUID)      FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin_user_sessions(UUID, UUID) TO app_user;
GRANT EXECUTE ON FUNCTION admin_user_security(UUID)      TO app_user;
