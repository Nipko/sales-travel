-- 0048_provider_enablement.sql
-- ¿Qué proveedores puede usar cada tenant? Lo decide el superadmin, sin redesplegar.
--
-- Hasta ahora un proveedor `opt-in` se encendía con `FLIGHT_PROVIDERS_OPT_IN` /
-- `HOTEL_PROVIDERS_OPT_IN` y un proveedor `always` no se podía apagar para una sola agencia: la única
-- palanca era `PROVIDERS_DISABLED`, que apaga para toda la plataforma. Encender TBO para un
-- consolidador nuevo o cortar Sabre a una agencia que no paga exigía editar el entorno y desplegar.
--
-- Esta tabla guarda los ajustes del superadmin por proveedor:
--
--   - GLOBAL (`tenant_id IS NULL`): encendido o apagado para todos los tenants.
--   - por TENANT: encendido o apagado para ese tenant Y su red. El ajuste más cercano en la cadena
--     del árbol gana: encender a un consolidador cubre a sus agencias, y una agencia puntual se
--     puede apagar debajo.
--
-- El plegado vive en el API (apps/api/src/provider-enablement/provider-enablement.policy.ts), igual
-- que el de la divulgación de proveedor (0036): kill-switch > tenant más cercano > global > variable
-- legado > política del proveedor. Esta migración sólo guarda los ajustes y lee la cadena.
--
-- Borrar un ajuste es volver a heredar. El rastro de quién puso y quitó qué queda en `domain_events`
-- (la API escribe el evento en la misma transacción que el cambio).

