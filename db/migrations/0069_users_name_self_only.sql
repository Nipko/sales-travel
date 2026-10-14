-- 0069_users_name_self_only.sql
-- El nombre de una cuenta sólo lo cambia su dueño (USR-18).
--
-- Qué resuelve: ahora cada persona puede corregir su nombre visible desde Mi cuenta → Perfil
-- (PATCH /me). `users` no tiene RLS (identidad global, 0001: el login la lee por correo sin
-- contexto) y `app_user` puede actualizar cualquier fila, así que lo único que impedía cambiar el
-- nombre de OTRA cuenta era que la API usara el id de la sesión. Este trigger mueve esa regla a la
-- base, como 0025 con los roles de plataforma y 0055 con el autor de un permiso de reserva: un
-- endpoint futuro que actualice `users.name` con el id equivocado falla en vez de renombrar a otro.
--
-- Regla: si `app_user` (o cualquier rol que no se salta la RLS) cambia `users.name`, la fila tiene
-- que ser la de `app.current_user_id`, el usuario del request (DatabaseService.withRequestContext).
-- Sin contexto, o con el de otra cuenta, 42501 `users_name_self_only`. Migraciones, seeds y la
-- consola del operador corren con un rol que se salta la RLS y no los frena
-- (current_role_bypasses_rls, 0052/0060).
--
-- Sólo mira el nombre: el resto de las columnas de `users` (bloqueo, 2FA, contraseña, suspensión)
-- las siguen tocando el login y el soporte de un admin sobre otra cuenta, como hasta ahora. Y sólo
-- cuando el valor cambia de verdad: un UPDATE que repite el mismo nombre no dispara nada.
--
-- La forma del nombre (sin controles ni invisibles, 1 a 120, espacios colapsados) la valida el
-- borde del API (PersonNameSchema, packages/validation): la base no la repite, porque las cuentas
-- ya creadas pueden tener nombres que hoy no pasarían y un CHECK las dejaría sin poder tocarse.

CREATE OR REPLACE FUNCTION users_name_self_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_setting TEXT := current_setting('app.current_user_id', true);
BEGIN
  IF current_role_bypasses_rls() THEN
    RETURN NEW;
  END IF;

  IF actor_setting IS NULL
     OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR actor_setting::uuid IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING
      ERRCODE    = '42501',
      CONSTRAINT = 'users_name_self_only',
      TABLE      = 'users',
      MESSAGE    = 'el nombre de una cuenta sólo lo cambia su dueño',
      DETAIL     = format('cuenta %s, actúa %s', OLD.id, COALESCE(NULLIF(actor_setting, ''), 'ninguno'));
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION users_name_self_only() IS
  'Trigger de users: un rol que no se salta la RLS (app_user) sólo cambia el nombre de la cuenta de app.current_user_id; si no, 42501 users_name_self_only. Ver db/migrations/0069.';

DROP TRIGGER IF EXISTS users_name_self_only ON users;
CREATE TRIGGER users_name_self_only
  BEFORE UPDATE OF name ON users
  FOR EACH ROW
  WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION users_name_self_only();

-- Las funciones nacen ejecutables por PUBLIC. Un trigger no se llama a mano, pero sigue la regla de
-- las demás guardas.
REVOKE ALL ON FUNCTION users_name_self_only() FROM PUBLIC;

COMMENT ON COLUMN users.name IS
  'Nombre visible de la persona. Lo elige al aceptar la invitación y lo cambia sólo ella (PATCH /me, USR-18; trigger users_name_self_only, 0069).';
