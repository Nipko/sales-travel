-- 0007_tenant_business_rules.sql
-- Reglas de negocio para agencias B2B: Crédito, markups y métodos de pago.

ALTER TABLE tenants
  ADD COLUMN credit_limit       NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN credit_balance     NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN markup_percent     NUMERIC(5,2)  NOT NULL DEFAULT 0.00,
  ADD COLUMN fee_fixed          NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN payment_methods    TEXT[]        NOT NULL DEFAULT '{credit_card}';

COMMENT ON COLUMN tenants.credit_limit    IS 'Límite máximo de crédito otorgado a la agencia. 0 = Sin crédito.';
COMMENT ON COLUMN tenants.credit_balance  IS 'Saldo actual de la agencia (positivo = a favor, negativo = deuda).';
COMMENT ON COLUMN tenants.markup_percent  IS 'Porcentaje de markup a aplicar sobre la tarifa neta (ej. 5.00 para 5%).';
COMMENT ON COLUMN tenants.fee_fixed       IS 'Fee fijo a aplicar por cada boleto emitido (en la moneda por defecto del tenant).';
COMMENT ON COLUMN tenants.payment_methods IS 'Métodos de pago habilitados (credit_card, credit_line, etc.).';
