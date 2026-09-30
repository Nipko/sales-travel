-- 0060_wallet_network_holds.sql
-- Retención en cascada por la red de financiación ("opción 1" del founder, 2026-09-29).
--
-- Hasta acá una reserva retenía sólo en la cartera del nodo que vende, en la moneda de la tarifa
-- (D-TBO-21 A; 0052 y PR #10). El cupo de esa cartera lo fija quien la financia, pero nada acotaba
-- lo que ese financiador podía dar: una agencia le daba cupo ilimitado a su sub-agencia y ésta
-- reservaba con la cuenta de proveedor que hereda de Planetour, que es la que le paga al proveedor.
-- La retención caía sólo en la cartera de la sub-agencia, que nadie de más arriba controla.
--
-- Decisión del founder del 2026-09-29 ("opción 1"): CADA RESERVA RETIENE TAMBIÉN EN LA CARTERA DE
-- CADA NIVEL QUE FINANCIA, EN LA MONEDA DE LA TARIFA, HASTA EL DUEÑO DE LA CREDENCIAL con la que se
-- reserva. La otra opción ("nadie da más cupo del que tiene") no se eligió.
--
--   - El nodo que vende (T) retiene el precio de venta en su cartera, como hasta 0060 (depth 0).
--   - Retiene además cada ancestro de T que financia (platform, consolidator o agency) y está por
--     DEBAJO del dueño de la credencial (O), por su COSTO: el neto más los markups de los niveles que
--     tiene encima (depth 1 = quien financia a T, y así hacia arriba). "Hasta el dueño" es exclusivo:
--     O le paga al proveedor con su propio contrato, así que quien lo financia no queda expuesto por
--     esa venta. La raíz tampoco retiene: siempre es O o está por encima de O.
--   - Con la cuenta propia de T (O = T; decisión del founder del 2026-09-30, "opción B") NO SE
--     RETIENE NADA, ni en T ni en su red, y T no necesita cartera en esa moneda: le paga al proveedor
--     con su contrato y nadie de arriba queda expuesto. La retención queda registrada como un grupo
--     'exempt', sin niveles, con el evento portfolio.hold.exempted. Sólo se exime lo que se puede
--     probar: la cuenta de T grabada en la orden al reservar (hoteles), o T es la plataforma, dueña
--     de toda credencial que se le resuelve. Sin cuenta en la orden (vuelos y autos), la bóveda de
--     ahora no dice con qué cuenta se reservó (el nodo pudo cargar la suya después, o el factory
--     completarla con secretos de entorno): T retiene en su cartera, como antes. Un nodo legado
--     suelto que vende con credenciales de entorno tampoco: esas credenciales son de Planetour.
--   - O sale de la orden, nunca de un parámetro: el dueño de la cuenta de la bóveda con que se
--     reservó (orders.provider_account_id, con el criterio de 0045). Si la orden no guarda cuenta
--     (vuelos y autos no la guardan), el dueño de la cuenta que la bóveda le resuelve al nodo para
--     ese proveedor (resolve_provider_account, la misma resolución con que el factory reservó), o la
--     raíz del árbol de T si no resuelve ninguna (credenciales de entorno).
--   - Todo o nada: se decide cada nivel antes de escribir, y si uno no alcanza no se retiene en
--     ninguno y no se llama al proveedor.
--
-- Qué deja esta migración:
--
--   1. El endurecimiento sin el cual las guardas no significan nada: una tabla temporal sombreaba
--      `pg_roles` dentro de current_role_bypasses_rls (0052) y cualquier tabla de las funciones
--      SECURITY DEFINER con `search_path = public` (la prueba está en
--      apps/api/src/portfolios/network-holds-rls.integration.test.ts).
--   2. El error de las retenciones, con SQLSTATE propio (raise_wallet_hold_violation).
--   3. El modo por red (wallet_hold_policy: off | observe | enforce). Sin fila, enforce; un 'off'
--      en cualquier ancestro gana (el kill-switch).
--   4. La instantánea de cada retención: wallet_hold_groups (una por orden, la ve quien vende) y
--      wallet_hold_levels (una por cartera retenida, la ve el dueño de esa cartera). Liberar recorre
--      lo registrado y nunca recalcula la cadena ni el dueño. Una venta con la cuenta propia deja
--      su grupo 'exempt' sin niveles: no hay nada que capturar ni liberar.
--   5. Los asientos NETWORK_HOLD y NETWORK_RELEASED, con CHECK de tipo y de signo.
--   6. Las guardas: los asientos de retención sólo los escriben las funciones de acá, y el saldo de
--      una cartera sólo lo mueven ellas o quien la financia.
--   7. Retener, liberar, anticipar y reportar (wallet_hold_*), la captura al confirmarse la reserva
--      y la vuelta a 'held' si la confirmación se retracta (la orden vuelve a pending).
--   8. move_tenant_subtree con las carteras bloqueadas en orden y STH02 sobre retenciones abiertas.
--   9. Las retenciones de antes pasan a grupos de un nivel ('legacy'), sin débitos retroactivos.
--  10. Un WARNING 'REVISAR' con los nodos intermedios a los que les falta cartera o cupo en una
--      moneda que usa su red: sus ventas en esa moneda se rechazan hasta que se les abra, o hasta
--      que el operador ponga 'observe' a mano. No se relaja nada solo. En producción hoy
--      (Planetour, Amazon Minimalist y una sucursal, todos de nivel ≤ 2) la cadena de cualquier
--      venta es vacía: no cambia ninguna.
--
-- CONTRATO CON LA API.
--
--   - wallet_hold_retain(orden, actor), wallet_hold_settle(orden, actor, estado esperado),
--     wallet_hold_preview(...), wallet_hold_report_block(orden) y
--     wallet_hold_report_preview_block(...) corren con `app.current_tenant_id`
--     del nodo que VENDE (DatabaseService.withTenant). El actor es el usuario que firma: tiene que
--     tener una membership, de cualquier estado, en ese nodo o en un ancestro (el vendedor, el admin
--     del dueño que corre la conciliación, el superadmin).
--   - Los montos, la moneda, la cadena y el dueño de la credencial los decide la base desde la orden.
--     La API no los pasa por parámetro, pero la venta (total_amount) y el neto (selected_offer) son
--     campos de la orden que escribe ella: la cascada confía en esos campos, y nada acá impide que
--     app_user los cambie (docs/platform/12 §14.8). Sólo wallet_hold_preview y el aviso del PreBook
--     (wallet_hold_report_preview_block), que corren antes de que exista la orden y no escriben
--     asientos, reciben el neto: el mismo que la base leerá después (wallet_hold_net):
--     pricing.netMinor en hoteles y autos, offer.total en vuelos.
--   - Desde acá `app_user` no inserta asientos BOOKING_* ni NETWORK_* y no mueve `balance_minor`,
--     salvo como quien financia (WalletFinancingService, withRequestContext). El código anterior a
--     0060 recibe 42501 en cuanto retiene o libera: la migración y el reinicio de la API van en el
--     mismo deploy (docs/platform/13, Paso 14 del runbook).
--   - `app_user` tampoco crea tablas temporales ni objetos en `public`.
--
-- Errores (CONSTRAINT = la regla, TABLE = 'wallet_hold_groups', MESSAGE en castellano sin ids ni
-- montos, DETAIL con los ids sólo para los logs):
--
--   STW01  la operación no es posible con el estado de la reserva o de su retención (4xx).
--   STW02  la retención se rechaza: una cartera no puede cubrir la reserva (409). No se escribió
--          nada y el proveedor no se llama.
--   42501  error de programación: falta el tenant del request, el actor no es de la red, o se
--          intentó escribir un asiento de retención o mover un saldo fuera de estas funciones.

-- ============================================================================
-- 1. El rol de la migración se salta la RLS
-- ============================================================================
-- Las funciones de retención son SECURITY DEFINER con este rol como dueño, y escriben en tablas con
-- RLS forzada (agency_portfolios, portfolio_transactions, orders): sólo funcionan si su dueño es
-- superusuario o BYPASSRLS. Mejor fallar acá (en RDS, por ejemplo) que en la primera reserva.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles r
     WHERE r.rolname = current_user
       AND (r.rolsuper OR r.rolbypassrls)
  ) THEN
    RAISE EXCEPTION '0060: el rol % no es superusuario ni BYPASSRLS: las funciones de retención no podrían escribir las carteras', current_user
      USING HINT = 'Corre la migración con el rol dueño del esquema (postgres en el VPS y en CI) o dale BYPASSRLS antes de migrar.';
  END IF;
END $$;

-- ============================================================================
-- 2. Endurecimiento
-- ============================================================================
-- current_role_bypasses_rls (0052) es INVOKER a propósito (mira al rol que escribe), pero leía
-- `pg_roles` sin calificar y sin search_path fijo: una tabla temporal `pg_roles` de la sesión (el
-- esquema temporal se busca primero si no está en el path) le hacía creer a la guarda que app_user
-- se salta la RLS. Queda con pg_catalog primero y pg_temp último.
CREATE OR REPLACE FUNCTION current_role_bypasses_rls()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
    false);
$$;

COMMENT ON FUNCTION current_role_bypasses_rls() IS
  '¿El rol que ejecuta la sentencia (current_user) es superusuario o BYPASSRLS? Para que las guardas de 0052 y 0060 traten como la RLS a migraciones, seeds, la consola del operador y las funciones SECURITY DEFINER de retención. search_path fijo y pg_catalog.pg_roles calificado desde 0060. Llamarla sólo desde funciones SECURITY INVOKER.';

-- Sin tablas temporales para la aplicación: con ellas se sombrea cualquier relación que una función
-- lea sin calificar. Nada de la API las usa (sólo tools/sync-airports, que corre como postgres).
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM app_user', current_database());
END $$;

-- Ni objetos propios en `public` (en PostgreSQL 15+ ya viene así; en una base anterior, no).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- El search_path de las funciones que ya existen se endurece al final (sección 12), para cubrir
-- también a move_tenant_subtree, que se reemplaza acá con el encabezado de 0051.

-- ============================================================================
-- 3. El error
-- ============================================================================
-- Un solo sitio que arma los errores de las retenciones, para que las funciones, los triggers y las
-- guardas digan lo mismo con el mismo código. MESSAGE sin ids ni montos: la API muestra el suyo y
-- éste llega a los logs; DETAIL ('order=… depth=… tenant=… portfolio=…') es sólo para los logs.
CREATE FUNCTION raise_wallet_hold_violation(p_rule TEXT, p_detail TEXT)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  msg    TEXT;
  code   TEXT;
  advice TEXT;
BEGIN
  msg := CASE p_rule
    WHEN 'wallet_hold_no_tenant' THEN
      'la operación de retención necesita el tenant del request'
    WHEN 'wallet_hold_actor_invalid' THEN
      'quien firma la retención no pertenece a la red de la reserva'
    WHEN 'hold_entry_reserved' THEN
      'los asientos de retención sólo los escriben las funciones de retención'
    WHEN 'portfolio_balance_reserved' THEN
      'el saldo de una cartera sólo lo mueven sus asientos o quien la financia'
    WHEN 'hold_order_not_found' THEN
      'la reserva no existe en este nodo'
    WHEN 'hold_order_not_holdable' THEN
      'la reserva no está en un estado que pueda retener saldo'
    WHEN 'hold_already_exists' THEN
      'la reserva ya tiene una retención'
    WHEN 'hold_amount_invalid' THEN
      'la reserva no tiene un total y una moneda válidos'
    WHEN 'hold_owner_unresolvable' THEN
      'la cuenta del proveedor de la reserva ya no está activa en la red del nodo'
    WHEN 'hold_release_order_open' THEN
      'la reserva no está en el estado que la liberación exige'
    WHEN 'hold_release_out_of_range' THEN
      'la liberación dejaría el saldo fuera del rango registrable'
    WHEN 'hold_currency_not_enabled' THEN
      'el nodo no tiene cartera activa en la moneda de la reserva'
    WHEN 'hold_inactive' THEN
      'la cartera del nodo en esa moneda no está activa'
    WHEN 'hold_funds_insufficient' THEN
      'la cartera del nodo no tiene saldo ni cupo para la reserva'
    WHEN 'network_currency_not_enabled' THEN
      'un nivel de la red no tiene cartera en la moneda de la reserva'
    WHEN 'network_funds_unavailable' THEN
      'un nivel de la red no puede cubrir la reserva'
    WHEN 'network_cost_unavailable' THEN
      'no se pudo calcular el costo de la reserva para la red'
    ELSE 'la operación viola las reglas de las retenciones de cartera'
  END;

  code := CASE
    WHEN p_rule IN ('wallet_hold_no_tenant', 'wallet_hold_actor_invalid',
                    'hold_entry_reserved', 'portfolio_balance_reserved') THEN '42501'
    WHEN p_rule IN ('hold_currency_not_enabled', 'hold_inactive', 'hold_funds_insufficient',
                    'network_currency_not_enabled', 'network_funds_unavailable',
                    'network_cost_unavailable') THEN 'STW02'
    ELSE 'STW01'
  END;

  advice := CASE code
    WHEN '42501' THEN
      'Las retenciones las escriben sólo wallet_hold_retain y wallet_hold_settle, con app.current_tenant_id del nodo que vende y un actor de su red; el saldo lo mueven ellas o quien financia al nodo (can_finance_tenant). Ver db/migrations/0060.'
    WHEN 'STW02' THEN
      'No se retuvo saldo en ninguna cartera y el proveedor no se llamó. Cada nivel que financia retiene en la moneda de la tarifa hasta el dueño de la credencial. Ver db/migrations/0060.'
    ELSE
      'La retención de una reserva nace con la reserva abierta (o confirmada, en la retención manual), se captura al confirmarse y se libera cuando falla o se cancela. Ver db/migrations/0060.'
  END;

  RAISE EXCEPTION USING
    ERRCODE    = code,
    CONSTRAINT = p_rule,
    TABLE      = 'wallet_hold_groups',
    MESSAGE    = msg,
    DETAIL     = p_detail,
    HINT       = advice;
END;
$$;

COMMENT ON FUNCTION raise_wallet_hold_violation(text, text) IS
  'Lanza el error de la regla p_rule de las retenciones: 42501 (wallet_hold_no_tenant, wallet_hold_actor_invalid, hold_entry_reserved, portfolio_balance_reserved), STW02 (la retención se rechaza: hold_* de la cartera propia, network_* de la red) o STW01 (hold_* de estado). CONSTRAINT = p_rule, TABLE = wallet_hold_groups, mensaje en castellano sin ids ni montos y DETAIL para los logs. Ver db/migrations/0060.';

