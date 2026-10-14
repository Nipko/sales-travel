-- 0086_order_ancillary_services.sql
-- Maletas y servicios adicionales sobre una reserva de vuelo confirmada, antes de emitir (SAB-20).
--
-- El vendedor agrega a una reserva ya hecha lo que la aerolínea vende aparte (equipaje, comidas,
-- salas) y lo quita mientras no se emita. Lo agregado se cobra con el tiquete, como EMD, con la forma
-- de pago de la cuenta (nunca tarjeta, D1), y lo liquida por BSP el dueño de la cuenta: la reserva
-- sube de total y, si retenía la cartera de la red (0060, SAB-10), la retención sube con ella en cada
-- nivel. Quitar un servicio devuelve su parte.
--
--   1. Quitar servicios es otra escritura en el proveedor: entra al CAS de 0083 junto con emitir,
--      modificar y agregar. Una pendiente por orden, para que no se crucen (quitar mientras se emite
--      deja un EMD sobre un servicio que ya no está).
--   2. Lo agregado, línea por línea (un servicio para un pasajero): qué, para quién, en qué tramos, a
--      qué precio y con qué ids del proveedor se quita. Con tenant_id y RLS forzada.
--   3. El ajuste de una retención abierta (wallet_hold_adjust): la diferencia entre el total de la
--      orden y la venta retenida, en cada nivel de la retención, con su asiento en el mismo libro de
--      0060 y su rastro. No es un libro aparte: los asientos son BOOKING_* y NETWORK_*, los niveles
--      cambian de monto y liberar (wallet_hold_release_all) devuelve lo que cada nivel tiene ahora.
--
-- Nada de esta migración nombra a un proveedor. Sin PII: el nombre de un servicio es el comercial de
-- la aerolínea y los pasajeros van por posición.

-- ============================================================================
-- 1. Quitar servicios comparte el claim de las escrituras en el proveedor (0083)
-- ============================================================================
DROP INDEX uq_order_operations_pending_provider_write;

CREATE UNIQUE INDEX uq_order_operations_pending_provider_write
  ON order_operations (tenant_id, order_id)
  WHERE status = 'pending' AND type IN ('issue', 'modify', 'add-services', 'remove-services');

COMMENT ON INDEX uq_order_operations_pending_provider_write IS
  'CAS durable pre-write: como máximo una escritura pendiente en el proveedor (issue, modify, add-services, remove-services) por orden y tenant. La cancelación tiene el suyo (0037). Ver db/migrations/0083 y 0086.';

