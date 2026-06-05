-- 0019_auth_security.sql
-- Hardening de sesiones/login: account lockout por usuario (defensa-en-profundidad
-- frente a brute-force distribuido, complementa el rate-limit por IP del throttler) +
-- traza de último login. Los eventos de auth (login OK/fallido/bloqueo, registro,
-- switch-tenant) se registran en domain_events desde la app (AuthService + AuditService).
-- Ver docs/platform/12 §6 (Tier 3 seguridad).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at         TIMESTAMPTZ;

COMMENT ON COLUMN users.failed_login_attempts IS 'Intentos de login fallidos consecutivos. Se resetea a 0 al loguear OK o al bloquear.';
COMMENT ON COLUMN users.locked_until          IS 'Si NOW() < locked_until la cuenta está bloqueada temporalmente (lockout anti brute-force).';
COMMENT ON COLUMN users.last_login_at         IS 'Timestamp del último login exitoso (trazabilidad de sesión).';
