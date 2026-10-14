-- 0076_admin_orders_console.sql
-- Plataforma → Reservas de la red: buscar cualquier reserva de toda la red y abrir su ficha.
--
-- Qué resuelve: la RLS de orders sólo deja leer el tenant activo, y el superadmin no puede pasar a
-- un nodo del que no es miembro. No había forma de encontrar la reserva de una agencia por su PNR,
-- su número o el correo del cliente sin entrar a la base.
--
-- Mismas reglas que 0075 (ver su encabezado): cada lectura cruzada es una función con nombre que
--
--   1. exige ELLA MISMA que quien pide sea el superadmin de la plataforma
--      (platform_console_require_superadmin(), que pregunta a is_platform_superadmin(): si no,
--      42501 admin_superadmin_required, que la API traduce a 403 con rethrowAdminDbError);
--   2. en la lista devuelve lo que identifica la reserva (nodo, proveedor, localizadores, número,
--      estado, importe y el correo del VENDEDOR), nunca pasajeros ni datos de contacto del cliente.
--      El correo del cliente sirve para BUSCAR (exacto, nunca parcial) pero no sale en la fila.
--
-- La ficha no tiene función propia: admin_order_tenant() dice de qué nodo es la orden y la API la lee
-- con las lecturas de siempre, fijando ese tenant (withTenant), así que la RLS de cada tabla sigue
-- mandando. Esa lectura de datos de otro nodo queda en la auditoría (platform.order.viewed).
--
-- Las consume AdminOrdersService (apps/api/src/orders/admin-orders.service.ts), con
-- withRequestContext({ userId }) para que app.current_user_id llegue a la guarda.
--
-- search_path = pg_catalog, public, pg_temp (posterior a 0060: nada las endurece después; ver
-- apps/api/src/database/migrations-search-path.test.ts).

-- ============================================================================
-- 1. Buscar reservas en toda la red
-- ============================================================================
-- Filtros (NULL = sin ese filtro):
--   - p_root / p_subtree: el nodo y, con p_subtree (NULL = true), su red; con false, sólo ese nodo.
--     Sin p_root, toda la red. Un p_root que no existe no da ninguna fila (la API responde 404
--     antes);
--   - p_vertical: flights, hotels o cars, con el CASE de admin_sales_summary (0075 §8, el mismo de
--     apps/web-b2b/src/lib/order-vertical.ts);
--   - p_providers, p_statuses: listas de orders.provider y orders.status;
--   - p_from / p_to: orders.created_at en [p_from, p_to). La API manda el comienzo de los días de
--     Bogotá;
--   - p_q: el texto buscado, sin espacios a los lados. Coincide si es
--       · el localizador del proveedor (orders.provider_order_id, sin distinguir mayúsculas);
--       · nuestra referencia de reserva (orders.provider_booking_ref, exacta);
--       · el número de la orden (sólo dígitos, hasta 9);
--       · el correo del cliente (contact_info.email), EXACTO sin distinguir mayúsculas: una parte
--         del correo no encuentra nada, para que la búsqueda no sirva para listar clientes;
--       · el id de la orden;
--   - p_attention_only: sólo las que necesitan a una persona (admin_order_attention, 0075 §7).
--
-- Cada fila lleva el motivo más grave por el que necesita a una persona, con el orden de
-- ATTENTION_PRIORITY (apps/api/src/admin-console/attention.ts; attention.sql-contract.test.ts compara
-- el CASE de abajo con esa lista).
--
-- Paginación por (created_at, id), de lo más nuevo a lo más viejo (idx_orders_created_id, 0075 §6):
-- p_before_created y p_before_id van juntos. LIMIT entre 1 y 5001: la consola pide su página + 1 para
-- saber si hay más, y la exportación (ADM-14) pide 5001 para saber si se pasa de 5.000.
--
-- Un filtro imposible (vertical desconocida, cursor a medias, período vacío o al revés) es un error de
-- programación de la app: 22023 admin_orders_filter_invalid.
CREATE FUNCTION admin_search_orders(
  p_root           UUID,
  p_subtree        BOOLEAN,
  p_vertical       TEXT,
  p_providers      TEXT[],
  p_statuses       TEXT[],
  p_from           TIMESTAMPTZ,
  p_to             TIMESTAMPTZ,
  p_q              TEXT,
  p_attention_only BOOLEAN,
  p_before_created TIMESTAMPTZ,
  p_before_id      UUID,
  p_limit          INTEGER
)
RETURNS TABLE (
  id                   UUID,
  tenant_id            UUID,
  tenant_name          TEXT,
  tenant_type          TEXT,
  is_branch            BOOLEAN,
  provider             TEXT,
  vertical             TEXT,
  provider_order_id    TEXT,
  provider_booking_ref TEXT,
  order_number         INTEGER,
  status               TEXT,
  sub_status           TEXT,
  total_amount         BIGINT,
  currency             TEXT,
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ,
  seller_email         TEXT,
  attention_reason     TEXT,
  attention_since      TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_q       TEXT    := NULLIF(btrim(p_q), '');
  v_subtree BOOLEAN := COALESCE(p_subtree, true);
  v_limit   INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 5001);
  -- Las conversiones se hacen acá y no en el WHERE: un `v_q::integer` en el WHERE lo puede evaluar
  -- el planificador aunque la condición de al lado sea falsa, y 'ABC123' rompería la búsqueda.
  v_number  INTEGER;
  v_email   TEXT;
  v_id      UUID;
