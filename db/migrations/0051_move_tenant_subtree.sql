-- 0051_move_tenant_subtree.sql
-- Mover un nodo de padre con todo su subárbol (D6 A; G-09).
--
-- Es la forma de corregir la red desde el panel del superadmin: colgar de Planetour una agencia raíz
-- suelta (como Amazon Minimalist) o pasar una agencia de un consolidador a otro. D6 A:
--
--   - lo histórico queda como está: las órdenes y los movimientos de cartera no se reescriben;
--   - desde el cambio rigen las credenciales, las reglas y la marca del nuevo padre, porque todo eso
--     se hereda leyendo `tenants.path` en el momento (0012, 0016, 0030, 0036, 0048) y el `path` se
--     recalcula aquí para el nodo y todos sus descendientes;
--   - se rechazan los ciclos, más de 4 niveles y las combinaciones que prohíbe la matriz D4 (0050);
--   - se bloquea si el nodo o su subárbol tiene reservas ABIERTAS pagadas con cartera.
--
-- Abierta es "activa" como en 0045 (`pending`, o `confirmed`/`ticketed` hasta el día siguiente al
-- fin del viaje; sin fecha legible, abierta), pero con la fecha de fin de cada vertical: el check-out
-- del hotel, la devolución del auto o la vuelta (o la ida) del vuelo. 0045 sólo mira el check-out, y
-- con eso un vuelo o un auto emitidos quedaban abiertos para siempre: el nodo que alguna vez vendió
-- uno con cartera no se podía mover nunca. Pagada con cartera es que tiene su `BOOKING_HOLD` y
-- todavía no su `BOOKING_RELEASED` (0039, 0040).
--
-- Además se bloquea si hay reservas abiertas hechas con una cuenta de proveedor de un ancestro que
-- deja de serlo con el movimiento: su post-venta sale siempre con esa cuenta (0045) y
-- `resolve_order_provider_account` la deja de devolver en cuanto el dueño no es ancestro, así que
-- nadie podría volver a leerlas ni cancelarlas. Es la misma regla que impide cortar la herencia con
-- reservas activas (RF-29 CA 2).
--
-- 0011 rechaza el cambio de padre por UPDATE, con razón: dejaría huérfanos los `path` de los
-- descendientes. Esa guarda se mantiene para todos, salvo para el UPDATE que hace esta función: la
-- deja pasar sólo si (a) la marca transaccional `app.tenant_move` nombra ese nodo y ese padre, y
-- (b) el UPDATE corre con el rol dueño de move_tenant_subtree, es decir, desde adentro de esta
-- función SECURITY DEFINER. La marca sola no alcanza: `app_user` puede fijar cualquier variable
-- `app.*`, pero no puede ejecutar el UPDATE con otro rol.

-- ============================================================================
-- 1. ¿La reserva sigue abierta?
-- ============================================================================
-- El criterio de `provider_account_active_orders` (0045) con la fecha de fin de cada vertical, con
-- nombre propio para poder usarlo y probarlo fuera de esta migración. La fecha de fin es la primera
-- legible de: `checkoutDate` (hoteles), `dropOffDate` (autos), `returnDate` y `departureDate`
-- (vuelos; la ida sólo si no hay vuelta). Sin ninguna, abierta: ante la duda, se bloquea.
CREATE FUNCTION order_is_active(p_status TEXT, p_search_criteria JSONB)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT p_status = 'pending'
      OR (
        p_status IN ('confirmed', 'ticketed')
        AND COALESCE(
              (SELECT v.d >= to_char(current_date - 1, 'YYYY-MM-DD')
                 FROM (VALUES (1, p_search_criteria ->> 'checkoutDate'),
                              (2, p_search_criteria ->> 'dropOffDate'),
                              (3, p_search_criteria ->> 'returnDate'),
                              (4, p_search_criteria ->> 'departureDate')) AS v(o, d)
                WHERE v.d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                ORDER BY v.o
                LIMIT 1),
              true)
      );
