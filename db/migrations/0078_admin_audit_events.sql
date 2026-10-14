-- 0078_admin_audit_events.sql
-- Plataforma → Actividad: quién hizo qué, dónde y cuándo, en toda la plataforma.
--
-- Qué resuelve: el audit log (`domain_events`, 0015) sólo se leía de a pedazos. La Actividad de la red
-- (Mi Red) mira un subárbol y deja fuera los eventos sin nodo; el historial de una persona (0065) mira
-- a una sola. Para investigar un incidente el founder necesita filtrar TODA la plataforma por
-- categoría, nodo, persona, entidad y fechas, con los eventos sin nodo (un ingreso fallido, el modo de
-- la retención en cascada), y exportar lo que encontró.
--
-- Mismas reglas que las demás lecturas de la consola (0075, ver su encabezado):
--
--   1. la función exige ELLA MISMA que quien pide sea el superadmin de la plataforma
--      (platform_console_require_superadmin(): si no, 42501 admin_superadmin_required, que la API
--      traduce a 403 con rethrowAdminDbError). La RLS de domain_events (0029) no le deja leer a nadie
--      los eventos sin nodo: esta función, SECURITY DEFINER, es la única puerta a la lista entera;
--   2. devuelve el payload tal cual se guardó (nunca lleva secretos, 0015; la API igual le pasa
--      redactPayload) y de `meta` SÓLO la IP, el navegador y el id del pedido: el id de la sesión no
--      sale de la base;
--   3. las lecturas están acotadas: un período obligatorio de hasta 93 días (la API admite 92 días
--      calendario de Bogotá; el día de más es margen para una zona con cambio de hora), paginación por
--      (occurred_at, id) y hasta 5001 filas (la página de la consola + 1, o la exportación de 5.000 + 1
--      para saber si se pasó).
--
-- Las categorías (Accesos, Equipo, Red, Carteras, Proveedores, Reservas, Sistema) son listas de
-- prefijos de `event_type` que arma la API (apps/api/src/audit/audit-categories.ts): p_type_prefixes
-- (alguno tiene que coincidir) y p_exclude_prefixes (ninguno). Así la vista "Todo" deja fuera los
-- latidos del barrido de post-venta (`system.*`, cada 15 minutos en la raíz) sin que la base tenga
-- que conocer las categorías. Se comparan con starts_with, no con LIKE: `wallet_hold.` lleva un `_`,
-- que en LIKE es un comodín.
--
-- La consulta va por RETURN QUERY EXECUTE con un texto FIJO y los valores en USING (nada se concatena):
-- cada llamada se planifica con sus valores, así un filtro por persona usa idx_domain_events_actor_time
-- (0065), uno por tipo exacto idx_domain_events_type_time (0015) y "todo en este período" el índice
-- nuevo por tiempo. Con un plan genérico, los `$n IS NULL OR …` dejarían una sola forma para todos.
--
-- La consume AdminAuditService (apps/api/src/audit/admin-audit.service.ts), con
-- withRequestContext({ userId }) para que app.current_user_id llegue a la guarda.
--
-- domain_events es una tabla plana (0015): el índice es común. search_path = pg_catalog, public,
-- pg_temp (posterior a 0060: nada lo endurece después; ver
-- apps/api/src/database/migrations-search-path.test.ts).
--
-- Despliegue: el runner corre cada migración en una transacción, así que el índice no puede ir
-- CONCURRENTLY. CREATE INDEX toma un lock SHARE sobre domain_events mientras se arma: las lecturas
-- siguen, pero cada escritura de auditoría (ingresos, reservas, cada emit) espera a que termine.
-- Medido en PG16 local: ~0,3 s por millón de filas (con un audit log de pocos millones son segundos,
-- como los índices de 0065). Antes de desplegar, mirar `SELECT count(*) FROM domain_events`: si pasa
-- de unos 10 millones, crear el índice a mano (`CREATE INDEX CONCURRENTLY IF NOT EXISTS
-- idx_domain_events_time ON domain_events (occurred_at DESC, id DESC);`, fuera de una transacción) y
-- esta línea queda en nada por el IF NOT EXISTS.

-- ============================================================================
-- 1. El orden de la Actividad: del más nuevo al más viejo, con el id para desempatar
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_domain_events_time
  ON domain_events (occurred_at DESC, id DESC);

