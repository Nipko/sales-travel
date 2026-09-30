-- 0054_hotel_catalog_on_demand.sql
-- El API completa el catálogo de hoteles BAJO DEMANDA, por dos puertas angostas.
--
-- Hasta aquí el catálogo lo escribía sólo el sync, que corre como `postgres` (0041 §6): la app tenía
-- `SELECT` y nada más. Dos cosas del buscador de hoteles no pueden esperar a la corrida de madrugada:
--
--   1. Las fotos de los resultados. El catálogo de TBO de Colombia está entero en `hotel_inventory`
--      pero sin contenido: E4 sólo baja el de los destinos con demanda, y la demanda no contaba las
--      búsquedas del catálogo local (arreglado en el sync). Cuando el vendedor ve resultados sin
--      foto, la web pide el contenido de esos hoteles; el API lo trae de HotelDetails (lotes de 10,
--      por el limitador y el circuito de la cuenta) y lo GUARDA, para que la próxima búsqueda ya lo
--      tenga y el sync no lo vuelva a pedir.
--   2. Las ciudades que todavía no tienen hoteles. El sync baja la lista de ciudades de todos los
--      países (E2A) sin sus hoteles; la primera vez que alguien busca una, el API trae sus
--      `HotelCodes` con un `TBOHotelCodeList` (1-5 s) y los guarda, y la búsqueda sigue.
--
-- La app NO recibe `INSERT`/`UPDATE` sobre las tablas (el REVOKE de 0041 sigue): escribe sólo por
-- estas dos funciones `SECURITY DEFINER`, que validan cada campo y aplican las mismas reglas que el
-- sync, así un API comprometido o con un bug no puede reescribir el catálogo a su gusto:
--
--   - `hotel_catalog_store_contents`: contenido de hoteles QUE YA ESTÁN en `hotel_inventory`, con la
--     huella del ACL (`tbo-content-v1`, la misma del sync): una fila igual no se reescribe, un
--     `listing` nunca pisa un `details`, y el HTML tiene que cumplir la lista blanca del saneador.
--   - `hotel_catalog_import_city`: hoteles de UNA ciudad que existe en `hotel_provider_city` y que
--     no tiene ningún hotel activo. Nunca desactiva nada ni mueve un hotel activo de otra ciudad: la
--     baja y el barrido siguen siendo sólo del sync. Una ciudad que TBO contesta vacía queda con
--     `hotel_count = 0` y su `synced_at`, como la deja E3.
--
-- Siguen siendo tablas de catálogo de PLATAFORMA, sin tenant_id ni RLS (0041): no hay dato de tenant
-- que aislar. Quién puede disparar la escritura lo decide el API (la cuenta de TBO del tenant, su
-- flag de `opt-in` y el circuito del proveedor), no la base.

-- ============================================================================
-- 1. Validación compartida de una fila de contenido
-- ============================================================================
-- La gramática de salida del saneador del ACL (`sanitizeTboHtml`): `p`, `br`, `b`, `ul` y `li` sin
-- atributos y el texto escapado con cinco entidades. Quitadas ésas no puede quedar `<`, `>`, comilla
-- ni `&`. Es la misma comprobación que hace el API al servir (`isAllowlistedHtml`).
CREATE FUNCTION hotel_catalog_html_ok(p_html TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT p_html IS NULL
      OR (length(p_html) <= 100000
          AND regexp_replace(p_html, '</?(p|b|ul|li)>|<br>|&(amp|lt|gt|quot|#39);', '', 'g')
              !~ '[<>"''&]');
$$;

-- Las tres que siguen van con `CASE` y no con `AND`: Postgres no garantiza el orden de un `AND`, y
-- `jsonb_array_length` o `jsonb_array_elements` sobre algo que no es una lista LANZAN. Con `CASE`,
-- una fila con un campo que no es lista se rechaza (cuenta en `rejected`) en vez de tumbar la
-- llamada entera con las filas buenas.

-- `[]` o una lista de textos, cada uno como mucho `p_max_len` y a lo sumo `p_max_items`.
CREATE FUNCTION hotel_catalog_text_list_ok(p_list JSONB, p_max_items INTEGER, p_max_len INTEGER)
RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_list IS NULL THEN true
    WHEN jsonb_typeof(p_list) <> 'array' THEN false
    WHEN jsonb_array_length(p_list) > p_max_items THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_list) AS item(value)
       WHERE jsonb_typeof(item.value) <> 'string'
          OR length(item.value #>> '{}') > p_max_len)
  END;
$$;

-- Imágenes: sólo URLs absolutas `https` (RNF-16). Una `http` sería contenido mixto en el panel.
CREATE FUNCTION hotel_catalog_images_ok(p_images JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_images IS NULL THEN true
    WHEN NOT hotel_catalog_text_list_ok(p_images, 200, 2048) THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p_images) AS url(value)
       WHERE url.value !~ '^https://[^\s/@:]+(/|$)')
  END;
