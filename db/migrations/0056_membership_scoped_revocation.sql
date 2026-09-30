-- 0056_membership_scoped_revocation.sql
-- Suspender una membership corta ESE nodo, no a la persona; y una invitación vale mientras quien la
-- emitió la pueda seguir emitiendo. Brechas de la auditoría del 2026-09-29.
--
-- Qué resuelve:
--
--   - Suspender la membership de UN nodo llamaba a revoke_user_sessions() (0026), que cierra TODAS
--     las sesiones del usuario: un vendedor que opera en dos agencias quedaba afuera de las dos, y el
--     admin de una sucursal donde el superadmin es miembro podía cerrarle todas sus sesiones. El corte
--     del nodo ya lo hace SessionService.validate, que lee rol y estado de la membership en cada
--     request; lo que falta es liberar el puesto y avisarle al usuario, y eso se hace sólo con las
--     sesiones del subárbol del nodo (revoke_user_sessions_for_tenant).
--   - Una invitación pendiente sobrevivía a la baja de quien la emitió: un admin que se va invita a su
--     gmail como Manager, lo suspenden y acepta dentro de los 7 días. Ahora la app revoca, en la misma
--     transacción de la suspensión o la degradación, las invitaciones que el invitador ya no podría
--     emitir, y el canje revalida invitador y nodo antes de crear la membership. Qué rol alcanza para
--     emitir qué lo decide la app (ROLE_RANK en apps/api/src/auth/roles.ts, fuente única): la base
--     sólo junta los datos (invitation_backing).
--   - El canje buscaba la invitación (find_pending_invitation) y la marcaba aceptada después de crear
--     la membership, en otra sentencia y fuera de la transacción: dos canjes simultáneos del mismo
--     token pasaban los dos, y una revocación concurrente no lo frenaba. claim_pending_invitation la
--     marca en la misma transacción que crea la membership; si la revalidación falla, el rollback la
--     deja pendiente.
--
-- Como en 0026 y 0055, las funciones SECURITY DEFINER NO autorizan: la aplicación decide ANTES quién
-- puede llamarlas.

-- ============================================================================
-- 1. Revocar las sesiones de un usuario en un subárbol
-- ============================================================================
-- Sólo las sesiones emitidas en el subárbol de p_tenant cuyo nodo ya no tiene una membership ACTIVA
-- del usuario. Una sesión siempre se emite en un nodo donde el usuario tiene membership activa
-- (AuthService: login y switch-tenant), y de esa membership saca su rol. Si el usuario es admin de la
-- agencia y vendedor en una de sus sub-agencias, suspenderlo en la agencia no cierra la sesión de la
-- sub-agencia: esa sigue siendo legítima con su propio rol. Las potestades que le daba la agencia
-- sobre la sub-agencia se cortan solas (NetworkService.roleOver lee memberships activas).
--
-- Llamarla DESPUÉS de suspender la membership, en la misma transacción: si no, la de p_tenant todavía
-- figura activa y su sesión no se revoca.
CREATE OR REPLACE FUNCTION revoke_user_sessions_for_tenant(p_user UUID, p_tenant UUID, p_reason TEXT)
RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  WITH root AS (
    SELECT path FROM tenants WHERE id = p_tenant
  ),
  revoked AS (
    UPDATE sessions s
       SET revoked_at = now(), revoked_reason = p_reason
      FROM tenants t, root
     WHERE t.id = s.tenant_id
       AND t.path OPERATOR(public.<@) root.path   -- descendientes de p_tenant, él incluido
       AND s.user_id = p_user
       AND s.revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM memberships m
          WHERE m.user_id = p_user
            AND m.tenant_id = s.tenant_id
            AND m.status = 'active'
       )
    RETURNING 1
  )
  SELECT count(*)::int FROM revoked;
$$;

COMMENT ON FUNCTION revoke_user_sessions_for_tenant(UUID, UUID, TEXT) IS
  'Revoca las sesiones vivas de p_user emitidas en el subárbol de p_tenant cuyo nodo ya no tiene una membership activa suya; devuelve cuántas. Las de otros nodos, o las de un nodo del subárbol donde sigue activo, no se tocan. SECURITY DEFINER: sortea sessions_self para el camino administrativo; la autorización (administrar p_tenant y superar al usuario en rango) la valida la app ANTES. Ver db/migrations/0056.';