-- ============================================================================
-- 2. Los eventos de toda la plataforma, filtrados
-- ============================================================================
-- Filtros (NULL = sin ese filtro, salvo el período):
--   - p_from / p_to: occurred_at en [p_from, p_to). Obligatorios, p_from < p_to, hasta 93 días;
--   - p_type_prefixes: el event_type empieza con alguno; p_exclude_prefixes: con ninguno;
--   - p_event_type: el event_type exacto;
--   - p_actor: quien lo hizo (actor_user_id);
--   - p_root: los eventos de ese nodo y de todo lo que cuelga de él (path). Sin p_root, los de todos
--     los nodos. Un p_root que no existe no da ninguna fila (la API responde 404 antes);
--   - p_include_platform: además los eventos sin nodo (tenant_id NULL). NULL = false;
--   - p_aggregate_type / p_aggregate_id: la entidad (`order` y su id, `user` y su id…), exactos;
--   - p_before / p_before_id: la página siguiente, después de ese evento. Van juntos.
--
-- Cada fila trae el nombre del nodo (NULL si no tiene, o si el nodo ya no existe), el correo de quien
-- lo hizo y el de la cuenta sobre la que se hizo (audit_event_target_user, 0065), si no es la misma.
--
-- Un filtro imposible (sin período, período vacío, al revés o de más de 93 días, cursor a medias) es
-- un error de programación de la app: 22023 admin_audit_filter_invalid.
CREATE FUNCTION admin_audit_events(
  p_from             TIMESTAMPTZ,
  p_to               TIMESTAMPTZ,
  p_type_prefixes    TEXT[],
  p_exclude_prefixes TEXT[],
  p_event_type       TEXT,
  p_actor            UUID,
  p_root             UUID,
  p_include_platform BOOLEAN,
  p_aggregate_type   TEXT,
  p_aggregate_id     TEXT,
  p_before           TIMESTAMPTZ,
  p_before_id        UUID,
  p_limit            INTEGER
)
RETURNS TABLE (
  id             UUID,
  occurred_at    TIMESTAMPTZ,
  event_type     TEXT,
  tenant_id      UUID,
  tenant_name    TEXT,
  actor_user_id  UUID,
  actor_email    TEXT,
  target_email   TEXT,
  aggregate_type TEXT,
  aggregate_id   TEXT,
  payload        JSONB,
  meta           JSONB
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_limit     INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 5001);
  v_root_path public.ltree;
BEGIN
  PERFORM public.platform_console_require_superadmin();

  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_audit_filter_invalid',
      DETAIL = format('desde %s hasta %s', COALESCE(p_from::text, 'NULL'), COALESCE(p_to::text, 'NULL'));
  END IF;
  IF p_to - p_from > interval '93 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_audit_filter_invalid',
      DETAIL = format('el período tiene más de 93 días: desde %s hasta %s', p_from, p_to);
  END IF;
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_audit_filter_invalid',
      DETAIL = 'p_before y p_before_id van juntos';
  END IF;

  IF p_root IS NOT NULL THEN
    SELECT r.path INTO v_root_path FROM public.tenants r WHERE r.id = p_root;
    IF v_root_path IS NULL THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY EXECUTE $q$
    WITH page AS (
      SELECT e.id, e.occurred_at, e.event_type, e.tenant_id, t.name AS tenant_name,
             e.actor_user_id, e.aggregate_type, e.aggregate_id, e.payload, e.meta
        FROM public.domain_events e
        LEFT JOIN public.tenants t ON t.id = e.tenant_id
       WHERE e.occurred_at >= $1
         AND e.occurred_at <  $2
         AND ($11::timestamptz IS NULL OR (e.occurred_at, e.id) < ($11, $12))
         AND (CASE
                WHEN e.tenant_id IS NULL THEN $8
                WHEN $7::public.ltree IS NULL THEN true
                ELSE t.path OPERATOR(public.<@) $7
              END)
         AND ($3::text[] IS NULL
              OR EXISTS (SELECT 1 FROM unnest($3) AS inc(prefix)
                          WHERE starts_with(e.event_type, inc.prefix)))
         AND ($4::text[] IS NULL
              OR NOT EXISTS (SELECT 1 FROM unnest($4) AS exc(prefix)
                              WHERE starts_with(e.event_type, exc.prefix)))
         AND ($5::text IS NULL OR e.event_type = $5)
         AND ($6::uuid IS NULL OR e.actor_user_id = $6)
         AND ($9::text IS NULL OR e.aggregate_type = $9)
         AND ($10::text IS NULL OR e.aggregate_id = $10)
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT $13
    )
    SELECT p.id, p.occurred_at, p.event_type, p.tenant_id, p.tenant_name::text, p.actor_user_id,
           u.email::text, tu.email::text, p.aggregate_type, p.aggregate_id, p.payload,
           jsonb_build_object(
             'ip',        p.meta -> 'ip',
             'userAgent', p.meta -> 'userAgent',
             'requestId', p.meta -> 'requestId'
           )
      FROM page p
      LEFT JOIN public.users u  ON u.id  = p.actor_user_id
      LEFT JOIN public.users tu ON tu.id = public.audit_event_target_user(
                                             p.payload, p.aggregate_type, p.aggregate_id,
                                             p.actor_user_id)
     ORDER BY p.occurred_at DESC, p.id DESC
  $q$
  USING p_from, p_to, p_type_prefixes, p_exclude_prefixes, p_event_type, p_actor, v_root_path,
        COALESCE(p_include_platform, false), p_aggregate_type, p_aggregate_id, p_before,
        p_before_id, v_limit;
END;
$$;

COMMENT ON FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer) IS
  'Plataforma → Actividad: los eventos de domain_events de toda la plataforma en [p_from, p_to) (obligatorio, hasta 93 días), filtrados por prefijos de event_type (incluir y excluir), tipo exacto, actor, nodo con su subárbol (p_root), eventos sin nodo (p_include_platform) y entidad, del más nuevo al más viejo, paginados por (occurred_at, id) y hasta 5001. Cada fila trae el nodo, el correo de quien lo hizo y el de la cuenta sobre la que se hizo; de meta sólo ip, userAgent y requestId (nunca sessionId). Sólo el superadmin de la plataforma. Ver db/migrations/0078.';

-- Las funciones nacen ejecutables por PUBLIC; ésta pasa por encima de la RLS de domain_events.
REVOKE ALL ON FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer) TO app_user;
