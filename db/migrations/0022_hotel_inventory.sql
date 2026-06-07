-- 0022_hotel_inventory.sql
-- Catálogo de hoteles por proveedor (resuelve ciudad→IDs). Cross-tenant (referencia global).
-- La API de availability exige IDs de hotel explícitos (no acepta ciudad/gid); este catálogo
-- mapea city_id → hotel_ids. Se sincroniza desde content-api/hotels-inventory por un cron de Actions.

CREATE TABLE hotel_inventory (
  provider_code  TEXT               NOT NULL,
  hotel_id       TEXT               NOT NULL,
  city_id        BIGINT,
  country_code   CHAR(2),
  name           TEXT,
  stars          NUMERIC(2, 1),
  property_type  TEXT,
  latitude       DOUBLE PRECISION,
  longitude      DOUBLE PRECISION,
  address        TEXT,
  zipcode        TEXT,
  merged_ids     JSONB,
  synced_at      TIMESTAMPTZ        NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id)
);

COMMENT ON TABLE hotel_inventory IS 'Catálogo de hoteles por proveedor (ciudad→IDs) — cross-tenant. Sync desde content-api/hotels-inventory.';

-- Resolución por ciudad: city_id → hotel_ids del proveedor (uso central del buscador).
CREATE INDEX idx_hotel_inventory_city ON hotel_inventory (provider_code, city_id);

-- Catálogo de referencia: lectura para la app (la escritura la hace el job de sync como admin).
GRANT SELECT ON hotel_inventory TO app_user;
