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
--      (platform_console_require_superadmin, 42501 platform_console_superadmin_required). No confía
--      sólo en la app, a diferencia de network_sales_summary (0014): defensa en profundidad;
--   2. devuelve AGREGADOS (conteos y sumas por moneda), nunca filas con datos de pasajeros ni de
--      contacto;
--   3. acepta un nodo raíz (p_root) para mirar el subárbol de un consolidador; NULL es toda la red.
--
-- Nunca se suman monedas distintas: todo monto sale agrupado por moneda.
--
-- Las consume AdminOverviewService (apps/api/src/admin-console), que corre con
-- withRequestContext({ userId }) para que app.current_user_id llegue a estas funciones.
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
CREATE FUNCTION platform_console_is_superadmin()
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

COMMENT ON FUNCTION platform_console_is_superadmin() IS
  '¿El usuario de app.current_user_id es el superadmin de la plataforma (membership activa con rol superadmin en el tenant platform, usuario activo)? Gobierna las lecturas de toda la red de la consola. Ver db/migrations/0075.';

REVOKE ALL ON FUNCTION platform_console_is_superadmin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_console_is_superadmin() TO app_user;

-- La guarda con que empieza cada lectura de la consola. Sin GRANT: la llaman las funciones de abajo,
-- que corren con su dueño.
CREATE FUNCTION platform_console_require_superadmin()
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.platform_console_is_superadmin() THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'platform_console_superadmin_required',
      DETAIL  = format('app.current_user_id = %L',
                       COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), '(sin valor)')),
      HINT    = 'Sólo el superadmin de la plataforma lee la red entera. Un nodo se lee con su tenant en app.current_tenant_id.';
  END IF;
END;
$$;

COMMENT ON FUNCTION platform_console_require_superadmin() IS
  'Si app.current_user_id no es el superadmin de la plataforma, 42501 platform_console_superadmin_required. Helper de 0075, sin GRANT.';

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
-- por tenant, estado y PNR.
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
