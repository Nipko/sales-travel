-- 0035_multi_flight_provider.sql
-- Lo que el esquema daba por sentado cuando había UN solo proveedor de vuelos.
--
-- El fan-out multi-proveedor deja cuatro supuestos en falso: que el proveedor de una orden
-- se puede adivinar, que una búsqueda es una fila, que la lista de proveedores vive
-- repartida en literales por el código, y que el identificador de un ítem de paquete cabe
-- en 200 caracteres. Los cuatro se arreglan acá, ANTES de que exista el segundo proveedor.

-- ============================================================================
-- 1. orders.provider deja de tener default
-- ============================================================================
-- `DEFAULT 'latam-ndc'` (0005) convertía un INSERT que se olvidara del proveedor en una
-- orden atribuida al proveedor equivocado, en silencio y sin forma de detectarlo después:
-- la post-venta (retrieve/cancel/pay) se enruta por esta columna, así que el síntoma no
-- aparece al reservar sino semanas más tarde, cuando el pasajero quiere cambiar el vuelo
-- y se le pregunta al proveedor que no lo vendió. Sin default, ese INSERT falla al
-- instante. La columna sigue NOT NULL: quien inserta declara de quién es la orden.
ALTER TABLE orders ALTER COLUMN provider DROP DEFAULT;

COMMENT ON COLUMN orders.provider IS
  'Código del proveedor que emitió la reserva (provider_catalog.code). Sin default a propósito: enruta la post-venta. Ver db/migrations/0035.';

-- ============================================================================
-- 2. search_logs.search_group_id — una búsqueda es una búsqueda, no N
-- ============================================================================
-- La cuota del tenant cuenta FILAS de search_logs. El día que la telemetría pase a escribir
-- una fila por proveedor —que es lo que hace falta para responder "cuánto tarda cada uno" y
-- "cuál falla"—, una agencia con dos proveedores gastaría su cuota al doble de velocidad sin
-- que nadie hubiera cambiado su plan. El grupo identifica la búsqueda del usuario; las filas
-- por proveedor comparten grupo y la cuota las cuenta una vez.
ALTER TABLE search_logs
  ADD COLUMN IF NOT EXISTS search_group_id UUID;

COMMENT ON COLUMN search_logs.search_group_id IS
  'Búsqueda del usuario a la que pertenece esta fila. NULL = fila anterior a la columna (una búsqueda). Varias filas con el mismo grupo = un fan-out, y cuentan 1 en la cuota.';

-- El índice de la cuota (0032) se rehace para cubrir el nuevo cálculo: con search_group_id
-- e id en el INCLUDE, el conteo por ventana se resuelve sin ir al heap.
DROP INDEX IF EXISTS idx_search_logs_quota;
CREATE INDEX idx_search_logs_quota ON search_logs(tenant_id, occurred_at)
  INCLUDE (search_group_id, id)
  WHERE outcome <> 'error';

-- Camino de diagnóstico: reconstruir un fan-out entero (qué hizo cada proveedor en ESA
-- búsqueda) es la consulta que se hace cuando un vendedor reporta "me faltaban vuelos".
CREATE INDEX idx_search_logs_group ON search_logs(search_group_id)
  WHERE search_group_id IS NOT NULL;

-- N búsquedas × M proveedores tienen que dar N, no N×M. `COALESCE(search_group_id, id)`
-- hace que las filas anteriores a la columna sigan contando 1 cada una: sin el COALESCE,
-- COUNT(DISTINCT search_group_id) las descartaría a todas y la cuota de un tenant activo
-- se reiniciaría sola en el momento del deploy.
CREATE OR REPLACE FUNCTION count_recent_searches(p_tenant_id UUID, p_minutes INTEGER)
RETURNS integer
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT COALESCE(search_group_id, id))::int
  FROM search_logs
  WHERE tenant_id = p_tenant_id
    AND outcome <> 'error'
    AND occurred_at > now() - make_interval(mins => p_minutes);
$$;

COMMENT ON FUNCTION count_recent_searches(UUID, INTEGER) IS
  'Búsquedas facturables del tenant en la ventana dada, contadas por grupo: un fan-out a M proveedores es UNA búsqueda. SECURITY DEFINER: la cuota se comprueba antes de resolver el contexto de lectura. Ver db/migrations/0035.';

GRANT EXECUTE ON FUNCTION count_recent_searches(UUID, INTEGER) TO app_user;

