-- 0070_hotel_room_content_on_demand.sql
-- El API guarda BAJO DEMANDA el contenido de cada habitación de un hotel: fotos, tamaño y
-- descripción (docs/tbo/05 §2.6.3; 08 RF-32; Q-65).
--
-- El vendedor no ve la diferencia entre "Standard" y "Deluxe" porque nunca pedimos el detalle por
-- habitación de HotelDetails (`IsRoomDetailRequired`). El ACL ya lo sabe pedir y leer con un lector
-- tolerante (TBO-05); lo que falta es dónde dejarlo. `hotel_room_content` existe desde 0041 pero
-- nadie la escribe, y le faltan tres cosas para servir a la ficha:
--
--   1. Una identidad que no dependa de que TBO mande `RoomId`. El PDF dice que `0` es "mapping
--      isn't available"; una habitación sin id se identifica con `n-` y 16 hex del SHA-256 de su
--      nombre normalizado (el `roomKey` del ACL). `room_id` pasa a ser ese `roomKey`, y el id real
--      del proveedor va aparte, en `room_ref`, para enlazar con el `RoomID` de Search.
--   2. El nombre normalizado (`name_key`) con el que la web enlaza una habitación sin id con la
--      tarifa del mismo nombre (D-TBO-H2: sólo con un candidato único, marcada "Foto de referencia").
--   3. El orden en que el proveedor las listó (`position`).
--
-- Y una tabla de lo que ya se preguntó (`hotel_room_content_fetch`): sin ella, un hotel del que TBO
-- no tiene habitaciones se volvería a pedir en cada ficha, gastando el cupo de fondo de la cuenta.
--
-- Como el contenido de hotel de 0054, la app NO escribe las tablas: lo hace por UNA función
-- `SECURITY DEFINER` que valida cada habitación y reemplaza el set entero del hotel en ese idioma.
-- Es catálogo de PLATAFORMA (0041 §6): sin tenant_id ni RLS, porque no hay dato de tenant que
-- aislar. Quién puede disparar la escritura lo decide el API (la cuenta de TBO de la agencia, su
-- `opt-in`, el circuito del proveedor y el interruptor `HOTEL_ROOM_CONTENT`).
--
-- Forward-only: `hotel_room_content` está vacía (nada la escribió nunca), no hay datos que migrar.

-- ============================================================================
-- 1. hotel_room_content: roomKey, id del proveedor, nombre normalizado y orden
-- ============================================================================
ALTER TABLE hotel_room_content
  ADD COLUMN room_ref  TEXT CHECK (room_ref IS NULL OR room_ref <> '0'),
  ADD COLUMN name_key  TEXT,
  ADD COLUMN position  SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN hotel_room_content.room_id IS
  'roomKey del ACL: el id del proveedor o, si no lo mandó, `n-` + 16 hex del SHA-256 de name_key. Nunca `0`. Ver db/migrations/0070.';
COMMENT ON COLUMN hotel_room_content.room_ref IS
  'Id de la habitación en el proveedor (TBO `RoomId`, el `RoomID` de Search); NULL si no vino o vino `0`. Ver db/migrations/0070.';
COMMENT ON COLUMN hotel_room_content.name_key IS
  'Nombre normalizado con el mismo algoritmo que normalizeRoomName de la web: enlaza una habitación sin id con la tarifa del mismo nombre. Ver db/migrations/0070.';
COMMENT ON COLUMN hotel_room_content.position IS
  'Orden en que el proveedor listó la habitación, desde 0. Ver db/migrations/0070.';

-- ============================================================================
-- 2. hotel_room_content_fetch: qué se preguntó, cuándo y qué respondió
-- ============================================================================
-- Una fila por hotel e idioma preguntados. `outcome`:
--   rooms       vinieron habitaciones y se guardó al menos una (`room_count`);
--   none        el proveedor no tiene el hotel en ese idioma ("No Hotels Found" o no volvió);
--   unreadable  volvió el hotel pero no se pudo leer ninguna habitación (bloque ausente, forma
--               desconocida o todas rechazadas): se reintenta antes que `none`.
-- La vigencia de cada resultado la decide el API (30 días, 7 y 1); la base sólo guarda cuándo fue.
CREATE TABLE hotel_room_content_fetch (
  provider_code  TEXT         NOT NULL,
  hotel_id       TEXT         NOT NULL,
  lang           TEXT         NOT NULL CHECK (lang IN ('es', 'pt', 'en')),
  outcome        TEXT         NOT NULL CHECK (outcome IN ('rooms', 'none', 'unreadable')),
  room_count     SMALLINT     NOT NULL DEFAULT 0,
  fetched_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id, lang)
);

