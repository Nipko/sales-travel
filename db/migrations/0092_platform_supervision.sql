-- 0092_platform_supervision.sql
-- Varios superadmins, el superadmin supervisado y la auditoría clara de lo que hace la plataforma.
-- Diseño acordado con el founder el 2026-11-05: docs/platform/16-roles-y-superadmins.md.
--
-- Qué resuelve:
--
--   1. Superadmin pleno y superadmin SUPERVISADO. Los dos son memberships con rol `superadmin` en el
--      tenant `platform` (0025 sigue mandando: un rol de plataforma sólo vive ahí); el supervisado
--      lleva `platform_supervised = true`. Ve toda la consola y opera, pero los cambios sensibles
--      (gobierno de proveedores y formas de pago, habilitación de proveedores, levantar un apagado de
--      emergencia, dar o quitar superadmins, suspender cuentas) no se aplican: quedan como una
--      solicitud en `platform_change_requests` que otro superadmin PLENO aprueba o rechaza.
--
--   2. Cambios hechos directo en la base, fuera del panel. Hoy un `UPDATE provider_accounts SET
--      config = …` corrido por SSH en el VPS no deja rastro. Un trigger en las tablas sensibles deja
--      `db.direct_change` en domain_events cuando quien escribe NO es la API (`session_user` distinto
--      de `app_user`): una consola psql, una migración, un seed. La API ya deja su propio evento
--      (con quién, antes y después) y no se duplica. Nunca guarda un secreto: las columnas cifradas
--      sólo dicen que cambiaron.
--
--   3. Plataforma → Actividad: "Sólo superadmins". admin_audit_events gana un filtro por quien actuó
--      (un superadmin, pleno o supervisado, o un cambio directo en la base) y devuelve el tipo de
--      superadmin de quien actuó, para marcarlo en la lista.
--
-- search_path = pg_catalog, public, pg_temp en todas (posterior a 0060: ver
-- apps/api/src/database/migrations-search-path.test.ts).

-- ============================================================================
-- 1. El superadmin supervisado
-- ============================================================================
ALTER TABLE memberships
  ADD COLUMN platform_supervised BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_platform_supervised_role
  CHECK (NOT platform_supervised OR role = 'superadmin');

COMMENT ON COLUMN memberships.platform_supervised IS
  'Superadmin supervisado: ve y opera la consola, pero sus cambios sensibles quedan como solicitud (platform_change_requests) que aprueba un superadmin pleno. Sólo con rol superadmin. Ver db/migrations/0092.';

-- ¿Quien pide es un superadmin PLENO (no supervisado)? Mismo criterio que is_platform_superadmin (0075).
CREATE FUNCTION is_platform_full_superadmin()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_setting TEXT := current_setting('app.current_user_id', true);
BEGIN
  IF actor_setting IS NULL
     OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.memberships m
      JOIN public.users u   ON u.id = m.user_id
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE m.user_id = actor_setting::uuid
       AND m.role = 'superadmin'
       AND m.status = 'active'
       AND NOT m.platform_supervised
       AND u.status = 'active'
       AND t.tenant_type = 'platform'
  );
END;
$$;

COMMENT ON FUNCTION is_platform_full_superadmin() IS
  '¿El usuario de app.current_user_id es un superadmin PLENO de la plataforma (no supervisado)? Decide quién aprueba las solicitudes de cambio. Ver db/migrations/0092.';

REVOKE ALL ON FUNCTION is_platform_full_superadmin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_platform_full_superadmin() TO app_user;

-- ============================================================================
-- 2. Las solicitudes de cambio del superadmin supervisado
-- ============================================================================
-- `input` es lo que pidió, ya validado por la API, para repetirlo tal cual al aprobar. Nunca lleva
-- secretos: las credenciales de proveedor no pasan por acá (un supervisado no las carga).
CREATE TABLE platform_change_requests (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT         NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)+$' AND char_length(kind) <= 80),
  summary        TEXT         NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 300),
  input          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  requested_by   UUID         NOT NULL REFERENCES users(id),
  status         TEXT         NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'failed')),
  decided_by     UUID         REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT         CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500),
  -- Por qué falló al aplicarse (el mensaje de la API, sin datos del proveedor).
  error          TEXT         CHECK (error IS NULL OR char_length(error) <= 500),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Nadie se aprueba ni se rechaza a sí mismo (cancelar la propia es `cancelled`, sin decided_by).
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE INDEX idx_platform_change_requests_status
  ON platform_change_requests (status, created_at DESC);

