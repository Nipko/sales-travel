-- 0075_platform_console_reads.sql
-- Lecturas de TODA la red para la consola de la plataforma (Plataforma → Resumen), seguras en la base.
--
-- Qué resuelve: el superadmin no tenía una pantalla que le dijera cómo va la plataforma. Inicio mira
-- sólo la agencia activa y Mi Red sólo cuenta órdenes y cotizaciones. Las tablas operativas (orders,
-- quotations, order_operations, hotel_order_tracking, sessions, wallet_hold_groups, conciliación)
-- tienen RLS forzada por tenant o por usuario, así que leer la red entera exige funciones SECURITY
-- DEFINER.
--
-- Por qué no una policy "el superadmin ve todo" en cada tabla: los servicios que hoy leen el tenant
-- activo confían en la RLS para acotar, y algunos no repiten el filtro por tenant_id. Con una policy
-- amplia, cualquier pantalla que el superadmin abra en su agencia empezaría a devolver filas de toda
-- la red. Acá cada lectura cruzada es una función con nombre, que:
--
--   1. exige ELLA MISMA que quien pide sea el superadmin de la plataforma
--      (is_platform_superadmin(); si no, 42501 admin_superadmin_required). No confía sólo en la
--      app, a diferencia de network_sales_summary (0014): defensa en profundidad. Las migraciones
--      siguientes de la consola (0076-0079) usan el mismo predicado y el mismo mensaje, que la API
--      traduce a 403 con rethrowAdminDbError (apps/api/src/network/superadmin.errors.ts);
--   2. devuelve AGREGADOS (conteos y sumas por moneda) o, en admin_order_attention, sólo el número,
--      el localizador y el estado de la orden: nunca datos de pasajeros ni de contacto;
--   3. las del Resumen aceptan un nodo raíz (p_root) para mirar el subárbol de un consolidador; NULL
--      es toda la red. Las admin_* devuelven el tenant de cada fila y quien las llama acota.
--
-- Nunca se suman monedas distintas: todo monto sale agrupado por moneda.
--
-- Las consume AdminOverviewService (apps/api/src/admin-console), que corre con
-- withRequestContext({ userId }) para que app.current_user_id llegue a estas funciones. Las admin_*
-- (secciones 7 a 10) son además la base de las consolas siguientes: Reservas de la red (ADM-4),
-- Agencias con puestos e impacto (ADM-9), Procesos (ADM-11) y la ficha de cada nodo (ADM-13).
--
-- search_path = pg_catalog, public, pg_temp en todas (posterior a 0060: nada las endurece después;
-- ver apps/api/src/database/migrations-search-path.test.ts).

-- ============================================================================
-- 1. ¿Quién pide es el superadmin de la plataforma?
-- ============================================================================
-- Espejo del criterio de can_finance_tenant (0052) para el superadmin: membership ACTIVA con rol
-- superadmin en el tenant de tipo platform y usuario activo. `platform_admin` está retirado (D7 B) y
-- no cuenta, como en el resto del panel de la plataforma. Sin usuario en el request, o con un valor que
-- no es un UUID, false.
--
-- SECURITY DEFINER para leer memberships sin re-disparar su RLS (mismo patrón que 0020).
CREATE FUNCTION is_platform_superadmin()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_setting TEXT := current_setting('app.current_user_id', true);
BEGIN
  IF actor_setting IS NULL
     OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.users u   ON u.id = m.user_id
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE m.user_id = actor_setting::uuid
       AND m.role = 'superadmin'
       AND m.status = 'active'
       AND u.status = 'active'
       AND t.tenant_type = 'platform'
  );
END;
$$;

COMMENT ON FUNCTION is_platform_superadmin() IS
  '¿El usuario de app.current_user_id es el superadmin de la plataforma (membership activa con rol superadmin en el tenant platform, usuario activo)? Gobierna las lecturas de toda la red de la consola. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION is_platform_superadmin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_platform_superadmin() TO app_user;

-- La guarda con que empieza cada lectura de la consola. Sin GRANT: la llaman las funciones de abajo,
-- que corren con su dueño.
CREATE FUNCTION platform_console_require_superadmin()
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'admin_superadmin_required',
      DETAIL  = format('app.current_user_id = %L',
                       COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), '(sin valor)')),
      HINT    = 'Sólo el superadmin de la plataforma lee la red entera. Un nodo se lee con su tenant en app.current_tenant_id.';
  END IF;
END;
$$;

COMMENT ON FUNCTION platform_console_require_superadmin() IS
  'Si app.current_user_id no es el superadmin de la plataforma, 42501 admin_superadmin_required. Helper de 0075, sin GRANT.';

REVOKE ALL ON FUNCTION platform_console_require_superadmin() FROM PUBLIC;

-- Los nodos que mira la consola: el subárbol de p_root (él incluido) o, con NULL, toda la red. Un
-- p_root que no existe no da ningún nodo (la app responde 404 antes). Sin GRANT.
CREATE FUNCTION platform_console_scope(p_root UUID)
RETURNS TABLE (tenant_id UUID)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id
    FROM public.tenants t
   WHERE p_root IS NULL
      OR t.path OPERATOR(public.<@) (SELECT r.path FROM public.tenants r WHERE r.id = p_root);
$$;

