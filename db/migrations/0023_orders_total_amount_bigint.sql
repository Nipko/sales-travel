-- 0023_orders_total_amount_bigint.sql
-- orders.total_amount era INTEGER (INT4, máx 2.147.483.647 en minor units). Los precios en monedas
-- de alto nominal (COP) desbordan: 25.000.000 COP = 2.500.000.000 minor > INT4 max. Las reservas de
-- autos en COP no se podían persistir (el INSERT lanzaba 'integer out of range'). Se migra a BIGINT.
ALTER TABLE orders ALTER COLUMN total_amount TYPE BIGINT;