-- EXECUTE para app_user porque la llaman las guardas INVOKER (secciones 7 y 8), que corren con el
-- rol de quien escribe. Sólo lanza un error: no lee ni escribe nada.
REVOKE ALL ON FUNCTION raise_wallet_hold_violation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION raise_wallet_hold_violation(text, text) TO app_user;

-- ============================================================================
-- 4. El modo por red
-- ============================================================================
-- Un 'off' en cualquier ancestro-o-igual del nodo que vende gana; si no hay, manda la fila del
-- ancestro-o-igual más cercano; sin ninguna, 'enforce':
--
--   off      sólo retiene el nodo que vende, como antes de 0060, sin exigir que la cuenta de la
--            orden se resuelva (el kill-switch: en la raíz apaga la cascada en todo el árbol, aunque
--            una red tenga su propia fila 'enforce');
--   observe  retiene el nodo que vende y deja 'portfolio.network_hold.would_block' en cada nivel de
--            la red que habría rechazado, sin tocar sus carteras;
--   enforce  la cascada completa.
--
-- La cambia el operador por psql (INSERT … ON CONFLICT (tenant_id) DO UPDATE SET mode, reason y
-- updated_by, docs/platform/13 Paso 14). La aplicación no la lee ni la escribe: la consultan las
-- funciones de retención. El rastro de cada cambio no es de la red afectada: va como evento de
-- plataforma (tenant_id NULL), así el nodo no lee la razón ni el autor que anotó el operador. El
-- modo con que se tomó cada retención sí lo ve: va en sus eventos portfolio.hold.* y en
-- wallet_hold_groups.mode.
CREATE TABLE wallet_hold_policy (
  tenant_id   UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode        TEXT         NOT NULL,
  reason      TEXT         NOT NULL,
  updated_by  UUID         NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT wallet_hold_policy_mode_check
    CHECK (mode IN ('off', 'observe', 'enforce')),
  CONSTRAINT wallet_hold_policy_reason_length
    CHECK (char_length(reason) BETWEEN 1 AND 200)
);

COMMENT ON TABLE wallet_hold_policy IS
  'Modo de la retención en cascada por red: off | observe | enforce. Un off en cualquier ancestro-o-igual del nodo que vende gana; si no, manda la fila del más cercano; sin ninguna, enforce. La escribe el operador por psql; app_user no la lee ni la escribe. Cada cambio deja wallet_hold.policy_changed como evento de plataforma (tenant_id NULL). Ver db/migrations/0060.';
COMMENT ON COLUMN wallet_hold_policy.mode IS
  'off: sólo retiene el nodo que vende (kill-switch; gana sobre las filas de más abajo). observe: además deja portfolio.network_hold.would_block en los niveles que habrían rechazado. enforce: la cascada completa.';
COMMENT ON COLUMN wallet_hold_policy.reason IS
  'Por qué se fijó el modo (1 a 200 caracteres): la última razón declarada. Va al domain_event del cambio sólo si ese cambio la declaró.';
COMMENT ON COLUMN wallet_hold_policy.updated_by IS
  'Usuario que hizo el último cambio, si lo declaró (en la sentencia o con SET LOCAL wallet_hold.actor). Un cambio que no lo declara lo deja en NULL: nunca hereda el del cambio anterior. Sin FK: es rastro, no referencia.';

ALTER TABLE wallet_hold_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_hold_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON wallet_hold_policy FROM app_user;

CREATE TRIGGER wallet_hold_policy_set_updated_at
  BEFORE UPDATE ON wallet_hold_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Quien cambia la política por psql puede declararse con SET LOCAL wallet_hold.actor = '<uuid>'
-- (y el motivo de un borrado con wallet_hold.reason). Un valor que no es un UUID cuenta como no
-- declarado.
CREATE FUNCTION wallet_hold_policy_actor_setting()
RETURNS UUID
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v TEXT := current_setting('wallet_hold.actor', true);
BEGIN
  IF v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v::uuid;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION wallet_hold_policy_actor_setting() IS
  'wallet_hold.actor como UUID, o NULL si no está puesto o no es un UUID. Helper de 0060, sin GRANT.';

REVOKE ALL ON FUNCTION wallet_hold_policy_actor_setting() FROM PUBLIC;

-- Un cambio de modo o de razón que no nombra updated_by lo dejaría con el autor del cambio anterior
-- (el upsert natural, DO UPDATE SET mode = EXCLUDED.mode, no lo toca), y el rastro le atribuiría a
-- otro, por ejemplo, un kill-switch. Sin autor declarado queda el de wallet_hold.actor o NULL.
CREATE FUNCTION wallet_hold_policy_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_by := COALESCE(NEW.updated_by, public.wallet_hold_policy_actor_setting());
  ELSIF (NEW.mode, NEW.reason) IS DISTINCT FROM (OLD.mode, OLD.reason)
        AND NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by THEN
    NEW.updated_by := public.wallet_hold_policy_actor_setting();
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION wallet_hold_policy_stamp() IS
  'Trigger de wallet_hold_policy: un cambio que no declara updated_by queda con wallet_hold.actor o NULL, nunca con el autor del cambio anterior. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_policy_stamp() FROM PUBLIC;

CREATE TRIGGER wallet_hold_policy_stamp
  BEFORE INSERT OR UPDATE ON wallet_hold_policy
  FOR EACH ROW EXECUTE FUNCTION wallet_hold_policy_stamp();

-- ============================================================================
-- 5. La instantánea de cada retención
-- ============================================================================
-- Sin FK a `tenants` en ninguna de las dos: move_tenant_subtree bloquea los tenants FOR UPDATE y
-- después las carteras, y el KEY SHARE que tomaría una FK desde la retención (que bloquea la cartera
-- primero) armaría un deadlock. Las FK a orders, agency_portfolios y portfolio_transactions caen
-- sobre filas que la misma transacción ya tiene bloqueadas. ON DELETE RESTRICT: borrar una orden o
-- una cartera con retenciones registradas falla (23503) en vez de dejar plata varada.
CREATE TABLE wallet_hold_groups (
  id                          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id                    UUID         NOT NULL,
  origin_tenant_id            UUID         NOT NULL,
  order_number                BIGINT       NULL,
  currency                    TEXT         NOT NULL,
  sale_amount_minor           BIGINT       NOT NULL,
  provider_code               TEXT         NOT NULL,
  provider_account_id         UUID         NULL,
  credential_owner_tenant_id  UUID         NULL,
  credential_source           TEXT         NOT NULL,
  mode                        TEXT         NOT NULL,
  status                      TEXT         NOT NULL,
  created_by                  UUID         NOT NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  captured_at                 TIMESTAMPTZ  NULL,
  closed_at                   TIMESTAMPTZ  NULL,

  CONSTRAINT wallet_hold_groups_order_key UNIQUE (order_id),
  -- Destino de la FK compuesta de los niveles: el nivel es de ESE grupo y de esa orden.
  CONSTRAINT wallet_hold_groups_id_order_key UNIQUE (id, order_id),
  CONSTRAINT wallet_hold_groups_order_fk
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT wallet_hold_groups_currency_format
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallet_hold_groups_sale_amount_positive
    CHECK (sale_amount_minor > 0),
  CONSTRAINT wallet_hold_groups_credential_source_check
    CHECK (credential_source IN ('account', 'resolved', 'root', 'legacy', 'unresolved')),
  CONSTRAINT wallet_hold_groups_unresolved_only_off
    CHECK (credential_source <> 'unresolved' OR (mode = 'off' AND credential_owner_tenant_id IS NULL)),
  CONSTRAINT wallet_hold_groups_mode_check
    CHECK (mode IN ('off', 'observe', 'enforce', 'legacy')),
  CONSTRAINT wallet_hold_groups_status_check
    CHECK (status IN ('held', 'captured', 'released', 'conflict', 'exempt')),
  -- Sin retención sólo con la cuenta propia del que vende (O = T): la grabada en la orden o, sin
  -- cuenta en la orden, la de la plataforma (wallet_hold_is_own_account; el tipo no cabe en un CHECK).
  CONSTRAINT wallet_hold_groups_exempt_own_account
    CHECK (status <> 'exempt'
           OR (credential_owner_tenant_id = origin_tenant_id
               AND ((credential_source = 'account' AND provider_account_id IS NOT NULL)
                    OR (credential_source IN ('resolved', 'root')
                        AND provider_account_id IS NULL)))),
  CONSTRAINT wallet_hold_groups_captured_at
    CHECK (status <> 'captured' OR captured_at IS NOT NULL),
  CONSTRAINT wallet_hold_groups_closed_at
    CHECK ((status = 'released') = (closed_at IS NOT NULL))
);

CREATE INDEX idx_wallet_hold_groups_origin
  ON wallet_hold_groups (origin_tenant_id, created_at DESC);
CREATE INDEX idx_wallet_hold_groups_account_open
  ON wallet_hold_groups (provider_account_id, origin_tenant_id)
  WHERE status IN ('held', 'captured');

COMMENT ON TABLE wallet_hold_groups IS
  'Una retención de cartera por orden (0060): quién vende, qué se vendió, con qué credencial y en qué modo, y su estado. La ve el nodo que vende (RLS por origin_tenant_id); la escriben sólo wallet_hold_retain, wallet_hold_settle y la captura al confirmar. Sus niveles, uno por cartera retenida, están en wallet_hold_levels; una venta con la cuenta propia del que vende queda exempt y sin niveles.';
COMMENT ON COLUMN wallet_hold_groups.origin_tenant_id IS
  'El nodo que vende (app.current_tenant_id de la retención). Sin FK a tenants a propósito (ver 0060 §5).';
COMMENT ON COLUMN wallet_hold_groups.sale_amount_minor IS
  'Precio de venta retenido en la cartera del nodo que vende (orders.total_amount), en unidades menores de currency.';
COMMENT ON COLUMN wallet_hold_groups.credential_owner_tenant_id IS
  'Dueño de la credencial (O) al retener: el de la cuenta de la orden; si la orden no tiene cuenta, el de la cuenta que la bóveda le resolvía al nodo para ese proveedor, o la raíz si no había. Los niveles por debajo de O retienen; O no. Si O es el que vende con su cuenta propia grabada en la orden, o el que vende es la plataforma, no retiene nadie: el grupo queda exempt. NULL en una retención legacy sin cuenta o en una unresolved.';
COMMENT ON COLUMN wallet_hold_groups.credential_source IS
  'account: O es el dueño de orders.provider_account_id. resolved: la orden no guarda cuenta (vuelos, autos) y O es el dueño de la que resolve_provider_account le resolvía al nodo para ese proveedor. root: la orden no tiene cuenta y la bóveda no resuelve ninguna (credenciales de entorno); O es la raíz. legacy: retención anterior a 0060. unresolved: con el modo off, la cuenta de la orden ya no se resolvía y sólo retuvo el nodo que vende.';
COMMENT ON COLUMN wallet_hold_groups.mode IS
  'El modo de wallet_hold_policy con que se retuvo, o legacy si es anterior a 0060.';
COMMENT ON COLUMN wallet_hold_groups.status IS
  'held: retenida. captured: la reserva se confirmó y la retención quedó como cargo. released: liberada en todos sus niveles. conflict: figuró confirmada y después no realizada; requiere conciliación manual. exempt: no retuvo nada porque el que vende reservó con su propia cuenta (credential_owner_tenant_id = origin_tenant_id, con la cuenta en provider_account_id; o la plataforma sin cuenta en la orden; decisión del founder del 2026-09-30); no tiene niveles ni cambia de estado.';

CREATE TABLE wallet_hold_levels (
  id                      UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id                UUID         NOT NULL,
  order_id                UUID         NOT NULL,
  depth                   SMALLINT     NOT NULL,
  tenant_id               UUID         NOT NULL,
  portfolio_id            UUID         NOT NULL,
  origin_tenant_id        UUID         NOT NULL,
  order_number            BIGINT       NULL,
  currency                TEXT         NOT NULL,
  amount_minor            BIGINT       NOT NULL,
  basis                   TEXT         NOT NULL,
  hold_transaction_id     UUID         NOT NULL,
  release_transaction_id  UUID         NULL,
  status                  TEXT         NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT wallet_hold_levels_group_fk
    FOREIGN KEY (group_id, order_id) REFERENCES wallet_hold_groups (id, order_id) ON DELETE RESTRICT,
  -- La cartera es de ese nodo y en esa moneda (el UNIQUE (id, tenant_id, currency) de 0052).
  CONSTRAINT wallet_hold_levels_portfolio_fk
    FOREIGN KEY (portfolio_id, tenant_id, currency)
    REFERENCES agency_portfolios (id, tenant_id, currency) ON DELETE RESTRICT,
  CONSTRAINT wallet_hold_levels_hold_transaction_fk
    FOREIGN KEY (hold_transaction_id) REFERENCES portfolio_transactions (id),
  CONSTRAINT wallet_hold_levels_release_transaction_fk
    FOREIGN KEY (release_transaction_id) REFERENCES portfolio_transactions (id),
  CONSTRAINT wallet_hold_levels_hold_transaction_key UNIQUE (hold_transaction_id),
  CONSTRAINT wallet_hold_levels_release_transaction_key UNIQUE (release_transaction_id),
  CONSTRAINT wallet_hold_levels_group_depth_key UNIQUE (group_id, depth),
  CONSTRAINT wallet_hold_levels_order_portfolio_key UNIQUE (order_id, portfolio_id),
  CONSTRAINT wallet_hold_levels_depth_range
    CHECK (depth BETWEEN 0 AND 3),
  CONSTRAINT wallet_hold_levels_currency_format
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallet_hold_levels_amount_positive
    CHECK (amount_minor > 0),
  CONSTRAINT wallet_hold_levels_basis_check
    CHECK (basis IN ('sale', 'cost')),
  CONSTRAINT wallet_hold_levels_basis_by_depth
    CHECK ((depth = 0) = (basis = 'sale')),
  CONSTRAINT wallet_hold_levels_status_check
    CHECK (status IN ('held', 'captured', 'released', 'conflict')),
  CONSTRAINT wallet_hold_levels_release_link
    CHECK ((status = 'released') = (release_transaction_id IS NOT NULL))
);

CREATE INDEX idx_wallet_hold_levels_tenant
  ON wallet_hold_levels (tenant_id, status, created_at DESC);
CREATE INDEX idx_wallet_hold_levels_portfolio
  ON wallet_hold_levels (portfolio_id);

CREATE TRIGGER wallet_hold_levels_set_updated_at
  BEFORE UPDATE ON wallet_hold_levels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE wallet_hold_levels IS
  'Un nivel de una retención (0060): la cartera retenida, cuánto y por qué base. depth 0 es el nodo que vende (precio de venta); depth ≥ 1, cada ancestro que financia por debajo del dueño de la credencial (su costo). La ve sólo el dueño de la cartera (RLS por tenant_id): el que vende no ve los niveles de arriba. La escriben sólo las funciones de retención.';
