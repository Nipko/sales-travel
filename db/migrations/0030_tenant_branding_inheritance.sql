-- 0030_tenant_branding_inheritance.sql
-- Herencia de branding por la jerarquía + integridad de los campos de marca.
--
-- Problema: el modelo consolidador promete white-label en cascada, pero NO existía
-- ninguna lógica de herencia, ni en SQL ni en TS. Una sub-agencia que no configuraba
-- logo simplemente no tenía logo — no heredaba el de su agencia ni el del consolidador.
-- Y los tres campos eran TEXT libre pese a que el COMMENT prometía un máximo de 2048.

-- ============================================================================
-- 1. Ampliación de la identidad del tenant
-- ============================================================================
-- Con logo + 2 colores no alcanza para un white-label creíble de cara al cliente
-- final de una agencia minorista: falta cómo se llama comercialmente y cómo la contactan.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS commercial_name TEXT,
  ADD COLUMN IF NOT EXISTS favicon_url     TEXT,
  ADD COLUMN IF NOT EXISTS support_email   TEXT,
  ADD COLUMN IF NOT EXISTS support_phone   TEXT,
  ADD COLUMN IF NOT EXISTS website_url     TEXT;

COMMENT ON COLUMN tenants.commercial_name IS 'Nombre comercial de cara al cliente final. Si es NULL se hereda, y en última instancia cae a tenants.name.';
COMMENT ON COLUMN tenants.favicon_url     IS 'Favicon propio de la agencia. Heredable.';
COMMENT ON COLUMN tenants.support_email   IS 'Contacto que ve el cliente final en documentos y correos. Heredable.';

-- ============================================================================
-- 2. Integridad de los campos de marca
-- ============================================================================
-- Los colores se editan con <input type="color">, que emite hex de 6 dígitos, y la
-- derivación de tokens del cliente (lib/brand-tokens.ts) sólo entiende ese formato:
-- un OKLCH guardado acá se descartaría en silencio. Se restringe a hex explícitamente.
--
-- Backfill primero: cualquier valor preexistente que no matchee pasa a NULL (el tenant
-- vuelve a los colores de la plataforma) en vez de bloquear la migración.
UPDATE tenants SET primary_color = NULL WHERE primary_color !~ '^#[0-9a-fA-F]{6}$';
UPDATE tenants SET accent_color  = NULL WHERE accent_color  !~ '^#[0-9a-fA-F]{6}$';
UPDATE tenants SET logo_url      = NULL WHERE length(logo_url)    > 2048;
UPDATE tenants SET favicon_url   = NULL WHERE length(favicon_url) > 2048;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_primary_color_hex CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT tenants_accent_color_hex  CHECK (accent_color  ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT tenants_logo_url_len      CHECK (length(logo_url)    <= 2048),
  ADD CONSTRAINT tenants_favicon_url_len   CHECK (length(favicon_url) <= 2048);

-- ============================================================================
-- 3. Resolución del branding efectivo, con herencia por path (ltree)
-- ============================================================================
-- Herencia POR CAMPO, no por registro: una sub-agencia puede poner sólo su logo y
-- seguir heredando el color del consolidador. Para cada campo gana el valor no nulo del
-- nodo más profundo dentro de la cadena ancestro-o-propio (el propio primero).
--
-- SECURITY DEFINER, igual que resolve_provider_account (0012): hace falta leer filas de
-- tenants ancestros, fuera del alcance del tenant activo de la app.
CREATE OR REPLACE FUNCTION resolve_tenant_branding(p_tenant_id UUID)
RETURNS TABLE (
  logo_url        TEXT,
  favicon_url     TEXT,
  primary_color   TEXT,
  accent_color    TEXT,
  commercial_name TEXT,
  support_email   TEXT,
  support_phone   TEXT,
  website_url     TEXT
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  WITH me AS (SELECT path FROM tenants WHERE id = p_tenant_id),
  chain AS (
    SELECT t.*, nlevel(t.path) AS lvl
    FROM tenants t
    CROSS JOIN me
    WHERE t.path OPERATOR(public.@>) me.path   -- ancestros de p_tenant_id, incluido él mismo
      AND t.status = 'active'
  )
  SELECT
    (SELECT c.logo_url        FROM chain c WHERE c.logo_url        IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.favicon_url     FROM chain c WHERE c.favicon_url     IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.primary_color   FROM chain c WHERE c.primary_color   IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.accent_color    FROM chain c WHERE c.accent_color    IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    -- El nombre comercial cae al nombre legal del PROPIO tenant, no al del ancestro:
    -- heredarlo mostraría la marca del consolidador como si fuera la de la agencia.
    COALESCE(
      (SELECT c.commercial_name FROM chain c WHERE c.commercial_name IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
      (SELECT t.name FROM tenants t WHERE t.id = p_tenant_id)
    ),
    (SELECT c.support_email   FROM chain c WHERE c.support_email   IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.support_phone   FROM chain c WHERE c.support_phone   IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.website_url     FROM chain c WHERE c.website_url     IS NOT NULL ORDER BY c.lvl DESC LIMIT 1);
$$;

COMMENT ON FUNCTION resolve_tenant_branding(UUID) IS
  'Branding efectivo de un tenant con herencia por campo a lo largo de su cadena de ancestros (consolidador → agencia → sub-agencia). Ver db/migrations/0030.';

GRANT EXECUTE ON FUNCTION resolve_tenant_branding(UUID) TO app_user;
