-- 0049_platform_root.sql
-- Planetour es la raíz ÚNICA de la red y es de tipo 'platform' (D4 A; docs/platform/12).
--
-- 0011 dejó como 'agency' a todo tenant que ya existía y nada lo cambió después, así que el nodo de
-- Planetour (slug 'platform') quedó como una agencia raíz más. Con eso TBO no le funciona (su
-- factory sólo opera cuentas de plataforma o de consolidador), 0025 le rechaza el rol superadmin y
-- sus hijos nacen como sub-agencias.
--
-- Esta migración sólo PROMUEVE: el tenant con slug 'platform' y SIN padre pasa a tipo 'platform',
-- con su `domain_event`. Es la única regla por slug y no toca datos de nadie más. Si no existe (una
-- base nueva, el stack de certificación) no hace nada, y correrla dos veces tampoco.
--
-- Si ya hay OTRO tenant de tipo 'platform', o uno con padre, falla con un mensaje que dice qué
-- revisar, en vez de elegir una raíz por su cuenta: 0050 exige una sola y sin padre.
--
-- Lo demás que no cumple la matriz D4 (por ejemplo, una agencia raíz suelta) no se toca: 0050 lo
-- avisa y se corrige moviendo el nodo desde el panel del superadmin (0051).

DO $$
DECLARE
  root_id   UUID;
  root_type TEXT;
  others    INTEGER;
BEGIN
  SELECT id, tenant_type INTO root_id, root_type
    FROM tenants
   WHERE slug = 'platform' AND parent_tenant_id IS NULL
   FOR UPDATE;

  IF root_id IS NOT NULL AND root_type <> 'platform' THEN
    SELECT count(*) INTO others
      FROM tenants
     WHERE tenant_type = 'platform' AND id <> root_id;
    IF others > 0 THEN
      RAISE EXCEPTION
        'no se puede promover el tenant ''platform'': ya hay % tenant(s) de tipo platform y D4 admite uno solo',
        others
        USING HINT = 'Revisa SELECT slug, parent_tenant_id FROM tenants WHERE tenant_type = ''platform'' y deja una sola raíz antes de migrar.';
    END IF;

    UPDATE tenants SET tenant_type = 'platform' WHERE id = root_id;

    INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
    VALUES (
      root_id,
      NULL,
      'tenant.type.changed',
      'tenant',
      root_id::text,
      jsonb_build_object(
        'from', root_type,
        'to', 'platform',
        'source', 'migration:0049_platform_root'
      )
    );
  END IF;

  SELECT count(*) INTO others FROM tenants WHERE tenant_type = 'platform';
  IF others > 1 THEN
    RAISE EXCEPTION 'hay % tenants de tipo platform y D4 admite uno solo', others
      USING HINT = 'Revisa SELECT slug, parent_tenant_id FROM tenants WHERE tenant_type = ''platform'' y deja una sola raíz antes de migrar.';
  END IF;

  IF EXISTS (SELECT 1 FROM tenants WHERE tenant_type = 'platform' AND parent_tenant_id IS NOT NULL) THEN
    RAISE EXCEPTION 'el tenant de tipo platform tiene padre y D4 lo exige raíz'
      USING HINT = 'Revisa SELECT slug, parent_tenant_id FROM tenants WHERE tenant_type = ''platform''.';
  END IF;
END $$;
