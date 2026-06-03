-- 0011_tenant_hierarchy.sql
-- Jerarquía multinivel de tenants para el MODELO CONSOLIDADOR (B2B2B).
-- consolidador → agencia → sub-agencia → (vendedor = usuario, no tenant).
-- Materialized path con ltree para visibilidad descendente eficiente.
-- Ver docs/platform/12-modelo-consolidador-y-plan.md §3.1.

CREATE EXTENSION IF NOT EXISTS ltree;

ALTER TABLE tenants
  ADD COLUMN parent_tenant_id UUID NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN tenant_type      TEXT NOT NULL DEFAULT 'agency'
    CHECK (tenant_type IN ('platform', 'consolidator', 'agency', 'subagency')),
  ADD COLUMN path             LTREE;

COMMENT ON COLUMN tenants.parent_tenant_id IS 'Padre en la jerarquía B2B2B. NULL = nodo raíz (plataforma o consolidador).';
COMMENT ON COLUMN tenants.tenant_type      IS 'platform | consolidator | agency | subagency.';
COMMENT ON COLUMN tenants.path             IS 'Materialized path (ltree). Label = id sin guiones. Habilita visibilidad descendente (path <@ ancestro).';

-- Backfill: los tenants existentes pasan a ser nodos raíz (agencias) hasta que se
-- les asigne un consolidador padre. Se ejecuta ANTES de crear el trigger.
UPDATE tenants
  SET path = replace(id::text, '-', '')::ltree
  WHERE path IS NULL;

ALTER TABLE tenants ALTER COLUMN path SET NOT NULL;

CREATE INDEX idx_tenants_path_gist ON tenants USING GIST (path);
CREATE INDEX idx_tenants_parent    ON tenants(parent_tenant_id);

-- ============================================================================
-- Mantención automática de `path` + límite de profundidad (D1: máx 4 niveles).
-- El path se deriva del padre; el label propio es el id sin guiones (label ltree válido).
-- Re-parenting vía UPDATE se rechaza explícitamente (orfanaría los paths de los
-- descendientes); mover un subárbol es una operación dedicada futura.
-- ============================================================================
CREATE OR REPLACE FUNCTION tenants_maintain_path() RETURNS trigger AS $$
DECLARE
  parent_path LTREE;
  self_label  TEXT := replace(NEW.id::text, '-', '');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_tenant_id IS DISTINCT FROM OLD.parent_tenant_id THEN
    RAISE EXCEPTION 'Re-parenting a tenant via UPDATE is not supported (would orphan descendant paths). Use a dedicated move-subtree operation.';
  END IF;

  IF NEW.parent_tenant_id IS NULL THEN
    NEW.path := self_label::ltree;
  ELSE
    SELECT path INTO parent_path FROM tenants WHERE id = NEW.parent_tenant_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'parent tenant % has no path', NEW.parent_tenant_id;
    END IF;
    NEW.path := parent_path || self_label::ltree;
  END IF;

  IF nlevel(NEW.path) > 4 THEN
    RAISE EXCEPTION 'tenant hierarchy depth limit (4) exceeded: %', NEW.path::text;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_maintain_path
  BEFORE INSERT OR UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_maintain_path();
