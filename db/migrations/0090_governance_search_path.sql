-- 0090_governance_search_path.sql
-- Las dos funciones SECURITY DEFINER de 0089 fijan `search_path = public` y la regla de la base
-- (desde 0060, migrations-search-path.test.ts) es que todo search_path fijado termine en pg_temp:
-- sin eso, un objeto temporal con el nombre de una tabla podría colarse delante en la resolución.
-- 0089 ya está aplicada en producción, así que se corrige aquí sin tocar su cuerpo.

ALTER FUNCTION governance_bootstrap(TEXT, JSONB, JSONB) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION governance_chain(UUID) SET search_path = pg_catalog, public, pg_temp;
