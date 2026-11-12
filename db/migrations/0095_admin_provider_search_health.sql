-- 0095_admin_provider_search_health.sql
-- Plataforma → Salud: cómo están respondiendo los proveedores a las búsquedas (founder 2026-11-12).
--
-- Desde el 29 oct TBO devolvía «No Available rooms» a TODAS las búsquedas y nadie lo vio: no había
-- ninguna pantalla que mirara search_logs por proveedor. Esta función lo resume para el superadmin:
-- por proveedor y vertical, cuántas búsquedas, cuántas trajeron algo, cuántas vacías y con error,
-- la latencia, y la última vez que trajo resultados. La pantalla marca en rojo al que lleva
-- horas buscando sin traer nada.
--
-- Como admin_reconciliation_health (0075): SECURITY DEFINER y exige platform_console_require_superadmin.
-- Sólo agregados; nunca criterios ni tenants.
--
-- search_path = pg_catalog, public, pg_temp (posterior a 0060: ver
-- apps/api/src/database/migrations-search-path.test.ts).

CREATE OR REPLACE FUNCTION admin_provider_search_health(p_since TIMESTAMPTZ, p_recent TIMESTAMPTZ)
RETURNS TABLE (
  provider_code      TEXT,
  vertical           TEXT,
  searches           BIGINT,
  with_results       BIGINT,
  empty_searches     BIGINT,
  error_searches     BIGINT,
  recent_searches    BIGINT,
  recent_with_results BIGINT,
  avg_duration_ms    BIGINT,
  p95_duration_ms    BIGINT,
  last_search_at     TIMESTAMPTZ,
  last_result_at     TIMESTAMPTZ,
  last_error_code    TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.platform_console_require_superadmin();
  IF p_since IS NULL OR p_recent IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'platform_console_period_invalid',
      DETAIL = 'p_since o p_recent es NULL';
  END IF;

  RETURN QUERY
    SELECT l.provider_code,
           l.vertical,
           count(*)                                                     AS searches,
           count(*) FILTER (WHERE l.outcome = 'ok' AND l.result_count > 0) AS with_results,
           count(*) FILTER (WHERE l.outcome = 'empty')                 AS empty_searches,
           count(*) FILTER (WHERE l.outcome = 'error')                 AS error_searches,
           count(*) FILTER (WHERE l.occurred_at >= p_recent)           AS recent_searches,
           count(*) FILTER (WHERE l.occurred_at >= p_recent
                              AND l.outcome = 'ok' AND l.result_count > 0) AS recent_with_results,
           avg(l.duration_ms)::bigint                                   AS avg_duration_ms,
           (percentile_cont(0.95) WITHIN GROUP (ORDER BY l.duration_ms))::bigint AS p95_duration_ms,
           max(l.occurred_at)                                           AS last_search_at,
           -- La última vez que trajo algo, aunque sea anterior al período: «hace 14 días» es la alerta.
           (SELECT max(o.occurred_at)
              FROM public.search_logs o
             WHERE o.provider_code = l.provider_code
               AND o.vertical = l.vertical
               AND o.outcome = 'ok' AND o.result_count > 0)             AS last_result_at,
           (SELECT e.error_code
              FROM public.search_logs e
             WHERE e.provider_code = l.provider_code
               AND e.vertical = l.vertical
               AND e.outcome = 'error'
               AND e.occurred_at >= p_since
             ORDER BY e.occurred_at DESC
             LIMIT 1)                                                   AS last_error_code
      FROM public.search_logs l
     WHERE l.occurred_at >= p_since
       AND l.provider_code <> 'none'
     GROUP BY l.provider_code, l.vertical;
END;
$$;

COMMENT ON FUNCTION admin_provider_search_health(timestamptz, timestamptz) IS
  'Por proveedor y vertical: búsquedas desde p_since (y desde p_recent), con resultados, vacías, con error, latencia media y p95, la última búsqueda, la última con resultados (sin límite de fecha) y el último código de error. Sólo el superadmin de la plataforma. Ver db/migrations/0095.';

REVOKE ALL ON FUNCTION admin_provider_search_health(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_provider_search_health(timestamptz, timestamptz) TO app_user;
