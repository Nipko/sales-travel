-- Orders: PNRs created via NDC OrderCreate
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  quotation_id    UUID REFERENCES quotations(id),

  -- LATAM NDC order reference
  provider        TEXT NOT NULL DEFAULT 'latam-ndc',
  provider_order_id TEXT,          -- PNR / OrderID from LATAM

  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending -> confirmed -> ticketed -> cancelled / failed

  -- Snapshots (JSONB)
  search_criteria JSONB NOT NULL,
  selected_offer  JSONB NOT NULL,
  passengers      JSONB NOT NULL,  -- array of passenger objects
  contact_info    JSONB NOT NULL,  -- email + phone for the booking

  -- Money
  total_amount    INTEGER NOT NULL,  -- minor units
  currency        TEXT NOT NULL DEFAULT 'USD',

  -- Metadata
  order_number    INTEGER NOT NULL,
  provider_raw    JSONB,             -- raw response from provider (for debugging)
  error_message   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_orders_tenant  ON orders(tenant_id);
CREATE INDEX idx_orders_user    ON orders(user_id, tenant_id);
CREATE INDEX idx_orders_status  ON orders(status) WHERE status IN ('pending', 'confirmed');
CREATE INDEX idx_orders_pnr     ON orders(provider_order_id) WHERE provider_order_id IS NOT NULL;

-- RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_tenant_isolation ON orders
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Auto-update updated_at
CREATE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE orders IS 'Flight bookings created via NDC OrderCreate. Stores PNR and passenger data.';
