-- 0089_governance_profiles.sql
-- Gobierno de proveedores y formas de pago: reglas a mano y perfiles enlazados, sólo superadmin.
-- Diseño acordado con el founder: docs/platform/14-opciones-de-pago.md.
--
-- Qué ya existía y se conserva:
--   provider_enablement (0048) — reglas a mano de PROVEEDORES, globales (tenant_id NULL) o por nodo.
--   Sigue siendo la tabla de esas reglas y su panel sigue funcionando.
--
-- Qué agrega esta migración:
--   payment_method_rules        — reglas a mano de FORMAS DE PAGO (proveedor + método), igual que 0048.
--   governance_profiles         — perfiles con nombre, que el superadmin crea, edita y archiva.
--   governance_profile_items    — qué enciende o apaga cada perfil (proveedor, o proveedor + método).
--   tenant_governance_profiles  — el perfil asignado a un nodo. ENLAZADO: editar el perfil cambia a
--                                 todos sus nodos. Asignado al nodo plataforma vale como global.
--   governance_state            — marca de que la configuración vigente ya se sembró (la siembra el
--                                 API al arrancar, porque depende de variables de entorno que una
--                                 migración no ve).
--   governance_chain(tenant)    — todo lo que puede decidir para un tenant, CRUDO; el plegado vive en
--                                 el API (apps/api/src/governance/governance.policy.ts).
--
-- Escritura: sólo is_platform_superadmin() (0075). Lectura abierta: la resuelve el servidor en cada
-- búsqueda y cada pago, y no hay datos de un tenant que aislar (como 0048).

