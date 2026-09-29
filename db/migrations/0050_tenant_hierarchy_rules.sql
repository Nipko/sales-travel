-- 0050_tenant_hierarchy_rules.sql
-- Qué tipo de nodo puede colgar de cuál (D4 A, jerarquía estricta) y las sucursales de Planetour.
--
-- Hasta ahora cualquiera que escribiera en `tenants` elegía el tipo y el padre que quisiera: un admin
-- podía crear por API un hijo 'consolidator' o 'platform' (G-05), saltándose la regla de dueño de TBO
-- y el control de roles de 0025, y "Gestión de Agencias" creaba agencias raíz sueltas que no heredan
-- nada de Planetour (G-07). La regla pasa a la base, donde no depende de que cada endpoint la
-- recuerde:
--
--   raíz (sin padre)  → sólo 'platform', y una sola
--   bajo platform     → 'consolidator' y 'agency' (las sucursales incluidas)
--   bajo consolidator → 'agency'
--   bajo agency       → 'subagency'
--   bajo subagency    → nada (máximo 4 niveles)
--
-- Una SUCURSAL (`is_branch`) es una agencia de Planetour con sus propios vendedores: así vende
-- Planetour a nombre propio, porque el superadmin no vende. Sólo cuelga directamente de la
-- plataforma. En esta migración no cambia ni el pricing ni las carteras por serlo.
--
-- Los errores llevan un SQLSTATE propio para que la API los traduzca a un 409 con motivo, y no a un
-- 500 genérico:
--
--   STH01  la operación viola una regla de la jerarquía. `CONSTRAINT` dice cuál (la API la publica
--          como motivo máquina, en mayúsculas). MESSAGE y HINT van en castellano y sin ids; DETAIL
--          lleva el id y los tipos, para los logs.
--   STH02  mover un nodo está bloqueado por reservas abiertas (0051).
--
-- Lo que YA existe y no cumple la matriz (una agencia raíz suelta, por ejemplo) no se toca: el
-- trigger sólo mira las filas que se insertan o que cambian de tipo, padre o marca de sucursal. Al
-- final se emite un WARNING por cada nodo así, para moverlo desde el panel del superadmin (0051).

-- ============================================================================
-- 1. Una sola plataforma, y sin padre
-- ============================================================================
-- La unicidad es el índice y no el trigger: resuelve también la carrera de dos altas simultáneas
-- (ninguna ve la fila sin confirmar de la otra) y deja que un seed haga "buscar o crear" con
-- `INSERT ... ON CONFLICT DO NOTHING` sin abortar su transacción. La API traduce su violación
-- (23505 sobre este índice) al mismo motivo que las reglas del trigger.
CREATE UNIQUE INDEX uq_tenants_single_platform
  ON tenants (tenant_type)
  WHERE tenant_type = 'platform';

COMMENT ON INDEX uq_tenants_single_platform IS
  'D4 A: un solo tenant de tipo platform (Planetour), raíz de toda la red. Ver db/migrations/0050.';

-- Respaldo sin trigger de la regla `tenant_platform_is_root` (el trigger de abajo da el error
-- legible antes).
ALTER TABLE tenants
  ADD CONSTRAINT tenants_platform_is_root
  CHECK (tenant_type <> 'platform' OR parent_tenant_id IS NULL);

COMMENT ON COLUMN tenants.tenant_type IS
  'platform (raíz única, Planetour) | consolidator | agency | subagency. Qué cuelga de qué lo valida el trigger tenants_enforce_hierarchy (0050).';
COMMENT ON COLUMN tenants.parent_tenant_id IS
  'Padre en la jerarquía B2B2B. NULL sólo para la raíz platform (D4 A): una raíz de otro tipo es legado y se mueve con move_tenant_subtree (0051).';

-- ============================================================================
-- 2. Sucursales
-- ============================================================================
ALTER TABLE tenants
  ADD COLUMN is_branch BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_branch_is_agency
  CHECK (NOT is_branch OR tenant_type = 'agency');

COMMENT ON COLUMN tenants.is_branch IS
  'Sucursal de Planetour: agencia hija directa de la plataforma con sus propios vendedores; así vende Planetour a nombre propio. La UI la muestra como "Sucursal". Ver db/migrations/0050.';

