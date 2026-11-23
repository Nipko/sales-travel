-- 0098_package_quotations_studio.sql
-- La sección «Paquetes» del panel (2026-11-23): una búsqueda que combina vuelo, hotel y auto y
-- termina en una cotización visual para el cliente final.
--
-- `search_criteria`: lo que se buscó (origen, destino, fechas, habitaciones). La cotización lo usa
-- para su portada y para el itinerario día a día; sin él habría que reconstruirlo de los ítems, y
-- un paquete sin vuelo no tiene de dónde sacar el destino.
--
-- `show_breakdown`: si la cotización que ve el cliente desglosa el precio por servicio. Por
-- omisión NO: el paquete se vende como un total (algunas tarifas de hotel sólo pueden venderse
-- combinadas y sin que su precio se pueda deducir).
--
-- `position`: el orden en que el vendedor quiere mostrar los servicios.

ALTER TABLE package_quotations
  ADD COLUMN IF NOT EXISTS search_criteria JSONB,
  ADD COLUMN IF NOT EXISTS show_breakdown BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE package_items
  ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_package_items_package ON package_items (package_id, position);
CREATE INDEX IF NOT EXISTS idx_package_quotations_tenant_created
  ON package_quotations (tenant_id, created_at DESC);

COMMENT ON COLUMN package_quotations.search_criteria IS
  'Criterios de la búsqueda del paquete (origen, destino, fechas, habitaciones). Presentación de la cotización.';
COMMENT ON COLUMN package_quotations.show_breakdown IS
  'true = la cotización al cliente desglosa el precio por servicio; false = sólo el total.';
COMMENT ON COLUMN package_items.position IS 'Orden de presentación del servicio dentro del paquete.';
