-- 0033_tenant_custom_domain.sql
-- Dominio propio por agencia.
--
-- La pestaña "Dominio" del panel era un mockup muerto: no existía columna donde guardar
-- el host, ni resolución de tenant por hostname en ningún lado. Sin eso, un white-label
-- no es tal — todas las agencias entran por el mismo dominio del consolidador, y el
-- cliente final de una agencia minorista ve la marca de PlaneTour en la barra del navegador.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS custom_domain TEXT,
  ADD COLUMN IF NOT EXISTS custom_domain_verified_at TIMESTAMPTZ;

-- Un host sólo puede apuntar a UN tenant: sin esto, dos agencias podrían reclamar el
-- mismo dominio y la resolución sería no determinista (y un vector de suplantación).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_custom_domain
  ON tenants(lower(custom_domain))
  WHERE custom_domain IS NOT NULL;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_custom_domain_format
  CHECK (custom_domain IS NULL OR custom_domain ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$');

COMMENT ON COLUMN tenants.custom_domain IS
  'Host propio de la agencia (ej. viajes.miagencia.com). En minúsculas, sin protocolo ni puerto.';
COMMENT ON COLUMN tenants.custom_domain_verified_at IS
  'Cuándo se comprobó que el DNS apunta acá. Un dominio SIN verificar no resuelve: si no, cualquiera podría reclamar un host ajeno y servir su marca bajo él.';

-- ============================================================================
-- Resolución por hostname
-- ============================================================================
-- SECURITY DEFINER: corre ANTES de que haya contexto de tenant —es justamente lo que
-- está resolviendo—, así que no puede depender de la RLS. Devuelve sólo el id, y sólo
-- para dominios verificados y tenants activos.
CREATE OR REPLACE FUNCTION resolve_tenant_by_host(p_host TEXT)
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT t.id
  FROM tenants t
  WHERE lower(t.custom_domain) = lower(p_host)
    AND t.custom_domain_verified_at IS NOT NULL
    AND t.status = 'active'
  LIMIT 1;
$$;

COMMENT ON FUNCTION resolve_tenant_by_host(TEXT) IS
  'Tenant dueño de un host propio VERIFICADO. Ver db/migrations/0033.';

GRANT EXECUTE ON FUNCTION resolve_tenant_by_host(TEXT) TO app_user;