COMMENT ON COLUMN wallet_hold_levels.depth IS
  '0 = el nodo que vende; 1 = quien lo financia; y así hacia arriba, sin llegar al dueño de la credencial.';
COMMENT ON COLUMN wallet_hold_levels.tenant_id IS
  'Dueño de la cartera retenida. Sin FK a tenants a propósito (ver 0060 §5); la FK compuesta a agency_portfolios fija que la cartera es suya y en esa moneda.';
COMMENT ON COLUMN wallet_hold_levels.amount_minor IS
  'Lo retenido en la cartera, positivo, en unidades menores de currency: el precio de venta en depth 0, el costo del nivel en los demás.';
COMMENT ON COLUMN wallet_hold_levels.basis IS
  'sale en depth 0 (orders.total_amount); cost en los ancestros: neto + markups de los niveles con nlevel menor (compute_price_waterfall).';
COMMENT ON COLUMN wallet_hold_levels.hold_transaction_id IS
  'El asiento que retuvo: BOOKING_HOLD en depth 0, NETWORK_HOLD en los ancestros.';
COMMENT ON COLUMN wallet_hold_levels.release_transaction_id IS
  'El asiento que liberó (BOOKING_RELEASED o NETWORK_RELEASED), si se liberó.';

-- La RLS: sólo lectura para la aplicación. El grupo lo ve el nodo que vende; cada nivel, el dueño
-- de la cartera. Escribir, sólo las funciones de retención (dueño de la tabla, se salta la RLS).
ALTER TABLE wallet_hold_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_hold_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE wallet_hold_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_hold_levels FORCE ROW LEVEL SECURITY;

CREATE POLICY wallet_hold_groups_origin_read ON wallet_hold_groups
  FOR SELECT
  USING (origin_tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY wallet_hold_levels_owner_read ON wallet_hold_levels
  FOR SELECT
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

COMMENT ON POLICY wallet_hold_groups_origin_read ON wallet_hold_groups IS
  'El nodo que vende (app.current_tenant_id = origin_tenant_id) ve sus retenciones.';
COMMENT ON POLICY wallet_hold_levels_owner_read ON wallet_hold_levels IS
  'El dueño de la cartera retenida (app.current_tenant_id = tenant_id) ve sus niveles; el que vende no ve los de sus ancestros.';

-- 0001 da SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva: se deja sólo SELECT.
REVOKE ALL ON wallet_hold_groups, wallet_hold_levels FROM app_user;
GRANT SELECT ON wallet_hold_groups, wallet_hold_levels TO app_user;

-- ============================================================================
-- 6. Los asientos de la red
-- ============================================================================
-- Tipos conocidos y signo: una retención resta y una liberación suma. NOT VALID: rige para lo que
-- se escriba desde acá sin revisar el libro de antes (que podría tener un tipo viejo).
ALTER TABLE portfolio_transactions
  ADD CONSTRAINT portfolio_transactions_type_known
    CHECK (transaction_type IN ('DEPOSIT_PAYMENT', 'MANUAL_ADJUSTMENT', 'BOOKING_HOLD',
                                'BOOKING_RELEASED', 'BOOKING_CHARGE', 'NETWORK_HOLD',
                                'NETWORK_RELEASED')) NOT VALID,
  ADD CONSTRAINT portfolio_transactions_hold_sign
    CHECK (
      (transaction_type NOT IN ('BOOKING_HOLD', 'NETWORK_HOLD') OR amount_minor < 0)
      AND (transaction_type NOT IN ('BOOKING_RELEASED', 'NETWORK_RELEASED') OR amount_minor > 0)
    ) NOT VALID;

COMMENT ON CONSTRAINT portfolio_transactions_type_known ON portfolio_transactions IS
  'Tipos de asiento conocidos desde 0060. NOT VALID: no revisa el libro anterior.';
COMMENT ON CONSTRAINT portfolio_transactions_hold_sign ON portfolio_transactions IS
  'BOOKING_HOLD y NETWORK_HOLD restan (< 0); BOOKING_RELEASED y NETWORK_RELEASED suman (> 0). NOT VALID: no revisa el libro anterior.';

-- Una retención y una liberación de red por (cartera, orden). Las de depth 0 siguen con los índices
-- globales por orden de 0039 y 0040, que no se tocan.
CREATE UNIQUE INDEX uq_portfolio_transactions_network_hold
  ON portfolio_transactions (portfolio_id, lower(reference_id))
  WHERE transaction_type = 'NETWORK_HOLD';

CREATE UNIQUE INDEX uq_portfolio_transactions_network_release
  ON portfolio_transactions (portfolio_id, lower(reference_id))
  WHERE transaction_type = 'NETWORK_RELEASED';

COMMENT ON INDEX uq_portfolio_transactions_network_hold IS
  'Un NETWORK_HOLD por (cartera, orden normalizada): la red no retiene dos veces la misma reserva en la misma cartera. Ver db/migrations/0060.';
COMMENT ON INDEX uq_portfolio_transactions_network_release IS
  'Un NETWORK_RELEASED por (cartera, orden normalizada): la liberación de red no acredita dos veces. Ver db/migrations/0060.';

-- ============================================================================
-- 7. Las guardas del libro y del saldo
-- ============================================================================
-- Los asientos de retención (BOOKING_* y NETWORK_*) sólo los escriben las funciones de 0060, que
-- corren con el dueño de la tabla, o una sesión que se salta la RLS (migraciones, seeds, la consola
-- del operador). Sin esto la cascada es decorativa: la API, o quien la comprometa, retendría sólo
-- en la cartera propia. SECURITY INVOKER: `current_role_bypasses_rls` mira al rol que escribe.
CREATE FUNCTION portfolio_transactions_hold_entries_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.transaction_type IN ('BOOKING_HOLD', 'BOOKING_RELEASED', 'BOOKING_CHARGE',
                              'NETWORK_HOLD', 'NETWORK_RELEASED')
     AND NOT public.current_role_bypasses_rls() THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_entry_reserved',
      format('asiento %s en la cartera %s, orden %s: rol %s',
             NEW.transaction_type, NEW.portfolio_id, COALESCE(NEW.reference_id, '?'), current_user));
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION portfolio_transactions_hold_entries_gate() IS
  'Trigger de portfolio_transactions: un asiento BOOKING_HOLD, BOOKING_RELEASED, BOOKING_CHARGE, NETWORK_HOLD o NETWORK_RELEASED sólo lo escriben las funciones de retención (dueño de la tabla) o un rol que se salta la RLS. 42501 hold_entry_reserved. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION portfolio_transactions_hold_entries_gate() FROM PUBLIC;

CREATE TRIGGER portfolio_transactions_hold_entries_gate
  BEFORE INSERT ON portfolio_transactions
  FOR EACH ROW EXECUTE FUNCTION portfolio_transactions_hold_entries_gate();

-- El saldo lo mueven los asientos: las funciones de retención (dueño de la tabla) o quien financia
-- al nodo, que ya corre con su usuario (WalletFinancingService: depósitos, ajustes, aprobaciones).
-- Sin lista de columnas en el trigger: el WHEN compara el saldo antes y después, así lo frena
-- aunque otra guarda futura lo cambie en NEW sin que el UPDATE lo nombre.
CREATE FUNCTION agency_portfolios_balance_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF public.current_role_bypasses_rls() OR public.can_finance_tenant(NEW.tenant_id) THEN
    RETURN NEW;
  END IF;
  PERFORM public.raise_wallet_hold_violation(
    'portfolio_balance_reserved',
    format('cartera %s del tenant %s: rol %s, usuario %s',
           NEW.id, NEW.tenant_id, current_user,
           COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), 'ninguno')));
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION agency_portfolios_balance_guard() IS
  'Trigger de agency_portfolios: cambiar balance_minor exige un rol que se salta la RLS (las funciones de retención, migraciones, seeds) o ser quien financia al nodo (can_finance_tenant). 42501 portfolio_balance_reserved. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION agency_portfolios_balance_guard() FROM PUBLIC;

CREATE TRIGGER agency_portfolios_balance_guard
  BEFORE UPDATE ON agency_portfolios
  FOR EACH ROW
  WHEN (NEW.balance_minor IS DISTINCT FROM OLD.balance_minor)
  EXECUTE FUNCTION agency_portfolios_balance_guard();

-- ============================================================================
-- 8. Helpers (sin GRANT: los usan las funciones de retención, que corren con su dueño)
-- ============================================================================

-- El nodo del request. Sin él, o con un valor que no es un UUID, es un error de programación.
CREATE FUNCTION wallet_hold_current_tenant()
RETURNS UUID
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v TEXT := current_setting('app.current_tenant_id', true);
BEGIN
  IF v IS NULL OR v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.raise_wallet_hold_violation(
      'wallet_hold_no_tenant', format('app.current_tenant_id = %L', COALESCE(v, '(sin valor)')));
  END IF;
  RETURN v::uuid;
END;
$$;

COMMENT ON FUNCTION wallet_hold_current_tenant() IS
  'app.current_tenant_id como UUID; sin él o inválido, 42501 wallet_hold_no_tenant. Helper de 0060, sin GRANT.';

-- Quien firma tiene una membership (de cualquier estado: la liberación puede venir de un usuario
-- dado de baja) en el nodo o en un ancestro, o es superadmin de la plataforma (que también alcanza a
-- un nodo legado suelto). Así entran el vendedor, el admin del dueño que corre la conciliación y el
-- superadmin; no un usuario de otra red.
CREATE FUNCTION wallet_hold_assert_actor(p_actor UUID, p_tenant UUID)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.tenants mt ON mt.id = m.tenant_id
      JOIN public.tenants t  ON t.id = p_tenant
     WHERE m.user_id = p_actor
       AND (
         mt.path OPERATOR(public.@>) t.path
         OR (m.role = 'superadmin' AND mt.tenant_type = 'platform')
       )
  ) THEN
    PERFORM public.raise_wallet_hold_violation(
      'wallet_hold_actor_invalid',
      format('actor %s, tenant %s', COALESCE(p_actor::text, 'ninguno'), p_tenant));
  END IF;
END;
$$;

COMMENT ON FUNCTION wallet_hold_assert_actor(uuid, uuid) IS
  'Quien firma una retención tiene membership (de cualquier estado) en p_tenant o en un ancestro, o es superadmin de la plataforma; si no, 42501 wallet_hold_actor_invalid. Helper de 0060, sin GRANT.';

-- El modo de la red del nodo. Un 'off' en cualquier ancestro-o-igual gana sobre las filas de más
-- abajo: si no, el kill-switch en la raíz no destrabaría las redes que ya tienen su propia fila
-- (las que el operador pasó de observe a enforce). Entre las demás, manda la más cercana; sin
-- ninguna, enforce.
CREATE FUNCTION wallet_hold_mode(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT p.mode
       FROM public.wallet_hold_policy p
       JOIN public.tenants a ON a.id = p.tenant_id
       JOIN public.tenants t ON t.id = p_tenant
      WHERE a.path OPERATOR(public.@>) t.path
      ORDER BY (p.mode = 'off') DESC, nlevel(a.path) DESC
      LIMIT 1),
    'enforce');
$$;

COMMENT ON FUNCTION wallet_hold_mode(uuid) IS
  'Modo de la retención en cascada para p_tenant: off si algún ancestro-o-igual tiene off; si no, la fila de wallet_hold_policy del ancestro-o-igual más cercano; sin ninguna, enforce. Helper de 0060, sin GRANT.';

-- El dueño de la credencial (O) y su nivel:
--
--   - con cuenta: su dueño, si la cuenta cumple el criterio de 0045 (mismo proveedor que la orden,
--     activa, y propia del nodo o de un ancestro que la deja heredar). Si no lo cumple, ninguna fila
--     (y quien llama falla cerrado);
--   - sin cuenta en la orden (vuelos y autos no la guardan): el dueño de la cuenta que la bóveda le
--     resuelve al nodo para el proveedor (resolve_provider_account: la propia, o la del ancestro
--     heredable más cercano), que es la misma resolución con que el factory reservó. Sin esto una
--     sub-agencia que vuela con su propia cuenta retendría en toda su red hasta la raíz, y a sus
--     ancestros les quedaría un cargo por una venta que no les debe nada;
--   - sin cuenta en la orden ni en la bóveda (credenciales de entorno): la raíz del árbol del nodo.
--     Con la matriz D4 es Planetour; un nodo legado suelto es su propia raíz, así que su cadena
--     queda vacía.
--
-- La resolución de la bóveda es la de ahora, no la del momento de reservar: si el nodo cambió de
-- cuenta en el medio, retiene con la nueva. Liberar nunca la recalcula (recorre lo registrado).
CREATE FUNCTION wallet_hold_owner(p_tenant UUID, p_provider TEXT, p_account UUID)
RETURNS TABLE (owner_id UUID, owner_level INTEGER, source TEXT)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pa.tenant_id, nlevel(owner_t.path), 'account'::text
    FROM public.tenants me
    JOIN public.provider_accounts pa ON pa.id = p_account
                                    AND pa.provider_code = p_provider
                                    AND pa.status = 'active'
    JOIN public.tenants owner_t      ON owner_t.id = pa.tenant_id
   WHERE p_account IS NOT NULL
     AND me.id = p_tenant
     AND (
       pa.tenant_id = me.id
       OR (pa.is_inheritable AND owner_t.path OPERATOR(public.@>) me.path)
     )
  UNION ALL
  SELECT rp.tenant_id, nlevel(owner_t.path), 'resolved'::text
    FROM public.resolve_provider_account(p_tenant, p_provider) rp
    JOIN public.tenants owner_t ON owner_t.id = rp.tenant_id
   WHERE p_account IS NULL
     AND rp.id IS NOT NULL
  UNION ALL
  SELECT r.id, nlevel(r.path), 'root'::text
    FROM public.tenants me
    JOIN public.tenants r ON r.path = subpath(me.path, 0, 1)
   WHERE p_account IS NULL
     AND me.id = p_tenant
     AND NOT EXISTS (
       SELECT 1
         FROM public.resolve_provider_account(p_tenant, p_provider) rp
        WHERE rp.id IS NOT NULL
     );
$$;

COMMENT ON FUNCTION wallet_hold_owner(uuid, text, uuid) IS
  'Dueño de la credencial de una venta de p_tenant: el de la cuenta p_account si cumple el criterio de 0045 (mismo proveedor, activa, propia o de un ancestro heredable); con p_account NULL, el de la cuenta que resolve_provider_account le resuelve a p_tenant para p_provider (resolved), o la raíz del árbol si no resuelve ninguna (root). Sin fila si p_account no se resuelve. Helper de 0060, sin GRANT.';

