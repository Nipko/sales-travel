-- 0042_hotel_orders.sql
-- Una reserva de hotel pasa a ser una orden ANTES de llamar al proveedor, y su post-venta
-- necesita tres cosas que `orders` no guarda hoy:
--
--   1. la referencia que NOSOTROS generamos y mandamos en la reserva. Es la única llave para
--      recuperar una reserva que no respondió: el proveedor exige consultarla por ese valor, y si
--      el proceso muere con la llamada en vuelo, sólo queda lo que se escribió antes de llamar
--      (RF-19);
--   2. la cuenta de proveedor con la que se hizo la reserva. La post-venta tiene que usar ESA y no
--      la vigente del tenant: una agencia que pasa de la cuenta heredada a una propia no puede
--      quedarse sin leer ni cancelar sus reservas viejas (RF-29);
--   3. el seguimiento propio de un hotel (estado crudo del proveedor, subestado, factura, HCN). No
--      es de vuelos ni de autos, así que va en una tabla satélite y no en columnas de `orders`
--      (RF-26).
--
-- Los RF son los del expediente de integración de hoteles (`grep -rn "RF-19" docs`).
--
-- Todo es aditivo y nullable: vuelos, autos y la reserva de hoteles que no pasa por órdenes no
-- escriben ninguna columna nueva y no cambian. Nada de esta migración nombra a un proveedor.
--
-- Los tipos de operación nuevos (`hcn-check`, `hcn-ticket`, `reconcile`) no necesitan SQL:
-- `order_operations.type` es TEXT sin CHECK (0021). Sólo cambia el tipo de la app.

-- ============================================================================
-- 1. orders.provider_booking_ref: única por proveedor ENTRE todos los tenants
-- ============================================================================
-- El índice NO lleva tenant_id, a diferencia de `uq_orders_create_request_key` (0038). Varias
-- agencias de una red pueden reservar con la misma cuenta del consolidador, y para el proveedor
-- son un solo cliente: si dos de ellas mandaran la misma referencia, la consulta de recuperación
-- no sabría de cuál reserva habla. Por eso la referencia tampoco se deriva del `Idempotency-Key`
-- del navegador, que sólo es único dentro de un tenant.
--
-- Una referencia en blanco no sirve para recuperar nada y, además, sería un valor único más: la
-- segunda orden que la usara chocaría con la primera. Se rechaza.
ALTER TABLE orders
  ADD COLUMN provider_booking_ref TEXT NULL
    CONSTRAINT orders_provider_booking_ref_not_blank CHECK (btrim(provider_booking_ref) <> '');

CREATE UNIQUE INDEX uq_orders_provider_booking_ref
  ON orders (provider, provider_booking_ref)
  WHERE provider_booking_ref IS NOT NULL;

COMMENT ON COLUMN orders.provider_booking_ref IS
  'Referencia de reserva generada por la plataforma y enviada al proveedor. Se escribe en la misma transacción que el intent pending, antes de llamar, y nunca se recalcula ni se reutiliza. NULL en verticales que no la usan. Ver db/migrations/0042.';
COMMENT ON INDEX uq_orders_provider_booking_ref IS
  'Una referencia por proveedor en TODA la plataforma, sin tenant_id: las agencias que heredan la cuenta del consolidador comparten el espacio de referencias del proveedor.';

-- Una referencia ya escrita no cambia, ni siquiera a NULL. Si un reintento o un cierre por fallo
-- la pisara después de mandar la reserva, la recuperación preguntaría por la referencia nueva, no
-- encontraría la reserva que quedó viva en el proveedor y la orden podría volver a reservarse; la
-- conciliación tampoco podría cruzarla. Un nuevo intento es una orden nueva con otra referencia.
-- Escribirla sobre un NULL sí vale: el trigger sólo mira valores ya escritos.
CREATE FUNCTION orders_provider_booking_ref_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'orders.provider_booking_ref no se modifica una vez escrita (orden %)', OLD.id;
END;
$$;

CREATE TRIGGER orders_provider_booking_ref_immutable
  BEFORE UPDATE OF provider_booking_ref ON orders
  FOR EACH ROW
  WHEN (OLD.provider_booking_ref IS NOT NULL
        AND NEW.provider_booking_ref IS DISTINCT FROM OLD.provider_booking_ref)
  EXECUTE FUNCTION orders_provider_booking_ref_immutable();

