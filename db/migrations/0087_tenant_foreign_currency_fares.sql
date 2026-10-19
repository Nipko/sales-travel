-- 0087_tenant_foreign_currency_fares.sql
-- Tarifas en otra moneda, habilitadas por el superadmin para pruebas.
--
-- La búsqueda de vuelos descarta las tarifas que vuelven en una moneda distinta de la de la agencia
-- (search.service.ts, splitByCurrency): mezclar BRL con COP en la misma lista hace que el vendedor
-- cotice la equivocada. Es lo correcto en venta, pero deja sin probar de punta a punta un proveedor
-- cuyo punto de venta todavía cotiza en otra moneda (LATAM NDC devuelve BRL a una agencia en COP).
--
-- Con la columna en true la puerta no descarta: las tarifas se muestran en su moneda, se revalidan
-- y se reservan en ella, y del markup se aplican sólo los porcentajes (un markup fijo está escrito
-- en la moneda de la agencia). Por nodo y sin herencia: se enciende en la agencia de pruebas, no en
-- toda una red. Sólo lo cambia el superadmin (PATCH /admin/tenants/:id/foreign-currency-fares), con
-- rastro en domain_events (tenant.foreign_currency_fares.updated).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS foreign_currency_fares BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.foreign_currency_fares IS
  'Mostrar y vender tarifas de vuelo en otra moneda que default_currency, sin convertir. Para pruebas; false por defecto. Sólo lo fija el superadmin. Ver db/migrations/0087.';
