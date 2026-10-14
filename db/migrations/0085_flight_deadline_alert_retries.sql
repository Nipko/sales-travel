-- 0085_flight_deadline_alert_retries.sql
-- Un correo del aviso de plazo de emisión que falla se reintenta, con tope (SAB-14).
--
-- 0084 marcaba el aviso como enviado ANTES de mandar el correo y no lo reintentaba: un corte
-- pasajero del SMTP perdía en silencio el aviso de 2 h, justo el que importa. Ahora la marca es el
-- candado del envío y no la prueba de que salió:
--
--   1. El barrido toma el aviso con el CAS de 0084 (la columna en NULL pasa a la hora del barrido).
--      Mientras está tomada, ninguna otra corrida ni réplica lo manda: un aviso que salió, salió
--      una sola vez.
--   2. Si el correo sale, o si no hay a quién escribirle, el aviso se cierra con su `domain_event`.
--   3. Si el correo falla, la marca se suelta (vuelve a NULL, sólo si sigue siendo la que puso esa
--      corrida) y se cuenta el intento en `deadline_alert_*_failures`: la próxima corrida lo
--      reintenta. Al tercer fallo queda tomada para siempre y se cierra sin correo.
--
-- Una lectura que cambia el instante del plazo vuelve a cero los intentos, como ya vuelve a NULL
-- las marcas: es otro aviso.
--
-- Nada de esta migración nombra a un proveedor. Sin PII.

ALTER TABLE flight_order_tracking
  ADD COLUMN deadline_alert_24h_failures SMALLINT NOT NULL DEFAULT 0
    CONSTRAINT flight_order_tracking_alert_24h_failures_range
      CHECK (deadline_alert_24h_failures BETWEEN 0 AND 100),
  ADD COLUMN deadline_alert_2h_failures  SMALLINT NOT NULL DEFAULT 0
    CONSTRAINT flight_order_tracking_alert_2h_failures_range
      CHECK (deadline_alert_2h_failures BETWEEN 0 AND 100);

COMMENT ON COLUMN flight_order_tracking.deadline_alert_24h_failures IS
  'Correos fallidos del aviso de «vence en menos de 24 h» del plazo vigente. Cada fallo suelta la marca para que la próxima corrida reintente; al tope se cierra sin correo. Una lectura que cambia ticketing_deadline_at lo vuelve a 0. Ver db/migrations/0085.';
COMMENT ON COLUMN flight_order_tracking.deadline_alert_2h_failures IS
  'Correos fallidos del aviso de «vence en menos de 2 h» del plazo vigente. Igual que el de 24 h. Ver db/migrations/0085.';
COMMENT ON COLUMN flight_order_tracking.deadline_alerted_24h_at IS
  'Cuándo se tomó el aviso de «vence en menos de 24 h» del plazo vigente: el candado del envío. NULL: no salió, o falló y espera la próxima corrida (0085). Una lectura que cambia ticketing_deadline_at la vuelve a NULL. Ver db/migrations/0084.';
COMMENT ON COLUMN flight_order_tracking.deadline_alerted_2h_at IS
  'Cuándo se tomó el aviso de «vence en menos de 2 h» del plazo vigente. Al tomarse también marca el de 24 h, que ya no tiene sentido mandar. Un correo fallido la suelta (0085). Una lectura que cambia ticketing_deadline_at la vuelve a NULL.';
