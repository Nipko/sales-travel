-- 0082_flight_order_tracking.sql
-- Lo que una lectura del proveedor dice de una reserva de VUELO, guardado en la reserva.
--
-- Hasta ahora, el localizador de la aerolínea, los números de tiquete y el plazo de emisión sólo
-- se veían al consultar al proveedor desde Reservas, y se perdían en un aviso. El vendedor tiene
-- que verlos sin volver a consultar: el localizador de cada aerolínea es lo que el pasajero usa
-- para el check-in, y el plazo decide si se emite hoy o se pierde la reserva esta noche. Y la
-- emisión y la anulación tienen que conciliar contra documentos guardados, no contra lo que diga
-- la última pantalla.
--
-- Dos tablas satélite de `orders`, como `hotel_order_tracking` (0042), y no columnas: son de una
-- sola vertical. Nada de esta migración nombra a un proveedor.
--
--   1. `flight_order_tracking`: una fila por orden, con los localizadores de la aerolínea, el plazo
--      de emisión y el momento de la última lectura.
--   2. `order_flight_documents`: una fila por documento (tiquete o EMD) y su estado.
--
-- Las dos van con tenant_id, RLS forzada y la FK compuesta `(order_id, tenant_id)` a
-- `orders (id, tenant_id)` (0042): las FK se verifican sin RLS, y con una FK a `id` a secas una
-- agencia que conociera el id de una orden ajena podría colgarle filas con su propio tenant_id.
--
-- Sin PII: un número de tiquete no identifica a una persona, y el pasajero va por su posición en
-- la reserva, nunca por nombre.