-- ============================================================================
-- 2. Los servicios agregados a una orden
-- ============================================================================
-- Una fila por servicio y pasajero. Nace con el desenlace del alta:
--
--   active             la aerolínea confirmó que quedó en la reserva;
--   unverified         se mandó y no se sabe si quedó: cuenta en el total y en la retención hasta
--                      que una persona lo concilie (nunca se da por hecho ni por caído);
--   removed            se quitó y la aerolínea lo confirmó;
--   remove-unverified  se pidió quitarlo y no se sabe si salió: sigue contando.
--
-- `provider_item_ids` son los ids con que el proveedor lo quita. Si vienen compartidos por varias
-- líneas (el proveedor los da por servicio y no por pasajero), quitarlos quita todas esas líneas:
-- se quitan juntas.
CREATE TABLE order_ancillary_lines (
  id                        UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                 UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id                  UUID         NOT NULL,
  added_operation_id        UUID         NOT NULL,
  removed_operation_id      UUID         NULL,
  service_offer_item_id     TEXT         NOT NULL,
  passenger_index           SMALLINT     NOT NULL,
  category                  TEXT         NOT NULL,
  service_code              TEXT         NOT NULL,
  airline_code              TEXT         NOT NULL,
  name                      TEXT         NOT NULL,
  segments                  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  amount_minor              BIGINT       NOT NULL,
  currency                  TEXT         NOT NULL,
  provider_item_ids         TEXT[]       NOT NULL DEFAULT '{}',
  provider_item_ids_shared  BOOLEAN      NOT NULL DEFAULT false,
  status                    TEXT         NOT NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Compuesta, como 0082: con una FK a `id` a secas, una agencia que conociera el id de una orden
  -- ajena podría colgarle filas con su propio tenant_id (las FK se verifican sin RLS).
  CONSTRAINT order_ancillary_lines_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT order_ancillary_lines_offer_item_length
    CHECK (length(service_offer_item_id) BETWEEN 1 AND 255),
  CONSTRAINT order_ancillary_lines_passenger_index
    CHECK (passenger_index BETWEEN 0 AND 8),
  CONSTRAINT order_ancillary_lines_category
    CHECK (category IN ('BAGGAGE', 'MEAL', 'LOUNGE', 'PET', 'FEE', 'OTHER')),
  CONSTRAINT order_ancillary_lines_service_code
    CHECK (service_code ~ '^[0-9A-Z]{3}$'),
  CONSTRAINT order_ancillary_lines_airline_code
    CHECK (airline_code ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT order_ancillary_lines_name_length
    CHECK (length(name) BETWEEN 1 AND 160),
  CONSTRAINT order_ancillary_lines_segments_array
    CHECK (jsonb_typeof(segments) = 'array'),
  CONSTRAINT order_ancillary_lines_amount_range
    CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT order_ancillary_lines_currency_format
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT order_ancillary_lines_provider_ids_count
    CHECK (cardinality(provider_item_ids) <= 32),
  CONSTRAINT order_ancillary_lines_status
    CHECK (status IN ('active', 'unverified', 'removed', 'remove-unverified')),
  CONSTRAINT order_ancillary_lines_removed_operation
    CHECK ((status IN ('removed', 'remove-unverified')) = (removed_operation_id IS NOT NULL))
);

CREATE INDEX idx_order_ancillary_lines_order
  ON order_ancillary_lines (tenant_id, order_id, created_at);

CREATE TRIGGER order_ancillary_lines_set_updated_at
  BEFORE UPDATE ON order_ancillary_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE order_ancillary_lines IS
  'Servicios adicionales agregados a una orden de vuelo antes de emitir (SAB-20): uno por servicio y pasajero, con su precio, sus tramos y los ids con que el proveedor lo quita. Con tenant_id y RLS forzada; (order_id, tenant_id) apunta a orders (id, tenant_id). Sin PII. Ver db/migrations/0086.';
COMMENT ON COLUMN order_ancillary_lines.status IS
  'active: confirmado en la reserva. unverified: mandado sin confirmación, cuenta en el total y en la retención hasta conciliarlo. removed: quitado y confirmado. remove-unverified: se pidió quitarlo sin confirmación, sigue contando.';
COMMENT ON COLUMN order_ancillary_lines.amount_minor IS
  'Precio de la aerolínea para ese pasajero, en unidades menores de currency, el que vio el vendedor. Sin markup (P-16): es lo que suma al total de la orden y a cada nivel de la retención.';
COMMENT ON COLUMN order_ancillary_lines.provider_item_ids IS
  'Ids del proveedor con que se quita. Vacío: el proveedor no los devolvió y no se puede quitar desde la plataforma.';
COMMENT ON COLUMN order_ancillary_lines.provider_item_ids_shared IS
  'true: los ids son del servicio entero y los comparten otras líneas; quitarlos quita todas esas líneas.';

ALTER TABLE order_ancillary_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_ancillary_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY order_ancillary_lines_tenant_isolation ON order_ancillary_lines
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Sin DELETE: lo agregado y lo quitado queda como historia de la orden.
REVOKE ALL ON order_ancillary_lines FROM app_user;
GRANT SELECT, INSERT, UPDATE ON order_ancillary_lines TO app_user;

-- ============================================================================
-- 3. El ajuste de una retención abierta
-- ============================================================================
-- Cada ajuste deja una fila por nivel: qué operación lo pidió, si retuvo o liberó, cuánto y con qué
-- asiento. El asiento lleva como referencia la OPERACIÓN y no la orden: 0039, 0040 y 0060 dejan un
-- solo asiento de retención y uno de liberación por orden (y por cartera en la red), que son los de
-- la retención original, y liberar la reserva los sigue buscando por la orden.
--
-- Mismo criterio que wallet_hold_levels: sin FK a `tenants`, sólo lectura para la aplicación y cada
-- fila la ve el dueño de su cartera.
CREATE TABLE wallet_hold_adjustments (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id          UUID         NOT NULL,
  order_id          UUID         NOT NULL,
  level_id          UUID         NOT NULL,
  depth             SMALLINT     NOT NULL,
  tenant_id         UUID         NOT NULL,
  portfolio_id      UUID         NOT NULL,
  origin_tenant_id  UUID         NOT NULL,
  order_number      BIGINT       NULL,
  currency          TEXT         NOT NULL,
  operation_id      UUID         NOT NULL,
  direction         TEXT         NOT NULL,
  amount_minor      BIGINT       NOT NULL,
  transaction_id    UUID         NOT NULL,
  created_by        UUID         NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT wallet_hold_adjustments_group_fk
    FOREIGN KEY (group_id, order_id) REFERENCES wallet_hold_groups (id, order_id) ON DELETE RESTRICT,
  CONSTRAINT wallet_hold_adjustments_level_fk
    FOREIGN KEY (level_id) REFERENCES wallet_hold_levels (id) ON DELETE RESTRICT,
  CONSTRAINT wallet_hold_adjustments_transaction_fk
    FOREIGN KEY (transaction_id) REFERENCES portfolio_transactions (id),
  CONSTRAINT wallet_hold_adjustments_transaction_key UNIQUE (transaction_id),
  -- Una operación retiene una vez y libera una vez por nivel: un reintento no cobra dos veces.
  CONSTRAINT wallet_hold_adjustments_operation_key UNIQUE (operation_id, level_id, direction),
  CONSTRAINT wallet_hold_adjustments_depth_range
    CHECK (depth BETWEEN 0 AND 3),
  CONSTRAINT wallet_hold_adjustments_currency_format
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallet_hold_adjustments_direction
    CHECK (direction IN ('hold', 'release')),
  CONSTRAINT wallet_hold_adjustments_amount_positive
    CHECK (amount_minor > 0)
);

CREATE INDEX idx_wallet_hold_adjustments_level
  ON wallet_hold_adjustments (level_id);
CREATE INDEX idx_wallet_hold_adjustments_tenant
  ON wallet_hold_adjustments (tenant_id, created_at DESC);

COMMENT ON TABLE wallet_hold_adjustments IS
  'Ajustes de una retención abierta (0086): cuánto retuvo o liberó cada nivel por una operación de la orden (servicios adicionales), con su asiento BOOKING_* o NETWORK_* referido a la operación. La ve el dueño de la cartera; la escribe sólo wallet_hold_adjust.';
COMMENT ON COLUMN wallet_hold_adjustments.amount_minor IS
  'Positivo; direction dice si se retuvo (hold) o se liberó (release). El nivel guarda el monto resultante en wallet_hold_levels.amount_minor.';

ALTER TABLE wallet_hold_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_hold_adjustments FORCE ROW LEVEL SECURITY;

CREATE POLICY wallet_hold_adjustments_owner_read ON wallet_hold_adjustments
  FOR SELECT
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

COMMENT ON POLICY wallet_hold_adjustments_owner_read ON wallet_hold_adjustments IS
  'El dueño de la cartera ajustada (app.current_tenant_id = tenant_id) ve sus ajustes; el que vende no ve los de sus ancestros.';

REVOKE ALL ON wallet_hold_adjustments FROM app_user;
GRANT SELECT ON wallet_hold_adjustments TO app_user;

-- Ajusta la retención abierta de una orden confirmada a su total de ahora, en todos sus niveles y
-- con lo registrado (nunca recalcula la cadena ni el dueño). Una transacción, todo o nada:
--
--   orden FOR UPDATE → operación pendiente de la orden → grupo FOR UPDATE → carteras de sus niveles
--   abiertos FOR UPDATE por (nlevel DESC, id), el orden de retain, release y move.
--
-- La diferencia sale de la orden: orders.total_amount menos la venta retenida
-- (wallet_hold_groups.sale_amount_minor). La misma diferencia va a cada nivel: lo que se agrega son
-- servicios al precio de la aerolínea, sin markup de nadie (P-16), así que cuestan lo mismo en cada
-- nivel de la red. Si algún día llevan markup, el costo de cada nivel deja de ser la venta y esta
-- función tiene que recibir el neto.
--
-- Quien llama declara la diferencia que espera (p_expected_delta: lo que la operación agregó o
-- quitó del total en esta misma transacción), y tiene que ser la de la orden. Sin eso, cualquier
-- desfase entre el total y lo retenido que no venga de servicios (una retención legacy, un total
-- reescrito por otro camino) se retendría o liberaría en TODOS los niveles como si costara lo mismo
-- en cada uno.
--
--   > 0  retiene la diferencia: cada nivel la tiene que cubrir con las reglas de siempre (cartera
--        activa, saldo más cupo). El primer rechazo lanza STW02 y no queda nada. Sólo un alta
--        (add-services) retiene.
--   < 0  libera la diferencia. No exige la cartera activa: devolver no es operar. Nunca más de lo
--        que los ajustes retuvieron en ese nivel (retenido − liberado): un ajuste no toca la
--        retención de la reserva, que sólo libera wallet_hold_settle. Así, ni con el total de la
--        orden reescrito se libera por esta vía lo que retuvo wallet_hold_retain.
--
-- Devuelve:
--   adjusted   retuvo o liberó `delta_minor` en `levels` niveles;
--   unchanged  el total ya es lo retenido;
--   no-hold    la orden no tiene retención (cuenta de pruebas, un proveedor que cobra por su cuenta,
--              una reserva anterior a la retención): no hay nada que ajustar;
--   exempt     se reservó con la cuenta propia del nodo: no retiene nada.
--
-- STW01 hold_order_not_holdable si la orden no está confirmada, la operación no es una pendiente de
-- servicios de esa orden (o una baja quiere retener), o la retención ya se cerró o está en conflicto.
-- STW01 hold_amount_invalid si la diferencia no es la declarada, o una liberación excede lo que los
-- ajustes retuvieron en un nivel.
CREATE FUNCTION wallet_hold_adjust(
  p_order_id        UUID,
  p_actor           UUID,
  p_operation_id    UUID,
  p_expected_delta  BIGINT
)
RETURNS TABLE (
  outcome      TEXT,
  delta_minor  BIGINT,
  levels       SMALLINT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '2s'
AS $$
#variable_conflict use_column
DECLARE
  me          UUID;
  ord         RECORD;
  g           public.wallet_hold_groups;
  lvl         public.wallet_hold_levels;
  done        public.wallet_hold_levels;
  w           public.agency_portfolios;
  v_currency  TEXT;
  v_delta     BIGINT;
  v_decision  TEXT;
  v_type      TEXT;
  v_op_type   TEXT;
  v_net       NUMERIC;
  v_tx        UUID;
  v_written   SMALLINT := 0;
  v_open      SMALLINT := 0;
BEGIN
  me := public.wallet_hold_current_tenant();
  PERFORM public.wallet_hold_assert_actor(p_actor, me);
  IF p_expected_delta IS NULL
     OR p_expected_delta NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_amount_invalid', format('order=%s tenant=%s diferencia declarada inválida', p_order_id, me));
  END IF;

  SELECT o.id, o.status, o.total_amount, o.currency, o.order_number
    INTO ord
    FROM public.orders o
   WHERE o.id = p_order_id
     AND o.tenant_id = me
     FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_found', format('order=%s tenant=%s', p_order_id, me));
  END IF;
  IF ord.status <> 'confirmed' THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_holdable', format('order=%s tenant=%s status=%s', ord.id, me, ord.status));
  END IF;

  -- Sólo una operación de servicios en curso de ESA orden ajusta: el asiento la cita, y sin una
  -- operación viva el ajuste no tiene quién lo explique.
  SELECT op.type INTO v_op_type
    FROM public.order_operations op
   WHERE op.id = p_operation_id
     AND op.order_id = ord.id
     AND op.tenant_id = me
     AND op.type IN ('add-services', 'remove-services')
     AND op.status = 'pending';
  IF NOT FOUND THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_holdable',
      format('order=%s tenant=%s operation=%s no es una operación de servicios pendiente',
             ord.id, me, p_operation_id));
  END IF;

  SELECT wg.* INTO g FROM public.wallet_hold_groups wg WHERE wg.order_id = ord.id FOR UPDATE;
  IF g.id IS NULL THEN
    outcome := 'no-hold';
    delta_minor := 0;
    levels := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  IF g.status = 'exempt' THEN
    outcome := 'exempt';
    delta_minor := 0;
    levels := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  IF g.status NOT IN ('held', 'captured') THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_holdable',
      format('order=%s tenant=%s hold=%s', ord.id, me, g.status));
  END IF;

  v_currency := upper(btrim(ord.currency));
  IF v_currency IS DISTINCT FROM g.currency
     OR ord.total_amount IS NULL
     OR ord.total_amount < 1
     OR ord.total_amount > 9007199254740991 THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_amount_invalid', format('order=%s tenant=%s', ord.id, me));
  END IF;

  SELECT count(*)::smallint INTO v_open
    FROM public.wallet_hold_levels wl
   WHERE wl.group_id = g.id AND wl.status IN ('held', 'captured');

  v_delta := ord.total_amount - g.sale_amount_minor;
  IF v_delta <> p_expected_delta THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_amount_invalid',
      format('order=%s tenant=%s operation=%s la diferencia de la orden no es la declarada',
             ord.id, me, p_operation_id));
  END IF;
  IF v_delta > 0 AND v_op_type <> 'add-services' THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_holdable',
      format('order=%s tenant=%s operation=%s una baja de servicios no retiene',
             ord.id, me, p_operation_id));
  END IF;
  IF v_delta = 0 THEN
    outcome := 'unchanged';
    delta_minor := 0;
    levels := v_open;
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM 1
     FROM public.agency_portfolios ap
     LEFT JOIN public.tenants t ON t.id = ap.tenant_id
    WHERE ap.id IN (SELECT wl.portfolio_id
                      FROM public.wallet_hold_levels wl
                     WHERE wl.group_id = g.id
                       AND wl.status IN ('held', 'captured'))
    ORDER BY nlevel(t.path) DESC NULLS LAST, ap.id
      FOR UPDATE OF ap;

  -- Primero se decide cada nivel; recién después se escribe.
  FOR lvl IN
    SELECT wl.* FROM public.wallet_hold_levels wl
     WHERE wl.group_id = g.id AND wl.status IN ('held', 'captured')
     ORDER BY wl.depth
  LOOP
    IF v_delta > 0 THEN
      SELECT ap.* INTO w FROM public.agency_portfolios ap WHERE ap.id = lvl.portfolio_id;
      v_decision := public.wallet_hold_decide(w, v_delta);
      IF v_decision <> 'ok' THEN
        PERFORM public.raise_wallet_hold_violation(
          CASE
            WHEN lvl.depth = 0 THEN 'hold_' || v_decision
            WHEN v_decision = 'currency_not_enabled' THEN 'network_currency_not_enabled'
            ELSE 'network_funds_unavailable'
          END,
          format('order=%s depth=%s tenant=%s portfolio=%s',
                 ord.id, lvl.depth, lvl.tenant_id, lvl.portfolio_id));
      END IF;
    ELSE
      -- Lo que los ajustes retuvieron y todavía no liberaron en este nivel: el techo de cualquier
      -- liberación. La retención de la reserva no se toca por acá.
      SELECT COALESCE(sum(CASE WHEN wa.direction = 'hold' THEN wa.amount_minor
                               ELSE -wa.amount_minor END), 0)
        INTO v_net
        FROM public.wallet_hold_adjustments wa
       WHERE wa.level_id = lvl.id;
      IF v_net + v_delta < 0 OR lvl.amount_minor + v_delta < 1 THEN
        PERFORM public.raise_wallet_hold_violation(
          'hold_amount_invalid',
          format('order=%s depth=%s tenant=%s portfolio=%s la liberación excede lo retenido por servicios',
                 ord.id, lvl.depth, lvl.tenant_id, lvl.portfolio_id));
      END IF;
    END IF;
  END LOOP;

  FOR lvl IN
    SELECT wl.* FROM public.wallet_hold_levels wl
     WHERE wl.group_id = g.id AND wl.status IN ('held', 'captured')
     ORDER BY wl.depth
  LOOP
    v_type := CASE
      WHEN v_delta > 0 AND lvl.depth = 0 THEN 'BOOKING_HOLD'
      WHEN v_delta > 0 THEN 'NETWORK_HOLD'
      WHEN lvl.depth = 0 THEN 'BOOKING_RELEASED'
      ELSE 'NETWORK_RELEASED'
    END;

    INSERT INTO public.portfolio_transactions
      (portfolio_id, amount_minor, transaction_type, reference_id, notes, created_by)
    VALUES (
      lvl.portfolio_id,
      -v_delta,
      v_type,
      p_operation_id::text,
      CASE
        WHEN v_delta > 0 AND lvl.depth = 0 THEN
          'Retención por servicios adicionales de la reserva'
        WHEN v_delta > 0 THEN
          'Retención por servicios adicionales de una reserva de tu red'
        WHEN lvl.depth = 0 THEN
          'Servicios adicionales quitados de la reserva; saldo retenido liberado'
        ELSE
          'Servicios adicionales quitados de una reserva de tu red; retención liberada'
      END,
      p_actor)
    RETURNING id INTO v_tx;

    IF v_delta > 0 THEN
      -- La fila está bloqueada y la decisión tomada; el predicado repite el cupo y el rango por si
      -- otra ruta escribió el saldo sin tomar el mismo bloqueo.
      UPDATE public.agency_portfolios ap
         SET balance_minor = ap.balance_minor - v_delta
       WHERE ap.id = lvl.portfolio_id
         AND ap.status = 'active'
         AND ap.balance_minor::numeric + GREATEST(ap.credit_limit_minor, 0) >= v_delta
         AND ap.balance_minor::numeric - v_delta BETWEEN -9007199254740991 AND 9007199254740991;
      IF NOT FOUND THEN
        PERFORM public.raise_wallet_hold_violation(
          CASE WHEN lvl.depth = 0 THEN 'hold_funds_insufficient' ELSE 'network_funds_unavailable' END,
          format('order=%s depth=%s tenant=%s portfolio=%s',
                 ord.id, lvl.depth, lvl.tenant_id, lvl.portfolio_id));
      END IF;
    ELSE
      UPDATE public.agency_portfolios ap
         SET balance_minor = ap.balance_minor - v_delta
       WHERE ap.id = lvl.portfolio_id
         AND ap.balance_minor::numeric - v_delta BETWEEN -9007199254740991 AND 9007199254740991;
      IF NOT FOUND THEN
        PERFORM public.raise_wallet_hold_violation(
          'hold_release_out_of_range',
          format('order=%s depth=%s tenant=%s portfolio=%s',
                 ord.id, lvl.depth, lvl.tenant_id, lvl.portfolio_id));
      END IF;
    END IF;

    UPDATE public.wallet_hold_levels wl
       SET amount_minor = wl.amount_minor + v_delta, updated_at = now()
     WHERE wl.id = lvl.id
    RETURNING wl.* INTO done;

    INSERT INTO public.wallet_hold_adjustments
      (group_id, order_id, level_id, depth, tenant_id, portfolio_id, origin_tenant_id, order_number,
       currency, operation_id, direction, amount_minor, transaction_id, created_by)
    VALUES
      (g.id, ord.id, lvl.id, lvl.depth, lvl.tenant_id, lvl.portfolio_id, lvl.origin_tenant_id,
       lvl.order_number, lvl.currency, p_operation_id,
       CASE WHEN v_delta > 0 THEN 'hold' ELSE 'release' END, abs(v_delta), v_tx, p_actor);

    PERFORM public.wallet_hold_level_event(
      done, g.mode, p_actor, 'portfolio.hold.adjusted', 'db:wallet_hold_adjust',
      jsonb_build_object(
        'deltaMinor', v_delta,
        'operationId', p_operation_id,
        'reason', 'ancillary-services'));
    v_written := v_written + 1;
  END LOOP;

  UPDATE public.wallet_hold_groups wg
     SET sale_amount_minor = ord.total_amount
   WHERE wg.id = g.id;

  outcome := 'adjusted';
  delta_minor := v_delta;
  levels := v_written;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION wallet_hold_adjust(uuid, uuid, uuid, bigint) IS
  'Ajusta la retención abierta de la orden confirmada p_order_id del nodo app.current_tenant_id a su total de ahora (orders.total_amount − sale_amount_minor, que tiene que ser p_expected_delta), en todos sus niveles y con lo registrado, por la operación de servicios pendiente p_operation_id: retiene la diferencia (sólo un alta; cada nivel la cubre o STW02) o la libera (nunca más de lo que los ajustes retuvieron en cada nivel). Asiento BOOKING_* o NETWORK_* con referencia a la operación, fila en wallet_hold_adjustments y portfolio.hold.adjusted por nivel. Devuelve adjusted | unchanged | no-hold | exempt. Ver db/migrations/0086.';

REVOKE ALL ON FUNCTION wallet_hold_adjust(uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_hold_adjust(uuid, uuid, uuid, bigint) TO app_user;
