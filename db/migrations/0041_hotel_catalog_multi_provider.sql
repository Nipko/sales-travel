-- 0041_hotel_catalog_multi_provider.sql
-- El catálogo de hoteles deja de suponer que hay UN proveedor que lo borra y lo reescribe entero.
--
-- 0022 nació con el molde del sync de Despegar: una descarga diaria, `DELETE` de todas sus filas e
-- `INSERT` del inventario completo en una sola transacción. Ese molde da por sentadas tres cosas que
-- un segundo proveedor de hoteles no cumple:
--
--   1. que el id de ciudad de cualquier proveedor cabe en el BIGINT de Despegar (`city_id`);
--   2. que un hotel que desaparece se borra, porque el catálogo se reemplaza entero de una vez;
--   3. que el catálogo es sólo "ciudad → ids": no hay dónde guardar las ciudades del proveedor, el
--      mapa de destinos, las equivalencias de un mismo hotel entre proveedores ni el contenido.
--
-- Todo lo de esta migración es ADITIVO. El job nocturno de Despegar no cambia: sigue insertando sus
-- 12 columnas, las nuevas toman su default y su `DELETE` sigue filtrando por su `provider_code`.
--
-- Las seis tablas son catálogo de PLATAFORMA, como `hotel_inventory` y `provider_catalog`: no llevan
-- tenant_id ni RLS porque no contienen ningún dato de tenant que aislar. Las escribe sólo el sync,
-- que corre como `postgres`; la app sólo las lee (sección 6).

-- ============================================================================
-- 1. hotel_inventory: código de ciudad del proveedor y baja lógica
-- ============================================================================
-- `provider_city_code` va en una columna propia y no en `city_id`: el código de ciudad de otro
-- proveedor puede no ser numérico, y aunque lo sea vive en OTRO espacio de ids. Guardar los dos en
-- la misma columna invita a buscar la ciudad de un proveedor con el id del otro y recibir hoteles
-- de otra ciudad sin ningún error. `city_id` queda sólo para Despegar.
--
-- `active` + `last_seen_at` son la baja lógica de un proveedor que sincroniza ciudad por ciudad con
-- upsert: una corrida cortada a mitad con `DELETE` + `INSERT` global dejaría el catálogo vacío o a
-- medias, así que ese proveedor marca los hoteles que dejó de ver en lugar de borrarlos. Un hotel
-- inactivo conserva su fila (y su contenido) para las reservas ya hechas y sus vouchers.
--
-- `NOT NULL DEFAULT true` con un default constante no reescribe la tabla (Postgres >= 11 lo guarda
-- en el catálogo): las filas de Despegar existentes quedan activas al instante y las que inserte su
-- job mañana nacen activas sin que el job sepa que la columna existe. Despegar nunca tiene filas
-- inactivas: su baja sigue siendo el borrado. `last_seen_at` queda NULL en sus filas, y como
-- `NULL < x` no es verdadero, ningún barrido por `last_seen_at` puede alcanzarlas.
ALTER TABLE hotel_inventory
  ADD COLUMN IF NOT EXISTS provider_city_code TEXT,
  ADD COLUMN IF NOT EXISTS active             BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at       TIMESTAMPTZ;

COMMENT ON COLUMN hotel_inventory.provider_city_code IS
  'Código de ciudad en el espacio de ids del propio proveedor (TEXT: no tiene por qué ser numérico). NULL en las filas de Despegar, que usan city_id. Ver db/migrations/0041.';
COMMENT ON COLUMN hotel_inventory.active IS
  'Baja lógica: false = el proveedor dejó de listar el hotel. La búsqueda sólo usa activos; la fila se conserva para reservas y vouchers. Ver db/migrations/0041.';
COMMENT ON COLUMN hotel_inventory.last_seen_at IS
  'Inicio de la última corrida del sync que vio el hotel; el barrido desactiva los no vistos. NULL en proveedores que reemplazan su catálogo entero. Ver db/migrations/0041.';

-- Resolución "ciudad del proveedor → ids" de la búsqueda, que sólo pide hoteles activos. Sin las
-- filas de Despegar (`provider_city_code IS NULL`): son casi todo el catálogo de hoy, ninguna
-- consulta por este código las necesita, y cada una sería una entrada más que su `INSERT` nocturno
-- tendría que escribir. `provider_city_code = $1` implica `IS NOT NULL`, así que el planificador
-- sigue pudiendo usarlo.
CREATE INDEX idx_hotel_inventory_provider_city
  ON hotel_inventory (provider_code, provider_city_code)
  WHERE active AND provider_city_code IS NOT NULL;