-- ============================================================================
-- 1. flight_order_tracking
-- ============================================================================
CREATE TABLE flight_order_tracking (
  order_id                  UUID         PRIMARY KEY,
  tenant_id                 UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- [{ "carrierCode": "LA", "locator": "ABC123" }, ...]. La forma de cada elemento la valida la
  -- app (Zod); la base garantiza que es una lista, para que leerla nunca falle.
  airline_locators          JSONB        NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT flight_order_tracking_locators_array CHECK (jsonb_typeof(airline_locators) = 'array'),

  -- El plazo, como lo dio el proveedor. Con zona PROVIDER_LOCAL, la fecha y la hora son las de la
  -- oficina del proveedor y no hay instante: no se inventa una zona.
  ticketing_deadline_date   DATE,
  ticketing_deadline_time   TEXT
    CONSTRAINT flight_order_tracking_deadline_time_hhmm
      CHECK (ticketing_deadline_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ticketing_deadline_zone   TEXT
    CHECK (ticketing_deadline_zone IN ('UTC', 'PROVIDER_LOCAL')),
  ticketing_deadline_at     TIMESTAMPTZ,

  last_read_at              TIMESTAMPTZ,

  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT flight_order_tracking_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE CASCADE,

  -- Una fecha sin zona no se sabe leer, y una hora o una zona sin fecha no son un plazo.
  CONSTRAINT flight_order_tracking_deadline_complete
    CHECK ((ticketing_deadline_date IS NULL) = (ticketing_deadline_zone IS NULL)),
  CONSTRAINT flight_order_tracking_deadline_time_needs_date
    CHECK (ticketing_deadline_time IS NULL OR ticketing_deadline_date IS NOT NULL),
  -- El instante existe sólo si la zona se conoce: con la hora de la oficina sería inventado.
  CONSTRAINT flight_order_tracking_deadline_at_utc
    CHECK (ticketing_deadline_at IS NULL OR ticketing_deadline_zone = 'UTC')
);

COMMENT ON TABLE flight_order_tracking IS
  'Lo que la última lectura del proveedor dijo de una orden de vuelo: localizadores de la aerolínea y plazo de emisión. Una fila por orden, con tenant_id y RLS forzada; (order_id, tenant_id) apunta a orders (id, tenant_id). Sin PII. Ver db/migrations/0082.';
COMMENT ON COLUMN flight_order_tracking.airline_locators IS
  'Localizadores de la aerolínea ([{carrierCode, locator}]): con lo que el pasajero hace check-in. No son el PNR del proveedor ni el id de la orden. Una lectura que no trae ninguno no borra los guardados.';
COMMENT ON COLUMN flight_order_tracking.ticketing_deadline_zone IS
  'UTC: fecha y hora UTC, con instante en ticketing_deadline_at. PROVIDER_LOCAL: fecha y hora de la oficina del proveedor, zona no informada; sin instante.';
COMMENT ON COLUMN flight_order_tracking.ticketing_deadline_at IS
  'Instante del plazo. Sólo con zona UTC.';
COMMENT ON COLUMN flight_order_tracking.last_read_at IS
  'Cuándo se leyó al proveedor por última vez (cierre de la creación, verificación o consulta manual).';

CREATE TRIGGER flight_order_tracking_set_updated_at
  BEFORE UPDATE ON flight_order_tracking FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE flight_order_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE flight_order_tracking FORCE  ROW LEVEL SECURITY;

CREATE POLICY flight_order_tracking_tenant_isolation ON flight_order_tracking
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON flight_order_tracking TO app_user;

-- ============================================================================
-- 2. order_flight_documents
-- ============================================================================
-- Un documento no se borra porque una lectura no lo traiga: la lectura puede venir filtrada. El
-- estado sólo cambia por una lectura que lo dice, y uno terminal (anulado, devuelto, canjeado) no
-- vuelve a emitido; esa regla es de la app.
CREATE TABLE order_flight_documents (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id              UUID         NOT NULL,

  -- El número principal: los tres dígitos del emisor y el serial. Un conjuntivo va por el primero.
  number                TEXT         NOT NULL
    CONSTRAINT order_flight_documents_number_digits CHECK (number ~ '^[0-9]{10,16}$'),
  kind                  TEXT         NOT NULL
    CHECK (kind IN ('TICKET', 'EMD')),
  -- Posición del pasajero en la reserva, desde 0. NULL si el proveedor no la dio.
  traveler_index        INTEGER
    CONSTRAINT order_flight_documents_traveler_index CHECK (traveler_index >= 0),
  status                TEXT         NOT NULL
    CHECK (status IN ('ISSUED', 'VOIDED', 'REFUNDED', 'EXCHANGED', 'UNKNOWN')),
  -- El código del proveedor, para revisar un UNKNOWN. Letras y dígitos: nunca texto libre.
  provider_status_code  VARCHAR(4)
    CONSTRAINT order_flight_documents_provider_code CHECK (provider_status_code ~ '^[A-Z0-9]{1,4}$'),

  -- La primera lectura que vio cada estado.
  issued_at             TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,
  refunded_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT order_flight_documents_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT uq_order_flight_documents_number UNIQUE (order_id, number)
);

COMMENT ON TABLE order_flight_documents IS
  'Tiquetes y EMD de una orden de vuelo con su estado según la última lectura del proveedor. Uno por número dentro de la orden, con tenant_id y RLS forzada; (order_id, tenant_id) apunta a orders (id, tenant_id). Sin PII. Ver db/migrations/0082.';
COMMENT ON COLUMN order_flight_documents.status IS
  'ISSUED, VOIDED, REFUNDED, EXCHANGED o UNKNOWN (el proveedor dio un código que no se sabe traducir, o ninguno). Un estado terminal no vuelve a ISSUED.';
COMMENT ON COLUMN order_flight_documents.traveler_index IS
  'Posición del pasajero en orders.passengers, desde 0. Nunca el nombre.';

CREATE TRIGGER order_flight_documents_set_updated_at
  BEFORE UPDATE ON order_flight_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE order_flight_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_flight_documents FORCE  ROW LEVEL SECURITY;

CREATE POLICY order_flight_documents_tenant_isolation ON order_flight_documents
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON order_flight_documents TO app_user;