$$;

COMMENT ON FUNCTION order_is_active(text, jsonb) IS
  'Orden todavía abierta: pending, o confirmed/ticketed hasta el día siguiente al fin del viaje (checkoutDate, dropOffDate, returnDate o departureDate; sin ninguna legible, abierta). Ver db/migrations/0051.';

-- ============================================================================
-- 2. El `path`: la guarda de 0011, con la puerta de move_tenant_subtree
-- ============================================================================
-- Igual que 0011 salvo por la puerta y por los errores, que pasan a STH01 con su regla (antes el de
-- profundidad llegaba a la API como un 500 genérico).
--
-- SECURITY INVOKER a propósito: `current_user` tiene que ser el de quien ejecuta el UPDATE.
CREATE OR REPLACE FUNCTION tenants_maintain_path() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_path LTREE;
  self_label  TEXT := replace(NEW.id::text, '-', '');
  mover       NAME;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_tenant_id IS DISTINCT FROM OLD.parent_tenant_id THEN
    SELECT pg_get_userbyid(p.proowner) INTO mover
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.move_tenant_subtree(uuid,uuid)');
    IF mover IS NULL
       OR current_user <> mover
       OR current_setting('app.tenant_move', true) IS DISTINCT FROM
            (NEW.id::text || '>' || COALESCE(NEW.parent_tenant_id::text, '')) THEN
      PERFORM raise_tenant_hierarchy_violation('tenant_move_required', NEW.id, NEW.tenant_type, NULL);
    END IF;
  END IF;

  IF NEW.parent_tenant_id IS NULL THEN
    NEW.path := self_label::ltree;
  ELSE
    SELECT path INTO parent_path FROM tenants WHERE id = NEW.parent_tenant_id;
    IF parent_path IS NULL THEN
      PERFORM raise_tenant_hierarchy_violation('tenant_parent_not_found', NEW.id, NEW.tenant_type, NULL);
    END IF;
    NEW.path := parent_path || self_label::ltree;
  END IF;

  IF nlevel(NEW.path) > 4 THEN
    PERFORM raise_tenant_hierarchy_violation('tenant_depth_limit', NEW.id, NEW.tenant_type, NULL);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tenants_maintain_path() IS
  'Trigger de tenants: deriva path del padre y limita la profundidad a 4. El padre sólo cambia desde move_tenant_subtree (marca app.tenant_move + rol dueño de esa función). Ver db/migrations/0011 y 0051.';

