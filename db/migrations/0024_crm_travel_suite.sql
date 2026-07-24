-- 0024_crm_travel_suite.sql
-- Módulo Travel CRM Conversacional & IA Engine

-- ==========================================
-- 1. EXTENSIÓN DE TABLA CUSTOMERS
-- ==========================================
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS frequent_flyer_program JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS travel_preferences JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::text[];

-- ==========================================
-- 2. ACOMPAÑANTES Y NÚCLEO FAMILIAR
-- ==========================================
CREATE TABLE IF NOT EXISTS customer_passengers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    relationship VARCHAR(30) NOT NULL, -- 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'FRIEND', 'COLLEAGUE'
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    document_type VARCHAR(20) NOT NULL,
    document_number VARCHAR(50) NOT NULL,
    document_issuing_country VARCHAR(3) NOT NULL,
    birthdate DATE NOT NULL,
    gender VARCHAR(10) NOT NULL,
    nationality VARCHAR(3) NOT NULL,
    passport_expiry DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_passengers_customer ON customer_passengers(customer_id);

-- ==========================================
-- 3. BÓVEDA DE DOCUMENTOS DE VIAJE
-- ==========================================
CREATE TABLE IF NOT EXISTS customer_documents_vault (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    document_category VARCHAR(30) NOT NULL, -- 'PASSPORT', 'VISA_USA', 'VISA_SCHENGEN', 'YELLOW_FEVER_VACCINE', 'INSURANCE_POLICY'
    document_number VARCHAR(100),
    issue_date DATE,
    expiry_date DATE,
    file_url TEXT,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_vault_customer ON customer_documents_vault(customer_id);

-- ==========================================
-- 4. KANBAN DE OPORTUNIDADES DE VIAJE
-- ==========================================
CREATE TABLE IF NOT EXISTS crm_opportunities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL indica asignado a Agente IA / Cola General
    stage VARCHAR(40) NOT NULL DEFAULT 'AI_HANDLING',
    -- Stage enums: 'AI_HANDLING', 'LEAD_UNASSIGNED', 'QUALIFIED_LEAD', 'QUOTE_SENT', 'NEGOTIATION', 'BOOKING_CONFIRMED', 'IN_TRAVEL', 'POST_TRAVEL_COMPLETED', 'CLOSED_LOST'
    title VARCHAR(200) NOT NULL,
    estimated_value_minor BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'COP',
    destination_city VARCHAR(100),
    travel_start_date DATE,
    travel_end_date DATE,
    pax_count INTEGER NOT NULL DEFAULT 1,
    package_quotation_id UUID REFERENCES package_quotations(id) ON DELETE SET NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    source_channel VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP', -- 'WHATSAPP', 'WEB_B2B', 'WEB_B2C', 'MANUAL'
    is_ai_controlled BOOLEAN NOT NULL DEFAULT true, -- Permite que el bot de IA opere la conversación hasta handoff humano
    lost_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_tenant ON crm_opportunities(tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_customer ON crm_opportunities(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_assigned ON crm_opportunities(assigned_user_id);

-- ==========================================
-- 5. HISTORIAL OMNICANAL DE INTERACCIONES Y AUDITORÍA DE IA
-- ==========================================
CREATE TABLE IF NOT EXISTS crm_interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    opportunity_id UUID REFERENCES crm_opportunities(id) ON DELETE SET NULL,
    channel VARCHAR(30) NOT NULL, -- 'WHATSAPP', 'VOICE_CALL', 'EMAIL', 'INTERNAL_NOTE', 'AI_SYSTEM_EVENT'
    direction VARCHAR(10) NOT NULL, -- 'INBOUND', 'OUTBOUND', 'INTERNAL'
    summary TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb, -- Almacena WhatsApp MessageId, transcripciones de audio, tokens usados por LLM, etc.
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL si fue generado automáticamente por la IA
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_interactions_tenant ON crm_interactions(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_interactions_opp ON crm_interactions(opportunity_id);

-- ==========================================
-- 6. TRIGGERS DE UPDATED_AT
-- ==========================================
CREATE TRIGGER customer_passengers_set_updated_at      BEFORE UPDATE ON customer_passengers      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_documents_vault_set_updated_at BEFORE UPDATE ON customer_documents_vault FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crm_opportunities_set_updated_at       BEFORE UPDATE ON crm_opportunities       FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==========================================
-- 7. ROW-LEVEL SECURITY (RLS) POLICIES
-- ==========================================
ALTER TABLE customer_passengers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_passengers FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_passengers_tenant_isolation ON customer_passengers
  USING (EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = customer_id AND c.tenant_id::text = current_setting('app.current_tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = customer_id AND c.tenant_id::text = current_setting('app.current_tenant_id', true)
  ));

ALTER TABLE customer_documents_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_documents_vault FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_documents_vault_tenant_isolation ON customer_documents_vault
  USING (EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = customer_id AND c.tenant_id::text = current_setting('app.current_tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = customer_id AND c.tenant_id::text = current_setting('app.current_tenant_id', true)
  ));

ALTER TABLE crm_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_opportunities FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_opportunities_tenant_isolation ON crm_opportunities
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

ALTER TABLE crm_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_interactions FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_interactions_tenant_isolation ON crm_interactions
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));