COMMENT ON TABLE hotel_room_content_fetch IS
  'Qué respondió el proveedor la última vez que se le pidió el detalle por habitación de un hotel en un idioma. Catálogo de plataforma, sin tenant_id. La escribe sólo hotel_catalog_store_room_contents. Ver db/migrations/0070.';

-- ============================================================================
-- 3. Validación de UNA habitación
-- ============================================================================
-- Con `CASE`, como las de 0054: Postgres no garantiza el orden de un `OR`, y las funciones de lista
-- LANZAN sobre algo que no es una lista. Una habitación que no cumple se rechaza y cuenta; no tumba
-- la llamada con las demás.
--
-- Una habitación necesita nombre o id: el ACL deja el nombre vacío sólo cuando TBO mandó el id sin
-- nombre, y esa habitación todavía sirve para enlazar sus fotos por `RoomID`.
CREATE FUNCTION hotel_catalog_room_ok(p_room JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_room IS NULL OR jsonb_typeof(p_room) <> 'object' THEN false
    WHEN jsonb_typeof(p_room -> 'roomKey') IS DISTINCT FROM 'string' THEN false
    WHEN p_room ->> 'roomKey' !~ '^[A-Za-z0-9_-]{1,64}$' OR p_room ->> 'roomKey' = '0' THEN false
    WHEN COALESCE(jsonb_typeof(p_room -> 'roomRef'), 'null') NOT IN ('string', 'null') THEN false
    WHEN jsonb_typeof(p_room -> 'roomRef') = 'string'
         AND (p_room ->> 'roomRef' !~ '^[A-Za-z0-9_-]{1,64}$' OR p_room ->> 'roomRef' = '0') THEN false
    WHEN jsonb_typeof(p_room -> 'name') IS DISTINCT FROM 'string' THEN false
    WHEN length(p_room ->> 'name') > 300 THEN false
    WHEN btrim(p_room ->> 'name') = '' AND jsonb_typeof(p_room -> 'roomRef') IS DISTINCT FROM 'string'
      THEN false
    WHEN COALESCE(jsonb_typeof(p_room -> 'nameKey'), 'null') NOT IN ('string', 'null') THEN false
    WHEN length(p_room ->> 'nameKey') > 300 THEN false
    WHEN COALESCE(jsonb_typeof(p_room -> 'sizeText'), 'null') NOT IN ('string', 'null') THEN false
    WHEN length(p_room ->> 'sizeText') > 60 THEN false
    WHEN COALESCE(jsonb_typeof(p_room -> 'description'), 'null') NOT IN ('string', 'null') THEN false
    -- Texto plano: sin `<` ni `>` no hay etiqueta posible, la web lo escapa igual al pintarlo.
    WHEN length(p_room ->> 'description') > 4000 OR p_room ->> 'description' ~ '[<>]' THEN false
    WHEN NOT hotel_catalog_text_list_ok(p_room -> 'images', 30, 2048) THEN false
    WHEN NOT hotel_catalog_images_ok(p_room -> 'images') THEN false
    ELSE true
  END;
$$;

-- ============================================================================
-- 4. hotel_catalog_store_room_contents: el set de habitaciones de un hotel en un idioma
-- ============================================================================
-- `p_rooms` es una lista de hasta 100 objetos con los nombres del contrato del API (`roomKey`,
-- `roomRef`, `nameKey`, `name`, `sizeText`, `description`, `images`), vacía si `p_outcome` no es
-- `rooms`. Reemplaza el set entero de (proveedor, hotel, idioma): una habitación que el proveedor
-- dejó de listar no queda con fotos viejas. Una habitación inválida o con un `roomKey` repetido se
-- rechaza y cuenta; las demás se guardan. Si llegaron habitaciones y no pasó ninguna, el resultado
-- queda `unreadable` (se reintenta en un día), no `rooms` con cero.
--
-- El candado por (proveedor, hotel, idioma) serializa dos fichas que guardan a la vez: sin él, la
-- segunda chocaría con la clave primaria de las filas que acaba de insertar la primera.
--
-- Los errores de la llamada (proveedor, hotel o idioma inválidos, hotel fuera del catálogo) no
-- citan los valores: el mensaje puede terminar en un log.
CREATE FUNCTION hotel_catalog_store_room_contents(
  p_provider TEXT,
  p_hotel_id TEXT,
  p_lang     TEXT,
  p_outcome  TEXT,
  p_rooms    JSONB
)
RETURNS TABLE (stored INTEGER, rejected INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_room     JSONB;
  v_key      TEXT;
  v_seen     TEXT[] := ARRAY[]::TEXT[];
  v_outcome  TEXT;
BEGIN
  stored := 0;
  rejected := 0;

  IF p_provider IS NULL OR length(p_provider) > 40 OR p_provider !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: proveedor inválido' USING ERRCODE = '22023';
  END IF;
  IF p_hotel_id IS NULL OR p_hotel_id !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: hotel inválido' USING ERRCODE = '22023';
  END IF;
  IF p_lang IS NULL OR p_lang NOT IN ('es', 'pt', 'en') THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: idioma inválido' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('rooms', 'none', 'unreadable') THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: resultado inválido' USING ERRCODE = '22023';
  END IF;
  IF p_rooms IS NULL OR jsonb_typeof(p_rooms) <> 'array' THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: se esperaba una lista' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rooms) > 100 THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: más de 100 habitaciones' USING ERRCODE = '22023';
  END IF;
  IF p_outcome <> 'rooms' AND jsonb_array_length(p_rooms) > 0 THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: habitaciones con un resultado sin habitaciones'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hotel_inventory h
                  WHERE h.provider_code = p_provider AND h.hotel_id = p_hotel_id) THEN
    RAISE EXCEPTION 'hotel_catalog_store_room_contents: el hotel no está en el catálogo del proveedor'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('hotel_room_content ' || p_provider || ' ' || p_hotel_id || ' ' || p_lang, 0));

  DELETE FROM hotel_room_content c
   WHERE c.provider_code = p_provider AND c.hotel_id = p_hotel_id AND c.lang = p_lang;

  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    IF NOT hotel_catalog_room_ok(v_room) THEN
      rejected := rejected + 1;
      CONTINUE;
    END IF;
    v_key := v_room ->> 'roomKey';
    IF v_key = ANY (v_seen) THEN
      rejected := rejected + 1;
      CONTINUE;
    END IF;
    v_seen := v_seen || v_key;

    INSERT INTO hotel_room_content
      (provider_code, hotel_id, room_id, lang, room_ref, name_key, name, size_text, description,
       images, position, fetched_at)
    VALUES
      (p_provider, p_hotel_id, v_key, p_lang,
       NULLIF(v_room ->> 'roomRef', ''),
       NULLIF(v_room ->> 'nameKey', ''),
       NULLIF(btrim(v_room ->> 'name'), ''),
       NULLIF(btrim(v_room ->> 'sizeText'), ''),
       NULLIF(btrim(v_room ->> 'description'), ''),
       COALESCE(NULLIF(v_room -> 'images', 'null'::jsonb), '[]'::jsonb),
       stored, now());
    stored := stored + 1;
  END LOOP;

  v_outcome := CASE WHEN p_outcome = 'rooms' AND stored = 0 THEN 'unreadable' ELSE p_outcome END;

  INSERT INTO hotel_room_content_fetch (provider_code, hotel_id, lang, outcome, room_count, fetched_at)
  VALUES (p_provider, p_hotel_id, p_lang, v_outcome, stored, now())
  ON CONFLICT (provider_code, hotel_id, lang) DO UPDATE
     SET outcome    = EXCLUDED.outcome,
         room_count = EXCLUDED.room_count,
         fetched_at = EXCLUDED.fetched_at;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION hotel_catalog_store_room_contents(TEXT, TEXT, TEXT, TEXT, JSONB) IS
  'Reemplaza las habitaciones de un hotel del catálogo en un idioma con las que el API trajo bajo demanda (HotelDetails con IsRoomDetailRequired) y anota el resultado en hotel_room_content_fetch. Valida cada habitación: roomKey, id del proveedor, texto plano, imágenes https. Ver db/migrations/0070.';

-- ============================================================================
-- 5. Permisos: la app lee y escribe sólo por la función
-- ============================================================================
-- 0001 da por defecto SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva: se quitan los tres de
-- escritura, como 0041 con el resto del catálogo. `hotel_room_content` ya quedó de sólo lectura ahí.
GRANT SELECT ON hotel_room_content_fetch TO app_user;
REVOKE INSERT, UPDATE, DELETE ON hotel_room_content_fetch FROM app_user;

REVOKE ALL ON FUNCTION hotel_catalog_room_ok(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hotel_catalog_store_room_contents(TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hotel_catalog_store_room_contents(TEXT, TEXT, TEXT, TEXT, JSONB) TO app_user;
