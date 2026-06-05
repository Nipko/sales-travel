-- 0018_customers_pii_encryption.sql
-- Cifrado de PII de clientes: el número de documento deja de guardarse en claro.
-- document_number_enc = AES-256-GCM (cifrado en la app). document_number_hash = blind index
-- (HMAC) para búsqueda/dedup por igualdad. La columna plana document_number pasa a nullable;
-- la app deja de escribirla (NULL en filas nuevas) y sólo la lee como fallback de filas legacy.
-- Backfill de filas existentes: requiere la clave (vive en la app), se corre con un script aparte.
-- Ver docs/platform/12 §6 (Tier 3 seguridad).

ALTER TABLE customers
  ADD COLUMN document_number_enc  BYTEA,
  ADD COLUMN document_number_hash TEXT,
  ALTER COLUMN document_number DROP NOT NULL;

-- El índice de búsqueda pasa del valor en claro al blind index.
DROP INDEX IF EXISTS idx_customers_document;
CREATE INDEX idx_customers_document_hash ON customers(document_type, document_number_hash);

COMMENT ON COLUMN customers.document_number_enc  IS 'Número de documento cifrado (AES-256-GCM). NUNCA loguear ni exponer el blob.';
COMMENT ON COLUMN customers.document_number_hash IS 'Blind index (HMAC) del número de documento para lookup/dedup por igualdad.';
COMMENT ON COLUMN customers.document_number      IS 'DEPRECADO: sólo filas legacy; las nuevas guardan el documento cifrado en document_number_enc.';
