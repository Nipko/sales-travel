-- 0044_hotel_booking_verification.sql
-- Calendario de verificación de una reserva de hotel cuya respuesta no llegó.
--
-- Cuando la reserva se corta (timeout, red, 5xx, o una respuesta que no la prueba), el proveedor
-- exige consultarla por la referencia que mandamos "after 120 seconds of book response" (TBO,
-- p. 42). Esa consulta se repite en un calendario fijo contado desde el fallo observado: +120 s,
-- +5, +15 y +60 min (docs/tbo/03 §4.2; 08 RF-21). La cola de post-venta despierta cada paso con
-- un job diferido, pero la cola no es la fuente de verdad: sin Redis, o si el job se pierde, el
-- barrido periódico tiene que saber qué paso toca y desde cuándo. Eso vive acá, en la fila de
-- seguimiento de la orden (0042), no en Redis.
--
-- Aditivo y nullable: una fila de seguimiento sin calendario (la de una reserva que confirmó en
-- línea) no escribe ninguna de estas columnas.

ALTER TABLE hotel_order_tracking
  -- Instante desde el que corre el calendario: el fallo observado o, si el proceso murió con la
  -- reserva en vuelo, el último instante en que esa reserva pudo terminar.
  ADD COLUMN verify_anchor_at TIMESTAMPTZ,
  -- Índice del próximo paso a ejecutar. Sólo avanza: un job viejo de un paso ya hecho no vuelve a
  -- leer ni a emitir eventos, porque su paso ya no es el de la fila.
  ADD COLUMN verify_step      SMALLINT CHECK (verify_step >= 0),
  -- Cuándo toca ese paso. NULL = no queda nada programado: la reserva se consolidó, el calendario
  -- se agotó (queda para la conciliación) o necesita una persona.
  ADD COLUMN verify_next_at   TIMESTAMPTZ;

-- El paso y el ancla van juntos: un paso sin ancla no dice cuándo toca.
ALTER TABLE hotel_order_tracking
  ADD CONSTRAINT hotel_order_tracking_verify_calendar
    CHECK ((verify_anchor_at IS NULL) = (verify_step IS NULL));

-- Un paso programado necesita calendario. Sin esto, el barrido despertaría una fila que no sabe
-- qué leer.
ALTER TABLE hotel_order_tracking
  ADD CONSTRAINT hotel_order_tracking_verify_wakeup
    CHECK (verify_next_at IS NULL OR verify_anchor_at IS NOT NULL);

-- El barrido busca los pasos vencidos; son pocos entre todas las filas.
CREATE INDEX idx_hotel_order_tracking_verify_due
  ON hotel_order_tracking (verify_next_at)
  WHERE verify_next_at IS NOT NULL;

COMMENT ON COLUMN hotel_order_tracking.verify_anchor_at IS
  'Desde cuándo corre el calendario de verificación de una reserva sin respuesta: el fallo observado, o el último instante en que la reserva pudo terminar si el proceso murió en vuelo. Ver db/migrations/0044.';
COMMENT ON COLUMN hotel_order_tracking.verify_step IS
  'Índice del próximo paso del calendario de verificación. Sólo avanza; un job de un paso anterior no hace nada.';
COMMENT ON COLUMN hotel_order_tracking.verify_next_at IS
  'Cuándo toca el próximo paso. NULL = nada programado (consolidada, calendario agotado o a revisión). El barrido ejecuta los vencidos.';