-- ============================================================================
-- 3. provider_catalog — catálogo de plataforma
-- ============================================================================
-- Hoy la lista de proveedores está repartida en literales: el mapa de formularios del panel
-- de red, el `verticalMap` de reportes (que nombra proveedores que no existen), y un
-- `PROVIDER_CODE` por factory. Sumar un proveedor obliga a encontrarlos todos, y el que se
-- olvida no da error: da una etiqueta equivocada o una vertical inventada.
--
-- Es catálogo de PLATAFORMA, no de tenant: la misma lista para todas las agencias. Lo que
-- cambia por tenant es qué credenciales tiene cargadas, y eso ya vive en provider_accounts
-- (0012) con su propia RLS. Por eso esta tabla no lleva tenant_id ni política de
-- aislamiento — no hay nada que aislar— y en cambio se le quita a la app el permiso de
-- escritura: el catálogo se cambia con una migración, no con un INSERT desde un endpoint.
CREATE TABLE provider_catalog (
  code                TEXT         PRIMARY KEY,
  vertical            TEXT         NOT NULL
                                   CHECK (vertical IN ('flights', 'hotels', 'cars',
                                                       'assistance', 'messaging')),
  label               TEXT         NOT NULL,
  -- 'available' = conectable hoy; 'beta' = conectable con aviso; 'deprecated' = las cuentas
  -- existentes siguen operando pero no se admiten nuevas; 'disabled' = kill-switch.
  status              TEXT         NOT NULL DEFAULT 'available'
                                   CHECK (status IN ('available', 'beta', 'deprecated', 'disabled')),
  -- Espejo de CallPolicy en apps/api/src/providers/provider.types.ts. Es el default del
  -- catálogo; el gobierno por tenant vive en el registry.
  default_call_policy TEXT         NOT NULL DEFAULT 'always'
                                   CHECK (default_call_policy IN ('always', 'fallback', 'opt-in')),
  -- Espejo de ProviderCapabilities. Gatea la post-venta por capacidad y no por
  -- `if (provider === '<uno concreto>')`.
  capabilities        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_provider_catalog_vertical ON provider_catalog(vertical, status);

CREATE TRIGGER provider_catalog_set_updated_at
  BEFORE UPDATE ON provider_catalog FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE provider_catalog IS
  'Catálogo de plataforma: qué proveedores existen, de qué vertical y qué saben hacer. Sin tenant_id: la misma lista para todas las agencias. Ver db/migrations/0035.';
COMMENT ON COLUMN provider_catalog.capabilities IS
  'Capacidades declaradas (retrieve, cancel, pay, services, reshop). Espejo de ProviderCapabilities en el API.';

INSERT INTO provider_catalog (code, vertical, label, status, default_call_policy, capabilities) VALUES
  ('latam-ndc', 'flights', 'LATAM NDC', 'available', 'always',
   '{"retrieve":true,"cancel":true,"pay":true,"services":true,"reshop":true}'::jsonb),
  ('agent-cars', 'cars', 'AgentCars', 'available', 'always',
   '{"retrieve":false,"cancel":false,"pay":false,"services":false,"reshop":false}'::jsonb),
  ('despegar-hotels', 'hotels', 'Despegar Hoteles', 'available', 'always',
   '{"retrieve":false,"cancel":false,"pay":false,"services":false,"reshop":false}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Sin FK desde provider_accounts.provider_code, a propósito: hay cuentas cargadas con
-- códigos que no son proveedores de viaje (el correo saliente usa 'email') y la migración
-- se caería al aplicarla sobre datos reales. La integridad referencial se añade cuando el
-- catálogo cubra el 100 % de los códigos en uso, no antes.

GRANT SELECT ON provider_catalog TO app_user;
REVOKE INSERT, UPDATE, DELETE ON provider_catalog FROM app_user;

-- ============================================================================
-- 4. package_items.provider_item_id: VARCHAR(200) → TEXT   [decisión D8]
-- ============================================================================
-- El identificador de oferta de un proveedor de vuelos no tiene longitud acotada por
-- contrato: hay GDS que devuelven referencias opacas de más de 200 caracteres. Con el
-- VARCHAR(200) de 0010, el síntoma no es un error de validación entendible sino
-- "el vuelo de ese proveedor no se puede agregar al paquete", intermitente y sólo para
-- algunas tarifas.
--
-- Se hace HOY porque hoy es un ALTER que Postgres 16 resuelve sin reescribir la tabla
-- (varchar(n) → text es binario-compatible y sólo elimina una restricción de longitud).
-- Después es una migración sobre datos de producción.
ALTER TABLE package_items ALTER COLUMN provider_item_id TYPE TEXT;

COMMENT ON COLUMN package_items.provider_item_id IS
  'Referencia de la oferta en el proveedor. TEXT sin límite: los identificadores de oferta de los GDS no tienen longitud acotada por contrato. Ver db/migrations/0035.';