-- ============================================================================
-- 2. hotel_provider_city: las ciudades de cada proveedor
-- ============================================================================
-- Es a la vez el catálogo de ciudades y el checkpoint del sync: `synced_at` y `last_status_code`
-- dicen qué ciudades faltan en el ciclo, y una corrida interrumpida sigue desde ahí sin tabla de
-- control aparte. El centroide es la MEDIANA de las coordenadas de sus hoteles activos: una sola
-- coordenada errónea no lo mueve, y es lo que permite cruzar la ciudad con la de otro proveedor.
--
-- `name_norm` (minúsculas, sin acentos ni puntuación) lo calcula el sync y no un índice de
-- expresión: `unaccent()` no es IMMUTABLE y Postgres no lo acepta en un índice funcional.
CREATE TABLE hotel_provider_city (
  provider_code       TEXT             NOT NULL,
  provider_city_code  TEXT             NOT NULL,
  country_code        CHAR(2)          NOT NULL,
  name                TEXT             NOT NULL,
  name_norm           TEXT             NOT NULL,
  hotel_count         INTEGER,
  centroid_lat        DOUBLE PRECISION,
  centroid_lng        DOUBLE PRECISION,
  synced_at           TIMESTAMPTZ,
  last_status_code    INTEGER,
  PRIMARY KEY (provider_code, provider_city_code)
);

COMMENT ON TABLE hotel_provider_city IS
  'Ciudades de cada proveedor de hoteles con el centroide de sus hoteles activos. Checkpoint del sync (synced_at, last_status_code). Catálogo de plataforma, sin tenant_id. Ver db/migrations/0041.';

-- Búsqueda por similitud de nombre (pg_trgm, instalada por postgres-init y por CI antes de migrar,
-- como el índice de 0003_airports).
CREATE INDEX idx_hotel_provider_city_name ON hotel_provider_city USING GIN (name_norm gin_trgm_ops);

-- ============================================================================
-- 3. hotel_destination_map: el destino de la UI, traducido a las ciudades de otro proveedor
-- ============================================================================
-- El destino que elige el vendedor es hoy un id del autocomplete de Despegar. Un proveedor que no
-- busca por ese id necesita saber a qué ciudades SUYAS corresponde. El mapa se calcula fuera de
-- línea (solapamiento de hoteles equivalentes y distancia de centroides) para que sea
-- determinista, auditable y corregible a mano; calcularlo en cada búsqueda no sería ninguna de las
-- tres cosas.
--
-- Sólo `accepted` se usa para vender. `ambiguous` espera revisión y un destino sin fila aceptada
-- no consulta a ese proveedor: mezclar ciudades vecinas es peor que no mostrar sus hoteles. Una
-- fila `manual` es una decisión humana y el recálculo no la pisa (lo respeta el sync).
CREATE TABLE hotel_destination_map (
  source_provider_code  TEXT         NOT NULL,
  source_city_id        TEXT         NOT NULL,
  target_provider_code  TEXT         NOT NULL,
  target_city_code      TEXT         NOT NULL,
  method                TEXT         NOT NULL CHECK (method IN ('overlap', 'centroid', 'manual')),
  score                 NUMERIC(4,3),
  status                TEXT         NOT NULL CHECK (status IN ('accepted', 'ambiguous', 'rejected')),
  computed_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (source_provider_code, source_city_id, target_provider_code, target_city_code)
);

COMMENT ON TABLE hotel_destination_map IS
  'Destino de la UI (id de ciudad del proveedor de origen) → ciudades de otro proveedor. Sólo status = accepted se usa para vender; method = manual no lo pisa el recálculo. Ver db/migrations/0041.';

-- ============================================================================
-- 4. hotel_match: el mismo hotel en dos proveedores
-- ============================================================================
-- Tabla aparte y no columna de `hotel_inventory` porque el job de Despegar borra y reinserta todas
-- sus filas cada noche: cualquier enlace guardado en ellas desaparecería a diario.
--
-- Una fusión falsa es peor que un duplicado: el vendedor reservaría una tarifa creyendo que es de
-- otro hotel. Por eso sólo `accepted` agrupa tarjetas y la duda va a `review`. Un hotel sin fila
-- usa como clave `<provider_code>:<hotel_id>`.
CREATE TABLE hotel_match (
  canonical_hotel_id  TEXT         NOT NULL,
  provider_code       TEXT         NOT NULL,
  hotel_id            TEXT         NOT NULL,
  method              TEXT         NOT NULL CHECK (method IN ('heuristic', 'manual', 'giata')),
  score               NUMERIC(4,3),
  status              TEXT         NOT NULL CHECK (status IN ('accepted', 'review', 'rejected')),
  computed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id)
);

COMMENT ON TABLE hotel_match IS
  'Equivalencias de hotel entre proveedores: filas con el mismo canonical_hotel_id son el mismo hotel. Sólo status = accepted agrupa. Sobrevive al DELETE + INSERT diario de Despegar. Ver db/migrations/0041.';

