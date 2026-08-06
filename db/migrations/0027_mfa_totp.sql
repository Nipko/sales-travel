-- 0027_mfa_totp.sql
-- MFA TOTP (RFC 6238). CLAUDE.md lo declara requisito NO negociable para tenant_admin y
-- superiores; hasta ahora no existía nada: ni columnas, ni endpoints, ni enforcement.
--
-- Por qué importa en un consolidador: comprometer una sola cuenta tenant_admin
-- (phishing, credential stuffing) entrega el control de toda una sub-red, incluidas las
-- credenciales BYOC heredadas del consolidador.

ALTER TABLE users
  -- Secreto TOTP cifrado con AES-256-GCM por CredentialsCipher (misma clave maestra
  -- fuera de la DB que usa provider-credentials). NUNCA en claro.
  ADD COLUMN IF NOT EXISTS mfa_secret          TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at      TIMESTAMPTZ,
  -- Anti-replay: último "step" TOTP consumido (unix_time / 30). Un código robado del
  -- shoulder-surfing o de un proxy no se puede reutilizar dentro de su propia ventana.
  ADD COLUMN IF NOT EXISTS mfa_last_used_step  BIGINT;

COMMENT ON COLUMN users.mfa_secret         IS 'Secreto TOTP cifrado (AES-256-GCM). Nunca se devuelve por API tras el enrolamiento.';
COMMENT ON COLUMN users.mfa_enabled_at     IS 'MFA activo si no es NULL. Se setea recién al verificar el primer código, no al generar el secreto.';
COMMENT ON COLUMN users.mfa_last_used_step IS 'Último step TOTP consumido. Impide reusar el mismo código dentro de su ventana.';

-- ============================================================================
-- Códigos de recuperación (un solo uso)
-- ============================================================================
CREATE TABLE mfa_recovery_codes (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- bcrypt, igual que las contraseñas: si se filtra la tabla no se puede usar ninguno.
  code_hash   TEXT         NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_mfa_recovery_user ON mfa_recovery_codes(user_id) WHERE used_at IS NULL;

COMMENT ON TABLE mfa_recovery_codes IS 'Códigos de recuperación MFA de un solo uso, hasheados con bcrypt. Se regeneran en bloque, nunca individualmente.';

-- Mismo criterio user-scope que sessions (0026) y memberships_self (0002).
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE  ROW LEVEL SECURITY;

CREATE POLICY mfa_recovery_self ON mfa_recovery_codes
  USING      (user_id::text = current_setting('app.current_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO app_user;