BEGIN
  PERFORM public.platform_console_require_superadmin();

  IF p_vertical IS NOT NULL AND p_vertical NOT IN ('flights', 'hotels', 'cars') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_orders_filter_invalid',
      DETAIL = format('vertical %L', p_vertical);
  END IF;
  IF (p_before_created IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_orders_filter_invalid',
      DETAIL = 'p_before_created y p_before_id van juntos';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from >= p_to THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_orders_filter_invalid',
      DETAIL = format('desde %s hasta %s', p_from, p_to);
  END IF;

  IF v_q ~ '^[0-9]{1,9}$' THEN
    v_number := v_q::integer;
  END IF;
  IF position('@' IN v_q) > 0 THEN
    v_email := lower(v_q);
  END IF;
  IF v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_id := v_q::uuid;
  END IF;

  RETURN QUERY
    WITH scope AS (
      SELECT t.id AS tid
        FROM public.tenants t
       WHERE p_root IS NULL
          OR (NOT v_subtree AND t.id = p_root)
          OR (v_subtree
              AND t.path OPERATOR(public.<@) (SELECT r.path FROM public.tenants r WHERE r.id = p_root))
    ),
    attention AS (
      SELECT DISTINCT ON (a.order_id) a.order_id AS oid, a.reason AS why, a.since AS at
        FROM public.admin_order_attention() a
       ORDER BY a.order_id,
                CASE a.reason
                  WHEN 'hold-orphan'    THEN 0
                  WHEN 'hold-conflict'  THEN 1
                  WHEN 'cancel-failed'  THEN 2
                  WHEN 'review'         THEN 3
                  WHEN 'create-stuck'   THEN 4
                  WHEN 'reconciliation' THEN 5
                  WHEN 'hcn-missing'    THEN 6
                  WHEN 'verifying-long' THEN 7
                  ELSE 8
                END,
                a.since
    ),
    found AS (
      SELECT o.id AS oid,
             o.tenant_id AS tid,
             o.user_id AS uid,
             o.provider AS prov,
             (CASE
                WHEN o.search_criteria ->> 'vertical' = 'hotels' THEN 'hotels'
                WHEN o.search_criteria ->> 'vertical' = 'cars' OR o.provider = 'agent-cars' THEN 'cars'
                ELSE 'flights'
              END) AS vert,
             o.provider_order_id AS pnr,
             o.provider_booking_ref AS booking_ref,
             o.order_number AS num,
             o.status AS st,
             o.total_amount AS amount,
             o.currency AS cur,
             o.created_at AS created,
             o.updated_at AS updated
        FROM public.orders o
        JOIN scope s ON s.tid = o.tenant_id
       WHERE (p_statuses  IS NULL OR o.status   = ANY (p_statuses))
         AND (p_providers IS NULL OR o.provider = ANY (p_providers))
         AND (p_from IS NULL OR o.created_at >= p_from)
         AND (p_to   IS NULL OR o.created_at <  p_to)
         AND (p_before_created IS NULL OR (o.created_at, o.id) < (p_before_created, p_before_id))
         AND (v_q IS NULL
              OR upper(o.provider_order_id) = upper(v_q)
              OR o.provider_booking_ref = v_q
              OR o.order_number = v_number
              OR lower(btrim(o.contact_info ->> 'email')) = v_email
              OR o.id = v_id)
    )
    SELECT f.oid,
           f.tid,
           t.name::text,
           t.tenant_type::text,
           t.is_branch,
           f.prov::text,
           f.vert::text,
           f.pnr::text,
           f.booking_ref::text,
           f.num,
           f.st::text,
           h.sub_status::text,
           f.amount::bigint,
           upper(btrim(f.cur))::text,
           f.created,
           f.updated,
           u.email::text,
           a.why::text,
           a.at
      FROM found f
      JOIN public.tenants t      ON t.id = f.tid
      LEFT JOIN public.users u   ON u.id = f.uid
      LEFT JOIN public.hotel_order_tracking h ON h.order_id = f.oid
      LEFT JOIN attention a      ON a.oid = f.oid
     WHERE (p_vertical IS NULL OR f.vert = p_vertical)
       AND (NOT COALESCE(p_attention_only, false) OR a.oid IS NOT NULL)
     ORDER BY f.created DESC, f.oid DESC
     LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION admin_search_orders(uuid, boolean, text, text[], text[], timestamptz, timestamptz, text, boolean, timestamptz, uuid, integer) IS
  'Reservas de toda la red (o del nodo p_root, con su red si p_subtree), filtradas por vertical, proveedores, estados, [p_from, p_to), texto (localizador, referencia, número, correo EXACTO del cliente o id) y "necesita a una persona", de la más nueva a la más vieja, paginadas por (created_at, id) y hasta 5001. Cada fila trae su nodo, el correo del vendedor y el motivo más grave de admin_order_attention; nunca pasajeros ni contacto. Sólo el superadmin de la plataforma. Ver db/migrations/0076.';

REVOKE ALL ON FUNCTION admin_search_orders(uuid, boolean, text, text[], text[], timestamptz, timestamptz, text, boolean, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_search_orders(uuid, boolean, text, text[], text[], timestamptz, timestamptz, text, boolean, timestamptz, uuid, integer) TO app_user;

-- ============================================================================
-- 2. ¿De qué nodo es esta orden?
-- ============================================================================
-- El tenant de la orden, o NULL si no existe. Con él, la API lee la ficha fijando ese tenant
-- (withTenant): la orden, sus operaciones, el seguimiento del hotel, la retención y la conciliación
-- salen por la RLS de siempre, no por una lectura amplia.
CREATE FUNCTION admin_order_tenant(p_order UUID)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  PERFORM public.platform_console_require_superadmin();

  SELECT o.tenant_id INTO v_tenant
    FROM public.orders o
   WHERE o.id = p_order;

  RETURN v_tenant;
END;
$$;

COMMENT ON FUNCTION admin_order_tenant(uuid) IS
  'El tenant de la orden p_order, o NULL si no existe. Con él la API lee la ficha de la reserva fijando ese tenant (la RLS de cada tabla sigue mandando). Sólo el superadmin de la plataforma. Ver db/migrations/0076.';

REVOKE ALL ON FUNCTION admin_order_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_order_tenant(uuid) TO app_user;
