-- 0004_quotations.sql
-- Tabla de cotizaciones: snapshot de una oferta seleccionada por un agente.

CREATE TABLE quotations (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT         NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'expired', 'cancelled')),

  -- Datos de búsqueda original
  search_criteria JSONB        NOT NULL,

  -- Snapshot de la oferta seleccionada
  selected_offer  JSONB        NOT NULL,

  -- Cliente destinatario (opcional)
  customer_name   TEXT,
  customer_email  TEXT,
  customer_phone  TEXT,

  -- Notas del agente
  notes           TEXT,

  -- Referencia secuencial por tenant (para mostrar al usuario)
  quote_number    INT          NOT NULL,

  expires_at      TIMESTAMPTZ  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_quotations_tenant   ON quotations(tenant_id);
CREATE INDEX idx_quotations_user     ON quotations(user_id);
CREATE INDEX idx_quotations_status   ON quotations(status) WHERE status IN ('draft', 'sent');
CREATE INDEX idx_quotations_expires  ON quotations(expires_at) WHERE status NOT IN ('expired', 'cancelled');

-- Secuencia por tenant para quote_number
CREATE SEQUENCE quotations_number_seq;

-- RLS
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations FORCE ROW LEVEL SECURITY;

CREATE POLICY quotations_tenant_isolation ON quotations
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Trigger updated_at
CREATE TRIGGER set_updated_at_quotations
  BEFORE UPDATE ON quotations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE quotations IS 'Cotizaciones guardadas por agentes. Cada una es un snapshot de una oferta de vuelo con datos del cliente.';
