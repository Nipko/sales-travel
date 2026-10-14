-- 0081_flight_orders_active_by_travel_date.sql
-- Una reserva de vuelo deja de retener su cuenta de proveedor cuando termina el viaje.
--
-- Desde esta tanda la orden de un vuelo guarda la cuenta con la que se reservó
-- (`orders.provider_account_id`, 0042) cuando su proveedor sabe operar la post-venta con ella, como
-- ya lo hacían los hoteles: un PNR sólo se lee, se cancela o se emite desde la cuenta que lo creó
-- (RF-29). `provider_account_active_orders` (0045) cuenta esas reservas para que el dueño de la
-- cuenta no la desactive ni corte la herencia mientras sigan vivas, pero su fecha de fin es sólo el
-- check-out, y sin una fecha legible la reserva cuenta como activa. Una orden de vuelo no tiene
-- check-out: cada vuelo confirmado o emitido con cuenta guardada retendría la cuenta PARA SIEMPRE, y
-- su dueño no podría desactivarla nunca.
--
-- Se redefine con la misma firma, el mismo dueño (SECURITY DEFINER), el mismo filtro del tenant
-- activo y los mismos grants. Cambia sólo la fecha de fin: la de `order_is_active` (0051), el
-- criterio que ya usan el movimiento de nodos (0051) y las retenciones de la red (0060). Es la
-- primera fecha ISO legible de `checkoutDate` (hoteles), `dropOffDate` (autos), `returnDate` y
-- `departureDate` (vuelos: la vuelta o, sin vuelta, la ida), más un día de margen. Un hotel cuenta
-- igual que antes. Sin ninguna fecha legible, la reserva sigue contando: ante la duda, no se suelta
-- la cuenta. `pending` cuenta siempre: una reserva sin desenlace sólo se cierra leyendo al proveedor
-- con esta cuenta.
--
-- El search_path termina en pg_temp, como toda función posterior a 0060: una tabla temporal no puede
-- sombrear `orders` ni `provider_accounts` dentro de una función que corre sin sus policies.
--
-- La retención de cartera (0060) no cambia de código: ya toma la cuenta de la orden cuando la hay
-- (`credential_source = 'account'`), y si es la propia del nodo que vende, no retiene nada. Con la
-- cuenta guardada, un vuelo reservado con la cuenta propia del nodo queda exento como un hotel; sin
-- ella, retenía en la cartera del nodo porque la bóveda de ahora no prueba con qué se reservó. Sólo
-- se actualiza la descripción de la columna, que decía que ningún vuelo guarda la cuenta.
--
-- Nada de esta migración nombra a un proveedor.

CREATE OR REPLACE FUNCTION provider_account_active_orders(p_account_id UUID)
RETURNS TABLE (own_orders integer, inherited_orders integer)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    (count(o.id) FILTER (WHERE o.tenant_id = pa.tenant_id))::integer,
    (count(o.id) FILTER (WHERE o.tenant_id <> pa.tenant_id))::integer
  FROM public.provider_accounts pa
  LEFT JOIN public.orders o
    ON o.provider_account_id = pa.id
   AND public.order_is_active(o.status, o.search_criteria)
  WHERE pa.id = p_account_id
    AND pa.tenant_id::text = current_setting('app.current_tenant_id', true)
  GROUP BY pa.id;
$$;

COMMENT ON FUNCTION provider_account_active_orders(uuid) IS
  'Reservas activas (pending, o confirmadas/emitidas hasta el día siguiente al fin del viaje: check-out, devolución del auto o la vuelta o la ida del vuelo; sin fecha legible, activas) hechas con la cuenta p_account_id: las del dueño y las de su red. Sólo contesta al dueño (app.current_tenant_id); a cualquier otro, cero filas. Ver db/migrations/0045 y 0081.';

REVOKE ALL ON FUNCTION provider_account_active_orders(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider_account_active_orders(uuid) TO app_user;

COMMENT ON COLUMN wallet_hold_groups.credential_source IS
  'account: O es el dueño de orders.provider_account_id (hoteles, y vuelos de los proveedores que operan su post-venta con la cuenta de la reserva, 0081). resolved: la orden no guarda cuenta (autos, los demás vuelos y las órdenes anteriores a 0081) y O es el dueño de la que resolve_provider_account le resolvía al nodo para ese proveedor. root: la orden no tiene cuenta y la bóveda no resuelve ninguna (credenciales de entorno); O es la raíz. legacy: retención anterior a 0060. unresolved: con el modo off, la cuenta de la orden ya no se resolvía y sólo retuvo el nodo que vende.';
