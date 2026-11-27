-- 0100_branding_own_name_and_admin_user.sql
-- (QA-H-43, QA-H-44; plan de pruebas AGE-08 y SQL-06)
--
-- 1. El nombre comercial no se hereda (QA-H-43).
--    0030 lo documentaba así («cae al nombre legal del PROPIO tenant, no al del ancestro: heredarlo
--    mostraría la marca del consolidador como si fuera la de la agencia»), pero el COALESCE buscaba
--    primero en toda la cadena: una agencia sin nombre comercial propio salía con el del
--    consolidador en el PDF y el correo de sus cotizaciones, frente a su cliente. Logo, colores,
--    contacto de soporte y web se siguen heredando campo a campo, como en 0030.
--
-- 2. `is_admin_user()` (0008/0013) ya no la usa ninguna política ni función desde que 0020 pasó la
--    RLS de memberships a `can_read_membership` (QA-H-44). Respondía «es admin en CUALQUIER nodo»:
--    reusarla en una política nueva abriría filas de un nodo a quien es admin de otro. Se borra,
--    como accept_invitation en 0099.

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
SET search_path = pg_catalog, public, pg_temp
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
    -- Sólo el del propio tenant, o su nombre legal: nunca el de un ancestro.
    (SELECT COALESCE(t.commercial_name, t.name) FROM tenants t WHERE t.id = p_tenant_id),
    (SELECT c.support_email   FROM chain c WHERE c.support_email   IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.support_phone   FROM chain c WHERE c.support_phone   IS NOT NULL ORDER BY c.lvl DESC LIMIT 1),
    (SELECT c.website_url     FROM chain c WHERE c.website_url     IS NOT NULL ORDER BY c.lvl DESC LIMIT 1);
$$;

COMMENT ON FUNCTION resolve_tenant_branding(UUID) IS
  'Branding efectivo de un tenant: logo, colores, soporte y web heredados campo a campo de su cadena activa (consolidador → agencia → sub-agencia); el nombre comercial es siempre el propio o su nombre legal. Ver db/migrations/0030 y 0100.';

DROP FUNCTION IF EXISTS is_admin_user();
