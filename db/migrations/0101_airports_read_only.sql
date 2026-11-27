-- 0101_airports_read_only.sql
-- (QA-H-45; plan de pruebas TRV-07)
--
-- `airports` es catálogo de plataforma: lo escribe sólo el sync (tools/sync-airports), que corre como
-- `postgres` (.github/workflows/sync-airports.yml). El `GRANT SELECT` de 0003 no la dejó en sólo
-- lectura: 0001 da por defecto SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva (`ALTER
-- DEFAULT PRIVILEGES`) y ese GRANT no quitó nada. Hoy la API podría borrar o reescribir aeropuertos
-- aunque ningún código suyo lo haga, y la tabla no tiene RLS. El mismo REVOKE que 0035 y 0041
-- aplicaron a los catálogos de proveedores y de hoteles.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON airports FROM app_user;
