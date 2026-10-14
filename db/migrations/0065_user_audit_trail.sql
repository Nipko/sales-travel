-- 0065_user_audit_trail.sql
-- El historial de una persona: qué hizo y qué le hicieron.
--
-- Qué resuelve: el audit log (`domain_events`, 0015) sólo se leía como "Actividad de la red", los
-- últimos eventos del subárbol sin filtro. Para dar soporte hace falta responder por UNA persona:
-- sus ingresos, los cambios de su seguridad, quién la suspendió o le cambió el rol, y lo que ella
-- hizo sobre otros. Un evento es de la persona si lo hizo ella (`actor_user_id`), si el agregado es
-- su cuenta (`aggregate_type = 'user'`) o si la nombra como objetivo (`payload.targetUserId`, lo que
-- dejan las acciones de un admin sobre un miembro).
--
-- Dos alcances, como la ficha (0064):
--
--   - el admin de un nodo lee el historial con su contexto, por la RLS de domain_events (0029, su
--     subárbol) y acotado además al subárbol del nodo de la ruta. No necesita nada nuevo acá salvo
--     los índices: los eventos sin nodo (un login fallido, pedir restablecer la contraseña) no los
--     ve, y está bien, porque no son de su red;
--   - el superadmin necesita justamente ésos, y la RLS no se los deja leer a nadie (0029: la
--     potestad se mide sobre el nodo del evento). Para eso, y sólo para eso,
--     `platform_user_audit_trail`: SECURITY DEFINER, que la API llama DESPUÉS de comprobar que quien
--     pregunta es superadmin (UserAuditController) y que además no devuelve nada si
--     `app.current_user_id` no es superadmin (como 0063): un llamador nuevo que olvide el chequeo no
--     lee el historial de nadie.
--
-- El payload sale tal cual se guardó: domain_events nunca lleva secretos (0015) y `meta` (IP,
-- navegador, sesión) no sale.
--
-- domain_events es una tabla plana, no una hypertable (0015): los índices son comunes.

-- "Lo que hizo": por actor, en el orden del historial.
CREATE INDEX IF NOT EXISTS idx_domain_events_actor_time
  ON domain_events (actor_user_id, occurred_at DESC);

-- "Lo que le hicieron": por el objetivo del payload. En minúsculas porque algunos bordes del API
-- guardan el id tal como lo mandó el cliente; parcial, porque la mayoría de los eventos no lo traen.
CREATE INDEX IF NOT EXISTS idx_domain_events_target_user
  ON domain_events (lower(payload ->> 'targetUserId'), occurred_at DESC)
  WHERE payload ? 'targetUserId';

-- La persona sobre la que se hizo el evento, si no es quien lo hizo: la que nombra el payload o,
-- si el agregado es una cuenta, esa cuenta. Un id que no tiene forma de UUID se ignora en vez de
-- romper la consulta entera con un error de conversión. Es lo que el historial y la Actividad de la
-- red muestran como "a quién".
CREATE OR REPLACE FUNCTION audit_event_target_user(
  p_payload        JSONB,
  p_aggregate_type TEXT,
  p_aggregate_id   TEXT,
  p_actor          UUID
)
RETURNS UUID
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
           WHEN ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN NULLIF(ref::uuid, p_actor)
         END
    FROM (
      SELECT COALESCE(
               p_payload ->> 'targetUserId',
               CASE WHEN p_aggregate_type = 'user' THEN p_aggregate_id END
             ) AS ref
    ) target;
$$;

COMMENT ON FUNCTION audit_event_target_user(JSONB, TEXT, TEXT, UUID) IS
  'La cuenta sobre la que se hizo un evento de domain_events, si no es la de quien lo hizo: payload.targetUserId o, si el agregado es una cuenta (aggregate_type = user), esa cuenta. NULL si no hay o si no tiene forma de UUID. Ver db/migrations/0065.';

CREATE OR REPLACE FUNCTION platform_user_audit_trail(
  p_user      UUID,
  p_before    TIMESTAMPTZ,
  p_before_id UUID,
  p_limit     INTEGER
)
RETURNS TABLE (
  id             UUID,
  occurred_at    TIMESTAMPTZ,
  event_type     TEXT,
  tenant_id      UUID,
  tenant_name    TEXT,
  actor_email    TEXT,
  target_email   TEXT,
  aggregate_type TEXT,
  payload        JSONB
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH page AS (
    SELECT e.id, e.occurred_at, e.event_type, e.tenant_id, e.actor_user_id,
           e.aggregate_type, e.aggregate_id, e.payload
      FROM domain_events e
     WHERE (
             e.actor_user_id = p_user
             OR (e.aggregate_type = 'user' AND e.aggregate_id = p_user::text)
             OR (e.payload ? 'targetUserId' AND lower(e.payload ->> 'targetUserId') = p_user::text)
           )
       AND (p_before IS NULL OR (e.occurred_at, e.id) < (p_before, p_before_id))
       AND EXISTS (
         SELECT 1
           FROM memberships m
          WHERE m.user_id::text = current_setting('app.current_user_id', true)
            AND m.role = 'superadmin'
            AND m.status = 'active'
       )
     ORDER BY e.occurred_at DESC, e.id DESC
     -- 100 por página y uno más, para que la API sepa si hay otra.
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 101)
  )
  SELECT p.id, p.occurred_at, p.event_type, p.tenant_id, t.name, u.email, tu.email,
         p.aggregate_type, p.payload
    FROM page p
    LEFT JOIN tenants t  ON t.id  = p.tenant_id
    LEFT JOIN users   u  ON u.id  = p.actor_user_id
    LEFT JOIN users   tu ON tu.id = audit_event_target_user(
                                      p.payload, p.aggregate_type, p.aggregate_id, p.actor_user_id)
   ORDER BY p.occurred_at DESC, p.id DESC;
$$;

COMMENT ON FUNCTION platform_user_audit_trail(UUID, TIMESTAMPTZ, UUID, INTEGER) IS
  'Historial de p_user en toda la plataforma, eventos sin nodo incluidos (login fallido, pedir restablecer la contraseña): lo que hizo, lo que se hizo sobre su cuenta y lo que la nombra como objetivo. Del más nuevo al más viejo, antes de (p_before, p_before_id) si vienen, hasta 101 filas. Sin meta (IP, navegador). La app comprueba que quien pregunta es superadmin ANTES de llamarla; si app.current_user_id no es superadmin, no devuelve filas. Ver db/migrations/0065.';

-- Las funciones nacen ejecutables por PUBLIC; platform_user_audit_trail pasa por encima de la RLS de
-- domain_events. audit_event_target_user no lee nada, pero sigue la misma regla.
REVOKE ALL ON FUNCTION audit_event_target_user(JSONB, TEXT, TEXT, UUID)            FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_user_audit_trail(UUID, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION audit_event_target_user(JSONB, TEXT, TEXT, UUID)            TO app_user;
GRANT EXECUTE ON FUNCTION platform_user_audit_trail(UUID, TIMESTAMPTZ, UUID, INTEGER) TO app_user;