-- ============================================================================
-- 2. orders.provider_account_id: la cuenta que creó la reserva
-- ============================================================================
-- Si la cuenta es heredada o propia no se guarda aparte: sale de comparar
-- `provider_accounts.tenant_id` con `orders.tenant_id`, y la FK garantiza que esa fila existe
-- mientras exista la orden.
--
-- La FK referencia una fila que la agencia NO puede leer cuando la cuenta es del consolidador
-- (`provider_accounts` tiene RLS forzada, 0012 y 0029). No importa: Postgres verifica las FK como
-- dueño de la tabla referenciada y sin RLS, así que la agencia puede guardar la cuenta heredada
-- sin ver nunca su fila ni su secreto.
--
-- Ni CASCADE ni SET NULL: borrar una cuenta que todavía tiene órdenes se rechaza, porque es la
-- única que puede leerlas y cancelarlas. La verificación corre al final de la sentencia, así que
-- el borrado en cascada de un tenant que se lleva a la vez sus órdenes y su cuenta sigue
-- funcionando. Desactivar la cuenta es un UPDATE y la FK no lo ve: esa regla es de la app
-- (RF-29 CA 2).
ALTER TABLE orders
  ADD COLUMN provider_account_id UUID NULL
    CONSTRAINT orders_provider_account_id_fkey REFERENCES provider_accounts (id) ON DELETE NO ACTION;

-- La conciliación corre por cuenta y no por tenant, y cada borrado en `provider_accounts` tiene
-- que buscar sus órdenes: sin índice, las dos cosas recorren `orders` entera.
CREATE INDEX idx_orders_provider_account
  ON orders (provider_account_id)
  WHERE provider_account_id IS NOT NULL;

COMMENT ON COLUMN orders.provider_account_id IS
  'Cuenta BYOC (provider_accounts.id) con la que se creó la reserva. La post-venta y la conciliación usan siempre esta, no la vigente del tenant. Heredada si provider_accounts.tenant_id <> orders.tenant_id. Ver db/migrations/0042.';

-- ============================================================================
-- 3. hotel_order_tracking: seguimiento de una orden de hotel
-- ============================================================================
-- `orders.status` conserva su vocabulario (pending, confirmed, cancelled, failed). Lo que el
-- proveedor dice de la reserva es más fino que eso y vive acá: por ejemplo, una cancelación que
-- el proveedor aceptó pero todavía no terminó es `pending` en la orden y tiene su estado crudo y
-- su subestado en esta fila.
--
-- La fila es la fuente de verdad de los jobs de post-venta: la cola sólo los despierta, y el
-- barrido periódico relee de acá lo que se haya perdido en Redis.
--
-- `(order_id, tenant_id)` referencia `(id, tenant_id)` de `orders`, no sólo `id`. Las FK se
-- verifican sin RLS: con una FK a `id` a secas, una agencia que conociera el id de una orden
-- ajena podría colgarle una fila de seguimiento con su propio tenant_id (la policy sólo mira el
-- tenant_id de la fila nueva) y leer o pisar el estado de esa reserva. Con el par, la fila sólo
-- puede apuntar a una orden del mismo tenant. `order_operations` (0021) no tiene esa defensa.
ALTER TABLE orders ADD CONSTRAINT uq_orders_id_tenant UNIQUE (id, tenant_id);

COMMENT ON CONSTRAINT uq_orders_id_tenant ON orders IS
  'Redundante como unicidad (id ya es PK); existe para que las tablas satélite referencien (id, tenant_id) y no puedan apuntar a una orden de otro tenant.';

