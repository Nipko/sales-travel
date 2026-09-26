-- 0045_order_provider_account_post_sale.sql
-- La post-venta de una orden sale con la cuenta de proveedor con la que se hizo la reserva
-- (`orders.provider_account_id`, 0042) y no con la vigente del tenant: una agencia que pasa de la
-- cuenta heredada a una propia sigue leyendo y cancelando sus reservas viejas con la anterior, que
-- es la única que el proveedor reconoce para ellas (RF-29; D-TBO-28 A).
--
-- Dos cosas que la app no puede resolver con la RLS y que tampoco pueden saltarla a ciegas:
--
--   1. `resolve_order_provider_account`: la cuenta de UNA orden del tenant activo, sólo si sigue
--      perteneciendo a su red (propia, o de un ancestro que la deja heredar) y está activa. La FK
--      de 0042 se verificó sin RLS al escribir la orden: prueba que la cuenta existía, no que el
--      tenant pueda seguir operando con ella. Es el mismo criterio que `resolve_provider_account`
--      (0012), fijado a la cuenta de la orden en vez de a la más cercana.
--   2. `provider_account_active_orders`: cuántas reservas activas cuelgan de una cuenta, contadas
--      en toda la red que la hereda, para que su dueño no la desactive ni corte la herencia
--      mientras haya reservas que sólo ella puede leer y cancelar (RF-29 CA 2). Devuelve conteos,
--      nunca filas, y sólo al dueño de la cuenta.
--
-- Las dos son SECURITY DEFINER (owner = postgres) por el mismo motivo que las de 0012 y 0043:
-- `provider_accounts` no deja a una agencia leer la fila de su consolidador y `orders` tiene RLS
-- forzada por tenant. El dueño las ejecuta sin esas policies, así que cada una filtra el tenant
-- activo (`app.current_tenant_id`) explícitamente, igual que haría la policy.
--
-- Nada de esta migración nombra a un proveedor.

-- ============================================================================
-- 1. La cuenta con la que se opera la post-venta de una orden
-- ============================================================================
-- Parte de la ORDEN, no de un id de cuenta suelto: quien llama no puede pedir una cuenta cualquiera,
-- sólo la de una orden que el tenant activo puede leer. El código de proveedor tiene que coincidir
-- con el de la orden, y la cuenta tiene que estar 'active' (una cuenta en 'sandbox' o 'disabled' no
-- se usa, como en 0012).
CREATE FUNCTION resolve_order_provider_account(p_order_id UUID)
RETURNS provider_accounts
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT pa.*
  FROM orders o
  JOIN tenants me           ON me.id = o.tenant_id
  JOIN provider_accounts pa ON pa.id = o.provider_account_id
                           AND pa.provider_code = o.provider
  JOIN tenants owner_t      ON owner_t.id = pa.tenant_id
  WHERE o.id = p_order_id
    AND o.tenant_id::text = current_setting('app.current_tenant_id', true)
    AND pa.status = 'active'
    AND (
      pa.tenant_id = o.tenant_id
      OR (pa.is_inheritable AND owner_t.path OPERATOR(public.@>) me.path)
    );
$$;

COMMENT ON FUNCTION resolve_order_provider_account(uuid) IS
  'Cuenta de proveedor con la que se hizo la orden p_order_id, sólo si la orden es del tenant activo (app.current_tenant_id) y la cuenta sigue en su red (propia, o de un ancestro heredable) y activa. Fila vacía si no. Ver db/migrations/0045.';

REVOKE ALL ON FUNCTION resolve_order_provider_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_order_provider_account(uuid) TO app_user;

-- ============================================================================
-- 2. Reservas activas de una cuenta, en toda la red que la hereda
-- ============================================================================
-- Activa = todavía puede necesitar una lectura o una cancelación con esta cuenta:
--
--   - `pending`: una reserva sin desenlace (Book incierto, cancelación en curso) que sólo se cierra
--     leyendo al proveedor con esta cuenta, a veces días después (D-TBO-24 A);
--   - `confirmed` o `ticketed` hasta el día siguiente al check-out. El día de margen absorbe la zona
--     horaria del hotel, que la orden no guarda. Sin una fecha de salida legible (una vertical que
--     no la escribe), la reserva cuenta como activa: ante la duda, no se suelta la cuenta.
--
-- `cancelled` y `failed` no cuentan: un reembolso pendiente del proveedor lo sigue la conciliación
-- sin bloquear nada. La fecha se compara como texto ISO, que ordena igual que la fecha y no puede
-- fallar con un valor raro como fallaría un `::date`.
--
-- Sólo contesta al DUEÑO de la cuenta (el tenant activo): cualquier otro recibe cero filas, y la
-- app trata la falta de respuesta como "no se puede comprobar", nunca como "no hay reservas".
-- `own_orders` son las del propio dueño; `inherited_orders`, las de la red que la hereda.
CREATE FUNCTION provider_account_active_orders(p_account_id UUID)
RETURNS TABLE (own_orders integer, inherited_orders integer)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT
    (count(o.id) FILTER (WHERE o.tenant_id = pa.tenant_id))::integer,
    (count(o.id) FILTER (WHERE o.tenant_id <> pa.tenant_id))::integer
  FROM provider_accounts pa
  LEFT JOIN orders o
    ON o.provider_account_id = pa.id
   AND (
     o.status = 'pending'
     OR (
       o.status IN ('confirmed', 'ticketed')
       AND CASE
             WHEN (o.search_criteria ->> 'checkoutDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
               THEN (o.search_criteria ->> 'checkoutDate') >= to_char(current_date - 1, 'YYYY-MM-DD')
             ELSE true
           END
     )
   )
  WHERE pa.id = p_account_id
    AND pa.tenant_id::text = current_setting('app.current_tenant_id', true)
  GROUP BY pa.id;
$$;

COMMENT ON FUNCTION provider_account_active_orders(uuid) IS
  'Reservas activas (pending, o confirmadas hasta el día siguiente al check-out) hechas con la cuenta p_account_id: las del dueño y las de su red. Sólo contesta al dueño (app.current_tenant_id); a cualquier otro, cero filas. Ver db/migrations/0045.';

REVOKE ALL ON FUNCTION provider_account_active_orders(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider_account_active_orders(uuid) TO app_user;
