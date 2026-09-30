-- 0061_users_last_tenant.sql
-- La última agencia con la que operó cada usuario, para abrir su próxima sesión en ella.
--
-- Qué resuelve: aceptar una invitación le suma a una cuenta existente una membership en otra
-- agencia, y el panel ahora deja cambiar de agencia (POST /auth/switch-tenant). Sin recordar la
-- elección, el próximo login volvía siempre a la membership más antigua y el panel, por su lado,
-- tomaba la primera por orden alfabético: dos criterios distintos para la misma persona.
--
-- El criterio único vive en la API (apps/api/src/auth/default-tenant.ts): la última con la que
-- operó si sigue activa y su nodo opera; si no, la más antigua que opera. Se escribe cada vez que
-- se emite una sesión con tenant (login, cambio de agencia, liberar un puesto).
--
-- Es una preferencia de navegación, no una autorización: la API vuelve a comprobar la membership y
-- el estado del nodo antes de usarla. Si el nodo se borra, se olvida sola (ON DELETE SET NULL).
-- `users` no tiene RLS (identidad global, 0001), así que no hacen falta políticas nuevas.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_tenant_id UUID
    REFERENCES tenants(id) ON DELETE SET NULL;

COMMENT ON COLUMN users.last_tenant_id IS
  'Última agencia con la que operó el usuario (0061). Preferencia para abrir la próxima sesión; la API la ignora si ya no tiene membership activa allí o el nodo no opera.';
