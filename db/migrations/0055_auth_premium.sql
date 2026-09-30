-- 0055_auth_premium.sql
-- Puestos simultáneos por nodo, cierre por inactividad, MFA exigido por el servidor, "recordar este
-- equipo" y tokens de un solo uso. Decisiones del founder del 2026-09-29 (docs/platform/12).
--
-- Qué resuelve:
--
--   - Un puesto se compartía entre varias personas: no había límite de sesiones simultáneas ni por
--     usuario ni por nodo. Ahora cada nodo puede tener un cupo de sesiones concurrentes (licencia
--     estilo GDS) que fija el superadmin; un nodo sin cupo propio consume del ancestro más cercano
--     que lo tenga, y si ninguno lo tiene no hay límite. Cada sesión guarda el nodo del cupo que
--     consume al emitirse (`seat_tenant_id`), así contar puestos no recorre el árbol.
--   - Una sesión abierta en una PC de agencia vivía 12 h sin que nadie la usara. Ahora cada sesión
--     guarda su tope de inactividad (`idle_timeout_seconds`, snapshot del valor efectivo del nodo al
--     emitir) y la inactividad libera el puesto.
--   - El MFA "obligatorio" era un redirect del panel: la API no sabía si la sesión había pasado el
--     segundo factor. Ahora lo guarda la sesión (`mfa_verified_at`) y la API lo exige.
--   - El enrolamiento pisaba el secreto activo: el secreto nuevo espera en `mfa_pending_secret`
--     hasta que el usuario demuestra que su app genera códigos válidos.
--   - El desafío MFA no tenía estado: no había límite de intentos ni consumo de un solo uso
--     (`mfa_challenges`).
--   - No había "recordar este equipo" (`trusted_devices`).
--   - El token para liberar un puesto al entrar tiene que servir una sola vez (`consumed_tokens`).
--
-- Las sesiones abiertas antes de esta migración NO se marcan como verificadas con MFA: no hay forma
-- de saber cuáles pasaron el segundo factor (un switch-tenant desde una sesión sin MFA emitía otra
-- sin MFA). Quien tenga un rol con MFA obligatorio vuelve a ingresar una vez, con su código. Tampoco
-- consumen puesto hasta el próximo login: nadie tiene cupo todavía.
--
-- Las funciones SECURITY DEFINER NO autorizan: la aplicación decide ANTES quién puede llamarlas
-- (NetworkService.canManageTenant, superadmin, regla de reset de MFA), igual que revoke_user_sessions
-- (0026). Existen porque `sessions`, `mfa_recovery_codes` y `trusted_devices` tienen RLS por usuario
-- y el camino administrativo necesita tocar filas de OTRO usuario.

-- ============================================================================
-- 1. tenants: cupo de puestos e inactividad, heredables
-- ============================================================================
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS concurrent_seats INT
    CONSTRAINT tenants_concurrent_seats_range CHECK (concurrent_seats BETWEEN 1 AND 10000),
  ADD COLUMN IF NOT EXISTS idle_timeout_minutes INT
    CONSTRAINT tenants_idle_timeout_minutes_range CHECK (idle_timeout_minutes BETWEEN 5 AND 480);

COMMENT ON COLUMN tenants.concurrent_seats IS
  'Sesiones simultáneas que admite el nodo (1-10000). NULL = consume del ancestro más cercano que lo tenga (seat_pool_of); si ninguno, sin límite. Sólo lo fija el superadmin. Ver db/migrations/0055.';
COMMENT ON COLUMN tenants.idle_timeout_minutes IS
  'Minutos sin actividad antes de cerrar la sesión (5-480). NULL = hereda del ancestro más cercano; si ninguno, 30 (effective_idle_timeout_minutes). Sólo lo fija el superadmin. Ver db/migrations/0055.';

-- ============================================================================
-- 2. sessions: inactividad, puesto consumido y segundo factor
-- ============================================================================
-- El rango de `idle_timeout_seconds` es el de tenants.idle_timeout_minutes en segundos: además de
-- validar, atrapa el error de guardar minutos donde van segundos (30 en vez de 1800).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS idle_timeout_seconds INT NOT NULL DEFAULT 1800
    CONSTRAINT sessions_idle_timeout_seconds_range CHECK (idle_timeout_seconds BETWEEN 300 AND 28800),
  ADD COLUMN IF NOT EXISTS seat_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mfa_verified_at TIMESTAMPTZ;

