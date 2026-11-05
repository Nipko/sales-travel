-- 0091_billing_party_and_company_customers.sql
-- A nombre de quién se factura una cotización, y clientes que son empresa.
--
-- Pedido del founder (2026-11-04): en la cotización van primero los pasajeros, y abajo «a nombre de
-- quién facturar» —el pasajero 1 u otra persona o empresa—, con búsqueda de clientes ya registrados
-- y los datos fiscales que pide la factura electrónica (DIAN). Quien no esté en Clientes se guarda
-- al reservar.
--
-- 1. customers admite empresas: tipo persona/empresa, dirección, ciudad y país. Fecha de nacimiento,
--    género y nacionalidad dejan de ser obligatorios en la base (una empresa no los tiene); para una
--    persona los sigue exigiendo el API.
-- 2. quotations.billing: el facturador de la cotización (JSONB). El número de documento NO va en
--    claro: el API lo guarda cifrado con la misma clave que customers (pii-cipher, AES-256-GCM).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'person'
    CHECK (customer_type IN ('person', 'company')),
  ADD COLUMN IF NOT EXISTS address TEXT CHECK (address IS NULL OR char_length(address) <= 300),
  ADD COLUMN IF NOT EXISTS city TEXT CHECK (city IS NULL OR char_length(city) <= 120),
  ADD COLUMN IF NOT EXISTS country_code TEXT CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

ALTER TABLE customers ALTER COLUMN birthdate DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN gender DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN nationality DROP NOT NULL;

-- Búsqueda por documento (blind index) dentro del tenant: la usa el alta-o-actualización al reservar.
CREATE INDEX IF NOT EXISTS idx_customers_tenant_document_hash
  ON customers (tenant_id, document_type, document_number_hash);

COMMENT ON COLUMN customers.customer_type IS
  'person | company. Una empresa no tiene fecha de nacimiento, género ni nacionalidad. Ver db/migrations/0091.';

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS billing JSONB;

COMMENT ON COLUMN quotations.billing IS
  'A nombre de quién se factura: { mode: passenger|other, customerId?, customerType, name, documentType, documentNumberEnc (base64, cifrado), email, phone, address, city, countryCode }. Ver db/migrations/0091.';
