-- 0002_memberships_self_policy.sql
-- Política adicional sobre memberships: el usuario autenticado puede ver sus propias
-- memberships SIN necesidad de tener tenant context activo. Esto habilita endpoints
-- como GET /me/memberships donde el usuario lista los tenants a los que pertenece
-- antes de "entrar" a uno.
--
-- PostgreSQL combina múltiples policies con OR, así que esta convive con
-- memberships_tenant_isolation creada en 0001.

CREATE POLICY memberships_self ON memberships
  FOR ALL
  USING       (user_id::text = current_setting('app.current_user_id', true))
  WITH CHECK  (user_id::text = current_setting('app.current_user_id', true));