-- Camino caliente del login con cupo: contar las sesiones vivas de un pool bajo el advisory lock.
CREATE INDEX IF NOT EXISTS idx_sessions_seat_pool
  ON sessions (seat_tenant_id, last_seen_at)
  WHERE revoked_at IS NULL;

COMMENT ON COLUMN sessions.idle_timeout_seconds IS
  'Tope de inactividad de ESTA sesión, snapshot de effective_idle_timeout_minutes(tenant) * 60 al emitirla. Pasado last_seen_at + este valor, la sesión se revoca con revoked_reason = idle_timeout y deja de ocupar puesto.';
COMMENT ON COLUMN sessions.seat_tenant_id IS
  'Nodo del cupo que consume esta sesión (seat_pool_of del tenant al emitir). NULL = no consume puesto: usuario de plataforma o nodo sin límite.';
COMMENT ON COLUMN sessions.mfa_verified_at IS
  'La sesión pasó el segundo factor (TOTP, código de recuperación o equipo de confianza). NULL en un rol con MFA obligatorio = la API responde MFA_STEP_UP_REQUIRED.';
COMMENT ON COLUMN sessions.last_seen_at IS
  'Última actividad. Se refresca de forma perezosa (si tiene más de 60 s) y define la inactividad junto con idle_timeout_seconds; el ping pasivo del panel valida sin tocarla.';

-- ============================================================================
-- 3. users: secreto MFA pendiente
-- ============================================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;

COMMENT ON COLUMN users.mfa_pending_secret IS
  'Secreto TOTP nuevo (enrolamiento o "cambiar de teléfono"), cifrado igual que mfa_secret. El activo no se toca hasta que /auth/mfa/confirm verifica un código contra este.';

-- ============================================================================
-- 4. mfa_challenges: el desafío del segundo factor, con estado
-- ============================================================================
-- Antes el desafío era sólo un JWT de 5 minutos: se podía probar códigos sin límite mientras
-- viviera, y cada intento con forma de código de recuperación costaba 10 bcrypt. El `id` viaja como
-- `jti` del mfaToken; la API corta a los 5 intentos y cada fallo suma además al lockout de la
-- contraseña (users.failed_login_attempts).
--
-- Consumo atómico: UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL
-- AND attempts < 5 RETURNING ...; 0 filas = consumido, vencido o sin intentos.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),  -- viaja como `jti` del mfaToken
  user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts         INT          NOT NULL DEFAULT 0 CONSTRAINT mfa_challenges_attempts_nonneg CHECK (attempts >= 0),
  remember_device  BOOLEAN      NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  consumed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges (user_id, created_at DESC);

COMMENT ON TABLE mfa_challenges IS
  'Desafíos MFA del login. Máximo 5 intentos por desafío; consumido, vencido o sin intentos ya no sirve y se vuelve a la contraseña. Ver db/migrations/0055.';
COMMENT ON COLUMN mfa_challenges.remember_device IS
  'Se pidió "recordar este equipo" en el login: al pasar el segundo factor se emite un trusted_device.';

-- Mismo criterio user-scope que sessions (0026) y mfa_recovery_codes (0027): la API conoce el
-- usuario por el `sub` firmado del mfaToken y fija app.current_user_id antes de tocar la fila.
ALTER TABLE mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_challenges FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_challenges_self ON mfa_challenges;
CREATE POLICY mfa_challenges_self ON mfa_challenges
  USING      (user_id::text = current_setting('app.current_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_user_id', true));

GRANT SELECT, INSERT, UPDATE ON mfa_challenges TO app_user;
-- Append-mostly, como sessions: la limpieza de vencidos es un job, no la app.
REVOKE DELETE ON mfa_challenges FROM app_user;