CREATE TRIGGER platform_change_requests_set_updated_at
  BEFORE UPDATE ON platform_change_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE platform_change_requests IS
  'Cambios sensibles pedidos por un superadmin supervisado, a la espera de que un superadmin pleno los apruebe (se aplican con el input guardado) o los rechace. Cada paso deja su evento platform.change_request.*. Ver db/migrations/0092.';

ALTER TABLE platform_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_change_requests FORCE ROW LEVEL SECURITY;

-- La leen todos los superadmins; la escribe un superadmin a su nombre; la decide un pleno.
CREATE POLICY platform_change_requests_read ON platform_change_requests
  FOR SELECT TO app_user
  USING (public.is_platform_superadmin());

CREATE POLICY platform_change_requests_insert ON platform_change_requests
  FOR INSERT TO app_user
  WITH CHECK (
    public.is_platform_superadmin()
    AND requested_by::text = current_setting('app.current_user_id', true)
    AND status = 'pending'
  );

CREATE POLICY platform_change_requests_update ON platform_change_requests
  FOR UPDATE TO app_user
  USING (public.is_platform_superadmin())
  WITH CHECK (
    public.is_platform_full_superadmin()
    OR (status = 'cancelled' AND requested_by::text = current_setting('app.current_user_id', true))
  );

GRANT SELECT, INSERT, UPDATE ON platform_change_requests TO app_user;
REVOKE DELETE ON platform_change_requests FROM app_user;

-- ============================================================================
-- 3. Cambios hechos directo en la base
-- ============================================================================
-- AFTER por fila. TG_ARGV: las columnas secretas de la tabla, que nunca se copian (sólo se dice que
-- cambiaron). Se calla cuando escribe la API, que ya deja su propio evento: la API entra como
-- app_user (`session_user`, que vale también dentro de una SECURITY DEFINER, donde current_user es el
-- dueño) y los tests de integración, como superusuario con SET ROLE app_user (`current_user`). Por
-- eso esta función NO es SECURITY DEFINER: current_user tiene que ser el de quien cambió la fila.
-- Fuera de la API ése es el superusuario o el dueño de las tablas, que escriben en domain_events.
--
-- El nodo del evento es la columna tenant_id de la fila, si la tiene; si no, ninguno (plataforma).
-- `updated_at` no cuenta como cambio. Un UPDATE que no cambia nada no deja evento.
CREATE FUNCTION audit_direct_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_old      JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_new      JSONB := CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN to_jsonb(NEW) ELSE NULL END;
  v_row      JSONB;
  v_secret   TEXT;
  v_secrets  TEXT[] := COALESCE(TG_ARGV, ARRAY[]::text[]);
  v_secret_changed TEXT[] := ARRAY[]::text[];
  v_changes  JSONB := '{}'::jsonb;
  v_key      TEXT;
  v_id       TEXT;
  v_tenant   UUID;
BEGIN
  IF session_user = 'app_user' OR current_user = 'app_user' THEN
    RETURN NULL;
  END IF;
  -- Una herramienta que ya deja su propio evento por cada cambio (tools/seed-superadmin) lo dice en
  -- su transacción. Sólo lo puede poner quien ya escribe directo en la base: no oculta nada que esa
  -- persona no pudiera ocultar apagando el trigger.
  IF current_setting('app.direct_change_audited', true) = 'on' THEN
    RETURN NULL;
  END IF;

  -- En memberships sólo importan los roles de plataforma: el resto lo administra cada red.
  IF TG_TABLE_NAME = 'memberships'
     AND COALESCE(v_old ->> 'role', '') NOT IN ('superadmin', 'platform_admin')
     AND COALESCE(v_new ->> 'role', '') NOT IN ('superadmin', 'platform_admin') THEN
    RETURN NULL;
  END IF;

  FOREACH v_secret IN ARRAY v_secrets LOOP
    IF (v_old -> v_secret) IS DISTINCT FROM (v_new -> v_secret) THEN
      v_secret_changed := v_secret_changed || v_secret;
    END IF;
    v_old := v_old - v_secret;
    v_new := v_new - v_secret;
  END LOOP;

  FOR v_key IN
    SELECT k FROM (
      SELECT jsonb_object_keys(COALESCE(v_old, '{}'::jsonb)) AS k
      UNION
      SELECT jsonb_object_keys(COALESCE(v_new, '{}'::jsonb))
    ) keys
    WHERE k NOT IN ('updated_at', 'created_at')
  LOOP
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('before', v_old -> v_key, 'after', v_new -> v_key));
    END IF;
  END LOOP;

  IF v_changes = '{}'::jsonb AND cardinality(v_secret_changed) = 0 THEN
    RETURN NULL;
  END IF;

  v_row := COALESCE(v_new, v_old);
  v_id := COALESCE(
    v_row ->> 'id',
    v_row ->> 'tenant_id',
    v_row ->> 'provider_code',
    v_row ->> 'profile_id'
  );
  IF (v_row ->> 'tenant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_tenant := (v_row ->> 'tenant_id')::uuid;
    -- Un nodo que ya no existe (DELETE en cascada) no puede ser el del evento.
    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_tenant) THEN
      v_tenant := NULL;
    END IF;
  END IF;

  INSERT INTO public.domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload, meta)
  VALUES (
    v_tenant,
    NULL,
    'db.direct_change',
    TG_TABLE_NAME,
    left(v_id, 100),
    jsonb_build_object(
      'table', TG_TABLE_NAME,
      'operation', lower(TG_OP),
      'changes', v_changes,
      'secretColumnsChanged', to_jsonb(v_secret_changed),
      'dbUser', session_user::text,
      'application', NULLIF(current_setting('application_name', true), '')
    ),
    jsonb_build_object(
      'ip', host(inet_client_addr()),
      'userAgent', NULL,
      'requestId', NULL
    )
  );
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION audit_direct_change() IS
  'Deja db.direct_change en domain_events cuando una tabla sensible cambia sin pasar por la API (session_user distinto de app_user): quién en la base, desde dónde, y el antes y después de cada columna, sin las secretas (TG_ARGV), que sólo se nombran. Ver db/migrations/0092.';

