-- 0026_auth_sessions.sql
-- Sesiones revocables.
--
-- Problema que resuelve: hasta ahora el JWT era stateless con TTL de 24h y el
-- middleware sólo verificaba la firma (request-context.middleware.ts). Consecuencia:
-- suspender a un usuario, borrarle la membership o expulsar a una agencia de la red NO
-- surtía efecto hasta 24h después, y el logout sólo borraba la cookie del navegador
-- mientras el bearer seguía siendo válido. En un consolidador eso significa que un
-- vendedor despedido o una agencia dada de baja conserva acceso a órdenes, clientes y
-- credenciales BYOC heredadas.
--
-- Diseño: cada login crea una fila aquí; el `id` de la fila viaja en el claim `jti` del
-- token. El middleware valida que la sesión exista, no esté revocada y no haya expirado.
-- Revocar = UPDATE revoked_at, con efecto inmediato.

CREATE TABLE sessions (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),  -- viaja como claim `jti`
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID         REFERENCES tenants(id) ON DELETE CASCADE, -- tenant activo al emitir
  issued_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ  NOT NULL,
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  ip              INET,
  user_agent      TEXT
);

CREATE INDEX idx_sessions_user        ON sessions(user_id, issued_at DESC);
CREATE INDEX idx_sessions_expires     ON sessions(expires_at);
-- Camino caliente: el middleware valida la sesión en cada request.
CREATE INDEX idx_sessions_active      ON sessions(id) WHERE revoked_at IS NULL;

COMMENT ON TABLE  sessions            IS 'Sesiones emitidas. El id es el claim jti del access token; permite revocación inmediata.';
COMMENT ON COLUMN sessions.tenant_id  IS 'Tenant activo en el momento de emitir. switch-tenant emite una sesión nueva.';
COMMENT ON COLUMN sessions.last_seen_at IS 'Se refresca de forma perezosa (no en cada request) para poder listar sesiones activas.';

-- Invalidación por cambio de contraseña: cualquier token emitido antes de este
-- timestamp se rechaza, incluso si su sesión siguiera viva.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

COMMENT ON COLUMN users.password_changed_at IS 'Cambio de contraseña más reciente. Invalida sesiones anteriores.';

-- ============================================================================
-- RLS: una sesión pertenece a un usuario, no a un tenant.
-- ============================================================================
-- Se aísla por usuario (no por tenant): un usuario puede ver y revocar SUS sesiones
-- —"cerrar sesión en todos los dispositivos", listado de dispositivos activos— y
-- ninguna otra. Mismo criterio de user-scope que memberships_self (0002).
--
-- La revocación administrativa (suspender a un usuario de la red) NO pasa por esta
-- policy: usa revoke_user_sessions(), SECURITY DEFINER, cuya autorización se resuelve
-- en la capa de aplicación contra la jerarquía (NetworkService.canManageTenant).
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;

CREATE POLICY sessions_self ON sessions
  USING      (user_id::text = current_setting('app.current_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_user_id', true));

CREATE FUNCTION revoke_user_sessions(target_user_id UUID, reason TEXT)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public
AS $$
  WITH revoked AS (
    UPDATE sessions
       SET revoked_at = now(), revoked_reason = reason
     WHERE user_id = target_user_id
       AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM revoked;
$$;

COMMENT ON FUNCTION revoke_user_sessions(UUID, TEXT) IS
  'Revoca todas las sesiones activas de un usuario. SECURITY DEFINER: sortea sessions_self para el camino administrativo. La autorización jerárquica se valida en la aplicación ANTES de llamarla.';

GRANT SELECT, INSERT, UPDATE ON sessions TO app_user;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(UUID, TEXT) TO app_user;
-- Append-mostly: nadie borra sesiones desde la app (la limpieza de expiradas es un job).
REVOKE DELETE ON sessions FROM app_user;
