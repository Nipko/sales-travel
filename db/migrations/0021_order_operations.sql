-- 0021_order_operations.sql
-- Post-venta durable: registra cada operación sobre una orden (cancelar/void, pagar/emitir,
-- reemisión/reshop, consultar) con su resultado, para trazabilidad y reintento. Es la base de
-- la "cola de pendientes" (el worker durable Temporal/BullMQ se suma como evolución).
-- Ver docs/platform/12 — Fase 1 (post-venta).

CREATE TABLE order_operations (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    UUID         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type        TEXT         NOT NULL,   -- 'cancel','pay','reshop','retrieve',...
  status      TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  attempts    INT          NOT NULL DEFAULT 1,
  last_error  TEXT,
  result      JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- resumen NO sensible del resultado (sin PAN/secretos)
  actor_user_id UUID       REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_operations_order ON order_operations(order_id, created_at DESC);

COMMENT ON TABLE order_operations IS 'Historial durable de operaciones de post-venta por orden (cancelar/pagar/reemitir/consultar). result NUNCA debe contener PAN/CVV/secretos.';

CREATE TRIGGER order_operations_set_updated_at
  BEFORE UPDATE ON order_operations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS forzada por tenant (mismo patrón que orders).
ALTER TABLE order_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_operations FORCE  ROW LEVEL SECURITY;

CREATE POLICY order_operations_tenant_isolation ON order_operations
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));