CREATE TABLE hotel_order_tracking (
  order_id                 UUID         PRIMARY KEY,
  tenant_id                UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Última lectura del proveedor. El valor va crudo y sin CHECK: un estado que no conocemos se
  -- guarda tal cual, con sub_status 'unknown', para que una persona lo revise.
  provider_status          TEXT,
  provider_voucher_status  TEXT,
  provider_status_at       TIMESTAMPTZ,
  provider_status_source   TEXT
    CHECK (provider_status_source IN ('book', 'verify', 'retrieve', 'cancel', 'hcn', 'reconciliation')),

  -- NULL = el estado crudo alcanza para describir la orden.
  sub_status               TEXT
    CHECK (sub_status IN ('create-pending', 'create-uncertain', 'create-not-found-yet',
                          'cancel-requested', 'cancel-unverified', 'unverified-read', 'unknown')),
  refund_awaited           BOOLEAN      NOT NULL DEFAULT false,

  invoice_number           TEXT,
  client_reference_id      TEXT,

  -- HCN: número de confirmación del hotel y el plan de lecturas que lo espera.
  hcn                      TEXT         CHECK (btrim(hcn) <> ''),
  hcn_received_at          TIMESTAMPTZ,
  hcn_state                TEXT
    CHECK (hcn_state IN ('out-of-window', 'scheduled', 'received', 'missing', 'stopped')),
  hcn_priority             TEXT
    CHECK (hcn_priority IN ('P0', 'P1', 'P2', 'P3', 'P4', 'P4+', 'P5')),
  hcn_next_check_at        TIMESTAMPTZ,
  hcn_attempts             INTEGER      NOT NULL DEFAULT 0 CHECK (hcn_attempts >= 0),

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT hotel_order_tracking_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE CASCADE,

  -- El momento y la fuente de una lectura van juntos, y un estado leído tiene que decir cuándo.
  -- Una lectura sin estado sí vale: una reserva que respondió OK sin traer el estado, o cuya
  -- lectura de cierre falló, registra de dónde salió sin inventar un valor.
  CONSTRAINT hotel_order_tracking_read_moment
    CHECK ((provider_status_at IS NULL) = (provider_status_source IS NULL)),
  CONSTRAINT hotel_order_tracking_status_has_read
    CHECK ((provider_status IS NULL AND provider_voucher_status IS NULL) OR provider_status_at IS NOT NULL),

  -- 'received' sin número sería una reserva que muestra HCN y no lo tiene.
  CONSTRAINT hotel_order_tracking_hcn_received
    CHECK (hcn_state IS DISTINCT FROM 'received' OR (hcn IS NOT NULL AND hcn_received_at IS NOT NULL)),
  -- El barrido despierta toda fila con hcn_next_check_at vencido. Si un estado terminal
  -- conservara la fecha, el barrido volvería a consultar al proveedor por un HCN que ya llegó o
  -- que ya se dio por perdido, y gastaría la cuota de consultas.
  CONSTRAINT hotel_order_tracking_hcn_wakeup
    CHECK (hcn_next_check_at IS NULL OR coalesce(hcn_state IN ('out-of-window', 'scheduled'), false))
);

COMMENT ON TABLE hotel_order_tracking IS
  'Seguimiento de una orden de hotel: último estado del proveedor, subestado, factura y HCN. Una fila por orden, con tenant_id y RLS forzada. Fuente de verdad de los jobs de post-venta; la cola sólo los despierta. Sin PII. Ver db/migrations/0042.';
COMMENT ON COLUMN hotel_order_tracking.provider_status IS
  'Estado de la reserva tal como lo devolvió el proveedor en la última lectura, sin normalizar.';
COMMENT ON COLUMN hotel_order_tracking.provider_voucher_status IS
  'Estado del voucher tal como lo devolvió el proveedor (booleano o texto, guardado como texto).';
COMMENT ON COLUMN hotel_order_tracking.provider_status_source IS
  'Qué produjo la última lectura: book, verify (verificación y lectura de cierre), retrieve (consulta manual), cancel, hcn o reconciliation.';
COMMENT ON COLUMN hotel_order_tracking.sub_status IS
  'Subestado de la orden cuando orders.status no alcanza (p. ej. cancelación aceptada pero no terminada). NULL = el estado crudo del proveedor describe la orden.';
COMMENT ON COLUMN hotel_order_tracking.refund_awaited IS
  'La reserva está cancelada y el reembolso del proveedor a la cuenta sigue pendiente. No bloquea nada; la conciliación lo sigue.';
COMMENT ON COLUMN hotel_order_tracking.invoice_number IS
  'Número de factura del proveedor, para la conciliación financiera.';
COMMENT ON COLUMN hotel_order_tracking.client_reference_id IS
  'Referencia de cliente enviada al proveedor. Hoy es el mismo valor que orders.provider_booking_ref; se guarda aparte por si el proveedor exige que difieran.';
COMMENT ON COLUMN hotel_order_tracking.hcn_state IS
  'out-of-window: el check-in está fuera de la ventana del HCN y hcn_next_check_at es la entrada en ventana; scheduled: plan de lecturas en curso; received: llegó; missing: SLA y reintentos agotados, con tarea de operaciones; stopped: seguimiento cortado (cancelada o check-in pasado).';
COMMENT ON COLUMN hotel_order_tracking.hcn_priority IS
  'Tramo de SLA del proveedor según la distancia entre la reserva y el check-in.';
COMMENT ON COLUMN hotel_order_tracking.hcn_next_check_at IS
  'Próxima lectura del HCN. Sólo existe en out-of-window y scheduled; el barrido despierta las vencidas.';

CREATE TRIGGER hotel_order_tracking_set_updated_at
  BEFORE UPDATE ON hotel_order_tracking FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_hotel_order_tracking_hcn_due
  ON hotel_order_tracking (hcn_next_check_at)
  WHERE hcn_next_check_at IS NOT NULL;

-- RLS forzada por tenant, igual que orders y order_operations (0021, 0029).
ALTER TABLE hotel_order_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_order_tracking FORCE  ROW LEVEL SECURITY;

CREATE POLICY hotel_order_tracking_tenant_isolation ON hotel_order_tracking
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));