REVOKE ALL ON FUNCTION audit_direct_change() FROM PUBLIC;

CREATE TRIGGER provider_accounts_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON provider_accounts
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change('credentials_enc');

CREATE TRIGGER provider_enablement_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON provider_enablement
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

CREATE TRIGGER provider_kill_switches_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON provider_kill_switches
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

CREATE TRIGGER payment_method_rules_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON payment_method_rules
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

CREATE TRIGGER governance_profiles_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON governance_profiles
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

CREATE TRIGGER governance_profile_items_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON governance_profile_items
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

CREATE TRIGGER tenant_governance_profiles_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON tenant_governance_profiles
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

CREATE TRIGGER memberships_platform_direct_change
  AFTER INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION audit_direct_change();

-- ============================================================================
-- 4. Plataforma → Actividad: "Sólo superadmins" y el tipo de superadmin de quien actuó
-- ============================================================================
-- Igual que 0078, más:
--   - p_platform_only: sólo lo que hizo alguien que es o fue superadmin (una membership superadmin en
--     el tenant platform, de cualquier estado: lo que hizo uno que ya no lo es sigue contando) y los
--     cambios directos en la base (`db.`), que hace quien tiene acceso al servidor;
--   - actor_platform_role: 'superadmin' (pleno), 'supervised' o NULL, según su membership de HOY.
DROP FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer);

CREATE FUNCTION admin_audit_events(
  p_from             TIMESTAMPTZ,
  p_to               TIMESTAMPTZ,
  p_type_prefixes    TEXT[],
  p_exclude_prefixes TEXT[],
  p_event_type       TEXT,
  p_actor            UUID,
  p_root             UUID,
  p_include_platform BOOLEAN,
  p_aggregate_type   TEXT,
  p_aggregate_id     TEXT,
  p_before           TIMESTAMPTZ,
  p_before_id        UUID,
  p_limit            INTEGER,
  p_platform_only    BOOLEAN DEFAULT false
)
RETURNS TABLE (
  id                  UUID,
  occurred_at         TIMESTAMPTZ,
  event_type          TEXT,
  tenant_id           UUID,
  tenant_name         TEXT,
  actor_user_id       UUID,
  actor_email         TEXT,
  actor_platform_role TEXT,
  target_email        TEXT,
  aggregate_type      TEXT,
  aggregate_id        TEXT,
  payload             JSONB,
  meta                JSONB
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_limit     INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 5001);
  v_root_path public.ltree;