-- ============================================================================
-- 3. Mover el subárbol
-- ============================================================================
-- Devuelve cuántos nodos se movieron (el nodo y sus descendientes), o 0 si ya colgaba de ese padre.
--
-- Quién puede: una sesión privilegiada (superusuario o BYPASSRLS: migraciones, seeds, psql del
-- operador) o, desde la app, el usuario de `app.current_user_id` si es superadmin activo de la
-- plataforma. La API ya lo exige; esto es la defensa en la base, como 0025: un endpoint futuro que
-- llame a esta función sin comprobarlo no le abre a nadie el cambio de red.
--
-- Bloqueos, después de las validaciones que sólo miran dos filas: el nodo y todo su subárbol
-- `FOR UPDATE` (mientras tanto nadie les cuelga hijos, les cambia el tipo ni les abre órdenes o
-- carteras: esas altas verifican su FK contra estas filas), el nuevo padre `FOR SHARE` (no cambia de
-- tipo) y las carteras del subárbol `FOR UPDATE` (una retención nueva espera a que el movimiento
-- termine, y no se cuela entre el conteo y el cambio).
--
-- Los descendientes se recalculan nivel por nivel: el trigger de `path` deriva cada fila del `path`
-- de su padre, y dentro de un mismo UPDATE el orden de las filas no está garantizado.
--
-- Queda un `domain_event` 'tenant.moved' con el actor de `app.current_user_id` (NULL si fue un
-- proceso), en la misma transacción. La API no tiene que escribir otro.
CREATE FUNCTION move_tenant_subtree(p_tenant_id UUID, p_new_parent_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_setting TEXT := current_setting('app.current_user_id', true);
  actor         UUID;
  node_type     TEXT;
  node_branch   BOOLEAN;
  old_parent    UUID;
  old_path      LTREE;
  np_type       TEXT;
  np_path       LTREE;
  rule          TEXT;
  deepest       INTEGER;
  moved         INTEGER;
  blocked       INTEGER;
  lvl           INTEGER;
BEGIN
  IF actor_setting ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    actor := actor_setting::uuid;
  END IF;

  IF NOT COALESCE(
       (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = session_user),
       false)
     AND NOT (
       actor IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM memberships m
           JOIN users u   ON u.id = m.user_id
           JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = actor
            AND m.role = 'superadmin'
            AND m.status = 'active'
            AND u.status = 'active'
            AND t.tenant_type = 'platform'
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE    = 'insufficient_privilege',
      CONSTRAINT = 'tenant_move_forbidden',
      TABLE      = 'tenants',
      MESSAGE    = 'sólo el superadmin de la plataforma puede mover un nodo de la red';
  END IF;

  SELECT t.tenant_type, t.is_branch, t.parent_tenant_id, t.path
    INTO node_type, node_branch, old_parent, old_path
    FROM tenants t
   WHERE t.id = p_tenant_id
     FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM raise_tenant_hierarchy_violation('tenant_not_found', p_tenant_id, NULL, NULL);
  END IF;

  IF old_parent IS NOT DISTINCT FROM p_new_parent_id THEN
    RETURN 0;
  END IF;

  -- Primero lo que se decide con dos filas (ciclo y matriz), así un pedido imposible —mover la
  -- plataforma, por ejemplo— no bloquea toda la red antes de rechazarse.
  IF p_new_parent_id IS NOT NULL THEN
    SELECT t.tenant_type, t.path INTO np_type, np_path
      FROM tenants t
     WHERE t.id = p_new_parent_id
       FOR SHARE;
    IF NOT FOUND THEN
      PERFORM raise_tenant_hierarchy_violation('tenant_parent_not_found', p_tenant_id, node_type, NULL);
    END IF;
    IF np_path OPERATOR(public.<@) old_path THEN
      PERFORM raise_tenant_hierarchy_violation('tenant_move_cycle', p_tenant_id, node_type, np_type);
    END IF;
  END IF;

  rule := tenant_hierarchy_rule(node_type, node_branch, np_type);
  IF rule IS NOT NULL THEN
    PERFORM raise_tenant_hierarchy_violation(rule, p_tenant_id, node_type, np_type);
  END IF;

  PERFORM 1 FROM tenants t WHERE t.path OPERATOR(public.<@) old_path FOR UPDATE;
  SELECT count(*)::int, max(nlevel(t.path))
    INTO moved, deepest
    FROM tenants t
   WHERE t.path OPERATOR(public.<@) old_path;

  IF COALESCE(nlevel(np_path), 0) + 1 + (deepest - nlevel(old_path)) > 4 THEN
    PERFORM raise_tenant_hierarchy_violation('tenant_depth_limit', p_tenant_id, node_type, np_type);
  END IF;

  PERFORM 1
     FROM agency_portfolios ap
     JOIN tenants t ON t.id = ap.tenant_id
    WHERE t.path OPERATOR(public.<@) old_path
      FOR UPDATE OF ap;

  SELECT count(*)::int INTO blocked
    FROM orders o
    JOIN tenants t ON t.id = o.tenant_id
   WHERE t.path OPERATOR(public.<@) old_path
     AND order_is_active(o.status, o.search_criteria)
     AND EXISTS (
       SELECT 1 FROM portfolio_transactions h
        WHERE h.transaction_type = 'BOOKING_HOLD'
          AND lower(h.reference_id) = lower(o.id::text)
     )
     AND NOT EXISTS (
       SELECT 1 FROM portfolio_transactions r
        WHERE r.transaction_type = 'BOOKING_RELEASED'
          AND lower(r.reference_id) = lower(o.id::text)
     );
  IF blocked > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE    = 'STH02',
      CONSTRAINT = 'tenant_move_open_wallet_bookings',
      TABLE      = 'tenants',
      MESSAGE    = format('el nodo o su red tiene %s reserva(s) abierta(s) pagada(s) con cartera: hay que cerrarlas o cancelarlas antes de moverlo', blocked),
      DETAIL     = format('tenant %s', p_tenant_id),
      HINT       = 'Abierta: pendiente, o confirmada/emitida hasta el día siguiente al fin del viaje (check-out, devolución del auto o vuelta del vuelo), con la retención de cartera sin liberar.';
  END IF;

  SELECT count(*)::int INTO blocked
    FROM orders o
    JOIN tenants t            ON t.id = o.tenant_id
    JOIN provider_accounts pa ON pa.id = o.provider_account_id
    JOIN tenants owner_t      ON owner_t.id = pa.tenant_id
   WHERE t.path OPERATOR(public.<@) old_path
     AND order_is_active(o.status, o.search_criteria)
     AND NOT (owner_t.path OPERATOR(public.<@) old_path)
     AND NOT (owner_t.path OPERATOR(public.@>) np_path);
  IF blocked > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE    = 'STH02',
      CONSTRAINT = 'tenant_move_open_inherited_bookings',
      TABLE      = 'tenants',
      MESSAGE    = format('el nodo o su red tiene %s reserva(s) abierta(s) hechas con credenciales de un nodo que deja de ser su ancestro: su post-venta quedaría sin cuenta', blocked),
      DETAIL     = format('tenant %s', p_tenant_id),
      HINT       = 'Espera a que se cierren o cancélalas antes de moverlo.';
  END IF;

  PERFORM set_config('app.tenant_move', p_tenant_id::text || '>' || p_new_parent_id::text, true);
  UPDATE tenants SET parent_tenant_id = p_new_parent_id WHERE id = p_tenant_id;
  PERFORM set_config('app.tenant_move', '', true);

  FOR lvl IN (nlevel(old_path) + 1) .. deepest LOOP
    UPDATE tenants t
       SET path = t.path
     WHERE t.path OPERATOR(public.<@) old_path
       AND nlevel(t.path) = lvl;
  END LOOP;

  IF EXISTS (SELECT 1 FROM tenants t WHERE t.path OPERATOR(public.<@) old_path) THEN
    RAISE EXCEPTION 'move_tenant_subtree: quedaron nodos con el path anterior de %', p_tenant_id;
  END IF;

  INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (
    p_tenant_id,
    actor,
    'tenant.moved',
    'tenant',
    p_tenant_id::text,
    jsonb_build_object(
      'fromParentId', old_parent,
      'toParentId', p_new_parent_id,
      'movedTenants', moved,
      'source', 'move_tenant_subtree'
    )
  );

  RETURN moved;
END;
$$;

COMMENT ON FUNCTION move_tenant_subtree(uuid, uuid) IS
  'Mueve p_tenant_id y su subárbol bajo p_new_parent_id (D6 A): recalcula path, valida ciclos, profundidad y la matriz D4 (STH01), bloquea con reservas abiertas pagadas con cartera o hechas con una cuenta que deja de heredarse (STH02) y deja el domain_event tenant.moved. Sólo sesión privilegiada o superadmin de la plataforma. Devuelve cuántos nodos movió (0 = ya estaba ahí). Ver db/migrations/0051.';

REVOKE ALL ON FUNCTION move_tenant_subtree(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION move_tenant_subtree(uuid, uuid) TO app_user;
