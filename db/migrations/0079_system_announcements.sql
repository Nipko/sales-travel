-- 0079_system_announcements.sql
-- Anuncios de la plataforma: un aviso que ve dentro del panel toda la red, o un nodo y todo lo que
-- cuelga de él, y opcionalmente sólo sus administradores.
--
-- Qué resuelve: el founder no tenía cómo avisarle a la red de un mantenimiento, de un proveedor caído
-- o de un cambio de política sin escribirle a cada agencia por fuera. Con esto lo publica desde
-- Plataforma → Sistema › Anuncios y aparece como una franja debajo de la barra superior del panel de
-- cada usuario alcanzado, desde `starts_at` hasta `ends_at` (como mucho 31 días) o hasta que lo
-- archive.
--
-- Escribe y lee la tabla sólo el superadmin de la plataforma (is_platform_superadmin(), 0075): nadie
-- más la lee directo. Lo que ve el resto pasa por active_announcements(), SECURITY DEFINER y sin
-- parámetros: toma el usuario y el nodo activo del request (app.current_user_id y
-- app.current_tenant_id, que fija la API después de validar la sesión), así que nadie puede preguntar
-- por los anuncios de otra red. Devuelve sólo lo que se muestra (gravedad, título, mensaje y
-- vigencia), nunca a quién iba dirigido ni quién lo escribió.
--
-- Nada de esto vende: es un aviso de texto plano. La API limpia los caracteres de control y el panel
-- lo pinta como texto (sin HTML ni enlaces automáticos); los CHECK de abajo son la última defensa.
--
-- El rastro (quién publicó, cambió o archivó qué, a quién iba y con qué gravedad; nunca el mensaje)
-- queda en domain_events: la API escribe `platform.announcement.published`, `.updated` y `.archived`
-- en la misma transacción que el cambio, en la raíz `platform`.

-- ============================================================================
-- 1. Los anuncios
-- ============================================================================
CREATE TABLE system_announcements (
  id                       UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  severity                 TEXT          NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- Texto plano en una línea: sin caracteres de control (tampoco saltos de línea).
  title                    VARCHAR(120)  NOT NULL
                                         CHECK (btrim(title) <> '' AND title !~ '[[:cntrl:]]'),
  -- Texto plano; se admiten saltos de línea y nada más de los caracteres de control.
  body                     VARCHAR(600)  NOT NULL DEFAULT ''
                                         CHECK (body !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  -- NULL = toda la red. Si no, ese nodo y todo su subárbol. Se va con el nodo.
  audience_root_tenant_id  UUID          NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Sólo quienes tienen un rol de administración en el nodo o en uno de sus ancestros.
  audience_admins_only     BOOLEAN       NOT NULL DEFAULT false,
  starts_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  ends_at                  TIMESTAMPTZ   NOT NULL,
  -- Quién lo publicó. Sin ON DELETE, como provider_kill_switches (0077): el rastro no se pierde.
  created_by               UUID          NOT NULL REFERENCES users(id),
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Archivado: deja de mostrarse en el acto y no vuelve. NULL = no archivado.
  archived_at              TIMESTAMPTZ   NULL,
  -- Un aviso es de corta vida: un mes como mucho. Uno permanente se vuelve ruido que nadie lee.
  CONSTRAINT system_announcements_window
    CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '31 days')
);

COMMENT ON TABLE system_announcements IS
  'Anuncios de la plataforma para toda la red (audience_root_tenant_id NULL) o para un nodo y su subárbol, opcionalmente sólo para administradores. Sólo los lee y escribe el superadmin; el resto los ve por active_announcements(). Ver db/migrations/0079.';
COMMENT ON COLUMN system_announcements.audience_root_tenant_id IS
  'NULL = toda la red. Si no, el nodo raíz del público: él y todo lo que cuelga de él.';
COMMENT ON COLUMN system_announcements.audience_admins_only IS
  'true = sólo quien tiene una membership activa de administración (ADMIN_ROLES) en el nodo activo o en un ancestro.';

-- Lo vigente (no archivado) por vencimiento, para active_announcements(); el panel lista los
-- últimos por fecha de creación.
CREATE INDEX system_announcements_live_idx
  ON system_announcements (ends_at)
  WHERE archived_at IS NULL;
CREATE INDEX system_announcements_created_idx ON system_announcements (created_at DESC);
CREATE INDEX system_announcements_audience_idx
  ON system_announcements (audience_root_tenant_id)
  WHERE audience_root_tenant_id IS NOT NULL;

-- updated_at al cambiar, y quién lo publicó y cuándo no cambian nunca: un UPDATE no puede dejar el
-- anuncio a nombre de otro.
CREATE FUNCTION system_announcements_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION system_announcements_before_update() IS
  'Trigger de system_announcements: fija updated_at y conserva created_by y created_at. Ver db/migrations/0079.';

REVOKE ALL ON FUNCTION system_announcements_before_update() FROM PUBLIC;

CREATE TRIGGER system_announcements_before_update
  BEFORE UPDATE ON system_announcements
  FOR EACH ROW EXECUTE FUNCTION system_announcements_before_update();

