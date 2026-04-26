-- 0001_init.sql
-- Schema inicial: tenants, users, memberships + RLS forzada por tenant.
-- El rol `app_user` debe existir antes de aplicar esta migración (lo crea el migrator).

-- ============================================================================
-- Tenants
-- ============================================================================
CREATE TABLE tenants (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug              CITEXT       NOT NULL UNIQUE,
  name              TEXT         NOT NULL,
  country_code      CHAR(2)      NOT NULL,
  default_currency  CHAR(3)      NOT NULL,
  default_language  TEXT         NOT NULL DEFAULT 'es' CHECK (default_language IN ('es', 'pt', 'en')),
  status            TEXT         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_status ON tenants(status) WHERE status = 'active';

COMMENT ON TABLE tenants IS 'Agencias/marcas white-label. Tabla raíz del aislamiento multi-tenant.';

-- ============================================================================
-- Users (globales, pueden pertenecer a múltiples tenants)
-- ============================================================================
CREATE TABLE users (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          CITEXT       NOT NULL UNIQUE,
  password_hash  TEXT,
  name           TEXT,
  status         TEXT         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  email_verified_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE users IS 'Identidad global. Cross-tenant por diseño (un usuario puede ser admin en T1 y vendedor en T2).';

-- ============================================================================
-- Memberships (relación N:M user ↔ tenant con rol)
-- ============================================================================
CREATE TABLE memberships (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT         NOT NULL CHECK (role IN ('superadmin', 'tenant_admin', 'admin', 'vendedor', 'cliente_final')),
  status      TEXT         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'invited')),
  invited_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);
CREATE INDEX idx_memberships_user   ON memberships(user_id);

-- ============================================================================
-- updated_at trigger genérico
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_set_updated_at     BEFORE UPDATE ON tenants     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at       BEFORE UPDATE ON users       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- RLS — política central: filtrar por current_setting('app.current_tenant_id')
-- ============================================================================
-- Tablas con tenant_id: aplicar RLS forzada. El owner debe respetar las
-- policies (FORCE) y app_user no es superuser, así que las cumple por default.

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;

CREATE POLICY memberships_tenant_isolation ON memberships
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

-- tenants y users son cross-tenant por diseño: NO RLS aquí.
-- El acceso se controla a nivel aplicación (sólo superadmin lista tenants;
-- usuarios sólo ven tenants donde tienen membership activa).

-- ============================================================================
-- Grants para app_user (rol de runtime de apps/api)
-- ============================================================================
GRANT USAGE  ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, memberships TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Default privileges para tablas/secuencias futuras creadas por el owner
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
