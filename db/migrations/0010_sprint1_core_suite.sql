-- 0010_sprint1_core_suite.sql
-- Módulo Core B2B Business Suite: Clientes (CRM), Carteras y Créditos, Reglas de Markup y Paquetes Dinámicos

-- ==========================================
-- 1. CRM DE CLIENTES Y PASAJEROS
-- ==========================================
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(150),
    phone VARCHAR(50),
    document_type VARCHAR(20) NOT NULL, -- 'PASAPORTE', 'CC', 'CE', 'DNI'
    document_number VARCHAR(50) NOT NULL,
    document_issuing_country VARCHAR(3) NOT NULL, -- Código ISO de 3 letras
    birthdate DATE NOT NULL,
    gender VARCHAR(10) NOT NULL, -- 'M', 'F', 'O'
    nationality VARCHAR(3) NOT NULL,
    passport_expiry DATE,
    preferences JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_document ON customers(document_type, document_number);

-- ==========================================
-- 2. CARTERAS Y GESTIÓN DE CRÉDITOS B2B
-- ==========================================
CREATE TABLE IF NOT EXISTS agency_portfolios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    credit_limit_minor BIGINT NOT NULL DEFAULT 0, -- Guardado en centavos/unidad menor (ej: $100.00 = 10000)
    balance_minor BIGINT NOT NULL DEFAULT 0,       -- Balance actual (positivo = saldo a favor, negativo = deuda)
    currency VARCHAR(3) NOT NULL DEFAULT 'COP',
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active', 'suspended', 'overlimit'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_tenant_portfolio UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS portfolio_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id UUID NOT NULL REFERENCES agency_portfolios(id) ON DELETE CASCADE,
    amount_minor BIGINT NOT NULL,                  -- Negativo para cargos/compras, positivo para abonos/pagos
    transaction_type VARCHAR(30) NOT NULL,        -- 'BOOKING_CHARGE', 'DEPOSIT_PAYMENT', 'MANUAL_ADJUSTMENT'
    reference_id VARCHAR(100),                     -- ID de la orden o PNR de referencia
    notes TEXT,
    created_by UUID NOT NULL,                      -- ID del usuario que registra el movimiento
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portfolio_tx ON portfolio_transactions(portfolio_id);

-- ==========================================
-- 3. REGLAS DE MARKUP Y COMISIONES
-- ==========================================
CREATE TABLE IF NOT EXISTS markup_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vertical VARCHAR(20) NOT NULL,                 -- 'flights', 'hotels', 'cars', 'assistance'
    rule_type VARCHAR(20) NOT NULL,                -- 'percentage', 'fixed'
    value_minor BIGINT NOT NULL,                   -- Porcentaje multiplicado por 100 (ej: 5% = 500) o valor fijo en centavos
    priority INTEGER NOT NULL DEFAULT 1,
    conditions JSONB DEFAULT '{}'::jsonb,          -- Ej: {"carrier": "LA", "cabin": "business"}
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_markup_rules_tenant ON markup_rules(tenant_id, vertical);

-- ==========================================
-- 4. MOTOR DE PAQUETES (PAQUETES DINÁMICOS)
-- ==========================================
CREATE TABLE IF NOT EXISTS package_quotations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',   -- 'draft', 'sent', 'accepted', 'expired'
    title VARCHAR(200) NOT NULL,
    total_amount_minor BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    global_markup_minor BIGINT DEFAULT 0,
    notes TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS package_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    package_id UUID NOT NULL REFERENCES package_quotations(id) ON DELETE CASCADE,
    vertical VARCHAR(20) NOT NULL,                 -- 'flights', 'hotels', 'cars', 'assistance'
    provider_name VARCHAR(50) NOT NULL,            -- 'latam-ndc', 'hotelbeds', 'assistcard'
    provider_item_id VARCHAR(200) NOT NULL,
    raw_details JSONB NOT NULL,                    -- Guardado del itinerario, tarifas, etc.
    base_fare_minor BIGINT NOT NULL,
    taxes_minor BIGINT NOT NULL,
    markup_minor BIGINT NOT NULL,
    total_minor BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 5. TRIGGERS PARA UPDATED_AT
-- ==========================================
CREATE TRIGGER customers_set_updated_at          BEFORE UPDATE ON customers          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agency_portfolios_set_updated_at   BEFORE UPDATE ON agency_portfolios   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER markup_rules_set_updated_at       BEFORE UPDATE ON markup_rules       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER package_quotations_set_updated_at  BEFORE UPDATE ON package_quotations  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER package_items_set_updated_at       BEFORE UPDATE ON package_items       FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==========================================
-- 6. ROW-LEVEL SECURITY (RLS) POLICIES
-- ==========================================
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_tenant_isolation ON customers
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

ALTER TABLE agency_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_portfolios FORCE ROW LEVEL SECURITY;

CREATE POLICY agency_portfolios_tenant_isolation ON agency_portfolios
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

ALTER TABLE portfolio_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_transactions FORCE ROW LEVEL SECURITY;

CREATE POLICY portfolio_transactions_tenant_isolation ON portfolio_transactions
  USING (EXISTS (
    SELECT 1 FROM agency_portfolios p
    WHERE p.id = portfolio_id AND p.tenant_id::text = current_setting('app.current_tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agency_portfolios p
    WHERE p.id = portfolio_id AND p.tenant_id::text = current_setting('app.current_tenant_id', true)
  ));

ALTER TABLE markup_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE markup_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY markup_rules_tenant_isolation ON markup_rules
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

ALTER TABLE package_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_quotations FORCE ROW LEVEL SECURITY;

CREATE POLICY package_quotations_tenant_isolation ON package_quotations
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

ALTER TABLE package_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_items FORCE ROW LEVEL SECURITY;

CREATE POLICY package_items_tenant_isolation ON package_items
  USING (EXISTS (
    SELECT 1 FROM package_quotations q
    WHERE q.id = package_id AND q.tenant_id::text = current_setting('app.current_tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM package_quotations q
    WHERE q.id = package_id AND q.tenant_id::text = current_setting('app.current_tenant_id', true)
  ));
