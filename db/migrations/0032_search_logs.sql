-- 0032_search_logs.sql
-- Observabilidad de búsquedas.
--
-- Hasta ahora no había NINGUNA: no se podía responder cuánto tarda cada proveedor, qué
-- porcentaje de búsquedas falla, ni cuál es el look-to-book de una agencia. Para un
-- consolidador eso son las tres preguntas operativas básicas —y las que hacen falta para
-- negociar con un proveedor o detectar que una agencia dejó de vender.
--
-- Tabla plana (sin TimescaleDB) por el mismo motivo que domain_events en 0015: que CI con
-- postgres:16 la valide. En prod se puede convertir a hypertable después.

CREATE TABLE search_logs (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  occurred_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  tenant_id      UUID         REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id  UUID         REFERENCES users(id) ON DELETE SET NULL,
  vertical       TEXT         NOT NULL CHECK (vertical IN ('flights', 'hotels', 'cars')),
  provider_code  TEXT         NOT NULL,
  duration_ms    INTEGER      NOT NULL,
  result_count   INTEGER      NOT NULL DEFAULT 0,
  -- 'ok' | 'empty' | 'error' | 'simulated'. `simulated` distingue el modo mock, que de
  -- otro modo se contaría como una búsqueda exitosa y falsearía la tasa de éxito.
  outcome        TEXT         NOT NULL CHECK (outcome IN ('ok', 'empty', 'error', 'simulated')),
  error_code     TEXT,
  -- Criterio de búsqueda REDUCIDO: ruta, fechas y pax. NUNCA datos del pasajero ni del
  -- cliente final: esta tabla se consulta para métricas, no para reconstruir una reserva.
  criteria       JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_search_logs_tenant_time   ON search_logs(tenant_id, occurred_at DESC);
CREATE INDEX idx_search_logs_provider_time ON search_logs(provider_code, occurred_at DESC);
-- Camino de la cuota: contar búsquedas de un tenant en la ventana reciente.
CREATE INDEX idx_search_logs_quota         ON search_logs(tenant_id, occurred_at)
  WHERE outcome <> 'error';

COMMENT ON TABLE search_logs IS
  'Telemetría de búsquedas: latencia por proveedor, tasa de error y volumen por tenant. Sin PII. Ver db/migrations/0032.';

-- Lectura acotada al subárbol administrado, igual que domain_events (0029): las métricas
-- de una agencia son información comercial que su competencia dentro de la red no debe ver.
ALTER TABLE search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_logs FORCE  ROW LEVEL SECURITY;

CREATE POLICY search_logs_subtree_read ON search_logs
  FOR SELECT
  USING (can_read_membership(tenant_id));

-- INSERT permisivo, por el mismo motivo que domain_events: registrar la telemetría no
-- puede bloquear una búsqueda, y se escribe siempre desde la app con el tenant resuelto.
CREATE POLICY search_logs_append ON search_logs
  FOR INSERT
  WITH CHECK (true);

GRANT SELECT, INSERT ON search_logs TO app_user;
REVOKE UPDATE, DELETE ON search_logs FROM app_user;

-- ============================================================================
-- Cuota de búsquedas por tenant
-- ============================================================================
-- El rate limit era sólo por IP: una agencia entera comparte la IP de su oficina, así
-- que o se throttlea a todos juntos o no se throttlea a nadie. Y nada impedía que un
-- tenant consumiera la cuota de la plataforma contra los proveedores, que cobran por
-- consulta. La cuota vive en el tenant para poder diferenciarla por plan.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS search_quota_per_hour INTEGER;

COMMENT ON COLUMN tenants.search_quota_per_hour IS
  'Búsquedas por hora permitidas al tenant. NULL = sin límite propio (usa el de la plataforma).';

CREATE OR REPLACE FUNCTION count_recent_searches(p_tenant_id UUID, p_minutes INTEGER)
RETURNS integer
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT COUNT(*)::int
  FROM search_logs
  WHERE tenant_id = p_tenant_id
    AND outcome <> 'error'
    AND occurred_at > now() - make_interval(mins => p_minutes);
$$;

COMMENT ON FUNCTION count_recent_searches(UUID, INTEGER) IS
  'Búsquedas facturables del tenant en la ventana dada. SECURITY DEFINER: la cuota se comprueba antes de resolver el contexto de lectura.';

GRANT EXECUTE ON FUNCTION count_recent_searches(UUID, INTEGER) TO app_user;
