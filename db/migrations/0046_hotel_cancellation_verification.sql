-- 0046_hotel_cancellation_verification.sql
-- Calendario de la lectura que verifica una cancelación de hotel.
--
-- Un proveedor puede aceptar una cancelación sin terminarla (pedido enviado al hotel, pendiente de
-- respuesta), o no contestar si la aplicó (timeout, 5xx, respuesta ilegible). En los dos casos la
-- orden queda `pending` y NO se vuelve a mandar la cancelación: una lectura de la reserva la cierra
-- cuando el proveedor la muestra cancelada, y si no llega a eso la mira una persona. Esa lectura se
-- repite en un calendario fijo contado desde la respuesta de la cancelación: +2 min, +15 min, +1 h,
-- +6 h y +24 h (docs/tbo/04 §4.4 punto 6 y §10).
--
-- Como el de 0044, el calendario vive en Postgres y no en Redis: la cola despierta cada paso, pero
-- sin Redis, o si un job se pierde, el barrido periódico tiene que saber qué paso toca. Son
-- columnas aparte de las de 0044 porque es otro proceso: una orden cuyo Book se recuperó por
-- lectura ya tiene ese calendario cerrado, y lo que se cierra no se reabre.
--
-- Aditivo y nullable: una fila sin cancelación en verificación no escribe ninguna de estas columnas.

ALTER TABLE hotel_order_tracking
  -- Instante de la respuesta de la cancelación (o de su fallo), desde el que corre el calendario.
  ADD COLUMN cancel_verify_anchor_at TIMESTAMPTZ,
  -- Índice del próximo paso. Sólo avanza: un job de un paso ya hecho no vuelve a leer.
  ADD COLUMN cancel_verify_step      SMALLINT CHECK (cancel_verify_step >= 0),
  -- Cuándo toca ese paso. NULL = nada programado: la cancelación se cerró, el calendario se agotó
  -- o la orden necesita una persona.
  ADD COLUMN cancel_verify_next_at   TIMESTAMPTZ;

-- El paso y el ancla van juntos: un paso sin ancla no dice cuándo toca.
ALTER TABLE hotel_order_tracking
  ADD CONSTRAINT hotel_order_tracking_cancel_verify_calendar
    CHECK ((cancel_verify_anchor_at IS NULL) = (cancel_verify_step IS NULL));

-- Un paso programado necesita calendario: el barrido no despierta una fila que no sabe qué leer.
ALTER TABLE hotel_order_tracking
  ADD CONSTRAINT hotel_order_tracking_cancel_verify_wakeup
    CHECK (cancel_verify_next_at IS NULL OR cancel_verify_anchor_at IS NOT NULL);

CREATE INDEX idx_hotel_order_tracking_cancel_verify_due
  ON hotel_order_tracking (cancel_verify_next_at)
  WHERE cancel_verify_next_at IS NOT NULL;

COMMENT ON COLUMN hotel_order_tracking.cancel_verify_anchor_at IS
  'Desde cuándo corre el calendario de verificación de una cancelación: la respuesta del proveedor a la cancelación, o su fallo. Ver db/migrations/0046.';
COMMENT ON COLUMN hotel_order_tracking.cancel_verify_step IS
  'Índice del próximo paso de la verificación de la cancelación. Sólo avanza; un job de un paso anterior no hace nada.';
COMMENT ON COLUMN hotel_order_tracking.cancel_verify_next_at IS
  'Cuándo toca el próximo paso. NULL = nada programado (cerrada, agotada o a revisión). El barrido ejecuta los vencidos.';
