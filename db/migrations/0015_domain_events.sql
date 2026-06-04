-- 0015_domain_events.sql
-- Audit log append-only: registra acciones sensibles del sistema (cambios de credenciales,
-- roles, overrides de pricing, etc.). Fuente de verdad para trazabilidad/compliance.
-- Tabla plana (sin TimescaleDB) para que CI con postgres:16 la valide; en prod se puede
-- convertir a hypertable después. Ver docs/platform/10 §4.4 (DOMAIN_EVENT).

CREATE TABLE domain_events (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  tenant_id       UUID,                       -- nullable: eventos a nivel plataforma
  actor_user_id   UUID,                       -- quién lo hizo (nullable: sistema)
  event_type      TEXT         NOT NULL,      -- 'ProviderCredentialsUpdated', 'MembershipRoleChanged', ...
  aggregate_type  TEXT,                       -- 'provider_account' | 'membership' | 'tenant' | ...
  aggregate_id    TEXT,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- NUNCA secretos/PII sensible
  meta            JSONB        NOT NULL DEFAULT '{}'::jsonb   -- ip, user_agent, request_id
);

CREATE INDEX idx_domain_events_tenant_time ON domain_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_domain_events_type_time   ON domain_events(event_type, occurred_at DESC);
CREATE INDEX idx_domain_events_aggregate   ON domain_events(aggregate_type, aggregate_id);

COMMENT ON TABLE domain_events IS 'Audit log append-only. Nunca UPDATE/DELETE. Nunca guardar secretos en payload.';

-- Append-only: app_user puede INSERT y SELECT, pero NO UPDATE/DELETE (las default privileges
-- de 0001 otorgan todo; revocamos las mutaciones para garantizar inmutabilidad).
REVOKE UPDATE, DELETE ON domain_events FROM app_user;