-- ============================================================================
-- 3. La matriz D4
-- ============================================================================
-- Devuelve el nombre de la regla que viola un nodo de tipo `p_type` (sucursal o no) colgado de uno de
-- tipo `p_parent_type` (NULL = raíz), o NULL si puede. Pura: la usan el trigger, move_tenant_subtree
-- (0051) y el aviso del final, y la puede usar la API para ofrecer sólo los tipos válidos. No mira si
-- ya existe otra plataforma: eso es estado, y lo decide el índice de arriba.
CREATE FUNCTION tenant_hierarchy_rule(p_type TEXT, p_is_branch BOOLEAN, p_parent_type TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_is_branch, false) AND p_type IS DISTINCT FROM 'agency'
      THEN 'tenant_branch_type'
    WHEN p_type = 'platform' AND p_parent_type IS NOT NULL
      THEN 'tenant_platform_is_root'
    WHEN p_type = 'platform'
      THEN NULL
    WHEN p_parent_type IS NULL
      THEN 'tenant_root_must_be_platform'
    WHEN COALESCE(p_is_branch, false) AND p_parent_type <> 'platform'
      THEN 'tenant_branch_parent'
    WHEN p_parent_type = 'platform'     AND p_type IN ('consolidator', 'agency') THEN NULL
    WHEN p_parent_type = 'consolidator' AND p_type = 'agency'                    THEN NULL
    WHEN p_parent_type = 'agency'       AND p_type = 'subagency'                 THEN NULL
    ELSE 'tenant_parent_type'
  END;
$$;

COMMENT ON FUNCTION tenant_hierarchy_rule(text, boolean, text) IS
  'Matriz D4: regla que viola un nodo de tipo p_type (sucursal si p_is_branch) bajo un padre de tipo p_parent_type (NULL = raíz), o NULL si es válido. Ver db/migrations/0050.';

