-- 0068_invitation_preview.sql
-- Lo que la página de la invitación muestra antes de aceptar (USR-17).
--
-- Qué resuelve: /invitacion era un formulario ciego. No decía a qué nodo ni con qué rol invitaban, y
-- a quien ya tenía cuenta le pedía una "contraseña nueva" que el canje ignoraba en silencio. Ahora la
-- página lee la invitación primero: "Te invitaron a {nodo} como {rol}", quién la mandó y si el correo
-- invitado ya tiene una cuenta. Con cuenta, la persona ingresa con la suya y acepta con la sesión
-- abierta (POST /invitations/join); sin cuenta, elige su contraseña como siempre.
--
-- Como find_pending_invitation (0028) y claim_pending_invitation (0056), corre antes de la sesión,
-- donde la RLS por subárbol de user_invitations (0028) no puede aplicar: SECURITY DEFINER acotado.
--   - Resuelve UNA invitación por hash de token, sólo si está vigente (ni aceptada, ni revocada, ni
--     vencida). No permite enumerar ni listar: sin el token no hay fila.
--   - Sólo lee (STABLE): no la marca aceptada ni toca nada. Mirarla no la gasta.
--   - Devuelve el id de la invitación (para revalidar a quien la emitió con invitation_backing, 0056)
--     y el id de la cuenta dueña del correo invitado, si la hay (CITEXT: sin distinguir mayúsculas).
--     Esos ids y el correo no salen de la API: al navegador sólo le llegan el nombre del nodo, el
--     rol, el nombre de quien invitó, el vencimiento y si el correo ya tiene cuenta. Que el correo
--     tenga cuenta lo sabe igual quien controla ese buzón, que es lo que prueba el token.

CREATE OR REPLACE FUNCTION preview_pending_invitation(p_token_hash TEXT)
RETURNS TABLE (
  invitation_id   UUID,
  tenant_name     TEXT,
  role            TEXT,
  inviter_name    TEXT,
  expires_at      TIMESTAMPTZ,
  invitee_user_id UUID
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.id,
         t.name,
         i.role,
         NULLIF(btrim(inviter.name), ''),
         i.expires_at,
         invitee.id
    FROM user_invitations i
    JOIN tenants t ON t.id = i.tenant_id
    LEFT JOIN users inviter ON inviter.id = i.invited_by
    LEFT JOIN users invitee ON invitee.email = i.email
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.revoked_at  IS NULL
     AND i.expires_at  > now()
   LIMIT 1;
$$;

COMMENT ON FUNCTION preview_pending_invitation(TEXT) IS
  'Vista previa pre-auth de la invitación vigente de ese hash de token (como máximo una fila, sin marcarla aceptada): nodo, rol, nombre de quien invitó, vencimiento y la cuenta dueña del correo invitado, si existe. Los ids no salen de la API. Ver db/migrations/0068.';

REVOKE ALL ON FUNCTION preview_pending_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preview_pending_invitation(TEXT) TO app_user;
