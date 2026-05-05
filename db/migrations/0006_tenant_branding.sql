-- 0006_tenant_branding.sql
-- Branding fields for white-label tenant customization.

ALTER TABLE tenants
  ADD COLUMN logo_url       TEXT,
  ADD COLUMN primary_color  TEXT,
  ADD COLUMN accent_color   TEXT;

COMMENT ON COLUMN tenants.logo_url       IS 'URL to tenant logo (displayed in topbar + login). Max 2048 chars.';
COMMENT ON COLUMN tenants.primary_color  IS 'OKLCH or hex color string for primary brand color.';
COMMENT ON COLUMN tenants.accent_color   IS 'OKLCH or hex color string for accent/secondary brand color.';
