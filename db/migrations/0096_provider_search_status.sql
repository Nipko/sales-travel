-- 0096_provider_search_status.sql
-- El estado de los proveedores, para la agencia (founder 2026-11-12): un indicador pequeño que dice
-- si un proveedor está fallando y si eso depende de él o de nosotros.
--
-- A diferencia de admin_provider_search_health (0095), esto lo lee CUALQUIER usuario de la agencia,
-- así que devuelve sólo agregados de TODA la red (nunca cifras de otra agencia) y sólo de los
-- proveedores que esta agencia usó en la última semana: una agencia sin LATAM no ve LATAM.
--
-- Los errores se separan por origen: los del proveedor (ProviderCallError, AllFlightProvidersFailed,
-- CurrencyMismatch es configuración de moneda) y los demás, que son nuestros (un TypeError, una
-- consulta que falló). Así la pantalla puede decir «no depende de nosotros» con fundamento.
--
-- search_path = pg_catalog, public, pg_temp (posterior a 0060: ver
-- apps/api/src/database/migrations-search-path.test.ts).

CREATE OR REPLACE FUNCTION provider_search_status(p_tenant_id UUID, p_recent TIMESTAMPTZ)
RETURNS TABLE (
  provider_code      TEXT,
  vertical           TEXT,
  recent_searches    BIGINT,
  recent_with_results BIGINT,
  provider_errors    BIGINT,
  internal_errors    BIGINT,
  last_result_at     TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH usados AS (
    SELECT DISTINCT u.provider_code, u.vertical
      FROM public.search_logs u
     WHERE u.tenant_id = p_tenant_id
       AND u.occurred_at > now() - interval '7 days'
       AND u.provider_code <> 'none'
  )
  SELECT x.provider_code,
         x.vertical,
         count(l.*)                                                        AS recent_searches,
         count(l.*) FILTER (WHERE l.outcome = 'ok' AND l.result_count > 0) AS recent_with_results,
         count(l.*) FILTER (WHERE l.outcome = 'error'
                              AND l.error_code IN ('ProviderCallError',
                                                   'AllFlightProvidersFailedError',
                                                   'CurrencyMismatch'))   AS provider_errors,
         count(l.*) FILTER (WHERE l.outcome = 'error'
                              AND (l.error_code IS NULL OR l.error_code NOT IN (
                                     'ProviderCallError',
                                     'AllFlightProvidersFailedError',
                                     'CurrencyMismatch')))                AS internal_errors,
         (SELECT max(o.occurred_at)
            FROM public.search_logs o
           WHERE o.provider_code = x.provider_code
             AND o.vertical = x.vertical
             AND o.outcome = 'ok' AND o.result_count > 0)                  AS last_result_at
    FROM usados x
    LEFT JOIN public.search_logs l
      ON l.provider_code = x.provider_code
     AND l.vertical = x.vertical
     AND l.occurred_at >= p_recent
   GROUP BY x.provider_code, x.vertical
$$;

COMMENT ON FUNCTION provider_search_status(uuid, timestamptz) IS
  'Para la agencia: de los proveedores que usó en 7 días, cómo respondieron a TODA la red desde p_recent (sólo agregados), con los errores separados en del proveedor y nuestros. Ver db/migrations/0096.';

REVOKE ALL ON FUNCTION provider_search_status(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider_search_status(uuid, timestamptz) TO app_user;
