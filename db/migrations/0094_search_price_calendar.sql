-- 0094_search_price_calendar.sql
-- Calendario de precios ±3 días sin llamar al proveedor (founder 2026-11-11, docs/platform/18 §2).
--
-- Cada búsqueda ya deja una fila por proveedor en search_logs. Ahora además guarda el precio de
-- VENTA más bajo que ese proveedor trajo, en la moneda de venta de la agencia. Con eso la pantalla
-- muestra «mié 9 dic · $ 936.149» para los días vecinos a partir de lo que la propia agencia ya
-- buscó: son precios ESTIMADOS (la pantalla lo dice), y elegir un día lanza la búsqueda de verdad.
--
--   1. search_logs.min_price_minor / price_currency: el mínimo de ese proveedor en esa búsqueda.
--   2. flight_price_calendar(): el mínimo por día de salida en una ventana, SÓLO de la agencia
--      pedida y sólo agregados. Es SECURITY DEFINER como count_recent_searches (0032): la lectura
--      de search_logs está acotada a quien administra la red, y un vendedor tiene que poder ver el
--      calendario de su propia agencia sin leer la telemetría de nadie.
--
-- search_path = pg_catalog, public, pg_temp (posterior a 0060: ver
-- apps/api/src/database/migrations-search-path.test.ts).

ALTER TABLE search_logs
  ADD COLUMN IF NOT EXISTS min_price_minor BIGINT,
  ADD COLUMN IF NOT EXISTS price_currency  TEXT;

COMMENT ON COLUMN search_logs.min_price_minor IS
  'Precio de venta más bajo (unidades menores) que trajo este proveedor en esta búsqueda, en price_currency. NULL si no trajo nada vendible. Alimenta el calendario de precios (0094).';
COMMENT ON COLUMN search_logs.price_currency IS
  'Moneda de min_price_minor: la de venta de la agencia. Las ofertas en otra moneda no cuentan.';

-- El calendario busca por agencia y fecha reciente; el índice de la cuota (tenant_id, occurred_at)
-- ya cubre la ventana. Éste acota a las filas con precio de vuelos, que son las que se leen.
CREATE INDEX IF NOT EXISTS idx_search_logs_price_calendar
  ON search_logs (tenant_id, occurred_at DESC)
  WHERE vertical = 'flights' AND min_price_minor IS NOT NULL;

CREATE OR REPLACE FUNCTION flight_price_calendar(
  p_tenant_id   uuid,
  p_origin      text,
  p_destination text,
  p_cabin       text,
  p_currency    text,
  p_from        date,
  p_to          date,
  p_stay_days   integer,  -- NULL = solo ida; N = ida y vuelta de N noches
  p_adults      integer,
  p_children    integer,
  p_infants     integer,
  p_max_age_hours integer
)
RETURNS TABLE (departure_date date, min_price_minor bigint, observed_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT (l.criteria->>'departureDate')::date AS departure_date,
         MIN(l.min_price_minor)               AS min_price_minor,
         MAX(l.occurred_at)                   AS observed_at
  FROM public.search_logs l
  WHERE l.tenant_id = p_tenant_id
    AND l.vertical = 'flights'
    AND l.min_price_minor IS NOT NULL
    AND l.price_currency = p_currency
    AND l.occurred_at > now() - make_interval(hours => p_max_age_hours)
    AND l.criteria->>'origin' = p_origin
    AND l.criteria->>'destination' = p_destination
    AND COALESCE(l.criteria->>'cabin', 'economy') = p_cabin
    -- Un multidestino no es un solo ida: su primer tramo no dice el precio de ese trayecto.
    AND NOT (l.criteria ? 'legs')
    AND COALESCE((l.criteria->>'adults')::int, 1)   = p_adults
    AND COALESCE((l.criteria->>'children')::int, 0) = p_children
    AND COALESCE((l.criteria->>'infants')::int, 0)  = p_infants
    AND (l.criteria->>'departureDate') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (l.criteria->>'departureDate')::date BETWEEN p_from AND p_to
    AND (
      (p_stay_days IS NULL AND l.criteria->>'returnDate' IS NULL)
      OR (
        p_stay_days IS NOT NULL
        AND (l.criteria->>'returnDate') ~ '^\d{4}-\d{2}-\d{2}$'
        AND (l.criteria->>'returnDate')::date - (l.criteria->>'departureDate')::date = p_stay_days
      )
    )
  GROUP BY 1
$$;

REVOKE ALL ON FUNCTION flight_price_calendar(uuid, text, text, text, text, date, date, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION flight_price_calendar(uuid, text, text, text, text, date, date, integer, integer, integer, integer, integer) TO app_user;