-- ¿La venta es con la cuenta propia del nodo que vende (O = T)? Decisión del founder del
-- 2026-09-30 ("opción B"): entonces no retiene nadie, ni el nodo ni su red, y el nodo no necesita
-- cartera en esa moneda. Le paga al proveedor con su contrato y nadie de arriba queda expuesto.
--
-- Se exime sólo lo que se puede probar:
--
--   - account: la cuenta grabada en la orden al reservar (hoteles) es del nodo. Es la credencial
--     con que salió la reserva;
--   - la plataforma, con cualquier origen: todo lo que se le resuelve (su cuenta de la bóveda o las
--     credenciales de entorno) es suyo, porque no tiene ancestros de quien heredar.
--
-- Sin cuenta en la orden (resolved, vuelos y autos) no alcanza con que la bóveda le resuelva hoy
-- al nodo una cuenta suya: no dice con qué cuenta se reservó. El nodo pudo cargarla o activarla
-- después de reservar con la heredada, y el factory de autos completa una cuenta sin token con el
-- de Planetour. Retiene el nodo en su cartera, como antes de 0060 (su cadena es vacía: O = T). Un
-- nodo legado suelto con credenciales de entorno (root) tampoco se exime: es su propia raíz, pero
-- esas credenciales no son suyas sino de Planetour.
CREATE FUNCTION wallet_hold_is_own_account(p_tenant UUID, p_owner UUID, p_source TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    p_owner = p_tenant
    AND (
      p_source = 'account'
      OR (p_source IN ('resolved', 'root')
          AND EXISTS (SELECT 1 FROM public.tenants t
                       WHERE t.id = p_tenant AND t.tenant_type = 'platform'))
    ),
    false);
$$;

COMMENT ON FUNCTION wallet_hold_is_own_account(uuid, uuid, text) IS
  'true si la venta de p_tenant es con su propia cuenta y se puede probar: el dueño p_owner es p_tenant y la cuenta es la grabada en la orden (account) o p_tenant es la plataforma (resolved o root: todo lo que se le resuelve es suyo). Entonces no retiene nadie (decisión del founder del 2026-09-30). Sin cuenta en la orden, la de la bóveda de ahora no prueba con qué se reservó: false, y el nodo retiene. Helper de 0060, sin GRANT.';

-- La cadena de la red: los ancestros de p_tenant que financian (platform, consolidator, agency) con
-- nivel mayor que el del dueño, del más cercano al más lejano. depth 1 es quien financia a p_tenant;
-- con la matriz D4 es aplicar tenant_financier_id hacia arriba hasta O, sin incluirlo.
CREATE FUNCTION wallet_hold_chain(p_tenant UUID, p_owner_level INTEGER)
RETURNS TABLE (depth SMALLINT, tenant_id UUID, lvl INTEGER)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT (row_number() OVER (ORDER BY nlevel(a.path) DESC))::smallint,
         a.id,
         nlevel(a.path)
    FROM public.tenants t
    JOIN public.tenants a ON a.path OPERATOR(public.@>) t.path
                         AND a.id <> t.id
   WHERE t.id = p_tenant
     AND a.tenant_type IN ('platform', 'consolidator', 'agency')
     AND nlevel(a.path) > p_owner_level
   ORDER BY nlevel(a.path) DESC;
$$;

COMMENT ON FUNCTION wallet_hold_chain(uuid, integer) IS
  'Ancestros de p_tenant que financian (platform, consolidator, agency) con nlevel > p_owner_level, en depth 1, 2… del más cercano al más lejano. Helper de 0060, sin GRANT.';

-- El neto de la oferta que guardó la orden, sólo si es un entero en rango y está en la moneda de la
-- orden. Si no, NULL: quien llama falla cerrado y nunca vuelve al precio de venta.
--
--   - selected_offer.pricing.netMinor: lo escriben hoteles (desde el intent; lo reescribe el revise
--     de C2) y autos;
--   - en vuelos, selected_offer.total: la oferta canónica lleva ahí el NETO del proveedor
--     (packages/canonical offer.ts), revalidado contra el proveedor antes de abrir la orden
--     (OrdersService.revalidateForCreate); su pricing es la vista del tenant y no trae el neto.
CREATE FUNCTION wallet_hold_net(p_offer JSONB, p_currency TEXT, p_vertical TEXT)
RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  raw TEXT;
  cur TEXT;
BEGIN
  IF p_offer IS NULL OR jsonb_typeof(p_offer) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_offer -> 'pricing') = 'object' AND (p_offer -> 'pricing') ? 'netMinor' THEN
    raw := p_offer -> 'pricing' ->> 'netMinor';
    cur := p_offer -> 'pricing' ->> 'currency';
  ELSIF p_vertical = 'flights' AND jsonb_typeof(p_offer -> 'total') = 'object' THEN
    raw := p_offer -> 'total' ->> 'amountMinor';
    cur := p_offer -> 'total' ->> 'currency';
  ELSE
    RETURN NULL;
  END IF;
  IF cur IS DISTINCT FROM p_currency THEN
    RETURN NULL;
  END IF;
  IF raw IS NULL OR raw !~ '^[0-9]{1,16}$' THEN
    RETURN NULL;
  END IF;
  IF raw::numeric < 1 OR raw::numeric > 9007199254740991 THEN
    RETURN NULL;
  END IF;
  RETURN raw::bigint;
END;
$$;

COMMENT ON FUNCTION wallet_hold_net(jsonb, text, text) IS
  'Neto de la oferta de la orden: selected_offer.pricing.netMinor (hoteles, autos) o, en vuelos, selected_offer.total.amountMinor (el neto del proveedor de la oferta canónica); sólo si es un entero entre 1 y 2^53-1 en la moneda p_currency. Si no, NULL. Helper de 0060, sin GRANT.';

-- El costo de un nivel L de la red: el neto más lo que suman las reglas de los niveles de ARRIBA de
-- L (level < nlevel(L)), con las mismas reglas y el mismo orden que el precio de venta
-- (compute_price_waterfall, 0016; applyCascade en la API). No incluye el piso del proveedor ni los
-- markups de L y de sus descendientes. LEFT JOIN: sin reglas, el costo es el neto.
CREATE FUNCTION wallet_hold_level_cost(p_tenant UUID, p_vertical TEXT, p_net BIGINT, p_level INTEGER)
RETURNS NUMERIC
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_net::numeric
         + COALESCE(sum((e.value ->> 'addedMinor')::numeric)
                      FILTER (WHERE (e.value ->> 'level')::integer < p_level), 0)
    FROM public.compute_price_waterfall(p_tenant, p_vertical, p_net) w
    LEFT JOIN LATERAL jsonb_array_elements(w.breakdown) e ON true;
$$;

COMMENT ON FUNCTION wallet_hold_level_cost(uuid, text, bigint, integer) IS
  'Costo para el nivel p_level de una venta de p_tenant: p_net + addedMinor de las entradas de compute_price_waterfall con level < p_level. Helper de 0060, sin GRANT.';