-- ============================================================================
-- 2. Qué respalda a una invitación
-- ============================================================================
-- Una invitación vale mientras su invitador la podría volver a emitir: usuario activo, con un rol que
-- supere al de la invitación sobre el nodo (el mismo que calcula NetworkService.roleOver), y el nodo
-- con sus ancestros activos. La base junta los datos y la app decide con ROLE_RANK.
--
-- `inviter_roles`: roles de las memberships ACTIVAS del invitador que le dan potestad sobre el nodo
-- de la invitación: superadmin en cualquier nodo, o cualquier rol en el nodo o en un ancestro (la app
-- filtra los de admin). Una membership colgada de un nodo suspendido no cuenta, como en roleOver.
--
-- SECURITY DEFINER porque tiene que ver memberships del invitador fuera de la red de quien pregunta
-- (un consolidator_admin que también es admin de una agencia sigue respaldando lo que invitó ahí
-- aunque lo suspendan en la agencia) y porque el canje ocurre antes de autenticarse.
CREATE OR REPLACE FUNCTION invitation_backing(p_invitations UUID[])
RETURNS TABLE (
  invitation_id   UUID,
  tenant_id       UUID,
  role            TEXT,
  invited_by      UUID,
  inviter_active  BOOLEAN,
  tenant_active   BOOLEAN,
  inviter_roles   TEXT[]
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT i.id,
         i.tenant_id,
         i.role,
         i.invited_by,
         COALESCE(u.status = 'active', false),
         NOT EXISTS (
           SELECT 1
             FROM tenants t
             JOIN tenants a ON a.path OPERATOR(public.@>) t.path
            WHERE t.id = i.tenant_id
              AND a.status <> 'active'
         ),
         COALESCE(
           (SELECT array_agg(DISTINCT m.role ORDER BY m.role)
              FROM memberships m
              JOIN tenants admin_t  ON admin_t.id  = m.tenant_id
              JOIN tenants target_t ON target_t.id = i.tenant_id
             WHERE m.user_id = i.invited_by
               AND m.status = 'active'
               AND (m.role = 'superadmin' OR admin_t.path OPERATOR(public.@>) target_t.path)
               AND NOT EXISTS (
                 SELECT 1
                   FROM tenants anc
                  WHERE anc.path OPERATOR(public.@>) admin_t.path
                    AND anc.status <> 'active'
               )),
           '{}'::text[]
         )
    FROM user_invitations i
    LEFT JOIN users u ON u.id = i.invited_by
   WHERE i.id = ANY(p_invitations);
$$;

COMMENT ON FUNCTION invitation_backing(UUID[]) IS
  'Por cada invitación: su nodo y rol, el invitador, si el invitador está activo, si el nodo y sus ancestros lo están, y los roles activos del invitador con potestad sobre el nodo (superadmin en cualquier nodo o cualquier rol en el nodo o un ancestro, sin nodos suspendidos en el camino). Si alcanzan para emitirla lo decide la app con ROLE_RANK. Ver db/migrations/0056.';

-- ============================================================================
-- 3. Canje atómico
-- ============================================================================
-- Reemplaza find_pending_invitation + accept_invitation en el canje: marca la invitación aceptada y
-- la devuelve en una sola sentencia, dentro de la transacción de quien canjea. Mientras esa
-- transacción no termina, la fila queda bloqueada: una revocación concurrente espera y, al ver
-- accepted_at, no la toca; un segundo canje del mismo token no encuentra fila. Si la revalidación
-- del invitador falla, el rollback de la app la devuelve a pendiente.
--
-- Como find_pending_invitation: resuelve UNA invitación por hash de token y no permite enumerar.
CREATE OR REPLACE FUNCTION claim_pending_invitation(p_token_hash TEXT)
RETURNS TABLE (id UUID, tenant_id UUID, email CITEXT, role TEXT, invited_by UUID)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE user_invitations i
     SET accepted_at = now()
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.revoked_at  IS NULL
     AND i.expires_at  > now()
  RETURNING i.id, i.tenant_id, i.email, i.role, i.invited_by;
$$;

COMMENT ON FUNCTION claim_pending_invitation(TEXT) IS
  'Canje pre-auth: marca aceptada la invitación vigente de ese hash de token y la devuelve (como máximo una fila). Llamarla dentro de la transacción que crea la membership: el rollback la devuelve a pendiente. Ver db/migrations/0056.';

-- ============================================================================
-- 4. Permisos
-- ============================================================================
REVOKE ALL ON FUNCTION revoke_user_sessions_for_tenant(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION invitation_backing(UUID[])                         FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_invitation(TEXT)                     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION revoke_user_sessions_for_tenant(UUID, UUID, TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION invitation_backing(UUID[])                         TO app_user;
GRANT EXECUTE ON FUNCTION claim_pending_invitation(TEXT)                     TO app_user;