-- ============================================================================
-- 5. trusted_devices: "recordar este equipo"
-- ============================================================================
-- Se guarda sólo el SHA-256 (hex) del token, como password_reset_tokens (0028): el token en claro
-- vive únicamente en la cookie httpOnly del navegador.
--
-- Un equipo es de confianza sólo si:
--
--   revoked_at IS NULL AND expires_at > now()
--   AND created_at > COALESCE(users.password_changed_at, '-infinity')
--   AND created_at > COALESCE(users.mfa_enabled_at,      '-infinity')
--
-- Así un cambio de contraseña o un re-enrolamiento los invalida a todos sin barrer la tabla. El
-- reset de MFA deja mfa_enabled_at en NULL, así que ése sí los revoca explícitamente
-- (admin_reset_user_mfa).
CREATE TABLE IF NOT EXISTS trusted_devices (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT         NOT NULL UNIQUE
                             CONSTRAINT trusted_devices_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            INET,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
  ON trusted_devices (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE trusted_devices IS
  'Equipos de confianza ("recordar este equipo", 30 días): con uno válido el login no pide el segundo factor. Válido si no está revocado ni vencido y es posterior a users.password_changed_at y a users.mfa_enabled_at. Ver db/migrations/0055.';
COMMENT ON COLUMN trusted_devices.token_hash IS 'sha256 hex del token en claro, que sólo vive en la cookie st_trusted.';

ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_devices FORCE  ROW LEVEL SECURITY;

-- En el login la API ya verificó la contraseña, así que conoce el usuario y busca el hash con su
-- contexto: un token robado de otro usuario no encuentra fila.
DROP POLICY IF EXISTS trusted_devices_self ON trusted_devices;
CREATE POLICY trusted_devices_self ON trusted_devices
  USING      (user_id::text = current_setting('app.current_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_user_id', true));

GRANT SELECT, INSERT, UPDATE ON trusted_devices TO app_user;
-- "Quitar" un equipo es revocarlo (queda el rastro), no borrarlo.
REVOKE DELETE ON trusted_devices FROM app_user;

-- ============================================================================
-- 6. consumed_tokens: tokens firmados de un solo uso
-- ============================================================================
-- Un JWT firmado no se puede "gastar": el de liberación de puesto (5 min) serviría para desconectar
-- a otra persona una y otra vez. Consumir = INSERT ... ON CONFLICT (jti) DO NOTHING RETURNING jti;
-- 0 filas = ya se usó.
--
-- SIN RLS, deliberadamente, como password_reset_tokens (0028): el token se canjea antes de que
-- exista una sesión y la fila no tiene usuario. La seguridad está en la firma del token; esta tabla
-- sólo recuerda qué jti ya se usaron.
CREATE TABLE IF NOT EXISTS consumed_tokens (
  jti          UUID         PRIMARY KEY,
  purpose      TEXT         NOT NULL CONSTRAINT consumed_tokens_purpose_format CHECK (purpose ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  consumed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ  NOT NULL
);

-- Para el job que purga los vencidos (pasado expires_at el token ya no valida por firma).
CREATE INDEX IF NOT EXISTS idx_consumed_tokens_expires ON consumed_tokens (expires_at);

COMMENT ON TABLE consumed_tokens IS
  'jti de tokens firmados de un solo uso ya canjeados (p. ej. seat_release). Se purgan pasado expires_at. Ver db/migrations/0055.';

REVOKE ALL ON consumed_tokens FROM app_user;
GRANT SELECT, INSERT ON consumed_tokens TO app_user;

-- ============================================================================
-- 7. Herencia por la jerarquía: pool de puestos e inactividad efectiva
-- ============================================================================
-- Gana el ancestro-o-propio más profundo con valor, como el branding (0030). Sin filtro por
-- `status`: un consolidador suspendido sigue siendo quien fija el cupo de su red, y su red no opera
-- igual (SessionService.validate).
CREATE OR REPLACE FUNCTION seat_pool_of(p_tenant UUID)
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT a.id
    FROM tenants t
    JOIN tenants a ON a.path OPERATOR(public.@>) t.path   -- ancestros de p_tenant, él incluido
   WHERE t.id = p_tenant
     AND a.concurrent_seats IS NOT NULL
   ORDER BY nlevel(a.path) DESC
   LIMIT 1;
$$;

COMMENT ON FUNCTION seat_pool_of(UUID) IS
  'Nodo cuyo cupo consume p_tenant: el ancestro-o-propio más profundo con concurrent_seats. NULL = sin límite. Ver db/migrations/0055.';

CREATE OR REPLACE FUNCTION effective_idle_timeout_minutes(p_tenant UUID)
RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT a.idle_timeout_minutes
       FROM tenants t
       JOIN tenants a ON a.path OPERATOR(public.@>) t.path   -- ancestros de p_tenant, él incluido
      WHERE t.id = p_tenant
        AND a.idle_timeout_minutes IS NOT NULL
      ORDER BY nlevel(a.path) DESC
      LIMIT 1),
    30
  );
$$;

COMMENT ON FUNCTION effective_idle_timeout_minutes(UUID) IS
  'Minutos de inactividad que rigen para p_tenant: el ancestro-o-propio más profundo con idle_timeout_minutes; si ninguno (o p_tenant NULL), 30. Ver db/migrations/0055.';

-- ============================================================================
-- 8. Puestos en uso y quién los ocupa
-- ============================================================================
-- Una sesión ocupa puesto si no está revocada, no venció su absoluto y no superó su propio tope de
-- inactividad. Esta última condición es la que hace que "la inactividad libera el puesto" aunque
-- nadie haya revocado todavía la sesión (se revoca recién en su próximo request).
--
-- `p_exclude_user`: quien está entrando. Su sesión anterior se reemplaza en la misma transacción
-- (una sesión por usuario), así que no cuenta contra su propio ingreso.
--
-- Sólo cuentan (y se listan) las sesiones cuyo nodo sigue debajo del cupo. TenantsService.move
-- cierra en su transacción las que quedarían en el cupo de la red vieja, pero un login que calculó
-- seat_pool_of antes de que el movimiento se comprometiera inserta DESPUÉS su sesión con el cupo
-- viejo (su INSERT espera el bloqueo del subárbol que toma move_tenant_subtree). Con el filtro esa
-- sesión no le ocupa un puesto a la red vieja ni muestra el nombre, el email, la IP o el navegador
-- de alguien de otra red en el 409 SEATS_FULL o en GET /tenants/:id/seats de su admin.
CREATE OR REPLACE FUNCTION seats_in_use(p_pool UUID, p_exclude_user UUID)
RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM sessions s
    JOIN tenants t    ON t.id = s.tenant_id
    JOIN tenants pool ON pool.id = p_pool
   WHERE s.seat_tenant_id = p_pool
     AND t.path OPERATOR(public.<@) pool.path   -- su nodo sigue debajo del cupo
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'
     AND s.user_id IS DISTINCT FROM p_exclude_user;
$$;

COMMENT ON FUNCTION seats_in_use(UUID, UUID) IS
  'Sesiones vivas (no revocadas, no vencidas, dentro de su inactividad) que ocupan el cupo p_pool y cuyo nodo sigue debajo de p_pool, sin contar las de p_exclude_user (NULL = contarlas todas). Llamar bajo pg_advisory_xact_lock(hashtextextended(''seat:'' || pool, 0)). Ver db/migrations/0055.';

CREATE OR REPLACE FUNCTION pool_active_sessions(p_pool UUID)
RETURNS TABLE (
  session_id    UUID,
  user_id       UUID,
  email         TEXT,
  name          TEXT,
  tenant_id     UUID,
  tenant_name   TEXT,
  issued_at     TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id,
         s.user_id,
         u.email::text,
         u.name,
         s.tenant_id,
         t.name,
         s.issued_at,
         s.last_seen_at,
         host(s.ip),   -- `ip::text` agregaría la máscara ("203.0.113.7/32")
         s.user_agent
    FROM sessions s
    JOIN users u      ON u.id = s.user_id
    JOIN tenants t    ON t.id = s.tenant_id
    JOIN tenants pool ON pool.id = p_pool
   WHERE s.seat_tenant_id = p_pool
     AND t.path OPERATOR(public.<@) pool.path   -- su nodo sigue debajo del cupo
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'
   ORDER BY s.last_seen_at DESC;
$$;

COMMENT ON FUNCTION pool_active_sessions(UUID) IS
  'Sesiones que ocupan el cupo p_pool (mismas condiciones que seats_in_use, incluido que su nodo siga debajo de p_pool), con usuario, nodo y dispositivo, de la más reciente a la más vieja. La app filtra al subárbol que administra quien mira. Ver db/migrations/0055.';

-- ============================================================================
-- 9. Revocar una sesión ajena
-- ============================================================================
-- Liberar un puesto (un admin desde Equipo, o quien queda afuera y administra el nodo del cupo)
-- toca la sesión de OTRO usuario, que sessions_self no deja ver.
CREATE OR REPLACE FUNCTION revoke_session(p_session UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  WITH revoked AS (
    UPDATE sessions
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE id = p_session
       AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM revoked);
$$;

COMMENT ON FUNCTION revoke_session(UUID, TEXT) IS
  'Revoca UNA sesión de cualquier usuario; false si no existía o ya estaba revocada. SECURITY DEFINER: la autorización (administrar el nodo de la sesión) la valida la app ANTES. Ver db/migrations/0055.';

-- ============================================================================
-- 10. Reset de MFA de un miembro que perdió el teléfono
-- ============================================================================
-- Deja al usuario sin segundo factor y sin nada que lo reemplace: ni códigos de recuperación, ni
-- equipos de confianza, ni desafíos pendientes, ni sesiones abiertas. Si su rol exige MFA, el
-- próximo login lo manda a enrolarse de nuevo.
--
-- También levanta el bloqueo por intentos: quien perdió el teléfono suele haber probado códigos (o
-- códigos de recuperación viejos) hasta bloquear la cuenta, y sin esto seguía 15 minutos sin poder
-- entrar con su contraseña correcta después de que el admin lo ayudara. El admin ya confirmó que
-- es la persona.
CREATE OR REPLACE FUNCTION admin_reset_user_mfa(p_user UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users
     SET mfa_secret            = NULL,
         mfa_pending_secret    = NULL,
         mfa_enabled_at        = NULL,
         mfa_last_used_step    = NULL,
         failed_login_attempts = 0,
         locked_until          = NULL
   WHERE id = p_user;

  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;

  -- Revocar y no confiar en el filtro por mfa_enabled_at: con MFA en NULL ese filtro deja de
  -- invalidar nada.
  UPDATE trusted_devices
     SET revoked_at = now()
   WHERE user_id = p_user
     AND revoked_at IS NULL;

  UPDATE mfa_challenges
     SET consumed_at = now()
   WHERE user_id = p_user
     AND consumed_at IS NULL;

  PERFORM revoke_user_sessions(p_user, 'mfa_reset');
END;
$$;

COMMENT ON FUNCTION admin_reset_user_mfa(UUID) IS
  'Quita el MFA de un usuario: secreto activo y pendiente, códigos de recuperación, equipos de confianza, desafíos pendientes y sesiones (revoked_reason = mfa_reset), y levanta el bloqueo por intentos fallidos. La autorización (administrar todos sus nodos y superarlo en rango, o superadmin) la valida la app ANTES. Ver db/migrations/0055.';

-- ============================================================================
-- 11. Vista de Equipo para el admin
-- ============================================================================
-- `users` no tiene RLS pero `sessions` sí (por usuario): sin DEFINER un admin no podría contar las
-- sesiones de su equipo. Cubre a quien tenga una membership (de cualquier estado) en el subárbol de
-- p_tenant; las sesiones se cuentan sólo las abiertas en ese subárbol.
CREATE OR REPLACE FUNCTION user_admin_overview(p_tenant UUID)
RETURNS TABLE (
  user_id          UUID,
  last_login_at    TIMESTAMPTZ,
  mfa_enabled      BOOLEAN,
  locked_until     TIMESTAMPTZ,
  active_sessions  INTEGER
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
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
             AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second')
    FROM team
    JOIN users u ON u.id = team.user_id;
$$;

COMMENT ON FUNCTION user_admin_overview(UUID) IS
  'Por cada usuario con membership en el subárbol de p_tenant: último login, si tiene MFA activo, hasta cuándo está bloqueado (NULL si no lo está) y cuántas sesiones vivas tiene en ese subárbol. La app valida canManageTenant(p_tenant) ANTES. Ver db/migrations/0055.';

-- ============================================================================
-- 12. Aplicar una BAJA de inactividad a las sesiones vivas
-- ============================================================================
-- El tope de inactividad es un snapshot al emitir. Si el superadmin lo baja de 8 h a 15 min, quien
-- ya está conectado seguiría con 8 h hasta volver a entrar: esto baja el de cada sesión viva del
-- subárbol de p_tenant al valor efectivo de SU nodo (que respeta un override más profundo).
--
-- Sólo BAJA, nunca sube. Una subida rige para las sesiones nuevas (SeatsService.updatePolicy no
-- llama a esta función), así que conviven snapshots MENORES que el valor efectivo de su nodo. Si
-- esto igualara en vez de bajar, bajar un ancestro estiraría esas sesiones: la agencia que subió a
-- 8 h propias sin tocar sus sesiones abiertas de 1 h las vería pasar a 8 h cuando el consolidador
-- baja de 60 a 15 min, justo cuando alguien pidió más seguridad.
--
-- `revoked_at IS NULL` se repite en el UPDATE y no queda sólo en `target`: si un login concurrente
-- reemplaza la sesión entre la foto de `target` y el UPDATE, en READ COMMITTED Postgres re-evalúa
-- el WHERE del UPDATE contra la versión comprometida y la saltea en vez de tocar una revocada.
-- `sessions` tiene RLS por usuario, de ahí el DEFINER.
CREATE OR REPLACE FUNCTION refresh_session_idle_timeouts(p_tenant UUID)
RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  WITH root AS (
    SELECT path FROM tenants WHERE id = p_tenant
  ),
  target AS (
    SELECT s.id, effective_idle_timeout_minutes(s.tenant_id) * 60 AS seconds
      FROM sessions s
      JOIN tenants t ON t.id = s.tenant_id
      CROSS JOIN root
     WHERE t.path OPERATOR(public.<@) root.path
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       -- Sólo las que siguen ocupando puesto: una que ya superó su tope sin que nadie la revocara
       -- (se revoca en su próximo request) ya está afuera; bajárselo no cambia nada y no debe
       -- contar como alcanzada en el evento de auditoría.
       AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'
  ),
  updated AS (
    UPDATE sessions s
       SET idle_timeout_seconds = target.seconds
      FROM target
     WHERE s.id = target.id
       AND s.revoked_at IS NULL
       AND target.seconds < s.idle_timeout_seconds
    RETURNING 1
  )
  SELECT count(*)::int FROM updated;
$$;

COMMENT ON FUNCTION refresh_session_idle_timeouts(UUID) IS
  'Baja idle_timeout_seconds de las sesiones vivas (no revocadas, no vencidas, dentro de su inactividad) del subárbol de p_tenant al valor efectivo de su nodo; nunca lo sube (una subida rige para las sesiones nuevas). Devuelve cuántas bajaron. Para PATCH /admin/tenants/:id/seats cuando la inactividad efectiva baja (sólo superadmin, validado en la app). Ver db/migrations/0055.';

-- ============================================================================
-- 13. Permisos de las funciones
-- ============================================================================
-- Las funciones nacen ejecutables por PUBLIC; éstas pasan por encima de la RLS, así que sólo el rol
-- de la API las ejecuta.
REVOKE ALL ON FUNCTION seat_pool_of(UUID)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION effective_idle_timeout_minutes(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION seats_in_use(UUID, UUID)             FROM PUBLIC;
REVOKE ALL ON FUNCTION pool_active_sessions(UUID)           FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_session(UUID, TEXT)           FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_reset_user_mfa(UUID)           FROM PUBLIC;
REVOKE ALL ON FUNCTION user_admin_overview(UUID)            FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_session_idle_timeouts(UUID)  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION seat_pool_of(UUID)                   TO app_user;
GRANT EXECUTE ON FUNCTION effective_idle_timeout_minutes(UUID) TO app_user;
GRANT EXECUTE ON FUNCTION seats_in_use(UUID, UUID)             TO app_user;
GRANT EXECUTE ON FUNCTION pool_active_sessions(UUID)           TO app_user;
GRANT EXECUTE ON FUNCTION revoke_session(UUID, TEXT)           TO app_user;
GRANT EXECUTE ON FUNCTION admin_reset_user_mfa(UUID)           TO app_user;
GRANT EXECUTE ON FUNCTION user_admin_overview(UUID)            TO app_user;
GRANT EXECUTE ON FUNCTION refresh_session_idle_timeouts(UUID)  TO app_user;