-- La búsqueda agrupa por canónico y sólo con equivalencias aceptadas.
CREATE INDEX idx_hotel_match_canonical ON hotel_match (canonical_hotel_id) WHERE status = 'accepted';

-- ============================================================================
-- 5. hotel_content y hotel_room_content: contenido por hotel, habitación e idioma
-- ============================================================================
-- El contenido no cabe en `hotel_inventory`, que es una tabla de resolución ciudad → ids, y hay
-- proveedores cuya disponibilidad no trae ni el nombre del hotel: todo lo que el vendedor ve de
-- ellos sale de acá.
--
-- `lang` usa los mismos valores que `LanguageCodeSchema` de @sales-travel/validation; el ACL de cada
-- proveedor lo traduce a su código.
--
-- `source` dice qué llamada del proveedor produjo la fila, porque no valen lo mismo:
--   'details'  el método de detalle del hotel, pedido en ese idioma y con imágenes;
--   'listing'  el texto que llega de paso en el listado de hoteles por ciudad, sin idioma pedido y
--              sin imágenes. Sirve para que el detalle tenga texto desde el primer día, y el sync no
--              lo escribe sobre una fila 'details'.
-- Son clases de llamada y no nombres de métodos: los nombres son de cada proveedor, y un CHECK con
-- ellos obligaría a migrar para sumar el siguiente.
--
-- `content_hash` evita reescribir una fila que no cambió: los proveedores no ofrecen deltas y el
-- refresco es siempre completo. Las imágenes se guardan como URL, no se copian.
CREATE TABLE hotel_content (
  provider_code     TEXT         NOT NULL,
  hotel_id          TEXT         NOT NULL,
  lang              TEXT         NOT NULL CHECK (lang IN ('es', 'pt', 'en')),
  name              TEXT,
  description_html  TEXT,
  sections          JSONB,
  facilities        JSONB,
  attractions_html  TEXT,
  images            JSONB,
  phone             TEXT,
  website_url       TEXT,
  check_in_time     TIME,
  check_out_time    TIME,
  source            TEXT         NOT NULL CHECK (source IN ('details', 'listing')),
  content_hash      TEXT         NOT NULL,
  fetched_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id, lang)
);

COMMENT ON TABLE hotel_content IS
  'Contenido de hotel por proveedor e idioma. description_html y attractions_html llegan ya saneados con lista blanca; sections = [{label, text}]; facilities e images = string[]. Ver db/migrations/0041.';
COMMENT ON COLUMN hotel_content.source IS
  'details = método de detalle del proveedor (por idioma, con imágenes); listing = texto del listado por ciudad. El sync no pisa details con listing. Ver db/migrations/0041.';

-- '0' es el centinela con que un proveedor dice "esta habitación no tiene mapeo de contenido".
-- Guardarlo como id haría que todas las habitaciones sin mapeo de un hotel compartieran fotos y
-- descripción, y el vendedor vería las de otra habitación. Esas habitaciones van sin contenido.
CREATE TABLE hotel_room_content (
  provider_code  TEXT         NOT NULL,
  hotel_id       TEXT         NOT NULL,
  room_id        TEXT         NOT NULL CHECK (room_id <> '0'),
  lang           TEXT         NOT NULL CHECK (lang IN ('es', 'pt', 'en')),
  name           TEXT,
  size_text      TEXT,
  description    TEXT,
  images         JSONB,
  fetched_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id, room_id, lang)
);

COMMENT ON TABLE hotel_room_content IS
  'Contenido por habitación, proveedor e idioma. size_text es texto libre del proveedor y no se parsea. Ver db/migrations/0041.';

-- ============================================================================
-- 6. Permisos: la app lee, el sync escribe
-- ============================================================================
-- Sin RLS en ninguna tabla nueva porque no hay tenant_id que filtrar. Si el catálogo de algún
-- proveedor resultara distinto por cuenta, deja de ser de plataforma y necesita otra migración.
--
-- El `GRANT SELECT` de 0022 NO dejó `hotel_inventory` en sólo lectura: 0001 da por defecto
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla futura (`ALTER DEFAULT PRIVILEGES`), y ese
-- GRANT no quitó nada. Hoy la app puede borrar el catálogo de hoteles aunque ningún código suyo lo
-- escriba. Se corrige acá con el mismo REVOKE que 0035 aplicó a `provider_catalog`, y se aplica a
-- las tablas nuevas, que nacen con el mismo default.
--
-- El sync no se ve afectado: corre como `postgres` (.github/workflows/sync-hotel-inventory.yml).
GRANT SELECT ON hotel_inventory, hotel_provider_city, hotel_destination_map, hotel_match,
                hotel_content, hotel_room_content TO app_user;
REVOKE INSERT, UPDATE, DELETE ON hotel_inventory, hotel_provider_city, hotel_destination_map,
                                 hotel_match, hotel_content, hotel_room_content FROM app_user;