-- ============================================================================
-- 2. Quién lee y quién escribe: sólo el superadmin
-- ============================================================================
ALTER TABLE system_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_announcements FORCE  ROW LEVEL SECURITY;

CREATE POLICY system_announcements_superadmin_read ON system_announcements
  FOR SELECT
  USING (public.is_platform_superadmin());

-- Y la fila tiene que nombrarlo a él: nadie publica a nombre de otro.
CREATE POLICY system_announcements_superadmin_insert ON system_announcements
  FOR INSERT
  WITH CHECK (
    public.is_platform_superadmin()
    AND created_by::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY system_announcements_superadmin_update ON system_announcements
  FOR UPDATE
  USING (public.is_platform_superadmin())
  WITH CHECK (public.is_platform_superadmin());

-- Sin DELETE: archivar es un UPDATE y el anuncio queda para la historia del panel.
REVOKE ALL ON system_announcements FROM app_user;
GRANT SELECT, INSERT, UPDATE ON system_announcements TO app_user;

-- ============================================================================
-- 3. Lo que ve cada usuario
-- ============================================================================
-- Los anuncios vigentes para el usuario del request en su nodo activo: no archivados, con now()
-- entre starts_at y ends_at, dirigidos a toda la red o a un ancestro-o-igual del nodo activo, y los
-- de "sólo administradores" únicamente si el usuario tiene una membership activa con un rol de
-- administración (ADMIN_ROLES de apps/api/src/auth/roles.ts, espejo de is_admin_user()) en el nodo
-- activo o en un ancestro. Los más graves primero y, a igual gravedad, los más nuevos; tres como
-- mucho, que es lo que entra en la franja del panel.
--
-- Sin parámetros: el usuario y el nodo salen del request. Defensa en profundidad: aunque la API ya
-- validó que el usuario opera en ese nodo, acá se vuelve a exigir una membership activa en él o en un
-- ancestro (usuario activo); si no, no devuelve nada. Sin usuario o sin nodo (o con valores que no
-- son UUID), tampoco.
--
-- SECURITY DEFINER para leer la tabla (que sólo lee el superadmin) y memberships sin su RLS. Una
-- sola llamada por pedido: el panel la consulta al abrir y cada 5 minutos.
CREATE FUNCTION active_announcements()
RETURNS TABLE (
  id         UUID,
  severity   TEXT,
  title      TEXT,
  body       TEXT,
  starts_at  TIMESTAMPTZ,
  ends_at    TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  uuid_re      CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  user_setting TEXT := current_setting('app.current_user_id', true);
  node_setting TEXT := current_setting('app.current_tenant_id', true);
  v_user       UUID;
  v_path       public.ltree;
  v_admin      BOOLEAN;
BEGIN
  IF user_setting IS NULL OR user_setting !~* uuid_re
     OR node_setting IS NULL OR node_setting !~* uuid_re THEN
    RETURN;
  END IF;
  v_user := user_setting::uuid;

  SELECT t.path INTO v_path FROM public.tenants t WHERE t.id = node_setting::uuid;
  IF v_path IS NULL THEN
    RETURN;
  END IF;

  -- ¿Opera en ese nodo? Una membership activa en él o en un ancestro, con el usuario activo.
  IF NOT EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.users u    ON u.id = m.user_id
      JOIN public.tenants mt ON mt.id = m.tenant_id
     WHERE m.user_id = v_user
       AND m.status = 'active'
       AND u.status = 'active'
       AND mt.path OPERATOR(public.@>) v_path
  ) THEN
    RETURN;
  END IF;

  v_admin := EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.tenants mt ON mt.id = m.tenant_id
     WHERE m.user_id = v_user
       AND m.status = 'active'
       AND m.role IN ('superadmin', 'platform_admin', 'consolidator_admin',
                      'tenant_admin', 'agency_admin', 'admin')
       AND mt.path OPERATOR(public.@>) v_path
  );

  RETURN QUERY
    SELECT a.id, a.severity, a.title::text, a.body::text, a.starts_at, a.ends_at
      FROM public.system_announcements a
      LEFT JOIN public.tenants r ON r.id = a.audience_root_tenant_id
     WHERE a.archived_at IS NULL
       AND a.starts_at <= now()
       AND a.ends_at > now()
       AND (a.audience_root_tenant_id IS NULL OR r.path OPERATOR(public.@>) v_path)
       AND (NOT a.audience_admins_only OR v_admin)
     ORDER BY CASE a.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
              a.starts_at DESC,
              a.id
     LIMIT 3;
END;
$$;

COMMENT ON FUNCTION active_announcements() IS
  'Hasta 3 anuncios vigentes para app.current_user_id en app.current_tenant_id (toda la red o un ancestro-o-igual del nodo; los de sólo administradores si tiene un rol de administración en el nodo o un ancestro), los más graves primero. Exige una membership activa en el nodo o un ancestro. Ver db/migrations/0079.';

REVOKE ALL ON FUNCTION active_announcements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_announcements() TO app_user;
