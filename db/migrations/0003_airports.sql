-- 0003_airports.sql
-- Catálogo global de aeropuertos IATA. Cross-tenant (lectura pública).
-- Se sincroniza diariamente desde OpenFlights por un job cron de Actions.

CREATE TABLE airports (
  code          CHAR(3)            PRIMARY KEY,
  name          TEXT               NOT NULL,
  city          TEXT               NOT NULL,
  country_code  CHAR(2),
  country_name  TEXT               NOT NULL,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  timezone      TEXT,
  updated_at    TIMESTAMPTZ        NOT NULL DEFAULT now()
);

COMMENT ON TABLE airports IS 'Aeropuertos IATA — catálogo global cross-tenant. Sync diario desde OpenFlights (ODbL).';

-- Índices trigram para búsqueda fuzzy rápida sobre city/name (autocomplete).
CREATE INDEX idx_airports_city_trgm ON airports USING GIN (city gin_trgm_ops);
CREATE INDEX idx_airports_name_trgm ON airports USING GIN (name gin_trgm_ops);
CREATE INDEX idx_airports_country   ON airports (country_code);

-- Lectura pública para todos los roles que toquen la app
GRANT SELECT ON airports TO app_user;
