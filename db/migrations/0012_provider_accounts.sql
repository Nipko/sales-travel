-- 0012_provider_accounts.sql
-- BYOC (Bring Your Own Credentials): credenciales de proveedor por tenant, con
-- HERENCIA por el path jerárquico. Una agencia usa sus propias credenciales o,
-- si no tiene, hereda las de su consolidador (ancestro más cercano heredable).
-- Ver docs/platform/12-modelo-consolidador-y-plan.md §3.2.

CREATE TABLE provider_accounts (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code   TEXT         NOT NULL,                       -- 'latam-ndc','amadeus','hotelbeds','stripe'...
  label           TEXT         NOT NULL DEFAULT 'default',
  credentials_enc BYTEA        NOT NULL,                       -- AES-256-GCM (cifrado en la app). NUNCA loguear ni exponer.
  config          JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- no-secreto: PCC/pseudo-city, IATA, endpoints, country...
  is_inheritable  BOOLEAN      NOT NULL DEFAULT true,          -- ¿pueden los descendientes resolver esta cuenta?
  status          TEXT         NOT NULL DEFAULT 'sandbox' CHECK (status IN ('active', 'sandbox', 'disabled')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_code, label)
);

CREATE INDEX idx_provider_accounts_tenant ON provider_accounts(tenant_id);
CREATE INDEX idx_provider_accounts_lookup ON provider_accounts(provider_code, status);

COMMENT ON TABLE  provider_accounts                 IS 'BYOC: credenciales de proveedor por tenant. credentials_enc cifrado AES-256-GCM. El secreto sólo se descifra server-side; nunca se devuelve por API.';
COMMENT ON COLUMN provider_accounts.is_inheritable  IS 'Si un tenant descendiente puede resolver/heredar esta cuenta cuando no tiene una propia.';
COMMENT ON COLUMN provider_accounts.config          IS 'Configuración NO secreta (PCC/pseudo-city define tarifas privadas visibles, IATA, country, endpoints).';

CREATE TRIGGER provider_accounts_set_updated_at
  BEFORE UPDATE ON provider_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
-- Aislamiento para `app_user` (NOBYPASSRLS): una agencia sólo ve/gestiona SUS
-- propias provider_accounts (igualdad de tenant). NUNCA ve las de un ancestro
-- por query directa (evita filtrar el secreto del consolidador al hijo).
--
-- IMPORTANTE: aquí se usa ENABLE pero NO FORCE ROW LEVEL SECURITY (a diferencia
-- del resto de tablas). Es deliberado: la HERENCIA requiere leer hacia ARRIBA del
-- árbol (filas de OTROS tenants), lo que se hace SÓLO vía la función
-- `resolve_provider_account` (SECURITY DEFINER, corre como owner). Sin FORCE, el
-- owner no está sujeto a la policy, así la función puede resolver ancestros; la app
-- (app_user) sigue 100% aislada. El secreto sólo sale por esa ruta controlada y
-- jamás se expone en respuestas de API.
ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_accounts_tenant_isolation ON provider_accounts
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- Resolución BYOC con herencia por el path.
-- Devuelve la cuenta a usar para (tenant, provider):
--   1) la propia del tenant si existe y está 'active'; si no
--   2) la del ancestro más cercano con is_inheritable = true y 'active'.
-- ORDER BY nlevel(path) DESC ⇒ la propia (path más profundo) gana, luego el
-- ancestro más cercano. SECURITY DEFINER para poder leer filas de ancestros.
-- ============================================================================
CREATE OR REPLACE FUNCTION resolve_provider_account(p_tenant_id UUID, p_provider_code TEXT)
RETURNS provider_accounts
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  WITH me AS (SELECT path FROM tenants WHERE id = p_tenant_id)
  SELECT pa.*
  FROM provider_accounts pa
  JOIN tenants t ON t.id = pa.tenant_id
  CROSS JOIN me
  WHERE pa.provider_code = p_provider_code
    AND pa.status = 'active'
    AND (
      pa.tenant_id = p_tenant_id                          -- cuenta propia
      OR (t.path @> me.path AND pa.is_inheritable = TRUE) -- ancestro heredable (t.path ancestro de me.path)
    )
  ORDER BY nlevel(t.path) DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION resolve_provider_account(UUID, TEXT) TO app_user;
