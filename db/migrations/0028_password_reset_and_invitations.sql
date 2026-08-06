-- 0028_password_reset_and_invitations.sql
-- Recuperación de contraseña e invitaciones por token.
--
-- Problema que resuelve: no existía "olvidé mi contraseña" (un usuario bloqueado sólo
-- podía recuperarse pidiéndole a un admin que le fijara una contraseña nueva), y el alta
-- de usuarios obligaba al admin a ELEGIR y CONOCER la contraseña del invitado
-- (admin.controller.ts createUser recibe `password`). Eso significa que toda contraseña
-- inicial de la red nace conocida por un tercero.
--
-- Diseño de tokens: se guarda sólo el SHA-256 del token; el valor en claro viaja una
-- única vez por email y nunca se persiste. Un dump de estas tablas no permite usarlos.

-- ============================================================================
-- Reset de contraseña
-- ============================================================================
CREATE TABLE password_reset_tokens (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT         NOT NULL UNIQUE,     -- sha256(token en claro)
  expires_at    TIMESTAMPTZ  NOT NULL,
  used_at       TIMESTAMPTZ,
  requested_ip  INET,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);

COMMENT ON TABLE  password_reset_tokens          IS 'Tokens de reset de un solo uso. Se persiste sólo el hash; el token en claro viaja únicamente por email.';
COMMENT ON COLUMN password_reset_tokens.used_at IS 'Marca de consumo. Un token usado no se reutiliza aunque no haya expirado.';

-- SIN RLS, deliberadamente: el token se canjea ANTES de autenticarse, así que no hay
-- app.current_user_id que pueda filtrar. La seguridad descansa en que el token es un
-- secreto de alta entropía, se guarda hasheado y expira. Mismo criterio explícito que
-- la decisión de no poner RLS en `users` (0001:85-87).
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO app_user;
REVOKE DELETE ON password_reset_tokens FROM app_user;

-- ============================================================================
-- Invitaciones de usuario
-- ============================================================================
CREATE TABLE user_invitations (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       CITEXT       NOT NULL,
  -- Mismo invariante que 0025: una invitación tampoco puede conceder roles de plataforma.
  role        TEXT         NOT NULL CHECK (role IN (
                             'consolidator_admin', 'tenant_admin', 'agency_admin',
                             'admin', 'vendedor', 'cliente_final'
                           )),
  token_hash  TEXT         NOT NULL UNIQUE,
  invited_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ  NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_invitations_tenant  ON user_invitations(tenant_id, created_at DESC);
CREATE INDEX idx_user_invitations_pending ON user_invitations(email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE user_invitations IS 'Invitaciones pendientes. El invitado elige su propia contraseña al aceptar: el admin nunca la conoce.';

-- RLS jerárquica para el LISTADO (un admin ve las invitaciones de su subárbol y nada más),
-- reutilizando la misma lógica de subárbol que memberships (0020).
ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_invitations_subtree ON user_invitations
  USING      (can_read_membership(tenant_id))
  WITH CHECK (can_read_membership(tenant_id));

-- El canje ocurre pre-autenticación, donde la policy de arriba no puede aplicar.
-- SECURITY DEFINER acotado: resuelve UNA invitación por hash de token y sólo si está
-- vigente. No permite enumerar ni listar.
CREATE FUNCTION find_pending_invitation(p_token_hash TEXT)
  RETURNS TABLE (id UUID, tenant_id UUID, email CITEXT, role TEXT)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT i.id, i.tenant_id, i.email, i.role
  FROM user_invitations i
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL
    AND i.revoked_at  IS NULL
    AND i.expires_at  > now();
$$;

CREATE FUNCTION accept_invitation(p_invitation_id UUID)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public
AS $$
  UPDATE user_invitations SET accepted_at = now() WHERE id = p_invitation_id;
$$;

COMMENT ON FUNCTION find_pending_invitation(TEXT) IS
  'Resuelve una invitación vigente por hash de token en el flujo pre-auth. SECURITY DEFINER acotado: devuelve como máximo una fila y no permite enumeración.';

GRANT SELECT, INSERT, UPDATE ON user_invitations TO app_user;
GRANT EXECUTE ON FUNCTION find_pending_invitation(TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION accept_invitation(UUID) TO app_user;