-- ¿La cartera cubre el monto? La misma decisión que decideBookingHold (booking-hold.ts): sin
-- cartera en la moneda, no habilitada; no activa, inactiva; saldo + cupo positivo < monto, sin
-- fondos. Un monto NULL (costo no calculable) no llega acá: lo corta quien llama.
CREATE FUNCTION wallet_hold_decide(p_wallet agency_portfolios, p_amount BIGINT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_wallet.id IS NULL THEN
    RETURN 'currency_not_enabled';
  END IF;
  IF p_wallet.status IS DISTINCT FROM 'active' THEN
    RETURN 'inactive';
  END IF;
  IF p_wallet.balance_minor::numeric + GREATEST(p_wallet.credit_limit_minor, 0) < p_amount THEN
    RETURN 'funds_insufficient';
  END IF;
  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION wallet_hold_decide(agency_portfolios, bigint) IS
  'ok | currency_not_enabled | inactive | funds_insufficient para retener p_amount de la cartera p_wallet (fila vacía = sin cartera en esa moneda). Replica decideBookingHold. Helper de 0060, sin GRANT.';

-- El rastro, en la misma transacción que el movimiento. aggregate = la orden; payload sin nombres
-- ni pasajeros.
CREATE FUNCTION wallet_hold_emit(p_tenant UUID, p_actor UUID, p_type TEXT, p_order UUID, p_payload JSONB)
RETURNS void
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (p_tenant, p_actor, p_type, 'order', p_order::text, p_payload);
$$;

COMMENT ON FUNCTION wallet_hold_emit(uuid, uuid, text, uuid, jsonb) IS
  'Escribe un domain_event de retención (aggregate_type order) en el tenant p_tenant. Helper de 0060, sin GRANT.';

-- El evento de un nivel, en el tenant dueño de la cartera. El actor sólo en depth 0: los eventos de
-- los niveles de la red no dicen quién vendió. El de depth 0 queda en el tenant del que vende, y la
-- actividad de la red (AuditService.networkAudit) se lo muestra a los admins de sus ancestros.
CREATE FUNCTION wallet_hold_level_event(
  p_level  wallet_hold_levels,
  p_mode   TEXT,
  p_actor  UUID,
  p_type   TEXT,
  p_source TEXT,
  p_extra  JSONB
) RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.wallet_hold_emit(
    p_level.tenant_id,
    CASE WHEN p_level.depth = 0 THEN p_actor END,
    p_type,
    p_level.order_id,
    jsonb_build_object(
      'orderId', p_level.order_id,
      'orderNumber', p_level.order_number,
      'originTenantId', p_level.origin_tenant_id,
      'portfolioId', p_level.portfolio_id,
      'depth', p_level.depth,
      'amountMinor', p_level.amount_minor,
      'currency', p_level.currency,
      'basis', p_level.basis,
      'status', p_level.status,
      'mode', p_mode,
      'source', p_source
    ) || COALESCE(p_extra, '{}'::jsonb));
END;
$$;

COMMENT ON FUNCTION wallet_hold_level_event(wallet_hold_levels, text, uuid, text, text, jsonb) IS
  'Escribe el domain_event p_type de un nivel en el tenant dueño de su cartera, con el actor sólo en depth 0 y sin nombres. Helper de 0060, sin GRANT.';

-- held → captured en el grupo y en sus niveles, sin tocar carteras: la retención ya es el cargo.
-- La llaman la captura al confirmar (actor NULL) y wallet_hold_settle. Quien llama ya tiene el
-- grupo bloqueado.
CREATE FUNCTION wallet_hold_capture(p_group_id UUID, p_actor UUID, p_source TEXT)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  g   public.wallet_hold_groups;
  lvl public.wallet_hold_levels;
BEGIN
  UPDATE public.wallet_hold_groups wg
     SET status = 'captured', captured_at = now()
   WHERE wg.id = p_group_id AND wg.status = 'held'
  RETURNING wg.* INTO g;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  FOR lvl IN
    UPDATE public.wallet_hold_levels wl
       SET status = 'captured', updated_at = now()
     WHERE wl.group_id = p_group_id AND wl.status = 'held'
    RETURNING wl.*
  LOOP
    PERFORM public.wallet_hold_level_event(lvl, g.mode, p_actor, 'portfolio.hold.captured', p_source, NULL);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION wallet_hold_capture(uuid, uuid, text) IS
  'Pasa un grupo held y sus niveles a captured, con portfolio.hold.captured por nivel, sin mover saldo. Helper de 0060, sin GRANT.';

-- El grupo y sus niveles abiertos pasan a 'conflict': la reserva figuró confirmada (la retención ya
-- es un cargo) y después no realizada, o el libro tiene una liberación que no casa. No mueve saldo:
-- lo resuelve una persona. Un evento por nivel en el dueño de su cartera, como retener, capturar y
-- liberar: el consolidador o la agencia cuyo cupo queda congelado tiene su rastro (actor sólo en
-- depth 0).
CREATE FUNCTION wallet_hold_mark_conflict(p_group wallet_hold_groups, p_actor UUID, p_cause TEXT)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  lvl public.wallet_hold_levels;
  n   INTEGER := 0;
BEGIN
  UPDATE public.wallet_hold_groups wg SET status = 'conflict' WHERE wg.id = p_group.id;

  FOR lvl IN
    UPDATE public.wallet_hold_levels wl
       SET status = 'conflict', updated_at = now()
     WHERE wl.group_id = p_group.id AND wl.status IN ('held', 'captured')
    RETURNING wl.*
  LOOP
    PERFORM public.wallet_hold_level_event(
      lvl, p_group.mode, p_actor, 'portfolio.hold.conflict', 'db:wallet_hold_settle',
      jsonb_build_object('cause', p_cause, 'previousStatus', p_group.status));
    n := n + 1;
  END LOOP;

  -- Sin niveles abiertos (no debería pasar), el rastro queda igual en el nodo que vende.
  IF n = 0 THEN
    PERFORM public.wallet_hold_emit(
      p_group.origin_tenant_id, p_actor, 'portfolio.hold.conflict', p_group.order_id,
      jsonb_build_object(
        'orderId', p_group.order_id,
        'orderNumber', p_group.order_number,
        'originTenantId', p_group.origin_tenant_id,
        'currency', p_group.currency,
        'previousStatus', p_group.status,
        'cause', p_cause,
        'source', 'db:wallet_hold_settle'
      ));
  END IF;
END;
$$;

COMMENT ON FUNCTION wallet_hold_mark_conflict(wallet_hold_groups, uuid, text) IS
  'Pasa un grupo y sus niveles abiertos a conflict, sin mover saldo, con portfolio.hold.conflict por nivel en el dueño de su cartera (actor sólo en depth 0). Helper de 0060, sin GRANT.';

-- Libera todos los niveles abiertos de un grupo, sobre LO REGISTRADO: nunca recalcula la cadena ni
-- el dueño (una cuenta desactivada o un nodo movido después de retener no cambian dónde se
-- devuelve). Bloquea las carteras por (nlevel DESC, id), el orden de retain y de move.
--
-- Reentrante: si el asiento de liberación de (cartera, orden) ya existe —un estado a medias, o una
-- liberación del código anterior a 0060—, lo enlaza sin volver a acreditar. Si existe y no casa con
-- lo retenido, no mueve nada y el grupo pasa a 'conflict'. No exige que la cartera esté activa:
-- devolver lo retenido no es operar.
CREATE FUNCTION wallet_hold_release_all(p_group wallet_hold_groups, p_actor UUID, p_reason TEXT)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  lvl      public.wallet_hold_levels;
  done     public.wallet_hold_levels;
  prior    RECORD;
  tx_type  TEXT;
  tx_id    UUID;
  mismatch BOOLEAN := false;
BEGIN
  PERFORM 1
     FROM public.agency_portfolios ap
     LEFT JOIN public.tenants t ON t.id = ap.tenant_id
    WHERE ap.id IN (SELECT wl.portfolio_id
                      FROM public.wallet_hold_levels wl
                     WHERE wl.group_id = p_group.id
                       AND wl.status IN ('held', 'captured'))
    ORDER BY nlevel(t.path) DESC NULLS LAST, ap.id
      FOR UPDATE OF ap;

  -- Primero se mira todo; recién después se escribe.
  FOR lvl IN
    SELECT wl.* FROM public.wallet_hold_levels wl
     WHERE wl.group_id = p_group.id AND wl.status IN ('held', 'captured')
     ORDER BY wl.depth
  LOOP
    tx_type := CASE WHEN lvl.depth = 0 THEN 'BOOKING_RELEASED' ELSE 'NETWORK_RELEASED' END;
    -- BOOKING_RELEASED es único por orden en todo el libro (0040): se busca en cualquier cartera.
    FOR prior IN
      SELECT pt.portfolio_id, pt.amount_minor
        FROM public.portfolio_transactions pt
       WHERE pt.transaction_type = tx_type
         AND lower(pt.reference_id) = lower(lvl.order_id::text)
         AND (lvl.depth = 0 OR pt.portfolio_id = lvl.portfolio_id)
    LOOP
      IF prior.portfolio_id <> lvl.portfolio_id OR prior.amount_minor <> lvl.amount_minor THEN
        mismatch := true;
      END IF;
    END LOOP;
  END LOOP;

  IF mismatch THEN
    PERFORM public.wallet_hold_mark_conflict(p_group, p_actor, 'release_mismatch');
    RETURN 'conflict';
  END IF;

  FOR lvl IN
    SELECT wl.* FROM public.wallet_hold_levels wl
     WHERE wl.group_id = p_group.id AND wl.status IN ('held', 'captured')
     ORDER BY wl.depth
  LOOP
    tx_type := CASE WHEN lvl.depth = 0 THEN 'BOOKING_RELEASED' ELSE 'NETWORK_RELEASED' END;
    SELECT pt.id INTO tx_id
      FROM public.portfolio_transactions pt
     WHERE pt.portfolio_id = lvl.portfolio_id
       AND pt.transaction_type = tx_type
       AND lower(pt.reference_id) = lower(lvl.order_id::text);

    IF NOT FOUND THEN
      INSERT INTO public.portfolio_transactions
        (portfolio_id, amount_minor, transaction_type, reference_id, notes, created_by)
      VALUES (
        lvl.portfolio_id,
        lvl.amount_minor,
        tx_type,
        lvl.order_id::text,
        CASE
          WHEN lvl.depth = 0 AND p_reason = 'failed' THEN
            'El proveedor no hizo la reserva; saldo retenido liberado'
          WHEN lvl.depth = 0 THEN
            'Cancelación confirmada por el proveedor; saldo retenido liberado'
          WHEN p_reason = 'failed' THEN
            'Reserva de tu red no realizada; retención liberada'
          ELSE
            'Reserva de tu red cancelada; retención liberada'
        END,
        p_actor)
      RETURNING id INTO tx_id;

      UPDATE public.agency_portfolios ap
         SET balance_minor = ap.balance_minor + lvl.amount_minor
       WHERE ap.id = lvl.portfolio_id
         AND ap.balance_minor::numeric + lvl.amount_minor
             BETWEEN -9007199254740991 AND 9007199254740991;
      IF NOT FOUND THEN
        PERFORM public.raise_wallet_hold_violation(
          'hold_release_out_of_range',
          format('order=%s depth=%s tenant=%s portfolio=%s',
                 lvl.order_id, lvl.depth, lvl.tenant_id, lvl.portfolio_id));
      END IF;
    END IF;

    UPDATE public.wallet_hold_levels wl
       SET status = 'released', release_transaction_id = tx_id, updated_at = now()
     WHERE wl.id = lvl.id
    RETURNING wl.* INTO done;

    PERFORM public.wallet_hold_level_event(
      done, p_group.mode, p_actor, 'portfolio.hold.released', 'db:wallet_hold_settle',
      jsonb_build_object('reason', p_reason));
  END LOOP;

  UPDATE public.wallet_hold_groups wg
     SET status = 'released', closed_at = now()
   WHERE wg.id = p_group.id;

  RETURN 'released';
END;
$$;

COMMENT ON FUNCTION wallet_hold_release_all(wallet_hold_groups, uuid, text) IS
  'Libera los niveles abiertos de un grupo sobre lo registrado (BOOKING_RELEASED en depth 0, NETWORK_RELEASED en los demás), enlazando la liberación que ya exista; si una no casa, conflict sin mover saldo. Bloquea las carteras por (nlevel DESC, id). Devuelve released | conflict. Helper de 0060, sin GRANT.';

REVOKE ALL ON FUNCTION wallet_hold_current_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_assert_actor(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_mode(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_owner(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_is_own_account(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_chain(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_net(jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_level_cost(uuid, text, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_decide(agency_portfolios, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_emit(uuid, uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_level_event(wallet_hold_levels, text, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_capture(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_mark_conflict(wallet_hold_groups, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_hold_release_all(wallet_hold_groups, uuid, text) FROM PUBLIC;

-- El rastro de cada cambio de modo, en la misma transacción que el cambio. SECURITY DEFINER: lo
-- escribe el operador con cualquier rol que pueda tocar la tabla.
--
-- Es un evento de plataforma (tenant_id NULL, aggregate = el nodo): los admins del nodo y de sus
-- ancestros leen los eventos de su tenant (0029) y no tienen por qué enterarse de que su cascada
-- está apagada ni leer la razón que anotó el operador. Se consulta directo en la base, como los
-- demás eventos de plataforma.
--
-- El actor es el que declaró ESE cambio (wallet_hold_policy_stamp): en un borrado, el de
-- wallet_hold.actor, nunca el autor de la fila borrada. La razón va sólo si el cambio la declaró:
-- en un borrado, la de wallet_hold.reason.
CREATE FUNCTION wallet_hold_policy_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target UUID;
  actor  UUID;
  now_m  TEXT;
  was_m  TEXT;
  why    TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD.tenant_id;
    actor  := public.wallet_hold_policy_actor_setting();
    was_m  := OLD.mode;
    why    := left(NULLIF(btrim(current_setting('wallet_hold.reason', true)), ''), 200);
  ELSIF TG_OP = 'UPDATE' THEN
    target := NEW.tenant_id; actor := NEW.updated_by; now_m := NEW.mode; was_m := OLD.mode;
    why := CASE WHEN NEW.reason IS DISTINCT FROM OLD.reason THEN NEW.reason END;
  ELSE
    target := NEW.tenant_id; actor := NEW.updated_by; now_m := NEW.mode; why := NEW.reason;
  END IF;

  INSERT INTO public.domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (
    NULL, actor, 'wallet_hold.policy_changed', 'tenant', target::text,
    jsonb_build_object(
      'targetTenantId', target,
      'mode', now_m,
      'previousMode', was_m,
      'reason', why,
      'operation', lower(TG_OP),
      'effectiveMode', public.wallet_hold_mode(target),
      'source', 'db:wallet_hold_policy'
    ));
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION wallet_hold_policy_audit() IS
  'Trigger de wallet_hold_policy: deja wallet_hold.policy_changed como evento de plataforma (tenant_id NULL, aggregate = el nodo, actor = quien declaró ese cambio) con targetTenantId, mode, previousMode, la razón que declaró el cambio y el modo efectivo después. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_policy_audit() FROM PUBLIC;

CREATE TRIGGER wallet_hold_policy_audit
  AFTER INSERT OR UPDATE OR DELETE ON wallet_hold_policy
  FOR EACH ROW EXECUTE FUNCTION wallet_hold_policy_audit();

-- La captura al confirmarse la reserva: el grupo held pasa a captured sin tocar carteras. Bloquea
-- la orden (ya la tiene el UPDATE) y después el grupo: el mismo orden que wallet_hold_settle.
-- SECURITY DEFINER: la confirmación la escribe app_user, que no escribe en wallet_hold_*.
CREATE FUNCTION wallet_hold_capture_on_confirm() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target UUID;
BEGIN
  SELECT wg.id INTO target
    FROM public.wallet_hold_groups wg
   WHERE wg.order_id = NEW.id AND wg.status = 'held'
     FOR UPDATE;
  IF FOUND THEN
    PERFORM public.wallet_hold_capture(target, NULL, 'db:wallet_hold_capture_on_confirm');
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION wallet_hold_capture_on_confirm() IS
  'Trigger de orders: al pasar a confirmed o ticketed, la retención held de la orden pasa a captured en el grupo y en sus niveles (portfolio.hold.captured por nivel, actor NULL), sin mover saldo. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_capture_on_confirm() FROM PUBLIC;

CREATE TRIGGER wallet_hold_capture_on_confirm
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status IN ('confirmed', 'ticketed') AND OLD.status NOT IN ('confirmed', 'ticketed'))
  EXECUTE FUNCTION wallet_hold_capture_on_confirm();

-- La confirmación retractada: la plataforma devuelve a 'pending' una orden confirmada cuando la
-- lectura de cierre contradice al proveedor (OrderCreateIntentStore.markPending). La retención
-- capturada vuelve a 'held' en el grupo y en sus niveles, sin mover saldo, así la conciliación
-- decide de nuevo: si la reserva no existía (failed), se libera como antes de 0060, en vez de
-- quedar en 'conflict' con la plata congelada en toda la red. 'conflict' queda para una orden que
-- pasa a failed directo desde confirmed o ticketed. Mismo orden de bloqueo que la captura.
CREATE FUNCTION wallet_hold_uncapture_on_retract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  g   public.wallet_hold_groups;
  lvl public.wallet_hold_levels;
BEGIN
  SELECT wg.* INTO g
    FROM public.wallet_hold_groups wg
   WHERE wg.order_id = NEW.id AND wg.status = 'captured'
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.wallet_hold_groups wg
     SET status = 'held', captured_at = NULL
   WHERE wg.id = g.id;

  FOR lvl IN
    UPDATE public.wallet_hold_levels wl
       SET status = 'held', updated_at = now()
     WHERE wl.group_id = g.id AND wl.status = 'captured'
    RETURNING wl.*
  LOOP
    PERFORM public.wallet_hold_level_event(
      lvl, g.mode, NULL, 'portfolio.hold.uncaptured', 'db:wallet_hold_uncapture_on_retract',
      jsonb_build_object('previousOrderStatus', OLD.status));
  END LOOP;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION wallet_hold_uncapture_on_retract() IS
  'Trigger de orders: al volver de confirmed o ticketed a pending (la confirmación se retracta), la retención captured de la orden vuelve a held en el grupo y en sus niveles (portfolio.hold.uncaptured por nivel, actor NULL), sin mover saldo. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_uncapture_on_retract() FROM PUBLIC;

CREATE TRIGGER wallet_hold_uncapture_on_retract
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (OLD.status IN ('confirmed', 'ticketed') AND NEW.status = 'pending')
  EXECUTE FUNCTION wallet_hold_uncapture_on_retract();

-- ============================================================================
-- 9. Retener, liberar, anticipar y reportar
-- ============================================================================

-- Retiene la reserva en la cartera del nodo que vende y, según el modo, en la de cada nivel de su
-- red hasta el dueño de la credencial. Una transacción, todo o nada:
--
--   orden FOR UPDATE → cartera propia FOR UPDATE → cadena (derivada después de ese bloqueo, así un
--   move concurrente ya terminó o espera) → carteras de la red FOR UPDATE por nlevel DESC. Se
--   decide cada nivel antes de escribir; el primer rechazo lanza STW02 y no queda nada.
--
-- La orden nace:
--   - 'held' si es un intent abierto (pending, sin desenlace del proveedor y con create_request_key):
--     la retención de hoteles antes del Book (RF-23; D-TBO-21 A);
--   - 'captured' si ya está confirmada (la retención manual de POST /portfolios/hold-booking);
--   - 'exempt' si se reserva con la cuenta propia del nodo (O = T; wallet_hold_is_own_account: la
--     grabada en la orden, o el nodo es la plataforma): no se retiene nada, ni en su cartera ni en
--     su red, y no hace falta que tenga cartera en esa moneda. Queda el grupo sin niveles y
--     'portfolio.hold.exempted' en el nodo, con el proveedor y la cuenta. Rige en todos los modos:
--     'off' apaga la cascada, nunca endurece. Llamarla otra vez devuelve el mismo grupo.
--
-- Los montos salen de la orden y de las reglas de markup: el precio de venta en depth 0 y el costo
-- de cada nivel en los demás. Sin neto válido con la cadena no vacía, no se retiene
-- (network_cost_unavailable): nunca se vuelve al precio de venta.
CREATE FUNCTION wallet_hold_retain(p_order_id UUID, p_actor UUID)
RETURNS TABLE (
  group_id            UUID,
  hold_status         TEXT,
  own_portfolio_id    UUID,
  own_transaction_id  UUID,
  network_levels      SMALLINT,
  mode                TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '2s'
AS $$
#variable_conflict use_column
DECLARE
  me          UUID;
  ord         RECORD;
  v_currency  TEXT;
  v_amount    BIGINT;
  v_initial   TEXT;
  v_mode      TEXT;
  v_owner_id  UUID;
  v_owner_level INTEGER;
  v_source    TEXT;
  v_resolved  BOOLEAN;
  prior       public.wallet_hold_groups;
  own         public.agency_portfolios;
  anc         public.agency_portfolios;
  v_decision  TEXT;
  v_reason    TEXT;
  v_net       BIGINT;
  v_vertical  TEXT;
  v_cost      NUMERIC;
  c_tenant    UUID[]     := '{}';
  c_depth     SMALLINT[] := '{}';
  c_lvl       INTEGER[]  := '{}';
  c_cost      NUMERIC[]  := '{}';
  c_wallet    UUID[]     := '{}';
  v_group     UUID;
  v_own_tx    UUID;
  v_tx        UUID;
  v_level     public.wallet_hold_levels;
  v_written   SMALLINT   := 0;
  i           INTEGER;
  r           RECORD;
BEGIN
  me := public.wallet_hold_current_tenant();
  PERFORM public.wallet_hold_assert_actor(p_actor, me);

  SELECT o.id, o.status, o.total_amount, o.currency, o.provider, o.provider_account_id,
         (o.provider_raw IS NULL) AS no_outcome, o.create_request_key, o.order_number,
         o.selected_offer, o.search_criteria
    INTO ord
    FROM public.orders o
   WHERE o.id = p_order_id
     AND o.tenant_id = me
     FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_found', format('order=%s tenant=%s', p_order_id, me));
  END IF;

  IF ord.status = 'pending' AND ord.no_outcome AND ord.create_request_key IS NOT NULL THEN
    v_initial := 'held';
  ELSIF ord.status = 'confirmed' THEN
    v_initial := 'captured';
  ELSE
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_holdable', format('order=%s tenant=%s status=%s', ord.id, me, ord.status));
  END IF;

  -- Una orden ya eximida no tiene nada que retener: se devuelve lo registrado, sin otro evento.
  SELECT wg.* INTO prior FROM public.wallet_hold_groups wg WHERE wg.order_id = ord.id;
  IF prior.id IS NOT NULL AND prior.status = 'exempt' THEN
    group_id := prior.id;
    hold_status := prior.status;
    own_portfolio_id := NULL;
    own_transaction_id := NULL;
    network_levels := 0;
    mode := prior.mode;
    RETURN NEXT;
    RETURN;
  END IF;
  IF prior.id IS NOT NULL
     OR EXISTS (SELECT 1
                  FROM public.portfolio_transactions pt
                 WHERE pt.transaction_type = 'BOOKING_HOLD'
                   AND lower(pt.reference_id) = lower(ord.id::text)) THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_already_exists', format('order=%s tenant=%s', ord.id, me));
  END IF;

  -- La moneda como la normaliza la API (normalizeCurrency): sin espacios y en mayúsculas.
  v_currency := upper(btrim(ord.currency));
  IF ord.total_amount IS NULL
     OR ord.total_amount < 1
     OR ord.total_amount > 9007199254740991
     OR v_currency IS NULL
     OR v_currency !~ '^[A-Z]{3}$' THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_amount_invalid', format('order=%s tenant=%s', ord.id, me));
  END IF;
  v_amount := ord.total_amount;

  -- La cartera propia se bloquea antes de derivar el dueño y la cadena, como siempre (así un move
  -- concurrente ya terminó o espera); se decide después de saber si hace falta.
  SELECT ap.* INTO own
    FROM public.agency_portfolios ap
   WHERE ap.tenant_id = me AND ap.currency = v_currency
     FOR UPDATE;

  v_mode := public.wallet_hold_mode(me);
  SELECT o.owner_id, o.owner_level, o.source
    INTO v_owner_id, v_owner_level, v_source
    FROM public.wallet_hold_owner(me, ord.provider, ord.provider_account_id) o;
  v_resolved := FOUND;

  -- Sin saber quién le paga al proveedor no se sabe si hace falta cartera ni hasta dónde retener:
  -- se falla cerrado, antes que decidir la cartera propia. Con 'off' la cadena no se usa: una
  -- cuenta que ya no se resuelve (una credencial rotada antes de la retención manual de una orden
  -- confirmada) no frena la retención propia, como antes de 0060; queda registrada como
  -- 'unresolved' (y nunca es la cuenta propia).
  IF NOT v_resolved THEN
    IF v_mode <> 'off' THEN
      PERFORM public.raise_wallet_hold_violation(
        'hold_owner_unresolvable',
        format('order=%s tenant=%s account=%s', ord.id, me, COALESCE(ord.provider_account_id::text, '?')));
    END IF;
    v_owner_id := NULL;
    v_owner_level := NULL;
    v_source := 'unresolved';
  END IF;

  -- Con la cuenta propia (O = T) no se retiene nada ni hace falta cartera: queda el grupo sin
  -- niveles, con el rastro en el nodo que vende. El evento dice qué cuenta se tomó como propia (la
  -- de la orden; NULL sólo si vende la plataforma sin cuenta en la orden), por si después se
  -- desactiva: la orden la sigue referenciando y no se puede borrar.
  IF v_resolved AND public.wallet_hold_is_own_account(me, v_owner_id, v_source) THEN
    INSERT INTO public.wallet_hold_groups
      (order_id, origin_tenant_id, order_number, currency, sale_amount_minor, provider_code,
       provider_account_id, credential_owner_tenant_id, credential_source, mode, status, created_by)
    VALUES
      (ord.id, me, ord.order_number, v_currency, v_amount, ord.provider,
       ord.provider_account_id, v_owner_id, v_source, v_mode, 'exempt', p_actor)
    RETURNING id INTO v_group;

    PERFORM public.wallet_hold_emit(
      me, p_actor, 'portfolio.hold.exempted', ord.id,
      jsonb_build_object(
        'orderId', ord.id,
        'orderNumber', ord.order_number,
        'originTenantId', me,
        'amountMinor', v_amount,
        'currency', v_currency,
        'status', 'exempt',
        'reason', 'own_account',
        'providerCode', ord.provider,
        'providerAccountId', ord.provider_account_id,
        'credentialSource', v_source,
        'mode', v_mode,
        'source', 'db:wallet_hold_retain'
      ));

    group_id := v_group;
    hold_status := 'exempt';
    own_portfolio_id := NULL;
    own_transaction_id := NULL;
    network_levels := 0;
    mode := v_mode;
    RETURN NEXT;
    RETURN;
  END IF;

  -- La cartera propia, con sus motivos de siempre, antes que la red.
  v_decision := public.wallet_hold_decide(own, v_amount);
  IF v_decision <> 'ok' THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_' || v_decision,
      format('order=%s depth=0 tenant=%s portfolio=%s', ord.id, me, COALESCE(own.id::text, '?')));
  END IF;

  IF v_mode <> 'off' THEN
    FOR r IN SELECT * FROM public.wallet_hold_chain(me, v_owner_level) LOOP
      c_tenant := c_tenant || r.tenant_id;
      c_depth  := c_depth || r.depth;
      c_lvl    := c_lvl || r.lvl;
    END LOOP;
  END IF;

  IF cardinality(c_tenant) > 0 THEN
    v_vertical := COALESCE(ord.search_criteria ->> 'vertical', 'flights');
    v_net := public.wallet_hold_net(ord.selected_offer, v_currency, v_vertical);
    FOR i IN 1 .. cardinality(c_tenant) LOOP
      v_cost := NULL;
      IF v_net IS NOT NULL THEN
        v_cost := public.wallet_hold_level_cost(me, v_vertical, v_net, c_lvl[i]);
        IF v_cost < 1 OR v_cost > 9007199254740991 OR v_cost <> trunc(v_cost) THEN
          v_cost := NULL;
        END IF;
      END IF;
      c_cost := c_cost || v_cost;
    END LOOP;

    IF v_mode = 'enforce' THEN
      i := array_position(c_cost, NULL);
      IF i IS NOT NULL THEN
        PERFORM public.raise_wallet_hold_violation(
          'network_cost_unavailable',
          format('order=%s depth=%s tenant=%s portfolio=?', ord.id, c_depth[i], c_tenant[i]));
      END IF;

      FOR i IN 1 .. cardinality(c_tenant) LOOP
        SELECT ap.* INTO anc
          FROM public.agency_portfolios ap
         WHERE ap.tenant_id = c_tenant[i] AND ap.currency = v_currency
           FOR UPDATE;
        v_decision := public.wallet_hold_decide(anc, c_cost[i]::bigint);
        IF v_decision <> 'ok' THEN
          PERFORM public.raise_wallet_hold_violation(
            CASE WHEN v_decision = 'currency_not_enabled'
                 THEN 'network_currency_not_enabled'
                 ELSE 'network_funds_unavailable' END,
            format('order=%s depth=%s tenant=%s portfolio=%s',
                   ord.id, c_depth[i], c_tenant[i], COALESCE(anc.id::text, '?')));
        END IF;
        c_wallet := c_wallet || anc.id;
      END LOOP;
    ELSE
      -- observe: la misma evaluación, sin bloquear ni escribir asientos en la red.
      FOR i IN 1 .. cardinality(c_tenant) LOOP
        v_reason := NULL;
        IF c_cost[i] IS NULL THEN
          v_reason := 'network_cost_unavailable';
        ELSE
          SELECT ap.* INTO anc
            FROM public.agency_portfolios ap
           WHERE ap.tenant_id = c_tenant[i] AND ap.currency = v_currency;
          v_decision := public.wallet_hold_decide(anc, c_cost[i]::bigint);
          IF v_decision = 'currency_not_enabled' THEN
            v_reason := 'network_currency_not_enabled';
          ELSIF v_decision <> 'ok' THEN
            v_reason := 'network_funds_unavailable';
          END IF;
        END IF;
        IF v_reason IS NOT NULL THEN
          PERFORM public.wallet_hold_emit(
            c_tenant[i], NULL, 'portfolio.network_hold.would_block', ord.id,
            jsonb_build_object(
              'orderId', ord.id,
              'orderNumber', ord.order_number,
              'originTenantId', me,
              'depth', c_depth[i],
              'currency', v_currency,
              'reason', v_reason,
              'amountMinor', c_cost[i],
              'source', 'db:wallet_hold_retain'
            ));
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Recién ahora se escribe: el grupo, la retención propia y la de cada nivel de la red.
  INSERT INTO public.wallet_hold_groups
    (order_id, origin_tenant_id, order_number, currency, sale_amount_minor, provider_code,
     provider_account_id, credential_owner_tenant_id, credential_source, mode, status, created_by,
     captured_at)
  VALUES
    (ord.id, me, ord.order_number, v_currency, v_amount, ord.provider,
     ord.provider_account_id, v_owner_id, v_source, v_mode, v_initial, p_actor,
     CASE WHEN v_initial = 'captured' THEN now() END)
  RETURNING id INTO v_group;

  INSERT INTO public.portfolio_transactions
    (portfolio_id, amount_minor, transaction_type, reference_id, notes, created_by)
  VALUES
    (own.id, -v_amount, 'BOOKING_HOLD', ord.id::text,
     CASE WHEN v_initial = 'held'
          THEN 'Retención de saldo antes de reservar con el proveedor'
          ELSE 'Retención preventiva de saldo por reserva pendiente de emisión' END,
     p_actor)
  RETURNING id INTO v_own_tx;

  -- La fila está bloqueada y la decisión tomada; el predicado repite el cupo y el rango por si otra
  -- ruta escribió el saldo sin tomar el mismo bloqueo.
  UPDATE public.agency_portfolios ap
     SET balance_minor = ap.balance_minor - v_amount
   WHERE ap.id = own.id
     AND ap.status = 'active'
     AND ap.balance_minor::numeric + GREATEST(ap.credit_limit_minor, 0) >= v_amount
     AND ap.balance_minor::numeric - v_amount BETWEEN -9007199254740991 AND 9007199254740991;
  IF NOT FOUND THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_funds_insufficient', format('order=%s depth=0 tenant=%s portfolio=%s', ord.id, me, own.id));
  END IF;

  INSERT INTO public.wallet_hold_levels
    (group_id, order_id, depth, tenant_id, portfolio_id, origin_tenant_id, order_number, currency,
     amount_minor, basis, hold_transaction_id, status)
  VALUES
    (v_group, ord.id, 0, me, own.id, me, ord.order_number, v_currency,
     v_amount, 'sale', v_own_tx, v_initial)
  RETURNING * INTO v_level;
  PERFORM public.wallet_hold_level_event(
    v_level, v_mode, p_actor, 'portfolio.hold.retained', 'db:wallet_hold_retain', NULL);

  FOR i IN 1 .. cardinality(c_wallet) LOOP
    INSERT INTO public.portfolio_transactions
      (portfolio_id, amount_minor, transaction_type, reference_id, notes, created_by)
    VALUES
      (c_wallet[i], -(c_cost[i]::bigint), 'NETWORK_HOLD', ord.id::text,
       'Retención por una reserva de tu red', p_actor)
    RETURNING id INTO v_tx;

    UPDATE public.agency_portfolios ap
       SET balance_minor = ap.balance_minor - c_cost[i]::bigint
     WHERE ap.id = c_wallet[i]
       AND ap.status = 'active'
       AND ap.balance_minor::numeric + GREATEST(ap.credit_limit_minor, 0) >= c_cost[i]
       AND ap.balance_minor::numeric - c_cost[i] BETWEEN -9007199254740991 AND 9007199254740991;
    IF NOT FOUND THEN
      PERFORM public.raise_wallet_hold_violation(
        'network_funds_unavailable',
        format('order=%s depth=%s tenant=%s portfolio=%s', ord.id, c_depth[i], c_tenant[i], c_wallet[i]));
    END IF;

    INSERT INTO public.wallet_hold_levels
      (group_id, order_id, depth, tenant_id, portfolio_id, origin_tenant_id, order_number,
       currency, amount_minor, basis, hold_transaction_id, status)
    VALUES
      (v_group, ord.id, c_depth[i], c_tenant[i], c_wallet[i], me, ord.order_number,
       v_currency, c_cost[i]::bigint, 'cost', v_tx, v_initial)
    RETURNING * INTO v_level;
    PERFORM public.wallet_hold_level_event(
      v_level, v_mode, p_actor, 'portfolio.hold.retained', 'db:wallet_hold_retain', NULL);
    v_written := v_written + 1;
  END LOOP;

  group_id := v_group;
  hold_status := v_initial;
  own_portfolio_id := own.id;
  own_transaction_id := v_own_tx;
  network_levels := v_written;
  mode := v_mode;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION wallet_hold_retain(uuid, uuid) IS
  'Retiene la orden p_order_id del nodo app.current_tenant_id: precio de venta en su cartera de la moneda de la orden y, en enforce, el costo de cada nivel de su red hasta el dueño de la credencial (NETWORK_HOLD). Todo o nada; nace held (intent abierto) o captured (orden confirmada). Con la cuenta propia del nodo (O = T: la grabada en la orden, o el nodo es la plataforma) no retiene nada, ni exige cartera: el grupo nace exempt, sin niveles, con portfolio.hold.exempted (y otra llamada lo devuelve igual). STW01 hold_* / STW02 hold_* y network_* / 42501. Devuelve sólo datos del nodo que vende (hold_status held | captured | exempt; sin cartera ni asiento propio si exempt). Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_retain(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_hold_retain(uuid, uuid) TO app_user;

-- Cierra la retención de una orden según su estado, sobre lo registrado:
--
--   pending               → 'open' (un desenlace incierto conserva la retención, D-TBO-24 A)
--   confirmed | ticketed  → held: captured; captured: already-captured
--   failed                → held: libera todo; captured: conflict (figuró confirmada)
--   cancelled             → held o captured: libera todo, el 100 % como hoy
--   released              → already-released;  conflict → conflict;  sin grupo → no-hold
--   exempt (cuenta propia) → no-hold en cualquier estado: no retuvo nada, no hay nada que cerrar
--
-- p_expected_status ('failed' o 'cancelled') es la precondición de la API: si la orden no está en
-- ese estado y la retención sigue abierta, STW01 hold_release_order_open. Orden de bloqueo: la
-- orden, el grupo y las carteras por (nlevel DESC, id).
CREATE FUNCTION wallet_hold_settle(p_order_id UUID, p_actor UUID, p_expected_status TEXT DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  me  UUID;
  ord RECORD;
  g   public.wallet_hold_groups;
BEGIN
  me := public.wallet_hold_current_tenant();
  PERFORM public.wallet_hold_assert_actor(p_actor, me);

  SELECT o.id, o.status INTO ord
    FROM public.orders o
   WHERE o.id = p_order_id
     AND o.tenant_id = me
     FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_order_not_found', format('order=%s tenant=%s', p_order_id, me));
  END IF;

  SELECT wg.* INTO g
    FROM public.wallet_hold_groups wg
   WHERE wg.order_id = ord.id
     FOR UPDATE;
  IF NOT FOUND OR g.status = 'exempt' THEN
    RETURN 'no-hold';
  END IF;

  IF p_expected_status IS NOT NULL
     AND ord.status IS DISTINCT FROM p_expected_status
     AND g.status IN ('held', 'captured') THEN
    PERFORM public.raise_wallet_hold_violation(
      'hold_release_order_open',
      format('order=%s tenant=%s status=%s expected=%s', ord.id, me, ord.status, p_expected_status));
  END IF;

  IF ord.status = 'pending' THEN
    RETURN 'open';
  END IF;

  IF ord.status IN ('confirmed', 'ticketed') THEN
    CASE g.status
      WHEN 'held' THEN
        PERFORM public.wallet_hold_capture(g.id, p_actor, 'db:wallet_hold_settle');
        RETURN 'captured';
      WHEN 'captured' THEN RETURN 'already-captured';
      WHEN 'released' THEN RETURN 'already-released';
      ELSE RETURN 'conflict';
    END CASE;
  END IF;

  IF ord.status = 'failed' THEN
    CASE g.status
      WHEN 'held' THEN
        RETURN public.wallet_hold_release_all(g, p_actor, 'failed');
      WHEN 'captured' THEN
        PERFORM public.wallet_hold_mark_conflict(g, p_actor, 'failed_after_capture');
        RETURN 'conflict';
      WHEN 'released' THEN RETURN 'already-released';
      ELSE RETURN 'conflict';
    END CASE;
  END IF;

  IF ord.status = 'cancelled' THEN
    CASE g.status
      WHEN 'held', 'captured' THEN
        RETURN public.wallet_hold_release_all(g, p_actor, 'cancelled');
      WHEN 'released' THEN RETURN 'already-released';
      ELSE RETURN 'conflict';
    END CASE;
  END IF;

  RETURN 'open';
END;
$$;

COMMENT ON FUNCTION wallet_hold_settle(uuid, uuid, text) IS
  'Cierra la retención de la orden p_order_id del nodo app.current_tenant_id según su estado: captura (confirmed/ticketed), libera (failed con held, cancelled) o marca conflict (failed después de capturar), sobre lo registrado. Devuelve released | already-released | captured | already-captured | open | no-hold | conflict; no-hold también para una retención exempt (cuenta propia, sin nada retenido). Con p_expected_status y la retención abierta, la orden tiene que estar en ese estado (STW01 hold_release_order_open). Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_settle(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_hold_settle(uuid, uuid, text) TO app_user;

-- El aviso previo (PreBook, verificación antes de C2): la misma decisión que wallet_hold_retain,
-- sin bloquear ni escribir, con lo que la API tiene antes de abrir la orden. Sólo dice ok, blocked
-- (con la regla STW02 del primer nivel que falla), exempt (la cuenta propia del nodo con el
-- criterio de wallet_hold_is_own_account: la cuenta de la cotización, que la orden va a grabar, o
-- el nodo es la plataforma; no se retiene nada ni hace falta cartera) o unknown (parámetros
-- inválidos o una cuenta que no se
-- resuelve para el nodo, salvo con 'off', donde retain tampoco la exige): nunca montos, saldos ni
-- qué nivel falló.
CREATE FUNCTION wallet_hold_preview(
  p_provider_code        TEXT,
  p_provider_account_id  UUID,
  p_vertical             TEXT,
  p_currency             TEXT,
  p_sale_minor           BIGINT,
  p_net_minor            BIGINT
)
RETURNS TABLE (status TEXT, reason TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  me            UUID;
  v_mode        TEXT;
  v_owner_id    UUID;
  v_owner_level INTEGER;
  v_source      TEXT;
  own           public.agency_portfolios;
  anc           public.agency_portfolios;
  v_decision    TEXT;
  v_cost        NUMERIC;
  r             RECORD;
BEGIN
  me := public.wallet_hold_current_tenant();

  IF p_sale_minor IS NULL OR p_sale_minor < 1 OR p_sale_minor > 9007199254740991
     OR (p_net_minor IS NOT NULL AND (p_net_minor < 1 OR p_net_minor > 9007199254740991))
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR p_vertical IS NULL OR p_vertical !~ '^[a-z_]{1,32}$'
     OR p_provider_code IS NULL OR btrim(p_provider_code) = '' THEN
    status := 'unknown'; reason := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Como wallet_hold_retain: con 'off' la cuenta no tiene que resolverse, y con la cuenta propia
  -- del nodo no se retiene nada (en cualquier modo).
  v_mode := public.wallet_hold_mode(me);
  SELECT o.owner_id, o.owner_level, o.source INTO v_owner_id, v_owner_level, v_source
    FROM public.wallet_hold_owner(me, p_provider_code, p_provider_account_id) o;
  IF NOT FOUND THEN
    IF v_mode <> 'off' THEN
      status := 'unknown'; reason := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSIF public.wallet_hold_is_own_account(me, v_owner_id, v_source) THEN
    status := 'exempt'; reason := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT ap.* INTO own
    FROM public.agency_portfolios ap
   WHERE ap.tenant_id = me AND ap.currency = p_currency;
  v_decision := public.wallet_hold_decide(own, p_sale_minor);
  IF v_decision <> 'ok' THEN
    status := 'blocked'; reason := 'hold_' || v_decision;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_mode = 'enforce' THEN
    FOR r IN SELECT * FROM public.wallet_hold_chain(me, v_owner_level) LOOP
      v_cost := NULL;
      IF p_net_minor IS NOT NULL THEN
        v_cost := public.wallet_hold_level_cost(me, p_vertical, p_net_minor, r.lvl);
        IF v_cost < 1 OR v_cost > 9007199254740991 OR v_cost <> trunc(v_cost) THEN
          v_cost := NULL;
        END IF;
      END IF;
      IF v_cost IS NULL THEN
        status := 'blocked'; reason := 'network_cost_unavailable';
        RETURN NEXT;
        RETURN;
      END IF;

      SELECT ap.* INTO anc
        FROM public.agency_portfolios ap
       WHERE ap.tenant_id = r.tenant_id AND ap.currency = p_currency;
      v_decision := public.wallet_hold_decide(anc, v_cost::bigint);
      IF v_decision <> 'ok' THEN
        status := 'blocked';
        reason := CASE WHEN v_decision = 'currency_not_enabled'
                       THEN 'network_currency_not_enabled'
                       ELSE 'network_funds_unavailable' END;
        RETURN NEXT;
        RETURN;
      END IF;
    END LOOP;
  END IF;

  status := 'ok'; reason := NULL;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION wallet_hold_preview(text, uuid, text, text, bigint, bigint) IS
  'Anticipa wallet_hold_retain para una venta del nodo app.current_tenant_id sin bloquear ni escribir: ok | blocked (reason = regla STW02 del primer nivel que falla) | exempt (la cuenta propia del nodo, con el criterio de wallet_hold_is_own_account: no retiene nada ni exige cartera) | unknown (parámetros inválidos, o cuenta no resoluble fuera del modo off). p_provider_account_id NULL = la cuenta que la bóveda resuelve para el nodo, o la raíz si no hay (credenciales de entorno). Nunca montos, saldos ni qué nivel falló. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_preview(text, uuid, text, text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_hold_preview(text, uuid, text, text, bigint, bigint) TO app_user;

-- Después de un rechazo de la red, el aviso al ancestro afectado: vuelve a derivar desde la orden
-- el dueño, la cadena y los costos, sin bloquear, y deja 'portfolio.network_hold.blocked' en el
-- tenant del PRIMER nivel que bloquea (actor NULL, sin nombres). Uno por (tenant, orden). La API lo
-- llama en su propia transacción y en modo best-effort: una orden que no es del nodo o que ya no
-- bloquea no deja nada.
CREATE FUNCTION wallet_hold_report_block(p_order_id UUID)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  me          UUID;
  ord         RECORD;
  v_currency  TEXT;
  v_owner     RECORD;
  v_net       BIGINT;
  v_vertical  TEXT;
  v_cost      NUMERIC;
  v_reason    TEXT;
  anc         public.agency_portfolios;
  v_decision  TEXT;
  r           RECORD;
BEGIN
  me := public.wallet_hold_current_tenant();

  SELECT o.id, o.currency, o.provider, o.provider_account_id, o.order_number,
         o.selected_offer, o.search_criteria
    INTO ord
    FROM public.orders o
   WHERE o.id = p_order_id AND o.tenant_id = me;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_currency := upper(btrim(ord.currency));
  IF v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' OR public.wallet_hold_mode(me) <> 'enforce' THEN
    RETURN;
  END IF;

  SELECT * INTO v_owner FROM public.wallet_hold_owner(me, ord.provider, ord.provider_account_id);
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_vertical := COALESCE(ord.search_criteria ->> 'vertical', 'flights');
  v_net := public.wallet_hold_net(ord.selected_offer, v_currency, v_vertical);

  FOR r IN SELECT * FROM public.wallet_hold_chain(me, v_owner.owner_level) LOOP
    v_reason := NULL;
    v_cost := NULL;
    IF v_net IS NOT NULL THEN
      v_cost := public.wallet_hold_level_cost(me, v_vertical, v_net, r.lvl);
      IF v_cost < 1 OR v_cost > 9007199254740991 OR v_cost <> trunc(v_cost) THEN
        v_cost := NULL;
      END IF;
    END IF;

    IF v_cost IS NULL THEN
      v_reason := 'network_cost_unavailable';
    ELSE
      SELECT ap.* INTO anc
        FROM public.agency_portfolios ap
       WHERE ap.tenant_id = r.tenant_id AND ap.currency = v_currency;
      v_decision := public.wallet_hold_decide(anc, v_cost::bigint);
      IF v_decision = 'currency_not_enabled' THEN
        v_reason := 'network_currency_not_enabled';
      ELSIF v_decision <> 'ok' THEN
        v_reason := 'network_funds_unavailable';
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      -- Dos reportes a la vez de la misma orden no duplican el aviso.
      PERFORM pg_advisory_xact_lock(hashtextextended('wallet_hold_report_block:' || ord.id::text, 0));
      IF NOT EXISTS (
        SELECT 1
          FROM public.domain_events e
         WHERE e.tenant_id = r.tenant_id
           AND e.event_type = 'portfolio.network_hold.blocked'
           AND e.aggregate_type = 'order'
           AND e.aggregate_id = ord.id::text
      ) THEN
        PERFORM public.wallet_hold_emit(
          r.tenant_id, NULL, 'portfolio.network_hold.blocked', ord.id,
          jsonb_build_object(
            'orderId', ord.id,
            'orderNumber', ord.order_number,
            'originTenantId', me,
            'depth', r.depth,
            'currency', v_currency,
            'reason', v_reason,
            'amountMinor', v_cost,
            'source', 'db:wallet_hold_report_block'
          ));
      END IF;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION wallet_hold_report_block(uuid) IS
  'Deja portfolio.network_hold.blocked (actor NULL, sin nombres) en el tenant del primer nivel de la red que bloquea la orden p_order_id del nodo app.current_tenant_id, derivado de nuevo desde la orden y sin bloquear. Uno por (tenant, orden); sin bloqueo o sin orden, no hace nada. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_report_block(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_hold_report_block(uuid) TO app_user;

-- El mismo aviso cuando la red bloquea en el PreBook, antes de que exista la orden. Sin esto el
-- ancestro que bloquea no se entera nunca: la web frena al vendedor en el PreBook, el Book no llega
-- a correr y wallet_hold_report_block no tiene orden de la que partir. El vendedor sólo lee "pedile
-- a quien te financia"; el nivel que lo puede arreglar puede no ser ése.
--
-- Deriva el dueño, la cadena y los costos como wallet_hold_preview, con lo que la API tiene antes de
-- la orden, sin bloquear. Deja 'portfolio.network_hold.blocked' en el tenant del primer nivel que
-- bloquea, con aggregate = el nodo que vende (no hay orden), actor NULL y sin nombres. Uno por
-- (ancestro, nodo que vende, moneda) cada 24 h: un PreBook repetido no llena su rastro.
CREATE FUNCTION wallet_hold_report_preview_block(
  p_provider_code        TEXT,
  p_provider_account_id  UUID,
  p_vertical             TEXT,
  p_currency             TEXT,
  p_sale_minor           BIGINT,
  p_net_minor            BIGINT
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  me          UUID;
  v_owner     RECORD;
  v_cost      NUMERIC;
  v_reason    TEXT;
  anc         public.agency_portfolios;
  v_decision  TEXT;
  r           RECORD;
BEGIN
  me := public.wallet_hold_current_tenant();

  IF p_sale_minor IS NULL OR p_sale_minor < 1 OR p_sale_minor > 9007199254740991
     OR (p_net_minor IS NOT NULL AND (p_net_minor < 1 OR p_net_minor > 9007199254740991))
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR p_vertical IS NULL OR p_vertical !~ '^[a-z_]{1,32}$'
     OR p_provider_code IS NULL OR btrim(p_provider_code) = ''
     OR public.wallet_hold_mode(me) <> 'enforce' THEN
    RETURN;
  END IF;

  SELECT * INTO v_owner FROM public.wallet_hold_owner(me, p_provider_code, p_provider_account_id);
  IF NOT FOUND THEN
    RETURN;
  END IF;

  FOR r IN SELECT * FROM public.wallet_hold_chain(me, v_owner.owner_level) LOOP
    v_reason := NULL;
    v_cost := NULL;
    IF p_net_minor IS NOT NULL THEN
      v_cost := public.wallet_hold_level_cost(me, p_vertical, p_net_minor, r.lvl);
      IF v_cost < 1 OR v_cost > 9007199254740991 OR v_cost <> trunc(v_cost) THEN
        v_cost := NULL;
      END IF;
    END IF;

    IF v_cost IS NULL THEN
      v_reason := 'network_cost_unavailable';
    ELSE
      SELECT ap.* INTO anc
        FROM public.agency_portfolios ap
       WHERE ap.tenant_id = r.tenant_id AND ap.currency = p_currency;
      v_decision := public.wallet_hold_decide(anc, v_cost::bigint);
      IF v_decision = 'currency_not_enabled' THEN
        v_reason := 'network_currency_not_enabled';
      ELSIF v_decision <> 'ok' THEN
        v_reason := 'network_funds_unavailable';
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      -- Dos PreBooks a la vez del mismo nodo no duplican el aviso.
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'wallet_hold_report_preview_block:' || r.tenant_id::text || ':' || me::text || ':' || p_currency,
        0));
      IF NOT EXISTS (
        SELECT 1
          FROM public.domain_events e
         WHERE e.aggregate_type = 'tenant'
           AND e.aggregate_id = me::text
           AND e.tenant_id = r.tenant_id
           AND e.event_type = 'portfolio.network_hold.blocked'
           AND e.payload ->> 'currency' = p_currency
           AND e.occurred_at > now() - interval '24 hours'
      ) THEN
        INSERT INTO public.domain_events
          (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES
          (r.tenant_id, NULL, 'portfolio.network_hold.blocked', 'tenant', me::text,
           jsonb_build_object(
             'originTenantId', me,
             'depth', r.depth,
             'currency', p_currency,
             'reason', v_reason,
             'amountMinor', v_cost,
             'stage', 'prebook',
             'source', 'db:wallet_hold_report_preview_block'
           ));
      END IF;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION wallet_hold_report_preview_block(text, uuid, text, text, bigint, bigint) IS
  'Deja portfolio.network_hold.blocked (aggregate = el nodo app.current_tenant_id, actor NULL, sin nombres, stage prebook) en el tenant del primer nivel de la red que bloquearía la venta, derivado como wallet_hold_preview y sin bloquear. Uno por (ancestro, nodo, moneda) cada 24 h; fuera de enforce, con parámetros inválidos, una cuenta que no se resuelve o sin bloqueo, no hace nada. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_report_preview_block(text, uuid, text, text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_hold_report_preview_block(text, uuid, text, text, bigint, bigint) TO app_user;

-- ============================================================================
-- 10. move_tenant_subtree: carteras en orden y STH02 sobre retenciones abiertas
-- ============================================================================
-- El cuerpo de 0051 tal cual, salvo dos cambios (diffearlo contra 0051 en la revisión):
--
--   (a) las carteras del subárbol se bloquean por (nlevel DESC, id), el mismo orden que la retención
--       y la liberación, así un move y una retención de la red no se esperan en ciclo;
--   (b) STH02 tenant_move_open_wallet_bookings cuenta las órdenes del subárbol con una retención
--       abierta, en vez de "hay BOOKING_HOLD y no hay BOOKING_RELEASED": una cascada liberada a
--       medias ya no cuenta como liberada. Abierta es held o captured con la orden activa (como en
--       0051), o conflict con la orden en cualquier estado: un conflicto nace de una orden failed o
--       cancelled, que ya no está activa, y su plata sigue congelada en la red hasta que alguien lo
--       concilie; mover el nodo la dejaría en carteras que ya no son de su red. Un nivel de la red
--       siempre se origina en el subárbol que lo contiene, así que no hace falta otra condición.
--
-- Y el encabezado, con el search_path ya endurecido (pg_catalog, public, pg_temp), como el resto de
-- las funciones de 0060: la sección 12 lo haría igual, pero así no depende de ella.
CREATE OR REPLACE FUNCTION move_tenant_subtree(p_tenant_id UUID, p_new_parent_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
    ORDER BY nlevel(t.path) DESC, ap.id
      FOR UPDATE OF ap;

  SELECT count(*)::int INTO blocked
    FROM orders o
    JOIN tenants t ON t.id = o.tenant_id
   WHERE t.path OPERATOR(public.<@) old_path
     AND EXISTS (
       SELECT 1 FROM wallet_hold_groups g
        WHERE g.order_id = o.id
          AND (g.status = 'conflict'
               OR (g.status IN ('held', 'captured')
                   AND order_is_active(o.status, o.search_criteria)))
     );
  IF blocked > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE    = 'STH02',
      CONSTRAINT = 'tenant_move_open_wallet_bookings',
      TABLE      = 'tenants',
      MESSAGE    = format('el nodo o su red tiene %s reserva(s) abierta(s) pagada(s) con cartera: hay que cerrarlas o cancelarlas antes de moverlo', blocked),
      DETAIL     = format('tenant %s', p_tenant_id),
      HINT       = 'Abierta: pendiente, o confirmada/emitida hasta el día siguiente al fin del viaje (check-out, devolución del auto o vuelta del vuelo), con la retención de cartera sin liberar; o con la retención en conflicto sin conciliar, en cualquier estado.';
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
  'Mueve p_tenant_id y su subárbol bajo p_new_parent_id (D6 A): recalcula path, valida ciclos, profundidad y la matriz D4 (STH01), bloquea con reservas del subárbol con una retención de cartera abierta —held o captured con la reserva activa, o conflict en cualquier estado, 0060— o hechas con una cuenta que deja de heredarse (STH02) y deja el domain_event tenant.moved. Bloquea las carteras del subárbol por (nlevel DESC, id) desde 0060. Sólo sesión privilegiada o superadmin de la plataforma. Devuelve cuántos nodos movió (0 = ya estaba ahí). Ver db/migrations/0051 y 0060.';

-- ============================================================================
-- 11. Las retenciones de antes de 0060
-- ============================================================================
-- Cada BOOKING_HOLD enlazado a su orden (reference_id = la orden, la cartera del mismo tenant que la
-- orden) y sin grupo pasa a un grupo 'legacy' de un solo nivel: depth 0, base 'sale', por lo que
-- retuvo. Nunca debita a los ancestros: la cascada rige para las reservas que se retienen desde acá.
--
--   - released si su BOOKING_RELEASED está en la misma cartera (se enlaza);
--   - captured si la orden está confirmed o ticketed;
--   - held en otro caso (una orden failed o cancelled sin liberar la cierra wallet_hold_settle).
--
-- Idempotente: una orden con grupo no se vuelve a convertir. Lo que no se puede enlazar (una
-- retención sin orden, o de una cartera de otro tenant) se cuenta en el WARNING de la sección 13.
CREATE FUNCTION wallet_hold_backfill_legacy()
RETURNS INTEGER
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  h          RECORD;
  v_group    UUID;
  v_status   TEXT;
  converted  INTEGER := 0;
BEGIN
  FOR h IN
    SELECT pt.id            AS hold_id,
           pt.portfolio_id,
           -pt.amount_minor AS held_minor,
           pt.created_by,
           pt.created_at    AS held_at,
           ap.tenant_id,
           ap.currency,
           o.id             AS order_id,
           o.status         AS order_status,
           o.order_number,
           o.provider,
           o.provider_account_id,
           o.updated_at     AS order_updated_at,
           pa.tenant_id     AS owner_id,
           rel.id           AS release_id,
           rel.created_at   AS released_at
      FROM public.portfolio_transactions pt
      JOIN public.agency_portfolios ap ON ap.id = pt.portfolio_id
      JOIN public.orders o
        ON o.id = CASE
                    WHEN pt.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN pt.reference_id::uuid
                  END
       AND o.tenant_id = ap.tenant_id
      LEFT JOIN public.provider_accounts pa ON pa.id = o.provider_account_id
      LEFT JOIN LATERAL (
        SELECT r.id, r.created_at
          FROM public.portfolio_transactions r
         WHERE r.portfolio_id = pt.portfolio_id
           AND r.transaction_type = 'BOOKING_RELEASED'
           AND lower(r.reference_id) = lower(pt.reference_id)
         ORDER BY r.created_at
         LIMIT 1
      ) rel ON true
     WHERE pt.transaction_type = 'BOOKING_HOLD'
       AND pt.amount_minor < 0
       AND NOT EXISTS (SELECT 1 FROM public.wallet_hold_groups g WHERE g.order_id = o.id)
     ORDER BY pt.created_at, pt.id
  LOOP
    v_status := CASE
      WHEN h.release_id IS NOT NULL THEN 'released'
      WHEN h.order_status IN ('confirmed', 'ticketed') THEN 'captured'
      ELSE 'held'
    END;

    INSERT INTO public.wallet_hold_groups
      (order_id, origin_tenant_id, order_number, currency, sale_amount_minor, provider_code,
       provider_account_id, credential_owner_tenant_id, credential_source, mode, status,
       created_by, created_at, captured_at, closed_at)
    VALUES
      (h.order_id, h.tenant_id, h.order_number, h.currency, h.held_minor, h.provider,
       h.provider_account_id, h.owner_id, 'legacy', 'legacy', v_status,
       h.created_by, COALESCE(h.held_at, now()),
       CASE WHEN v_status = 'captured' THEN COALESCE(h.order_updated_at, now()) END,
       CASE WHEN v_status = 'released' THEN COALESCE(h.released_at, now()) END)
    RETURNING id INTO v_group;

    INSERT INTO public.wallet_hold_levels
      (group_id, order_id, depth, tenant_id, portfolio_id, origin_tenant_id, order_number,
       currency, amount_minor, basis, hold_transaction_id, release_transaction_id, status,
       created_at)
    VALUES
      (v_group, h.order_id, 0, h.tenant_id, h.portfolio_id, h.tenant_id, h.order_number,
       h.currency, h.held_minor, 'sale', h.hold_id, h.release_id, v_status,
       COALESCE(h.held_at, now()));

    converted := converted + 1;
  END LOOP;

  RETURN converted;
END;
$$;

COMMENT ON FUNCTION wallet_hold_backfill_legacy() IS
  'Convierte cada BOOKING_HOLD enlazado a su orden y sin grupo en un grupo legacy de un nivel (depth 0, sale): released si tiene su BOOKING_RELEASED en la misma cartera, captured si la orden está confirmada o emitida, held si no. Nunca debita ancestros. Idempotente; devuelve cuántos convirtió. Sin GRANT. Ver db/migrations/0060.';

REVOKE ALL ON FUNCTION wallet_hold_backfill_legacy() FROM PUBLIC;

DO $$
DECLARE
  converted INTEGER;
BEGIN
  converted := wallet_hold_backfill_legacy();
  RAISE NOTICE '0060: % retención(es) anterior(es) convertida(s) a grupos legacy', converted;
END $$;

-- ============================================================================
-- 12. search_path fijo en las funciones que ya existían
-- ============================================================================
-- Toda función de `public` con `search_path = public` (las SECURITY DEFINER de 0012 a 0055:
-- can_finance_tenant, tenant_financier_id, can_read_membership, resolve_*, compute_price_waterfall,
-- las de sesiones y puestos de 0055… y las guardas INVOKER de 0052 y 0055, que corren con el rol de
-- quien escribe) pasa a pg_catalog, public, pg_temp: sin pg_temp en el path, el esquema temporal se
-- busca PRIMERO y una tabla temporal sombrea la de verdad. Con la misma idea, una SECURITY DEFINER
-- sin search_path propio (usaba el de quien la llama) queda con el mismo. Las funciones de
-- extensiones no se tocan. Las migraciones ya aplicadas no se editan: en producción y en una base
-- nueva las endurece esto mismo.
--
-- Corre una vez, sobre lo que existe al migrar. Una migración que se aplique DESPUÉS (con otro
-- número, de otra rama) y vuelva a escribir `SET search_path = public`, o cree una SECURITY DEFINER
-- sin search_path, quedaría sin endurecer. apps/api/src/database/migrations-search-path.test.ts
-- rechaza las dos cosas en toda migración posterior a 0060, y una numerada hasta 0060 que no esté
-- entre las que llegan a producción antes que esta (0056, de main, sí);
-- migrations-search-path.integration.test.ts verifica en la base migrada que esto las cubrió.
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
       AND (
         'search_path=public' = ANY (COALESCE(p.proconfig, '{}'::text[]))
         OR (
           p.prosecdef
           AND NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) c
              WHERE c LIKE 'search_path=%'
           )
         )
       )
     ORDER BY p.oid
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f.sig);
  END LOOP;
END $$;

-- ============================================================================
-- 13. REVISAR: la red sin carteras o sin cupo
-- ============================================================================
-- Sin fila de política el modo es 'enforce': el riesgo queda cerrado desde el deploy. Un nodo
-- intermedio (consolidador o agencia de nivel ≥ 2) al que le falta cartera activa con saldo o cupo
-- en una moneda que usan sus descendientes frena las ventas de su red en esa moneda
-- (network_currency_not_enabled / network_funds_unavailable). Eso es lo que decidió el founder: nadie
-- de su red vende en esa moneda con una credencial de más arriba sin que ese nivel lo cubra.
--
-- La migración no pone 'observe' sola: una política es por nodo y vale para todas las monedas y
-- todos los niveles de su red, así que un hueco en una moneda apagaría la cascada también en las
-- demás y en los niveles solventes, y nada la levantaría después. Sólo avisa, con el par (nodo,
-- moneda), para el Paso 14 del runbook (docs/platform/13): abrirle la cartera, o poner 'observe' a
-- mano con su razón si hay que destrabar mientras tanto. En producción hoy no debería listar nada.
DO $$
DECLARE
  r         RECORD;
  gaps      INTEGER := 0;
  orphans   INTEGER;
BEGIN
  FOR r IN
    SELECT n.id, n.slug, x.currency
      FROM public.tenants n
      CROSS JOIN LATERAL (
        SELECT DISTINCT ap.currency
          FROM public.agency_portfolios ap
          JOIN public.tenants d ON d.id = ap.tenant_id
         WHERE d.path OPERATOR(public.<@) n.path
           AND d.id <> n.id
           AND ap.status = 'active'
      ) x
     WHERE n.tenant_type IN ('consolidator', 'agency')
       AND nlevel(n.path) >= 2
       AND NOT EXISTS (
         SELECT 1
           FROM public.agency_portfolios w
          WHERE w.tenant_id = n.id
            AND w.currency = x.currency
            AND w.status = 'active'
            AND w.balance_minor::numeric + GREATEST(w.credit_limit_minor, 0) > 0
       )
     ORDER BY n.path, x.currency
  LOOP
    gaps := gaps + 1;
    RAISE WARNING
      'REVISAR: el nodo % (%) no tiene cartera activa con saldo o cupo en %, que usa su red: las ventas de su red en % con una credencial de más arriba se rechazan hasta que se la abran o se ponga observe a mano',
      r.slug, r.id, r.currency, r.currency;
  END LOOP;

  SELECT count(*) INTO orphans
    FROM public.portfolio_transactions pt
   WHERE pt.transaction_type = 'BOOKING_HOLD'
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_hold_levels l WHERE l.hold_transaction_id = pt.id
     );
  IF orphans > 0 THEN
    RAISE WARNING
      'REVISAR: % retención(es) BOOKING_HOLD sin orden de su tenant no se convirtieron a grupos: no bloquean move_tenant_subtree ni las libera wallet_hold_settle',
      orphans;
  END IF;

  RAISE NOTICE '0060: % par(es) nodo-moneda sin cartera o cupo en la red, % retención(es) sin convertir',
    gaps, orphans;
END $$;