-- ============================================================================
-- 1. Reglas a mano de formas de pago
-- ============================================================================
CREATE TABLE payment_method_rules (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code   TEXT         NOT NULL CHECK (provider_code ~ '^[a-z0-9-]{1,64}$'),
  payment_method  TEXT         NOT NULL CHECK (payment_method ~ '^[a-z0-9_]{1,64}$'),
  -- NULL = regla GLOBAL.
  tenant_id       UUID         REFERENCES tenants(id) ON DELETE CASCADE,
  enabled         BOOLEAN      NOT NULL,
  reason          TEXT         CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  updated_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_payment_method_rules_global
  ON payment_method_rules (provider_code, payment_method) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX uq_payment_method_rules_tenant
  ON payment_method_rules (provider_code, payment_method, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_payment_method_rules_tenant
  ON payment_method_rules (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE TRIGGER payment_method_rules_set_updated_at
  BEFORE UPDATE ON payment_method_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE payment_method_rules IS
  'Reglas a mano del superadmin sobre qué formas de pago de cada proveedor puede usar un nodo y su red (tenant_id NULL = global). Pisan al perfil del mismo nodo. Ver db/migrations/0089.';

-- ============================================================================
-- 2. Perfiles
-- ============================================================================
CREATE TABLE governance_profiles (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT         NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description               TEXT         CHECK (description IS NULL OR char_length(description) <= 500),
  -- El perfil que recibe un nodo nuevo que no eligió otro. A lo sumo uno.
  is_default_for_new_nodes  BOOLEAN      NOT NULL DEFAULT false,
  archived_at               TIMESTAMPTZ,
  created_by                UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_by                UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Un perfil archivado no puede ser el predeterminado.
  CHECK (NOT (is_default_for_new_nodes AND archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_governance_profiles_name
  ON governance_profiles (lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_governance_profiles_default
  ON governance_profiles ((true)) WHERE is_default_for_new_nodes;

CREATE TRIGGER governance_profiles_set_updated_at
  BEFORE UPDATE ON governance_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE governance_profile_items (
  profile_id      UUID     NOT NULL REFERENCES governance_profiles(id) ON DELETE CASCADE,
  provider_code   TEXT     NOT NULL CHECK (provider_code ~ '^[a-z0-9-]{1,64}$'),
  -- '' = el proveedor mismo; otro valor = una forma de pago de ese proveedor. '' y no NULL para que
  -- la clave primaria sirva tal cual.
  payment_method  TEXT     NOT NULL DEFAULT '' CHECK (payment_method ~ '^[a-z0-9_]{0,64}$'),
  enabled         BOOLEAN  NOT NULL,
  PRIMARY KEY (profile_id, provider_code, payment_method)
);

COMMENT ON TABLE governance_profile_items IS
  'Lo que enciende o apaga un perfil: el proveedor (payment_method = '''') o una de sus formas de pago. Un elemento que el perfil no menciona no lo decide el perfil. Ver db/migrations/0089.';

CREATE TABLE tenant_governance_profiles (
  tenant_id   UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id  UUID         NOT NULL REFERENCES governance_profiles(id) ON DELETE RESTRICT,
  updated_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenant_governance_profiles_profile ON tenant_governance_profiles (profile_id);

CREATE TRIGGER tenant_governance_profiles_set_updated_at
  BEFORE UPDATE ON tenant_governance_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE tenant_governance_profiles IS
  'Perfil de gobierno asignado a un nodo (enlazado: editar el perfil cambia a todos sus nodos). Vale para el nodo y su red salvo un nodo más cercano que diga otra cosa. En el nodo plataforma hace de perfil global. Ver db/migrations/0089.';

CREATE TABLE governance_state (
  id               BOOLEAN      PRIMARY KEY DEFAULT true CHECK (id),
  bootstrapped_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE governance_state IS
  'Una fila: la configuración vigente ya se sembró como perfil (lo hace el API una vez, al arrancar). Ver db/migrations/0089.';

-- ============================================================================
-- 3. RLS: lectura abierta, escritura sólo del superadmin de la plataforma
-- ============================================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payment_method_rules', 'governance_profiles', 'governance_profile_items',
    'tenant_governance_profiles', 'governance_state'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (true)', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (is_platform_superadmin())', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (is_platform_superadmin()) WITH CHECK (is_platform_superadmin())',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (is_platform_superadmin())', t || '_delete', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_user', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END;
$$;

-- La siembra corre en el arranque del API, sin usuario en el request: necesita escribir el perfil
-- y su asignación sin pasar por is_platform_superadmin(). Se hace en una función con dueño que sólo
-- actúa si governance_state está vacía (una sola vez en la vida de la base).
CREATE FUNCTION governance_bootstrap(p_profile_name TEXT, p_items JSONB, p_tenant_rules JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_profile UUID;
  v_root    UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('governance_bootstrap'));
  IF EXISTS (SELECT 1 FROM governance_state) THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_root FROM tenants WHERE tenant_type = 'platform' AND parent_tenant_id IS NULL;
  IF v_root IS NULL THEN
    RAISE EXCEPTION 'governance_bootstrap: no hay nodo plataforma';
  END IF;

  INSERT INTO governance_profiles (name, description)
  VALUES (
    p_profile_name,
    'Lo que estaba encendido el día que entró el gobierno de proveedores y formas de pago. Asignado a la plataforma para no cortar ventas; edítalo o reemplázalo.'
  )
  RETURNING id INTO v_profile;

  INSERT INTO governance_profile_items (profile_id, provider_code, payment_method, enabled)
  SELECT v_profile, i->>'provider', COALESCE(i->>'method', ''), (i->>'enabled')::boolean
  FROM jsonb_array_elements(p_items) i;

  INSERT INTO tenant_governance_profiles (tenant_id, profile_id) VALUES (v_root, v_profile);

  -- Lo que la variable legado encendía para UN tenant (`codigo@<tenantId>`) pasa a ser una regla a
  -- mano de ese nodo: el perfil global no lo cubre y el día del cambio no puede apagarse nada.
  INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason)
  SELECT r->>'provider', t.id, true, 'Encendido por variable de entorno antes del gobierno (0089)'
  FROM jsonb_array_elements(p_tenant_rules) r
  JOIN tenants t ON t.id::text = r->>'tenantId'
  ON CONFLICT (provider_code, tenant_id) WHERE tenant_id IS NOT NULL DO NOTHING;

  INSERT INTO governance_state DEFAULT VALUES;
  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION governance_bootstrap(TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION governance_bootstrap(TEXT, JSONB, JSONB) TO app_user;

-- ============================================================================
-- 4. La cadena de un tenant
-- ============================================================================
-- Todo lo que puede decidir para p_tenant_id, CRUDO, con la profundidad del nodo:
--   source 'rule'    — provider_enablement (method '') y payment_method_rules del nodo o ancestro.
--   source 'profile' — los ítems del perfil asignado al nodo o ancestro.
--   Las reglas globales (tenant_id NULL) salen con lvl = 1, la profundidad del nodo plataforma: en ese
--   nivel la regla a mano le gana al perfil global, como en cualquier otro nodo.
-- SECURITY DEFINER como provider_enablement_chain (0048): hay que leer nodos ancestros.
CREATE FUNCTION governance_chain(p_tenant_id UUID)
RETURNS TABLE (
  source          TEXT,
  provider_code   TEXT,
  payment_method  TEXT,
  tenant_id       UUID,
  lvl             INTEGER,
  enabled         BOOLEAN,
  profile_id      UUID,
  profile_name    TEXT
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH me AS (SELECT path FROM tenants WHERE id = p_tenant_id),
  chain AS (
    SELECT t.id, nlevel(t.path)::int AS lvl
    FROM tenants t CROSS JOIN me
    WHERE t.path OPERATOR(public.@>) me.path
  )
  SELECT 'rule', s.provider_code, '', s.tenant_id, c.lvl, s.enabled, NULL::uuid, NULL::text
    FROM provider_enablement s JOIN chain c ON c.id = s.tenant_id
  UNION ALL
  SELECT 'rule', s.provider_code, '', NULL::uuid, 1, s.enabled, NULL::uuid, NULL::text
    FROM provider_enablement s WHERE s.tenant_id IS NULL
  UNION ALL
  SELECT 'rule', r.provider_code, r.payment_method, r.tenant_id, c.lvl, r.enabled, NULL::uuid, NULL::text
    FROM payment_method_rules r JOIN chain c ON c.id = r.tenant_id
  UNION ALL
  SELECT 'rule', r.provider_code, r.payment_method, NULL::uuid, 1, r.enabled, NULL::uuid, NULL::text
    FROM payment_method_rules r WHERE r.tenant_id IS NULL
  UNION ALL
  SELECT 'profile', i.provider_code, i.payment_method, a.tenant_id, c.lvl, i.enabled, p.id, p.name
    FROM tenant_governance_profiles a
    JOIN chain c ON c.id = a.tenant_id
    JOIN governance_profiles p ON p.id = a.profile_id
    JOIN governance_profile_items i ON i.profile_id = p.id
$$;

COMMENT ON FUNCTION governance_chain(UUID) IS
  'Reglas a mano (proveedores de provider_enablement y formas de pago de payment_method_rules) y perfiles asignados que pueden decidir para el tenant, con la profundidad de su nodo (las globales con lvl 1). El plegado vive en el API. Ver db/migrations/0089.';

REVOKE ALL ON FUNCTION governance_chain(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION governance_chain(UUID) TO app_user;
