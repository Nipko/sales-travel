-- Red de PRUEBA para los E2E del panel (apps/web-b2b/e2e). Idempotente: se corre al levantar el stack
-- (servicio `seed` de docker-compose.e2e.yml) y otra vez en cada corrida (e2e/global-setup.ts), y deja a
-- los usuarios de prueba como recién creados: contraseña conocida, sin MFA, sin sesiones.
--
-- NUNCA correr contra una base que no sea la del stack E2E: reescribe usuarios @e2e.test.
--
--   platform (Planetour E2E)
--   ├── e2e-consolidador (consolidator)
--   │   └── e2e-agencia-a (agency)
--   │       └── e2e-subagencia (subagency)
--   ├── e2e-agencia-b (agency)
--   └── e2e-agencia-suspendida (agency, suspendida: ACC-21)
--
-- Contraseña de todos (sólo de prueba, también en e2e/support/users.ts): E2e-Prueba-2026!

BEGIN;

-- Cambios directos ya «auditados» por este seed: que el trigger de 0092 no los duplique como
-- db.direct_change.
SELECT set_config('app.direct_change_audited', 'on', true);

-- ── Red ────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
VALUES ('platform', 'Planetour E2E', 'CO', 'COP', 'platform')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
SELECT 'e2e-consolidador', 'Consolidador E2E', 'CO', 'COP', 'consolidator', id FROM tenants WHERE slug = 'platform'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
SELECT 'e2e-agencia-a', 'Agencia E2E A', 'CO', 'COP', 'agency', id FROM tenants WHERE slug = 'e2e-consolidador'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
SELECT 'e2e-subagencia', 'Subagencia E2E', 'CO', 'COP', 'subagency', id FROM tenants WHERE slug = 'e2e-agencia-a'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
SELECT 'e2e-agencia-b', 'Agencia E2E B', 'PE', 'PEN', 'agency', id FROM tenants WHERE slug = 'platform'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
SELECT 'e2e-agencia-suspendida', 'Agencia E2E Suspendida', 'CO', 'COP', 'agency', id FROM tenants WHERE slug = 'platform'
ON CONFLICT (slug) DO NOTHING;
UPDATE tenants SET status = 'suspended' WHERE slug = 'e2e-agencia-suspendida';

-- ── Usuarios ───────────────────────────────────────────────────────────────────────────────────────
WITH seed_users(email, name) AS (
  VALUES
    ('superadmin@e2e.test', 'Superadmin E2E'),
    ('admin-a@e2e.test',    'Admin Agencia A'),
    ('mfa-nuevo@e2e.test',  'Admin Sin MFA'),
    ('vendedor-a@e2e.test', 'Vendedor Agencia A'),
    ('vendedor-b@e2e.test', 'Vendedor Agencia B'),
    -- Personas del arnés HTTP (e2e/api): una por rol, propias, para no compartir sesión ni MFA con el panel.
    ('api-superadmin@e2e.test',     'API Superadmin'),
    ('api-supervisado@e2e.test',    'API Superadmin Supervisado'),
    ('api-consolidador@e2e.test',   'API Admin Consolidador'),
    ('api-admin-a@e2e.test',        'API Admin Agencia A'),
    ('api-agency-admin-a@e2e.test', 'API Agency Admin A'),
    ('api-tenant-admin-a@e2e.test', 'API Tenant Admin A'),
    ('api-vendedor-a@e2e.test',     'API Vendedor A'),
    ('api-cliente-a@e2e.test',      'API Cliente Final A'),
    ('api-sin-mfa@e2e.test',        'API Admin Sin MFA'),
    ('api-vendedor-sub@e2e.test',   'API Vendedor Subagencia'),
    ('api-admin-b@e2e.test',        'API Admin Agencia B'),
    ('api-vendedor-b@e2e.test',     'API Vendedor B'),
    -- Casos especiales del arnés (INF-2): el seed los deja en su estado en cada corrida.
    ('api-bloqueo@e2e.test',        'API Bloqueo'),
    ('api-suspendido@e2e.test',     'API Usuario Suspendido'),
    ('api-multi@e2e.test',          'API Vendedor Dos Nodos'),
    ('api-memb-susp@e2e.test',      'API Membresia Suspendida'),
    ('api-nodo-susp@e2e.test',      'API Nodo Suspendido'),
    ('api-reset@e2e.test',          'API Cambio de Contrasena')
)
INSERT INTO users (email, name, password_hash, email_verified_at, password_changed_at)
SELECT email, name, crypt('E2e-Prueba-2026!', gen_salt('bf', 10)), now(), now() FROM seed_users
ON CONFLICT (email) DO UPDATE
   SET name                       = EXCLUDED.name,
       password_hash              = EXCLUDED.password_hash,
       status                     = 'active',
       email_verified_at          = now(),
       password_changed_at        = now(),
       password_reset_required_at = NULL,
       failed_login_attempts      = 0,
       locked_until               = NULL,
       mfa_secret                 = NULL,
       mfa_pending_secret         = NULL,
       mfa_enabled_at             = NULL,
       mfa_last_used_step         = NULL;

