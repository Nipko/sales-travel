-- 0063_platform_user_directory.sql
-- El directorio de usuarios de toda la red para el superadmin (Plataforma → Usuarios).
--
-- Qué resuelve: el superadmin no tenía cómo encontrar a una persona sin saber en qué nodo está.
-- GET /admin/users pasa a ser un directorio paginado de identidades (una fila por persona, con
-- todos sus nodos y roles), con búsqueda por nombre o correo y filtros. `users` no tiene RLS
-- (identidad global, 0001) y la RLS de memberships le deja al superadmin leerlas todas (0020): la
-- API las lee con su contexto, sin funciones nuevas.
--
-- Lo único que la RLS no le deja leer son las sesiones (0026: cada usuario ve sólo las suyas), y el
-- directorio necesita el último acceso real y si la persona está en línea. Para eso, y sólo para
-- eso, `platform_user_session_stats`: devuelve por usuario la última actividad y cuántas sesiones
-- vivas tiene, nunca las sesiones (ni IP, ni dispositivo, ni nodo). Es SECURITY DEFINER: la API
-- comprueba que quien pregunta es superadmin ANTES de llamarla (AdminController → assertSuperadmin),
-- y además la función no devuelve nada si `app.current_user_id` no es superadmin (membership activa
-- con rol superadmin, espejo de NetworkService.isSuperadmin): un llamador nuevo que olvide el
-- chequeo no lee la actividad de toda la red.
--
-- "Viva" es lo mismo que en user_admin_overview (0055) y en el cupo de puestos: no revocada, no
-- vencida y dentro de su inactividad.

CREATE OR REPLACE FUNCTION platform_user_session_stats(p_users UUID[])
RETURNS TABLE (
  user_id          UUID,
  last_seen_at     TIMESTAMPTZ,
  active_sessions  INTEGER
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.user_id,
         max(s.last_seen_at),
         (count(*) FILTER (
           WHERE s.revoked_at IS NULL
             AND s.expires_at > now()
             AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'
         ))::int
    FROM sessions s
   WHERE s.user_id = ANY (p_users)
     AND EXISTS (
       SELECT 1
         FROM memberships m
        WHERE m.user_id::text = current_setting('app.current_user_id', true)
          AND m.role = 'superadmin'
          AND m.status = 'active'
     )
   GROUP BY s.user_id;
$$;

COMMENT ON FUNCTION platform_user_session_stats(UUID[]) IS
  'Por cada usuario de p_users con alguna sesión: su última actividad (max last_seen_at, revocadas incluidas) y cuántas sesiones vivas tiene (no revocadas, no vencidas, dentro de su inactividad). Para el directorio de usuarios de la plataforma: la app comprueba que quien pregunta es superadmin ANTES de llamarla; si app.current_user_id no es superadmin, no devuelve filas. Ver db/migrations/0063.';

-- Las funciones nacen ejecutables por PUBLIC; ésta pasa por encima de la RLS de sessions.
REVOKE ALL ON FUNCTION platform_user_session_stats(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_user_session_stats(UUID[]) TO app_user;

-- El orden del directorio (las altas más recientes primero) y su cursor (created_at, id).
CREATE INDEX IF NOT EXISTS idx_users_created_id ON users (created_at DESC, id DESC);