BEGIN
  PERFORM public.platform_console_require_superadmin();

  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_audit_filter_invalid',
      DETAIL = format('desde %s hasta %s', COALESCE(p_from::text, 'NULL'), COALESCE(p_to::text, 'NULL'));
  END IF;
  IF p_to - p_from > interval '93 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_audit_filter_invalid',
      DETAIL = format('el período tiene más de 93 días: desde %s hasta %s', p_from, p_to);
  END IF;
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'admin_audit_filter_invalid',
      DETAIL = 'p_before y p_before_id van juntos';
  END IF;

  IF p_root IS NOT NULL THEN
    SELECT r.path INTO v_root_path FROM public.tenants r WHERE r.id = p_root;
    IF v_root_path IS NULL THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY EXECUTE $q$
    WITH platform_actors AS (
      SELECT pm.user_id,
             bool_or(pm.status = 'active' AND NOT pm.platform_supervised) AS full_now,
             bool_or(pm.status = 'active' AND pm.platform_supervised)     AS supervised_now
        FROM public.memberships pm
        JOIN public.tenants pt ON pt.id = pm.tenant_id AND pt.tenant_type = 'platform'
       WHERE pm.role = 'superadmin'
       GROUP BY pm.user_id
    ),
    page AS (
      SELECT e.id, e.occurred_at, e.event_type, e.tenant_id, t.name AS tenant_name,
             e.actor_user_id, e.aggregate_type, e.aggregate_id, e.payload, e.meta
        FROM public.domain_events e
        LEFT JOIN public.tenants t ON t.id = e.tenant_id
       WHERE e.occurred_at >= $1
         AND e.occurred_at <  $2
         AND ($11::timestamptz IS NULL OR (e.occurred_at, e.id) < ($11, $12))
         AND (CASE
                WHEN e.tenant_id IS NULL THEN $8
                WHEN $7::public.ltree IS NULL THEN true
                ELSE t.path OPERATOR(public.<@) $7
              END)
         AND ($3::text[] IS NULL
              OR EXISTS (SELECT 1 FROM unnest($3) AS inc(prefix)
                          WHERE starts_with(e.event_type, inc.prefix)))
         AND ($4::text[] IS NULL
              OR NOT EXISTS (SELECT 1 FROM unnest($4) AS exc(prefix)
                              WHERE starts_with(e.event_type, exc.prefix)))
         AND ($5::text IS NULL OR e.event_type = $5)
         AND ($6::uuid IS NULL OR e.actor_user_id = $6)
         AND ($9::text IS NULL OR e.aggregate_type = $9)
         AND ($10::text IS NULL OR e.aggregate_id = $10)
         AND (NOT $14
              OR starts_with(e.event_type, 'db.')
              OR EXISTS (SELECT 1 FROM platform_actors pa WHERE pa.user_id = e.actor_user_id))
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT $13
    )
    SELECT p.id, p.occurred_at, p.event_type, p.tenant_id, p.tenant_name::text, p.actor_user_id,
           u.email::text,
           CASE
             WHEN pa.full_now THEN 'superadmin'
             WHEN pa.supervised_now THEN 'supervised'
             WHEN pa.user_id IS NOT NULL THEN 'former'
             ELSE NULL
           END,
           tu.email::text, p.aggregate_type, p.aggregate_id, p.payload,
           jsonb_build_object(
             'ip',        p.meta -> 'ip',
             'userAgent', p.meta -> 'userAgent',
             'requestId', p.meta -> 'requestId'
           )
      FROM page p
      LEFT JOIN public.users u  ON u.id  = p.actor_user_id
      LEFT JOIN platform_actors pa ON pa.user_id = p.actor_user_id
      LEFT JOIN public.users tu ON tu.id = public.audit_event_target_user(
                                             p.payload, p.aggregate_type, p.aggregate_id,
                                             p.actor_user_id)
     ORDER BY p.occurred_at DESC, p.id DESC
  $q$
  USING p_from, p_to, p_type_prefixes, p_exclude_prefixes, p_event_type, p_actor, v_root_path,
        COALESCE(p_include_platform, false), p_aggregate_type, p_aggregate_id, p_before,
        p_before_id, v_limit, COALESCE(p_platform_only, false);
END;
$$;

COMMENT ON FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer, boolean) IS
  'Plataforma → Actividad: los eventos de domain_events de toda la plataforma en [p_from, p_to) (hasta 93 días), filtrados por prefijos de event_type, tipo exacto, actor, nodo con su subárbol, eventos sin nodo, entidad y, con p_platform_only, sólo lo que hicieron superadmins y los cambios directos en la base. Cada fila trae el nodo, el correo de quien lo hizo, su tipo de superadmin (superadmin, supervised, former o NULL) y el de la cuenta sobre la que se hizo; de meta sólo ip, userAgent y requestId. Sólo el superadmin de la plataforma. Ver db/migrations/0078 y 0092.';

REVOKE ALL ON FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_audit_events(timestamptz, timestamptz, text[], text[], text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer, boolean) TO app_user;
