-- 0084_flight_deadline_alerts.sql
-- El aviso de que vence el plazo de emisión de una reserva de vuelo (SAB-14).
--
-- Una reserva confirmada y sin tiquete se cae sola cuando vence su plazo de emisión: la aerolínea
-- la cancela y nadie se entera hasta que el pasajero llega al mostrador. Y si la reserva retenía la
-- cartera de la red, el saldo sigue retenido hasta que alguien la cancele aquí. El barrido de
-- post-venta avisa al vendedor a las 24 h y a las 2 h del plazo; para eso necesita el plazo como
-- INSTANTE y saber qué avisos ya salieron.
--
--   1. El instante de un plazo en la hora de la oficina del proveedor. 0082 lo dejaba sin instante
--      porque esa hora no dice su zona. La zona la declara la CUENTA del proveedor con que se hizo
--      la reserva (la zona IANA de su oficina): con ella el instante ya no se inventa, se calcula.
--      Se guarda la zona usada, para que la pantalla muestre la hora de la oficina tal cual y la
--      convierta a la de quien mira.
--   2. Un aviso por orden y umbral: `deadline_alerted_24h_at` y `deadline_alerted_2h_at`. El
--      barrido marca la columna en la misma transacción que el `domain_event` y ANTES de mandar el
--      correo (CAS sobre la columna en NULL): dos corridas a la vez no mandan dos avisos. Una
--      lectura que cambia el instante del plazo las vuelve a NULL, porque el aviso anterior decía
--      otra hora.
--   3. Un índice parcial por plazo para las órdenes a las que todavía les falta el último aviso.
--
-- Nada de esta migración nombra a un proveedor. Sin PII.

-- ============================================================================
-- 1. La zona de la oficina y el instante que permite
-- ============================================================================
ALTER TABLE flight_order_tracking
  ADD COLUMN ticketing_deadline_time_zone TEXT
    CONSTRAINT flight_order_tracking_deadline_time_zone_iana
      CHECK (
        length(ticketing_deadline_time_zone) <= 64
        AND ticketing_deadline_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
      ),
  -- La zona de la oficina sólo tiene sentido con un plazo en la hora de la oficina.
  ADD CONSTRAINT flight_order_tracking_deadline_time_zone_local
    CHECK (ticketing_deadline_time_zone IS NULL OR ticketing_deadline_zone = 'PROVIDER_LOCAL');

-- 0082 sólo admitía el instante con zona UTC. Ahora también con la hora de la oficina, si se sabe
-- la zona y hay hora: un día sin hora sigue sin instante (sería inventar la hora).
ALTER TABLE flight_order_tracking
  DROP CONSTRAINT flight_order_tracking_deadline_at_utc;

ALTER TABLE flight_order_tracking
  ADD CONSTRAINT flight_order_tracking_deadline_at_known_zone
    CHECK (
      ticketing_deadline_at IS NULL
      OR ticketing_deadline_zone = 'UTC'
      OR (
        ticketing_deadline_zone = 'PROVIDER_LOCAL'
        AND ticketing_deadline_time_zone IS NOT NULL
        AND ticketing_deadline_time IS NOT NULL
      )
    );

COMMENT ON COLUMN flight_order_tracking.ticketing_deadline_time_zone IS
  'Zona IANA de la oficina del proveedor, declarada por la cuenta con que se hizo la reserva. Sólo con zona PROVIDER_LOCAL; con ella y con hora, el plazo tiene instante. Ver db/migrations/0084.';
COMMENT ON COLUMN flight_order_tracking.ticketing_deadline_at IS
  'Instante del plazo. Con zona UTC, o con PROVIDER_LOCAL más hora y la zona de la oficina (0084).';
COMMENT ON COLUMN flight_order_tracking.ticketing_deadline_zone IS
  'UTC: fecha y hora UTC, con instante en ticketing_deadline_at. PROVIDER_LOCAL: fecha y hora de la oficina del proveedor; con instante sólo si la cuenta declara la zona de la oficina (ticketing_deadline_time_zone, 0084).';

-- ============================================================================
-- 2. Los avisos ya enviados
-- ============================================================================
ALTER TABLE flight_order_tracking
  ADD COLUMN deadline_alerted_24h_at TIMESTAMPTZ,
  ADD COLUMN deadline_alerted_2h_at  TIMESTAMPTZ;

COMMENT ON COLUMN flight_order_tracking.deadline_alerted_24h_at IS
  'Cuándo salió el aviso de «vence en menos de 24 h» del plazo vigente. NULL: no salió. Una lectura que cambia ticketing_deadline_at la vuelve a NULL. Ver db/migrations/0084.';
COMMENT ON COLUMN flight_order_tracking.deadline_alerted_2h_at IS
  'Cuándo salió el aviso de «vence en menos de 2 h» del plazo vigente. Al salir también marca el de 24 h, que ya no tiene sentido mandar. Una lectura que cambia ticketing_deadline_at la vuelve a NULL.';

-- ============================================================================
-- 3. Lo que el barrido busca: plazos con instante y sin el último aviso
-- ============================================================================
CREATE INDEX idx_flight_order_tracking_deadline_unalerted
  ON flight_order_tracking (tenant_id, ticketing_deadline_at)
  WHERE ticketing_deadline_at IS NOT NULL AND deadline_alerted_2h_at IS NULL;

COMMENT ON INDEX idx_flight_order_tracking_deadline_unalerted IS
  'El barrido de post-venta busca, tenant por tenant, los plazos de emisión que vencen pronto y a los que les falta el aviso de 2 h. Ver db/migrations/0084.';