DELETE FROM sessions           WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test');
DELETE FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test');
DELETE FROM mfa_challenges     WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test');
DELETE FROM trusted_devices    WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e.test');

-- ── Membresías ─────────────────────────────────────────────────────────────────────────────────────
WITH seed_memberships(email, slug, role, supervised) AS (
  VALUES
    ('superadmin@e2e.test', 'platform',      'superadmin', false),
    ('admin-a@e2e.test',    'e2e-agencia-a', 'admin',      false),
    ('mfa-nuevo@e2e.test',  'e2e-agencia-a', 'admin',      false),
    ('vendedor-a@e2e.test', 'e2e-agencia-a', 'vendedor',   false),
    ('vendedor-b@e2e.test', 'e2e-agencia-b', 'vendedor', false),
    ('api-superadmin@e2e.test',     'platform',         'superadmin',         false),
    ('api-supervisado@e2e.test',    'platform',         'superadmin',         true),
    ('api-consolidador@e2e.test',   'e2e-consolidador', 'consolidator_admin', false),
    ('api-admin-a@e2e.test',        'e2e-agencia-a',    'admin',              false),
    ('api-agency-admin-a@e2e.test', 'e2e-agencia-a',    'agency_admin',       false),
    ('api-tenant-admin-a@e2e.test', 'e2e-agencia-a',    'tenant_admin',       false),
    ('api-vendedor-a@e2e.test',     'e2e-agencia-a',    'vendedor',           false),
    ('api-cliente-a@e2e.test',      'e2e-agencia-a',    'cliente_final',      false),
    ('api-sin-mfa@e2e.test',        'e2e-agencia-a',    'admin',              false),
    ('api-vendedor-sub@e2e.test',   'e2e-subagencia',   'vendedor',           false),
    ('api-admin-b@e2e.test',        'e2e-agencia-b',    'admin',              false),
    ('api-vendedor-b@e2e.test',     'e2e-agencia-b',    'vendedor',           false),
    ('api-bloqueo@e2e.test',        'e2e-agencia-a',    'vendedor',           false),
    ('api-suspendido@e2e.test',     'e2e-agencia-a',    'vendedor',           false),
    ('api-multi@e2e.test',          'e2e-agencia-a',    'vendedor',           false),
    ('api-multi@e2e.test',          'e2e-agencia-b',    'vendedor',           false),
    ('api-memb-susp@e2e.test',      'e2e-agencia-a',    'vendedor',           false),
    ('api-memb-susp@e2e.test',      'e2e-agencia-b',    'vendedor',           false),
    ('api-nodo-susp@e2e.test',      'e2e-agencia-suspendida', 'vendedor',     false),
    ('api-reset@e2e.test',          'e2e-agencia-a',    'vendedor',           false)
)
INSERT INTO memberships (tenant_id, user_id, role, platform_supervised)
SELECT t.id, u.id, s.role, s.supervised
  FROM seed_memberships s
  JOIN tenants t ON t.slug = s.slug
  JOIN users   u ON u.email = s.email
ON CONFLICT (tenant_id, user_id) DO UPDATE
   SET role = EXCLUDED.role, platform_supervised = EXCLUDED.platform_supervised,
       status = 'active', removed_at = NULL, removed_by = NULL;

-- Estados de los casos especiales (después de dejar todo activo arriba).
UPDATE users SET status = 'suspended' WHERE email = 'api-suspendido@e2e.test';
UPDATE users SET password_reset_required_at = now() WHERE email = 'api-reset@e2e.test';
UPDATE memberships SET status = 'suspended'
 WHERE user_id = (SELECT id FROM users WHERE email = 'api-memb-susp@e2e.test')
   AND tenant_id = (SELECT id FROM tenants WHERE slug = 'e2e-agencia-a');

COMMIT;