$$;

-- Secciones de la descripción: `[{label, text}]` en texto plano.
CREATE FUNCTION hotel_catalog_sections_ok(p_sections JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_sections IS NULL THEN true
    WHEN jsonb_typeof(p_sections) <> 'array' THEN false
    WHEN jsonb_array_length(p_sections) > 100 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_sections) AS s(value)
       WHERE jsonb_typeof(s.value) <> 'object'
          OR jsonb_typeof(s.value -> 'label') IS DISTINCT FROM 'string'
          OR jsonb_typeof(s.value -> 'text') IS DISTINCT FROM 'string'
          OR length(s.value ->> 'label') > 200
          OR length(s.value ->> 'text') > 20000)
  END;
$$;

-- ============================================================================
-- 2. hotel_catalog_store_contents: el contenido que el API trajo de HotelDetails
-- ============================================================================
-- `p_contents` es una lista de hasta 50 objetos con los nombres del contrato del ACL
-- (`hotelId`, `lang`, `source`, `name`, `descriptionHtml`, `sections`, `facilities`,
-- `attractionsHtml`, `images`, `phone`, `websiteUrl`, `checkInTime`, `checkOutTime`, `contentHash`).
-- Cada fila decide su camino como `contentWriteAction` del sync:
--
--   insert     no había fila para ese hotel e idioma;
--   rewrite    cambió la huella, o llega `details` sobre un `listing`;
--   touch      `details` igual al guardado: sólo avanza `fetched_at`;
--   unchanged  `listing` igual al guardado: nada;
--   protected  `listing` sobre `details`: nada (el texto del listado nunca reemplaza al detalle);
--   rejected   no cumple el contrato, o el hotel no está en el catálogo de ese proveedor.
--
-- Una fila rechazada no tumba a las demás: se cuenta y se sigue, como los mappers del ACL.
CREATE FUNCTION hotel_catalog_store_contents(p_provider TEXT, p_contents JSONB)
RETURNS TABLE (
  inserted   INTEGER,
  rewritten  INTEGER,
  touched    INTEGER,
  unchanged  INTEGER,
  protected  INTEGER,
  rejected   INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item          JSONB;
  v_hotel         TEXT;
  v_lang          TEXT;
  v_source        TEXT;
  v_hash          TEXT;
  v_check_in      TEXT;
  v_check_out     TEXT;
  v_website       TEXT;
  v_stored_source TEXT;
  v_stored_hash   TEXT;
  v_rows          INTEGER;
BEGIN
  inserted := 0; rewritten := 0; touched := 0; unchanged := 0; protected := 0; rejected := 0;

  IF p_provider IS NULL OR length(p_provider) > 40 OR p_provider !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'hotel_catalog_store_contents: proveedor inválido' USING ERRCODE = '22023';
  END IF;
  IF p_contents IS NULL OR jsonb_typeof(p_contents) <> 'array' THEN
    RAISE EXCEPTION 'hotel_catalog_store_contents: se esperaba una lista' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_contents) > 50 THEN
    RAISE EXCEPTION 'hotel_catalog_store_contents: más de 50 filas por llamada' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_contents) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      rejected := rejected + 1;
      CONTINUE;
    END IF;
    v_hotel := v_item ->> 'hotelId';
    v_lang := v_item ->> 'lang';
    v_source := v_item ->> 'source';
    v_hash := v_item ->> 'contentHash';
    v_check_in := NULLIF(v_item ->> 'checkInTime', '');
    v_check_out := NULLIF(v_item ->> 'checkOutTime', '');
    v_website := NULLIF(v_item ->> 'websiteUrl', '');

    IF v_hotel IS NULL OR v_hotel !~ '^[A-Za-z0-9._-]{1,64}$'
       OR v_lang IS NULL OR v_lang NOT IN ('es', 'pt', 'en')
       OR v_source IS NULL OR v_source NOT IN ('details', 'listing')
       OR v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$'
       OR length(v_item ->> 'name') > 500
       OR length(v_item ->> 'phone') > 64
       OR (v_website IS NOT NULL AND (length(v_website) > 2048 OR v_website !~ '^https?://'))
       OR (v_check_in IS NOT NULL AND v_check_in !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
       OR (v_check_out IS NOT NULL AND v_check_out !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
       OR NOT hotel_catalog_html_ok(v_item ->> 'descriptionHtml')
       OR NOT hotel_catalog_html_ok(v_item ->> 'attractionsHtml')
       OR NOT hotel_catalog_sections_ok(v_item -> 'sections')
       OR NOT hotel_catalog_text_list_ok(v_item -> 'facilities', 500, 300)
       OR NOT hotel_catalog_images_ok(v_item -> 'images')
       OR NOT EXISTS (SELECT 1 FROM hotel_inventory h
                       WHERE h.provider_code = p_provider AND h.hotel_id = v_hotel)
    THEN
      rejected := rejected + 1;
      CONTINUE;
    END IF;

    SELECT c.source, c.content_hash INTO v_stored_source, v_stored_hash
      FROM hotel_content c
     WHERE c.provider_code = p_provider AND c.hotel_id = v_hotel AND c.lang = v_lang
       FOR UPDATE;

    IF NOT FOUND THEN
      -- Otro escritor (el sync, otra petición) puede haberla insertado entre la lectura y esto: la
      -- suya gana y ésta cuenta como igual. La próxima pasada la compara por la huella.
      INSERT INTO hotel_content
        (provider_code, hotel_id, lang, name, description_html, sections, facilities,
         attractions_html, images, phone, website_url, check_in_time, check_out_time, source,
         content_hash, fetched_at)
      VALUES
        (p_provider, v_hotel, v_lang, NULLIF(v_item ->> 'name', ''),
         NULLIF(v_item ->> 'descriptionHtml', ''),
         COALESCE(NULLIF(v_item -> 'sections', 'null'::jsonb), '[]'::jsonb),
         COALESCE(NULLIF(v_item -> 'facilities', 'null'::jsonb), '[]'::jsonb),
         NULLIF(v_item ->> 'attractionsHtml', ''),
         COALESCE(NULLIF(v_item -> 'images', 'null'::jsonb), '[]'::jsonb),
         NULLIF(v_item ->> 'phone', ''), v_website, v_check_in::time, v_check_out::time,
         v_source, v_hash, now())
      ON CONFLICT (provider_code, hotel_id, lang) DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN inserted := inserted + 1; ELSE unchanged := unchanged + 1; END IF;
    ELSIF v_source = 'listing' AND v_stored_source = 'details' THEN
      protected := protected + 1;
    ELSIF v_stored_source = v_source AND v_stored_hash = v_hash THEN
      IF v_source = 'details' THEN
        UPDATE hotel_content c SET fetched_at = now()
         WHERE c.provider_code = p_provider AND c.hotel_id = v_hotel AND c.lang = v_lang;
        touched := touched + 1;
      ELSE
        unchanged := unchanged + 1;
      END IF;
    ELSE
      UPDATE hotel_content c
         SET name             = NULLIF(v_item ->> 'name', ''),
             description_html = NULLIF(v_item ->> 'descriptionHtml', ''),
             sections         = COALESCE(NULLIF(v_item -> 'sections', 'null'::jsonb), '[]'::jsonb),
             facilities       = COALESCE(NULLIF(v_item -> 'facilities', 'null'::jsonb), '[]'::jsonb),
             attractions_html = NULLIF(v_item ->> 'attractionsHtml', ''),
             images           = COALESCE(NULLIF(v_item -> 'images', 'null'::jsonb), '[]'::jsonb),
             phone            = NULLIF(v_item ->> 'phone', ''),
             website_url      = v_website,
             check_in_time    = v_check_in::time,
             check_out_time   = v_check_out::time,
             source           = v_source,
             content_hash     = v_hash,
             fetched_at       = now()
       WHERE c.provider_code = p_provider AND c.hotel_id = v_hotel AND c.lang = v_lang;
      rewritten := rewritten + 1;
    END IF;
  END LOOP;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION hotel_catalog_store_contents(TEXT, JSONB) IS
  'Contenido de hoteles del catálogo que el API trajo bajo demanda (HotelDetails). Mismas reglas que el sync: huella tbo-content-v1, listing nunca pisa details, HTML de lista blanca, imágenes https, sólo hoteles de hotel_inventory. Ver db/migrations/0054.';

-- ============================================================================
-- 3. hotel_catalog_import_city: los hoteles de una ciudad que todavía no tenía
-- ============================================================================
-- `p_hotels` es la lista de hasta 20.000 hoteles de `TBOHotelCodeList` con los nombres del
-- contrato del ACL (`hotelId`, `name`, `stars`, `latitude`, `longitude`, `address`, `zipcode`,
-- `countryCode`). Devuelve qué pasó:
--
--   unknown-city    la ciudad no está en `hotel_provider_city` de ese proveedor: no se crea;
--   already-loaded  ya tiene hoteles activos (otra petición, o el sync, llegó antes): nada;
--   loaded          se insertaron sus hoteles;
--   empty           TBO la contestó sin hoteles: queda `hotel_count = 0` con su `synced_at`.
--
-- La fila de la ciudad se bloquea (`FOR UPDATE`) para que dos búsquedas simultáneas de la misma
-- ciudad no la carguen dos veces. Un hotel que ya existe ACTIVO en otra ciudad no se mueve (la
-- decisión es del sync, que ve el catálogo entero); uno inactivo se reactiva en ésta.
CREATE FUNCTION hotel_catalog_import_city(p_provider TEXT, p_city_code TEXT, p_hotels JSONB)
RETURNS TABLE (outcome TEXT, active_hotels INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_country TEXT;
  v_active  INTEGER;
  v_lat     DOUBLE PRECISION;
  v_lng     DOUBLE PRECISION;
BEGIN
  IF p_provider IS NULL OR length(p_provider) > 40 OR p_provider !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'hotel_catalog_import_city: proveedor inválido' USING ERRCODE = '22023';
  END IF;
  IF p_city_code IS NULL OR p_city_code !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'hotel_catalog_import_city: ciudad inválida' USING ERRCODE = '22023';
  END IF;
  IF p_hotels IS NULL OR jsonb_typeof(p_hotels) <> 'array' THEN
    RAISE EXCEPTION 'hotel_catalog_import_city: se esperaba una lista' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_hotels) > 20000 THEN
    RAISE EXCEPTION 'hotel_catalog_import_city: más de 20000 hoteles' USING ERRCODE = '22023';
  END IF;

  SELECT c.country_code::text INTO v_country
    FROM hotel_provider_city c
   WHERE c.provider_code = p_provider AND c.provider_city_code = p_city_code
     FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'unknown-city';
    active_hotels := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT count(*)::int INTO v_active
    FROM hotel_inventory h
   WHERE h.provider_code = p_provider AND h.provider_city_code = p_city_code AND h.active;
  IF v_active > 0 THEN
    outcome := 'already-loaded';
    active_hotels := v_active;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO hotel_inventory
    (provider_code, hotel_id, country_code, name, stars, latitude, longitude, address, zipcode,
     provider_city_code, active, last_seen_at, synced_at)
  SELECT p_provider, x.hotel_id, x.country_code, x.name, x.stars,
         CASE WHEN x.located THEN x.latitude END, CASE WHEN x.located THEN x.longitude END,
         x.address, x.zipcode, p_city_code, true, now(), now()
    FROM (
      -- Los números se leen con `CASE`, que sí garantiza el orden: un texto donde va un número
      -- queda en NULL en vez de tumbar la carga entera con un error de conversión.
      SELECT DISTINCT ON (e.value ->> 'hotelId')
             e.value ->> 'hotelId' AS hotel_id,
             CASE WHEN e.value ->> 'countryCode' ~ '^[A-Z]{2}$' THEN e.value ->> 'countryCode'
                  ELSE v_country END AS country_code,
             CASE WHEN length(e.value ->> 'name') BETWEEN 1 AND 300 THEN e.value ->> 'name' END AS name,
             CASE WHEN n.stars BETWEEN 0 AND 5 THEN round(n.stars, 1) END AS stars,
             n.latitude,
             n.longitude,
             COALESCE(n.latitude BETWEEN -90 AND 90 AND n.longitude BETWEEN -180 AND 180, false)
               AS located,
             CASE WHEN length(e.value ->> 'address') BETWEEN 1 AND 500 THEN e.value ->> 'address' END AS address,
             CASE WHEN length(e.value ->> 'zipcode') BETWEEN 1 AND 32 THEN e.value ->> 'zipcode' END AS zipcode
        FROM jsonb_array_elements(p_hotels) AS e(value)
       CROSS JOIN LATERAL (
         SELECT CASE WHEN jsonb_typeof(e.value -> 'stars') = 'number'
                     THEN (e.value ->> 'stars')::numeric END AS stars,
                CASE WHEN jsonb_typeof(e.value -> 'latitude') = 'number'
                     THEN (e.value ->> 'latitude')::double precision END AS latitude,
                CASE WHEN jsonb_typeof(e.value -> 'longitude') = 'number'
                     THEN (e.value ->> 'longitude')::double precision END AS longitude
       ) n
       WHERE jsonb_typeof(e.value) = 'object'
         AND e.value ->> 'hotelId' ~ '^[A-Za-z0-9._-]{1,64}$'
       ORDER BY e.value ->> 'hotelId'
    ) x
  ON CONFLICT (provider_code, hotel_id) DO UPDATE
     SET country_code       = EXCLUDED.country_code,
         name               = EXCLUDED.name,
         stars              = EXCLUDED.stars,
         latitude           = EXCLUDED.latitude,
         longitude          = EXCLUDED.longitude,
         address            = EXCLUDED.address,
         zipcode            = EXCLUDED.zipcode,
         provider_city_code = EXCLUDED.provider_city_code,
         active             = true,
         last_seen_at       = EXCLUDED.last_seen_at,
         synced_at          = EXCLUDED.synced_at
   WHERE NOT hotel_inventory.active;

  -- Conteo y centroide como los deja E3 (`cityStats`): mediana por eje de los activos ubicados.
  SELECT count(*)::int,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY h.latitude)
           FILTER (WHERE h.latitude IS NOT NULL AND h.longitude IS NOT NULL),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY h.longitude)
           FILTER (WHERE h.latitude IS NOT NULL AND h.longitude IS NOT NULL)
    INTO v_active, v_lat, v_lng
    FROM hotel_inventory h
   WHERE h.provider_code = p_provider AND h.provider_city_code = p_city_code AND h.active;

  UPDATE hotel_provider_city c
     SET hotel_count      = v_active,
         centroid_lat     = v_lat,
         centroid_lng     = v_lng,
         last_status_code = 200,
         synced_at        = now()
   WHERE c.provider_code = p_provider AND c.provider_city_code = p_city_code;

  outcome := CASE WHEN v_active > 0 THEN 'loaded' ELSE 'empty' END;
  active_hotels := v_active;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION hotel_catalog_import_city(TEXT, TEXT, JSONB) IS
  'Hoteles de una ciudad del proveedor sin hoteles activos, traídos por el API al buscarla (TBOHotelCodeList). No desactiva ni mueve hoteles activos: el barrido es del sync. Ver db/migrations/0054.';

-- ============================================================================
-- 4. Permisos: la app ejecuta las dos funciones de escritura; las tablas siguen de sólo lectura
-- ============================================================================
REVOKE ALL ON FUNCTION hotel_catalog_html_ok(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hotel_catalog_text_list_ok(JSONB, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION hotel_catalog_images_ok(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hotel_catalog_sections_ok(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hotel_catalog_store_contents(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hotel_catalog_import_city(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hotel_catalog_store_contents(TEXT, JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION hotel_catalog_import_city(TEXT, TEXT, JSONB) TO app_user;