-- ============================================================================
-- 1. Los ajustes
-- ============================================================================
-- Sin FK a `provider_catalog`: el catálogo todavía no tiene a todos los proveedores de los
-- registries (Sabre y TBO no están), y la API ya valida el código contra los registries, que son la
-- lista de lo que corre de verdad.
CREATE TABLE provider_enablement (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code  TEXT         NOT NULL
                              CHECK (provider_code ~ '^[a-z0-9-]{1,64}$'),
  -- NULL = ajuste GLOBAL. Si el tenant se borra, sus ajustes se van con él.
  tenant_id      UUID         REFERENCES tenants(id) ON DELETE CASCADE,
  enabled        BOOLEAN      NOT NULL,
  -- Motivo opcional, para quien lo lea después en el panel o en la auditoría. Nunca PII.
  reason         TEXT         CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  -- Quién lo puso por última vez. NULL si fue un proceso (el seed del stack de certificación) o si
  -- el usuario se borró: el nombre sigue en `domain_events`.
  updated_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Un solo ajuste global por proveedor y uno por (proveedor, tenant). Dos índices parciales y no un
-- UNIQUE con NULL: dos filas globales del mismo proveedor dejarían el estado a merced del orden.
CREATE UNIQUE INDEX uq_provider_enablement_global
  ON provider_enablement (provider_code)
  WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX uq_provider_enablement_tenant
  ON provider_enablement (provider_code, tenant_id)
  WHERE tenant_id IS NOT NULL;

-- La cadena de un tenant se lee por tenant; el borrado en cascada también.
CREATE INDEX idx_provider_enablement_tenant
  ON provider_enablement (tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE TRIGGER provider_enablement_set_updated_at
  BEFORE UPDATE ON provider_enablement FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE provider_enablement IS
  'Ajustes del superadmin sobre qué proveedores puede usar cada tenant: GLOBAL (tenant_id NULL) o por tenant y su red (el más cercano en la cadena gana). Configuración de plataforma: la lee el servidor sin RLS de tenant y sólo la escribe un superadmin. Ver db/migrations/0048.';
COMMENT ON COLUMN provider_enablement.tenant_id IS
  'NULL = ajuste para todos los tenants. Con valor, vale para ese tenant y sus descendientes que no tengan un ajuste propio más cercano.';

-- ============================================================================
-- 2. Quién escribe: sólo el superadmin
-- ============================================================================
-- Espejo de NetworkService.isSuperadmin(): una membership ACTIVA con rol `superadmin` en cualquier
-- nodo (0025 garantiza que sólo cuelgan del tenant de plataforma). `platform_admin` NO, como en el
-- resto del panel de plataforma (`/admin/tenants`): apagar un proveedor a una red entera es una
-- decisión del dueño de la plataforma.
--
-- SECURITY DEFINER (owner = postgres) por el mismo motivo que can_read_membership() (0020):
-- consultar memberships desde una policy sin re-disparar su propia RLS.
CREATE FUNCTION can_manage_provider_enablement() RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships m
    WHERE m.user_id::text = current_setting('app.current_user_id', true)
      AND m.status = 'active'
      AND m.role = 'superadmin'
  );
$$;

COMMENT ON FUNCTION can_manage_provider_enablement() IS
  '¿El usuario de app.current_user_id es superadmin (membership activa con rol superadmin)? Gobierna la escritura de provider_enablement. Ver db/migrations/0048.';

REVOKE ALL ON FUNCTION can_manage_provider_enablement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION can_manage_provider_enablement() TO app_user;

ALTER TABLE provider_enablement ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_enablement FORCE  ROW LEVEL SECURITY;

-- Lectura abierta: la resuelve el servidor en cada búsqueda, casi siempre sin usuario en el
-- contexto (jobs, búsquedas cacheadas), y no hay nada de un tenant que aislar. Lo que protege
-- esta tabla es quién la ESCRIBE.
CREATE POLICY provider_enablement_read ON provider_enablement
  FOR SELECT
  USING (true);

CREATE POLICY provider_enablement_superadmin_insert ON provider_enablement
  FOR INSERT
  WITH CHECK (can_manage_provider_enablement());

CREATE POLICY provider_enablement_superadmin_update ON provider_enablement
  FOR UPDATE
  USING (can_manage_provider_enablement())
  WITH CHECK (can_manage_provider_enablement());

CREATE POLICY provider_enablement_superadmin_delete ON provider_enablement
  FOR DELETE
  USING (can_manage_provider_enablement());

-- Las default privileges de 0001 dan SELECT, INSERT, UPDATE y DELETE. Se deja lo justo, explícito:
-- la app escribe (quitar un ajuste es un DELETE), pero sólo por las policies de arriba.
REVOKE ALL ON provider_enablement FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_enablement TO app_user;

-- ============================================================================
-- 3. La cadena de un tenant
-- ============================================================================
-- Los ajustes que pueden decidir para `p_tenant_id`: los de su cadena de ancestros (él incluido),
-- con la profundidad de cada nodo, y los globales con `lvl = 0`. Devuelve los valores CRUDOS: el
-- plegado vive en el API, como en `provider_disclosure_chain` (0036), para poder probar la regla
-- con tests y sin base.
--
-- SECURITY DEFINER como provider_disclosure_chain (0036): hace falta leer los nodos ANCESTROS del
-- tenant, y quien llama no tiene por qué verlos.
--
-- Sin filtro por `status` del tenant: un consolidador suspendido sigue siendo el nodo que decidió
-- para su red; sacarlo de la cadena cambiaría en silencio lo que ven sus agencias.
CREATE FUNCTION provider_enablement_chain(p_tenant_id UUID)
RETURNS TABLE (
  provider_code TEXT,
  tenant_id     UUID,
  lvl           INTEGER,
  enabled       BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  WITH me AS (SELECT path FROM tenants WHERE id = p_tenant_id)
  SELECT s.provider_code, s.tenant_id, nlevel(t.path)::int, s.enabled
  FROM provider_enablement s
  JOIN tenants t ON t.id = s.tenant_id
  CROSS JOIN me
  WHERE t.path OPERATOR(public.@>) me.path   -- ancestros de p_tenant_id, él incluido
  UNION ALL
  SELECT s.provider_code, NULL::uuid, 0, s.enabled
  FROM provider_enablement s
  WHERE s.tenant_id IS NULL
  ORDER BY 1, 3 DESC;
$$;

COMMENT ON FUNCTION provider_enablement_chain(UUID) IS
  'Ajustes de provider_enablement que pueden decidir para el tenant: los de su cadena de ancestros (él incluido, con su nlevel) y los globales (lvl 0). El plegado (el más cercano gana; luego el global) vive en el API. Ver db/migrations/0048.';

REVOKE ALL ON FUNCTION provider_enablement_chain(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider_enablement_chain(UUID) TO app_user;