-- ============================================================================
-- 4. El error
-- ============================================================================
-- Un solo sitio que arma el error STH01, para que el trigger, el de `path` y move_tenant_subtree
-- digan lo mismo con el mismo código. `CONSTRAINT` es el nombre de la regla.
CREATE FUNCTION raise_tenant_hierarchy_violation(
  p_rule        TEXT,
  p_tenant_id   UUID,
  p_type        TEXT,
  p_parent_type TEXT
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  msg TEXT;
BEGIN
  msg := CASE p_rule
    WHEN 'tenant_root_must_be_platform' THEN
      format('sólo la plataforma puede ser raíz: un nodo de tipo %s tiene que colgar de la red', p_type)
    WHEN 'tenant_platform_is_root' THEN
      'la plataforma es la raíz de la red: no puede colgar de otro nodo'
    WHEN 'tenant_branch_type' THEN
      format('una sucursal es una agencia: no puede ser de tipo %s', p_type)
    WHEN 'tenant_branch_parent' THEN
      format('una sucursal cuelga directamente de la plataforma, no de un nodo de tipo %s', p_parent_type)
    WHEN 'tenant_parent_type' THEN
      format('un nodo de tipo %s no puede colgar de uno de tipo %s', p_type, p_parent_type)
    WHEN 'tenant_children_type' THEN
      format('el nodo tiene hijos que no pueden colgar de uno de tipo %s', p_type)
    WHEN 'tenant_depth_limit' THEN
      'la red admite como máximo 4 niveles'
    WHEN 'tenant_parent_not_found' THEN
      'el nodo padre no existe'
    WHEN 'tenant_not_found' THEN
      'el nodo no existe'
    WHEN 'tenant_move_cycle' THEN
      'un nodo no puede moverse debajo de sí mismo ni de uno de sus descendientes'
    WHEN 'tenant_move_required' THEN
      'el padre de un nodo sólo cambia con move_tenant_subtree, que recalcula todo su subárbol'
    ELSE 'la operación viola las reglas de la red'
  END;

  RAISE EXCEPTION USING
    ERRCODE    = 'STH01',
    CONSTRAINT = p_rule,
    TABLE      = 'tenants',
    MESSAGE    = msg,
    DETAIL     = format('tenant %s (tipo %s), padre de tipo %s',
                        COALESCE(p_tenant_id::text, '?'),
                        COALESCE(p_type, '?'),
                        COALESCE(p_parent_type, 'ninguno (raíz)')),
    HINT       = 'Bajo la plataforma cuelgan consolidadores y agencias (las sucursales incluidas); bajo un consolidador, agencias; bajo una agencia, sub-agencias. Máximo 4 niveles.';
END;
$$;

COMMENT ON FUNCTION raise_tenant_hierarchy_violation(text, uuid, text, text) IS
  'Lanza el error STH01 de la regla p_rule (CONSTRAINT = p_rule), con mensaje en castellano sin ids y el detalle para los logs. Ver db/migrations/0050.';

-- ============================================================================
-- 5. El trigger
-- ============================================================================
-- Valida la fila nueva o la que cambia de tipo, padre o marca de sucursal:
--
--   - la matriz contra el tipo del padre;
--   - la profundidad (el padre en el nivel 4 no admite hijos);
--   - si cambia el TIPO, que los hijos que ya tiene sigan cabiendo debajo.
--
-- El padre se lee `FOR SHARE`: mientras la fila no se confirme, nadie le cambia el tipo; y si alguien
-- lo está cambiando, se espera y se valida contra el tipo nuevo. Sin eso, un alta de sub-agencia y el
-- paso de su padre a consolidador podían confirmarse a la vez y dejar la combinación prohibida.
--
-- SECURITY DEFINER (owner = postgres) para que las comprobaciones vean todas las filas (padre e
-- hijos) aunque algún día `tenants` tenga RLS. Se dispara antes que `tenants_maintain_path` (orden
-- alfabético), así que una regla violada sale con su error y no con el de `path`.
CREATE FUNCTION tenants_enforce_hierarchy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parent_type TEXT;
  parent_path LTREE;
  rule        TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tenant_type      IS NOT DISTINCT FROM OLD.tenant_type
     AND NEW.parent_tenant_id IS NOT DISTINCT FROM OLD.parent_tenant_id
     AND NEW.is_branch        IS NOT DISTINCT FROM OLD.is_branch THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_tenant_id IS NOT NULL THEN
    SELECT p.tenant_type, p.path INTO parent_type, parent_path
      FROM tenants p
     WHERE p.id = NEW.parent_tenant_id
       FOR SHARE;
    IF NOT FOUND THEN
      PERFORM raise_tenant_hierarchy_violation('tenant_parent_not_found', NEW.id, NEW.tenant_type, NULL);
    END IF;
  END IF;

  rule := tenant_hierarchy_rule(NEW.tenant_type, NEW.is_branch, parent_type);
  IF rule IS NOT NULL THEN
    PERFORM raise_tenant_hierarchy_violation(rule, NEW.id, NEW.tenant_type, parent_type);
  END IF;

  IF parent_path IS NOT NULL AND nlevel(parent_path) >= 4 THEN
    PERFORM raise_tenant_hierarchy_violation('tenant_depth_limit', NEW.id, NEW.tenant_type, parent_type);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.tenant_type IS DISTINCT FROM OLD.tenant_type
     AND EXISTS (
       SELECT 1
         FROM tenants c
        WHERE c.parent_tenant_id = NEW.id
          AND tenant_hierarchy_rule(c.tenant_type, c.is_branch, NEW.tenant_type) IS NOT NULL
     ) THEN
    PERFORM raise_tenant_hierarchy_violation('tenant_children_type', NEW.id, NEW.tenant_type, parent_type);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tenants_enforce_hierarchy() IS
  'Trigger de tenants: valida la matriz D4 (tenant_hierarchy_rule), la profundidad y los hijos de un nodo que cambia de tipo. Errores STH01. La plataforma única la garantiza uq_tenants_single_platform. Ver db/migrations/0050.';

CREATE TRIGGER tenants_enforce_hierarchy
  BEFORE INSERT OR UPDATE OF tenant_type, parent_tenant_id, is_branch ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_enforce_hierarchy();

-- ============================================================================
-- 6. Aviso de lo que ya existe fuera de la matriz
-- ============================================================================
-- No se corrige nada: mover un nodo o cambiarle el tipo cambia de quién hereda credenciales, reglas
-- y marca, y eso lo decide el superadmin desde el panel (move_tenant_subtree, 0051). Sólo queda en
-- el log de la migración qué nodos revisar.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.slug, c.tenant_type, c.is_branch, p.tenant_type AS parent_type,
           tenant_hierarchy_rule(c.tenant_type, c.is_branch, p.tenant_type) AS rule
      FROM tenants c
      LEFT JOIN tenants p ON p.id = c.parent_tenant_id
     WHERE tenant_hierarchy_rule(c.tenant_type, c.is_branch, p.tenant_type) IS NOT NULL
     ORDER BY c.path
  LOOP
    RAISE WARNING
      'REVISAR (D4): el tenant % (tipo %) bajo un padre de tipo % viola %: corrígelo desde el panel del superadmin (moverlo o cambiarle el tipo)',
      r.slug, r.tenant_type, COALESCE(r.parent_type, 'ninguno (raíz)'), r.rule;
  END LOOP;
END $$;