COMMENT ON FUNCTION platform_console_scope(uuid) IS
  'Los ids del subárbol de p_root (él incluido), o de toda la red con NULL. Helper de 0075, sin GRANT.';

REVOKE ALL ON FUNCTION platform_console_scope(uuid) FROM PUBLIC;

-- El período que piden. Un período vacío o al revés es un error de programación de la app.
CREATE FUNCTION platform_console_check_period(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'platform_console_period_invalid',
      DETAIL  = format('desde %s hasta %s', COALESCE(p_from::text, 'NULL'), COALESCE(p_to::text, 'NULL'));
  END IF;
END;
$$;

COMMENT ON FUNCTION platform_console_check_period(timestamptz, timestamptz) IS
  'Período [p_from, p_to) no vacío; si no, 22023 platform_console_period_invalid. Helper de 0075, sin GRANT.';

REVOKE ALL ON FUNCTION platform_console_check_period(timestamptz, timestamptz) FROM PUBLIC;

-- ============================================================================
-- 2. Ventas del período
-- ============================================================================
-- Órdenes creadas en [p_from, p_to), por moneda, proveedor, vertical declarada y estado. La vertical
-- es la que la fila declara en search_criteria.vertical: la de las filas que no la declaran la
-- resuelve la API por proveedor (salesVertical en apps/api/src/reports), como los reportes.
CREATE FUNCTION platform_overview_orders(p_root UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  currency          TEXT,
  provider          TEXT,
  declared_vertical TEXT,
  status            TEXT,
  orders            BIGINT,
  amount_minor      NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  PERFORM public.platform_console_check_period(p_from, p_to);

  RETURN QUERY
    SELECT upper(btrim(o.currency))::text,
           o.provider::text,
           (o.search_criteria ->> 'vertical')::text,
           o.status::text,
           count(*)::bigint,
           COALESCE(sum(o.total_amount), 0)::numeric
      FROM public.orders o
      JOIN public.platform_console_scope(p_root) s ON s.tenant_id = o.tenant_id
     WHERE o.created_at >= p_from
       AND o.created_at <  p_to
     GROUP BY 1, 2, 3, 4;
END;
$$;

COMMENT ON FUNCTION platform_overview_orders(uuid, timestamptz, timestamptz) IS
  'Órdenes creadas en [p_from, p_to) del subárbol de p_root (NULL = toda la red), agrupadas por moneda, proveedor, vertical declarada y estado: cantidad y suma de total_amount (unidades menores). Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_orders(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_orders(uuid, timestamptz, timestamptz) TO app_user;

-- La tendencia mensual de lo confirmado (confirmed y ticketed), por mes calendario en p_tz y moneda.
CREATE FUNCTION platform_overview_trend(
  p_root UUID,
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ,
  p_tz   TEXT
)
RETURNS TABLE (
  month        TEXT,
  currency     TEXT,
  orders       BIGINT,
  amount_minor NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  PERFORM public.platform_console_check_period(p_from, p_to);

  RETURN QUERY
    SELECT to_char(o.created_at AT TIME ZONE p_tz, 'YYYY-MM')::text,
           upper(btrim(o.currency))::text,
           count(*)::bigint,
           COALESCE(sum(o.total_amount), 0)::numeric
      FROM public.orders o
      JOIN public.platform_console_scope(p_root) s ON s.tenant_id = o.tenant_id
     WHERE o.created_at >= p_from
       AND o.created_at <  p_to
       AND o.status IN ('confirmed', 'ticketed')
     GROUP BY 1, 2;
END;
$$;

COMMENT ON FUNCTION platform_overview_trend(uuid, timestamptz, timestamptz, text) IS
  'Lo confirmado (confirmed, ticketed) en [p_from, p_to) del subárbol de p_root, por mes calendario en la zona p_tz y moneda. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_trend(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_trend(uuid, timestamptz, timestamptz, text) TO app_user;

-- Los nodos que más reservas confirmaron en el período (hasta p_limit, máximo 50), y lo que vendió
-- cada uno en cada moneda. El ranking es por CANTIDAD de reservas confirmadas: ordenar por monto
-- obligaría a sumar monedas distintas.
CREATE FUNCTION platform_overview_top_nodes(
  p_root  UUID,
  p_from  TIMESTAMPTZ,
  p_to    TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (
  tenant_id    UUID,
  name         TEXT,
  slug         TEXT,
  tenant_type  TEXT,
  is_branch    BOOLEAN,
  status       TEXT,
  orders_total BIGINT,
  currency     TEXT,
  orders       BIGINT,
  amount_minor NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  PERFORM public.platform_console_check_period(p_from, p_to);

  RETURN QUERY
    WITH confirmed AS (
      SELECT o.tenant_id AS node,
             upper(btrim(o.currency)) AS cur,
             o.total_amount AS amount
        FROM public.orders o
        JOIN public.platform_console_scope(p_root) s ON s.tenant_id = o.tenant_id
       WHERE o.created_at >= p_from
         AND o.created_at <  p_to
         AND o.status IN ('confirmed', 'ticketed')
    ),
    ranked AS (
      SELECT c.node, count(*) AS n
        FROM confirmed c
        JOIN public.tenants t ON t.id = c.node
       GROUP BY c.node, t.name
       ORDER BY count(*) DESC, t.name, c.node
       LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
    )
    SELECT t.id,
           t.name::text,
           t.slug::text,
           t.tenant_type::text,
           t.is_branch,
           t.status::text,
           r.n::bigint,
           c.cur::text,
           count(*)::bigint,
           COALESCE(sum(c.amount), 0)::numeric
      FROM ranked r
      JOIN public.tenants t ON t.id = r.node
      JOIN confirmed c      ON c.node = r.node
     GROUP BY t.id, t.name, t.slug, t.tenant_type, t.is_branch, t.status, r.n, c.cur
     ORDER BY r.n DESC, t.name, t.id, c.cur;
END;
$$;

COMMENT ON FUNCTION platform_overview_top_nodes(uuid, timestamptz, timestamptz, integer) IS
  'Los nodos del subárbol de p_root con más reservas confirmadas en [p_from, p_to) (hasta p_limit, máx. 50), con lo vendido por moneda. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_top_nodes(uuid, timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_top_nodes(uuid, timestamptz, timestamptz, integer) TO app_user;

-- Las cotizaciones creadas en el período, por estado.
CREATE FUNCTION platform_overview_quotations(p_root UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  status     TEXT,
  quotations BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  PERFORM public.platform_console_check_period(p_from, p_to);

  RETURN QUERY
    SELECT q.status::text, count(*)::bigint
      FROM public.quotations q
      JOIN public.platform_console_scope(p_root) s ON s.tenant_id = q.tenant_id
     WHERE q.created_at >= p_from
       AND q.created_at <  p_to
     GROUP BY 1;
END;
$$;

COMMENT ON FUNCTION platform_overview_quotations(uuid, timestamptz, timestamptz) IS
  'Cotizaciones creadas en [p_from, p_to) del subárbol de p_root, por estado. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_quotations(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_quotations(uuid, timestamptz, timestamptz) TO app_user;

-- ============================================================================
-- 3. La red: nodos, personas y sesiones
-- ============================================================================
-- Una fila. Los nodos no cuentan la raíz platform. Las personas son las que tienen una membership en
-- el subárbol (las de la plataforma también, si se mira toda la red):
--   - users_active: usuario activo con al menos una membership activa;
--   - users_suspended: cuenta suspendida en toda la plataforma;
--   - users_locked: bloqueada ahora por intentos fallidos;
--   - admins_without_mfa: usuario activo con un rol de admin activo y sin segundo factor (el MFA es
--     obligatorio para tenant_admin y superiores, CLAUDE.md);
--   - users_logged_in: activos cuyo último ingreso cae en el período;
--   - live_sessions: sesiones vivas en el subárbol (no revocadas, no vencidas y dentro de su
--     inactividad), como user_admin_overview (0055).
CREATE FUNCTION platform_overview_network(p_root UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  nodes_total        BIGINT,
  nodes_active       BIGINT,
  nodes_suspended    BIGINT,
  nodes_archived     BIGINT,
  consolidators      BIGINT,
  agencies           BIGINT,
  branches           BIGINT,
  subagencies        BIGINT,
  nodes_created      BIGINT,
  users_active       BIGINT,
  users_suspended    BIGINT,
  users_locked       BIGINT,
  admins_without_mfa BIGINT,
  users_logged_in    BIGINT,
  live_sessions      BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  PERFORM public.platform_console_check_period(p_from, p_to);

  RETURN QUERY
    WITH scope AS (
      SELECT s.tenant_id FROM public.platform_console_scope(p_root) s
    ),
    nodes AS (
      SELECT t.status, t.tenant_type, t.is_branch, t.created_at
        FROM public.tenants t
        JOIN scope ON scope.tenant_id = t.id
       WHERE t.tenant_type <> 'platform'
    ),
    people AS (
      SELECT u.id,
             u.status,
             u.locked_until,
             u.mfa_enabled_at,
             u.last_login_at,
             bool_or(m.status = 'active') AS has_active,
             bool_or(m.status = 'active'
                     AND m.role IN ('superadmin', 'platform_admin', 'consolidator_admin',
                                    'tenant_admin', 'agency_admin', 'admin')) AS is_admin
        FROM public.memberships m
        JOIN scope ON scope.tenant_id = m.tenant_id
        JOIN public.users u ON u.id = m.user_id
       GROUP BY u.id, u.status, u.locked_until, u.mfa_enabled_at, u.last_login_at
    )
    SELECT
      (SELECT count(*) FROM nodes)::bigint,
      (SELECT count(*) FROM nodes n WHERE n.status = 'active')::bigint,
      (SELECT count(*) FROM nodes n WHERE n.status = 'suspended')::bigint,
      (SELECT count(*) FROM nodes n WHERE n.status = 'archived')::bigint,
      (SELECT count(*) FROM nodes n WHERE n.tenant_type = 'consolidator')::bigint,
      (SELECT count(*) FROM nodes n WHERE n.tenant_type = 'agency' AND NOT n.is_branch)::bigint,
      (SELECT count(*) FROM nodes n WHERE n.tenant_type = 'agency' AND n.is_branch)::bigint,
      (SELECT count(*) FROM nodes n WHERE n.tenant_type = 'subagency')::bigint,
      (SELECT count(*) FROM nodes n WHERE n.created_at >= p_from AND n.created_at < p_to)::bigint,
      (SELECT count(*) FROM people p WHERE p.status = 'active' AND p.has_active)::bigint,
      (SELECT count(*) FROM people p WHERE p.status = 'suspended')::bigint,
      (SELECT count(*) FROM people p WHERE p.locked_until > now())::bigint,
      (SELECT count(*) FROM people p
        WHERE p.status = 'active' AND p.is_admin AND p.mfa_enabled_at IS NULL)::bigint,
      (SELECT count(*) FROM people p
        WHERE p.status = 'active' AND p.has_active
          AND p.last_login_at >= p_from AND p.last_login_at < p_to)::bigint,
      (SELECT count(*)
         FROM public.sessions se
         JOIN scope ON scope.tenant_id = se.tenant_id
        WHERE se.revoked_at IS NULL
          AND se.expires_at > now()
          AND se.last_seen_at > now() - se.idle_timeout_seconds * interval '1 second')::bigint;
END;
$$;

COMMENT ON FUNCTION platform_overview_network(uuid, timestamptz, timestamptz) IS
  'Una fila con los nodos (sin la raíz platform) por estado y tipo, las personas con membership en el subárbol de p_root (activas, suspendidas, bloqueadas, admins sin MFA, ingresaron en el período) y las sesiones vivas. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_network(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_network(uuid, timestamptz, timestamptz) TO app_user;

-- ============================================================================
-- 4. Carteras: cupo dado, deuda y saldo a favor por moneda
-- ============================================================================
-- balance_minor positivo es saldo a favor y negativo es deuda (0010). Además, lo que financia
-- Planetour (tenant_financier_id es la raíz platform, o no hay financiador): su propia exposición.
CREATE FUNCTION platform_overview_wallets(p_root UUID)
RETURNS TABLE (
  currency                    TEXT,
  wallets                     BIGINT,
  credit_limit_minor          NUMERIC,
  debt_minor                  NUMERIC,
  funds_minor                 NUMERIC,
  overlimit                   BIGINT,
  suspended                   BIGINT,
  platform_credit_limit_minor NUMERIC,
  platform_debt_minor         NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();

  RETURN QUERY
    WITH w AS (
      SELECT upper(btrim(p.currency)) AS cur,
             p.credit_limit_minor,
             p.balance_minor,
             p.status,
             (f.id IS NULL OR f.tenant_type = 'platform') AS by_platform
        FROM public.agency_portfolios p
        JOIN public.platform_console_scope(p_root) s ON s.tenant_id = p.tenant_id
        LEFT JOIN public.tenants f ON f.id = public.tenant_financier_id(p.tenant_id)
    )
    SELECT w.cur::text,
           count(*)::bigint,
           COALESCE(sum(w.credit_limit_minor), 0)::numeric,
           COALESCE(sum(-w.balance_minor) FILTER (WHERE w.balance_minor < 0), 0)::numeric,
           COALESCE(sum(w.balance_minor) FILTER (WHERE w.balance_minor > 0), 0)::numeric,
           count(*) FILTER (WHERE w.status = 'overlimit')::bigint,
           count(*) FILTER (WHERE w.status = 'suspended')::bigint,
           COALESCE(sum(w.credit_limit_minor) FILTER (WHERE w.by_platform), 0)::numeric,
           COALESCE(sum(-w.balance_minor) FILTER (WHERE w.by_platform AND w.balance_minor < 0), 0)::numeric
      FROM w
     GROUP BY w.cur;
END;
$$;

COMMENT ON FUNCTION platform_overview_wallets(uuid) IS
  'Por moneda, las carteras del subárbol de p_root: cuántas, cupo total, deuda (saldo negativo), saldo a favor, sobregiradas y suspendidas, y el cupo y la deuda de lo que financia Planetour. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_wallets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_wallets(uuid) TO app_user;

-- ============================================================================
-- 5. Lo que espera a una persona
-- ============================================================================
-- La post-venta, por tipo de operación, mirando la ÚLTIMA operación de cada orden y tipo (un reintento
-- reusa la fila o agrega una nueva; la última dice cómo quedó):
--   - failed: la última falló y nada la reemplazó;
--   - stuck: sigue pending desde antes de p_stuck_before (en vuelo más de lo que puede durar).
CREATE FUNCTION platform_overview_post_sale(p_root UUID, p_stuck_before TIMESTAMPTZ)
RETURNS TABLE (
  op_type TEXT,
  failed  BIGINT,
  stuck   BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  IF p_stuck_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'platform_console_period_invalid',
      DETAIL = 'p_stuck_before es NULL';
  END IF;

  RETURN QUERY
    WITH latest AS (
      SELECT DISTINCT ON (op.order_id, op.type)
             op.type, op.status, op.updated_at
        FROM public.order_operations op
        JOIN public.platform_console_scope(p_root) s ON s.tenant_id = op.tenant_id
       ORDER BY op.order_id, op.type, op.created_at DESC, op.id DESC
    )
    SELECT l.type::text,
           count(*) FILTER (WHERE l.status = 'failed')::bigint,
           count(*) FILTER (WHERE l.status = 'pending' AND l.updated_at <= p_stuck_before)::bigint
      FROM latest l
     WHERE l.status = 'failed'
        OR (l.status = 'pending' AND l.updated_at <= p_stuck_before)
     GROUP BY l.type;
END;
$$;

COMMENT ON FUNCTION platform_overview_post_sale(uuid, timestamptz) IS
  'Por tipo de operación de post-venta, en el subárbol de p_root: órdenes cuya última operación de ese tipo falló, y las que siguen pending desde antes de p_stuck_before. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_post_sale(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_post_sale(uuid, timestamptz) TO app_user;

-- Una fila con los contadores que llevan a una cola:
--   - deposit_reports_platform / _network: depósitos informados pendientes que financia Planetour (el
--     dinero llegó a su cuenta) y los que financia otro nodo, como la cola de Aprobaciones;
--   - hotel_orders_unverified: reservas de hotel cuyo estado en el proveedor no está confirmado
--     (sin respuesta, no encontrada todavía, cancelación sin verificar, lectura sin verificar o un
--     estado desconocido). Las que están en vuelo (create-pending, cancel-requested) no cuentan;
--   - wallet_hold_conflicts: retenciones de cartera que figuraron confirmadas y después no (0060):
--     conciliación manual;
--   - reconciliation_critical / _warning: divergencias de conciliación desde p_since que esperan a
--     una persona (review) o se reportaron al dueño de la cuenta (reported);
--   - invitations_pending: vigentes sin aceptar; invitations_expired: vencidas sin aceptar desde
--     p_since (las más viejas ya no son una tarea).
CREATE FUNCTION platform_overview_attention(p_root UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (
  deposit_reports_platform BIGINT,
  deposit_reports_network  BIGINT,
  hotel_orders_unverified  BIGINT,
  wallet_hold_conflicts    BIGINT,
  reconciliation_critical  BIGINT,
  reconciliation_warning   BIGINT,
  invitations_pending      BIGINT,
  invitations_expired      BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  IF p_since IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'platform_console_period_invalid',
      DETAIL = 'p_since es NULL';
  END IF;

  RETURN QUERY
    WITH scope AS (
      SELECT s.tenant_id FROM public.platform_console_scope(p_root) s
    ),
    deposits AS (
      SELECT (f.id IS NULL OR f.tenant_type = 'platform') AS by_platform
        FROM public.portfolio_deposit_reports r
        JOIN scope ON scope.tenant_id = r.tenant_id
        LEFT JOIN public.tenants f ON f.id = public.tenant_financier_id(r.tenant_id)
       WHERE r.status = 'pending'
    ),
    reconciliation AS (
      SELECT i.severity
        FROM public.provider_reconciliation_items i
        JOIN scope ON scope.tenant_id = i.tenant_id
       WHERE i.action IN ('review', 'reported')
         AND i.created_at >= p_since
    ),
    invitations AS (
      SELECT inv.expires_at
        FROM public.user_invitations inv
        JOIN scope ON scope.tenant_id = inv.tenant_id
       WHERE inv.accepted_at IS NULL
         AND inv.revoked_at IS NULL
    )
    SELECT
      (SELECT count(*) FROM deposits d WHERE d.by_platform)::bigint,
      (SELECT count(*) FROM deposits d WHERE NOT d.by_platform)::bigint,
      (SELECT count(*)
         FROM public.hotel_order_tracking h
         JOIN scope ON scope.tenant_id = h.tenant_id
        WHERE h.sub_status IN ('create-uncertain', 'create-not-found-yet', 'cancel-unverified',
                               'unverified-read', 'unknown'))::bigint,
      (SELECT count(*)
         FROM public.wallet_hold_groups g
         JOIN scope ON scope.tenant_id = g.origin_tenant_id
        WHERE g.status = 'conflict')::bigint,
      (SELECT count(*) FROM reconciliation r WHERE r.severity = 'critical')::bigint,
      (SELECT count(*) FROM reconciliation r WHERE r.severity = 'warning')::bigint,
      (SELECT count(*) FROM invitations i WHERE i.expires_at > now())::bigint,
      (SELECT count(*) FROM invitations i
        WHERE i.expires_at <= now() AND i.expires_at >= p_since)::bigint;
END;
$$;

COMMENT ON FUNCTION platform_overview_attention(uuid, timestamptz) IS
  'Una fila con los contadores del subárbol de p_root que esperan a una persona: depósitos informados pendientes (Planetour / resto de la red), reservas de hotel sin estado verificado, retenciones en conflicto, divergencias de conciliación desde p_since (críticas / advertencias) e invitaciones pendientes y vencidas desde p_since. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_overview_attention(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_overview_attention(uuid, timestamptz) TO app_user;

-- ============================================================================
-- 6. Índice para leer por período
-- ============================================================================
-- Las lecturas de arriba filtran órdenes por created_at en toda la red; hasta ahora sólo había índices
-- por tenant, estado y PNR. (created_at DESC, id DESC) sirve también para paginar la consola de
-- Reservas de la red (ADM-4, 0076) por (created_at, id) de lo más nuevo a lo más viejo.
CREATE INDEX IF NOT EXISTS idx_orders_created_id ON orders (created_at DESC, id DESC);

-- ============================================================================
-- 7. Las reservas que necesitan a una persona
-- ============================================================================
-- Una fila por (orden, motivo) de las órdenes creadas en los últimos 180 días. El vocabulario es
-- cerrado y es el mismo de ORDER_ATTENTION_REASONS (apps/api/src/admin-console/attention.ts; un test
-- de contrato lee este archivo), y `since` es el momento del hecho que lo dispara:
--
--   review          hotel_order_tracking.sub_status create-not-found-yet o unknown: a la agencia se le
--                   dice "el equipo la revisa". since = hotel_order_tracking.updated_at.
--   verifying-long  sub_status create-uncertain, cancel-unverified o unverified-read y la orden sin
--                   cambios hace más de 2 horas. since = orders.updated_at.
--   create-stuck    orden pending hace más de 30 minutos sin una verificación de hotel en curso (sin
--                   tracking, o sub_status NULL o create-pending). since = orders.created_at.
--   cancel-failed   la ÚLTIMA operación cancel de la orden falló y la orden no quedó cancelada.
--                   since = order_operations.updated_at de esa operación.
--   hold-conflict   la retención de cartera quedó en conflicto (figuró confirmada y después no).
--                   since = wallet_hold_groups.captured_at, o created_at si nunca se capturó.
--   hold-orphan     retención todavía held con la orden failed o cancelled y creada hace más de 1
--                   hora: saldo retenido sin reserva. since = orders.updated_at (cuando se cerró).
--   hcn-missing     hotel_order_tracking.hcn_state missing: sin número de confirmación del hotel.
--                   since = hotel_order_tracking.updated_at.
--   reconciliation  divergencia crítica de la conciliación sobre la orden en los últimos 14 días.
--                   since = la primera de esas divergencias.
--
-- Los umbrales son heurísticos para afinar con datos reales: cambiarlos es cambiar esta función y
-- ATTENTION_THRESHOLDS juntos (el test de contrato lo exige).
CREATE FUNCTION admin_order_attention()
RETURNS TABLE (
  order_id          UUID,
  tenant_id         UUID,
  tenant_name       TEXT,
  order_number      INTEGER,
  provider          TEXT,
  provider_order_id TEXT,
  order_status      TEXT,
  reason            TEXT,
  since             TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();

  RETURN QUERY
    WITH recent AS (
      SELECT o.id, o.tenant_id, o.order_number, o.provider, o.provider_order_id, o.status,
             o.created_at, o.updated_at
        FROM public.orders o
       WHERE o.created_at > now() - interval '180 days'
    ),
    last_cancel AS (
      SELECT DISTINCT ON (op.order_id) op.order_id, op.status, op.updated_at
        FROM public.order_operations op
        JOIN recent r ON r.id = op.order_id
       WHERE op.type = 'cancel'
       ORDER BY op.order_id, op.created_at DESC, op.id DESC
    ),
    facts AS (
      SELECT r.id AS oid, 'review'::text AS why, h.updated_at AS at
        FROM recent r
        JOIN public.hotel_order_tracking h ON h.order_id = r.id
       WHERE h.sub_status IN ('create-not-found-yet', 'unknown')
      UNION ALL
      SELECT r.id, 'verifying-long', r.updated_at
        FROM recent r
        JOIN public.hotel_order_tracking h ON h.order_id = r.id
       WHERE h.sub_status IN ('create-uncertain', 'cancel-unverified', 'unverified-read')
         AND r.updated_at < now() - interval '2 hours'
      UNION ALL
      SELECT r.id, 'create-stuck', r.created_at
        FROM recent r
        LEFT JOIN public.hotel_order_tracking h ON h.order_id = r.id
       WHERE r.status = 'pending'
         AND r.created_at < now() - interval '30 minutes'
         AND (h.order_id IS NULL OR h.sub_status IS NULL OR h.sub_status = 'create-pending')
      UNION ALL
      SELECT r.id, 'cancel-failed', lc.updated_at
        FROM last_cancel lc
        JOIN recent r ON r.id = lc.order_id
       WHERE lc.status = 'failed'
         AND r.status <> 'cancelled'
      UNION ALL
      SELECT r.id, 'hold-conflict', COALESCE(g.captured_at, g.created_at)
        FROM recent r
        JOIN public.wallet_hold_groups g ON g.order_id = r.id
       WHERE g.status = 'conflict'
      UNION ALL
      SELECT r.id, 'hold-orphan', r.updated_at
        FROM recent r
        JOIN public.wallet_hold_groups g ON g.order_id = r.id
       WHERE g.status = 'held'
         AND r.status IN ('failed', 'cancelled')
         AND g.created_at < now() - interval '1 hour'
      UNION ALL
      SELECT r.id, 'hcn-missing', h.updated_at
        FROM recent r
        JOIN public.hotel_order_tracking h ON h.order_id = r.id
       WHERE h.hcn_state = 'missing'
      UNION ALL
      SELECT r.id, 'reconciliation', min(i.created_at)
        FROM public.provider_reconciliation_items i
        JOIN recent r ON r.id = i.order_id
       WHERE i.severity = 'critical'
         AND i.created_at > now() - interval '14 days'
       GROUP BY r.id
    )
    SELECT r.id,
           r.tenant_id,
           t.name::text,
           r.order_number,
           r.provider::text,
           r.provider_order_id::text,
           r.status::text,
           f.why,
           f.at
      FROM facts f
      JOIN recent r         ON r.id = f.oid
      JOIN public.tenants t ON t.id = r.tenant_id
     ORDER BY f.at, r.id, f.why;
END;
$$;

COMMENT ON FUNCTION admin_order_attention() IS
  'Una fila por (orden, motivo) de las órdenes de los últimos 180 días de toda la red que necesitan a una persona: review, verifying-long, create-stuck, cancel-failed, hold-conflict, hold-orphan, hcn-missing, reconciliation; since es el momento del hecho que lo dispara (ver el encabezado de la sección 7). Sin datos de pasajeros ni de contacto. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION admin_order_attention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_order_attention() TO app_user;

-- ============================================================================
-- 8. Ventas por nodo, proveedor, vertical y moneda
-- ============================================================================
-- Órdenes creadas en [p_from, p_to). Confirmadas son confirmed y ticketed; total_amount ya está en
-- unidades menores (0005). La vertical es la de apps/web-b2b/src/lib/order-vertical.ts: la marca
-- search_criteria.vertical (hotels, cars) y, para autos anteriores a la marca, el proveedor
-- agent-cars; lo demás son vuelos. La consola de Reservas de la red (0076) usa el mismo CASE.
CREATE FUNCTION admin_sales_summary(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  tenant_id              UUID,
  provider               TEXT,
  vertical               TEXT,
  currency               TEXT,
  orders_count           BIGINT,
  confirmed_count        BIGINT,
  confirmed_amount_minor NUMERIC,
  cancelled_count        BIGINT,
  failed_count           BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  PERFORM public.platform_console_check_period(p_from, p_to);

  RETURN QUERY
    SELECT o.tenant_id,
           o.provider::text,
           (CASE
              WHEN o.search_criteria ->> 'vertical' = 'hotels' THEN 'hotels'
              WHEN o.search_criteria ->> 'vertical' = 'cars' OR o.provider = 'agent-cars' THEN 'cars'
              ELSE 'flights'
            END)::text,
           upper(btrim(o.currency))::text,
           count(*)::bigint,
           count(*) FILTER (WHERE o.status IN ('confirmed', 'ticketed'))::bigint,
           COALESCE(sum(o.total_amount) FILTER (WHERE o.status IN ('confirmed', 'ticketed')), 0)::numeric,
           count(*) FILTER (WHERE o.status = 'cancelled')::bigint,
           count(*) FILTER (WHERE o.status = 'failed')::bigint
      FROM public.orders o
     WHERE o.created_at >= p_from
       AND o.created_at <  p_to
     GROUP BY 1, 2, 3, 4;
END;
$$;

COMMENT ON FUNCTION admin_sales_summary(timestamptz, timestamptz) IS
  'Órdenes creadas en [p_from, p_to) de toda la red por nodo, proveedor, vertical (flights, hotels, cars, como order-vertical.ts) y moneda: cuántas, confirmadas (confirmed, ticketed) con su monto en unidades menores, canceladas y fallidas. Nunca suma monedas. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION admin_sales_summary(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_sales_summary(timestamptz, timestamptz) TO app_user;

-- ============================================================================
-- 9. Cada nodo en números
-- ============================================================================
-- Una fila por nodo (la raíz incluida):
--   - active_users: usuarios activos con una membership activa en el nodo;
--   - live_sessions: sesiones vivas en el nodo, con el predicado de user_admin_overview (0055);
--   - seat_limit / seats_used: el cupo de sesiones simultáneas del nodo y cuántas lo ocupan
--     (seats_in_use, 0055); NULL si el nodo no fija cupo;
--   - orders_30d, last_order_at: lo que vendió en 30 días y su última orden;
--   - open_orders: órdenes pending, confirmed o ticketed (lo que sigue vivo si se suspende el nodo);
--   - held: lo retenido de SUS carteras por reservas en curso, moneda → unidades menores;
--   - pending_deposit_reports: depósitos informados que esperan aprobación;
--   - pending_invitations: invitaciones sin aceptar, sin revocar y vigentes.
CREATE FUNCTION admin_node_stats()
RETURNS TABLE (
  tenant_id               UUID,
  active_users            BIGINT,
  live_sessions           BIGINT,
  seat_limit              INTEGER,
  seats_used              INTEGER,
  orders_30d              BIGINT,
  last_order_at           TIMESTAMPTZ,
  open_orders             BIGINT,
  held                    JSONB,
  pending_deposit_reports BIGINT,
  pending_invitations     BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();

  RETURN QUERY
    WITH users_by AS (
      SELECT m.tenant_id AS tid, count(DISTINCT m.user_id) AS n
        FROM public.memberships m
        JOIN public.users u ON u.id = m.user_id
       WHERE m.status = 'active'
         AND u.status = 'active'
       GROUP BY m.tenant_id
    ),
    sessions_by AS (
      SELECT s.tenant_id AS tid, count(*) AS n
        FROM public.sessions s
       WHERE s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - s.idle_timeout_seconds * interval '1 second'
       GROUP BY s.tenant_id
    ),
    orders_by AS (
      SELECT o.tenant_id AS tid,
             count(*) FILTER (WHERE o.created_at > now() - interval '30 days') AS n30,
             max(o.created_at) AS last_at,
             count(*) FILTER (WHERE o.status IN ('pending', 'confirmed', 'ticketed')) AS open
        FROM public.orders o
       GROUP BY o.tenant_id
    ),
    held_by AS (
      SELECT x.tid, jsonb_object_agg(x.cur, x.amount) AS held
        FROM (SELECT l.tenant_id AS tid, l.currency AS cur, sum(l.amount_minor) AS amount
                FROM public.wallet_hold_levels l
               WHERE l.status = 'held'
               GROUP BY l.tenant_id, l.currency) x
       GROUP BY x.tid
    ),
    deposits_by AS (
      SELECT r.tenant_id AS tid, count(*) AS n
        FROM public.portfolio_deposit_reports r
       WHERE r.status = 'pending'
       GROUP BY r.tenant_id
    ),
    invitations_by AS (
      SELECT i.tenant_id AS tid, count(*) AS n
        FROM public.user_invitations i
       WHERE i.accepted_at IS NULL
         AND i.revoked_at IS NULL
         AND i.expires_at > now()
       GROUP BY i.tenant_id
    )
    SELECT t.id,
           COALESCE(ub.n, 0)::bigint,
           COALESCE(sb.n, 0)::bigint,
           t.concurrent_seats,
           CASE WHEN t.concurrent_seats IS NOT NULL THEN public.seats_in_use(t.id, NULL) END,
           COALESCE(ob.n30, 0)::bigint,
           ob.last_at,
           COALESCE(ob.open, 0)::bigint,
           COALESCE(hb.held, '{}'::jsonb),
           COALESCE(db.n, 0)::bigint,
           COALESCE(ib.n, 0)::bigint
      FROM public.tenants t
      LEFT JOIN users_by ub       ON ub.tid = t.id
      LEFT JOIN sessions_by sb    ON sb.tid = t.id
      LEFT JOIN orders_by ob      ON ob.tid = t.id
      LEFT JOIN held_by hb        ON hb.tid = t.id
      LEFT JOIN deposits_by db    ON db.tid = t.id
      LEFT JOIN invitations_by ib ON ib.tid = t.id
     ORDER BY t.path;
END;
$$;

COMMENT ON FUNCTION admin_node_stats() IS
  'Una fila por nodo: usuarios activos, sesiones vivas, cupo y puestos en uso (seats_in_use; NULL sin cupo), órdenes de 30 días y la última, órdenes abiertas (pending, confirmed, ticketed), lo retenido de sus carteras por moneda (held), depósitos por aprobar e invitaciones vigentes. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION admin_node_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_node_stats() TO app_user;

-- ============================================================================
-- 10. La conciliación por proveedor
-- ============================================================================
-- Por proveedor con alguna corrida (o alguna divergencia desde p_since): las corridas desde p_since
-- y cuántas fallaron (failed, invalid o abandoned), la última corrida terminada y el estado de la
-- última corrida, aunque sea anterior a p_since (un proveedor que dejó de conciliar sigue a la
-- vista), y las divergencias críticas y advertencias desde p_since.
CREATE FUNCTION admin_reconciliation_health(p_since TIMESTAMPTZ)
RETURNS TABLE (
  provider_code    TEXT,
  runs             BIGINT,
  failed_runs      BIGINT,
  last_finished_at TIMESTAMPTZ,
  last_status      TEXT,
  critical_items   BIGINT,
  warning_items    BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  IF p_since IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'platform_console_period_invalid',
      DETAIL = 'p_since es NULL';
  END IF;

  RETURN QUERY
    WITH runs_by AS (
      SELECT r.provider_code AS code,
             count(*) FILTER (WHERE r.started_at >= p_since) AS n,
             count(*) FILTER (WHERE r.started_at >= p_since
                                AND r.status IN ('failed', 'invalid', 'abandoned')) AS failed,
             max(r.finished_at) AS last_finished
        FROM public.provider_reconciliation_runs r
       GROUP BY r.provider_code
    ),
    last_run AS (
      SELECT DISTINCT ON (r.provider_code) r.provider_code AS code, r.status
        FROM public.provider_reconciliation_runs r
       ORDER BY r.provider_code, r.started_at DESC, r.id DESC
    ),
    items_by AS (
      SELECT i.provider_code AS code,
             count(*) FILTER (WHERE i.severity = 'critical') AS critical,
             count(*) FILTER (WHERE i.severity = 'warning') AS warning
        FROM public.provider_reconciliation_items i
       WHERE i.created_at >= p_since
       GROUP BY i.provider_code
    ),
    codes AS (
      SELECT rb.code FROM runs_by rb
      UNION
      SELECT ib.code FROM items_by ib
    )
    SELECT c.code::text,
           COALESCE(rb.n, 0)::bigint,
           COALESCE(rb.failed, 0)::bigint,
           rb.last_finished,
           lr.status::text,
           COALESCE(ib.critical, 0)::bigint,
           COALESCE(ib.warning, 0)::bigint
      FROM codes c
      LEFT JOIN runs_by rb  ON rb.code = c.code
      LEFT JOIN last_run lr ON lr.code = c.code
      LEFT JOIN items_by ib ON ib.code = c.code
     ORDER BY c.code;
END;
$$;

COMMENT ON FUNCTION admin_reconciliation_health(timestamptz) IS
  'Por proveedor: corridas de conciliación desde p_since y cuántas fallaron (failed, invalid, abandoned), la última terminada y el estado de la última corrida (aunque sea anterior), y divergencias críticas y advertencias desde p_since. Sólo el superadmin de la plataforma. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION admin_reconciliation_health(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_reconciliation_health(timestamptz) TO app_user;
