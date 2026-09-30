-- 0055_non_refundable_rates_permission.sql
-- "Puede reservar tarifas no reembolsables": un permiso por nodo que fija QUIEN LO FINANCIA.
--
-- Pedido del founder del 2026-09-29 (tarifas no reembolsables, punto e): una tarifa no reembolsable
-- cancelada, modificada o no presentada cuesta el 100 % y ese costo sale de la cartera o del crédito
-- de la agencia, que financia su consolidador (o Planetour). Por eso lo decide el mismo que fija la
-- cartera (0052, can_finance_tenant): el superadmin para cualquier nodo, el consolidador para sus
-- agencias y la agencia para sus sub-agencias. Nunca el propio nodo.
--
--   - `allowed` (por defecto, y lo que vale sin fila): la agencia reserva no reembolsables con la
--     confirmación obligatoria del checkout.
--   - `blocked`: la API rechaza el PreBook y el Book de una tarifa no reembolsable de ese nodo, y la
--     web las muestra como no disponibles.
--
-- El bloqueo SE HEREDA hacia abajo: si el consolidador está bloqueado, sus agencias y sub-agencias
-- también, digan lo que digan sus filas. Si no se heredara, una agencia bloqueada se lo saltaría
-- vendiendo desde una sub-agencia que ella misma financia, y el costo le llegaría igual a quien la
-- bloqueó. `non_refundable_rates_block` responde si rige y de dónde (el propio nodo o uno de arriba).
--
-- CONTRATO CON LA API. Fijarlo corre con `app.current_user_id` de quien actúa y `app.current_tenant_id`
-- del nodo (DatabaseService.withRequestContext), como las carteras (0052). La reserva lo lee con el
-- tenant de la agencia (withTenant). El `domain_event` de cada cambio lo escribe la API en la misma
-- transacción (booking.permissions.non_refundable_rates.changed).
--
-- Errores: escribir sin ser quien financia lo frena la RLS (42501). La API lo pregunta antes para
-- responder 403 con motivo (BOOKING_PERMISSIONS_FINANCIER_REQUIRED).

-- ============================================================================
-- 1. La tabla
-- ============================================================================
CREATE TABLE tenant_booking_permissions (
  tenant_id             UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  non_refundable_rates  TEXT         NOT NULL DEFAULT 'allowed',
  -- Sin ON DELETE: quién fijó un permiso que decide sobre plata no se pierde borrando un usuario.
  updated_by            UUID         NOT NULL REFERENCES users(id),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT tenant_booking_permissions_non_refundable_rates_check
    CHECK (non_refundable_rates IN ('allowed', 'blocked'))
);

COMMENT ON TABLE tenant_booking_permissions IS
  'Permisos de reserva de un nodo que fija quien lo financia (can_finance_tenant, 0052). Sin fila rige lo de por defecto. Ver db/migrations/0055.';
COMMENT ON COLUMN tenant_booking_permissions.non_refundable_rates IS
  'allowed | blocked: si el nodo puede reservar tarifas no reembolsables. Un blocked rige también para todo lo que cuelga del nodo (non_refundable_rates_block).';
COMMENT ON COLUMN tenant_booking_permissions.updated_by IS
  'El usuario que fijó el valor vigente: siempre el del request (trigger tenant_booking_permissions_guard).';
COMMENT ON COLUMN tenant_booking_permissions.updated_at IS
  'Cuándo se fijó el valor vigente. Lo pone la base.';

-- ============================================================================
-- 2. La guarda: el nodo no cambia y el cambio lo firma quien actúa
-- ============================================================================
-- SECURITY INVOKER: `current_role_bypasses_rls` (0052) mira al rol que escribe. Las migraciones, los
-- seeds y la consola del operador (que se saltan la RLS) pueden firmar a nombre de otro usuario.
CREATE FUNCTION tenant_booking_permissions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_setting TEXT := current_setting('app.current_user_id', true);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION USING
      ERRCODE    = 'STW01',
      CONSTRAINT = 'booking_permissions_tenant_immutable',
      TABLE      = 'tenant_booking_permissions',
      MESSAGE    = 'el nodo de un permiso de reserva no cambia',
      DETAIL     = format('permiso del tenant %s → %s', OLD.tenant_id, NEW.tenant_id);
  END IF;

  IF NOT current_role_bypasses_rls()
     AND (actor_setting IS NULL
          OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR NEW.updated_by IS DISTINCT FROM actor_setting::uuid) THEN
    RAISE EXCEPTION USING
      ERRCODE    = '42501',
      CONSTRAINT = 'booking_permissions_author',
      TABLE      = 'tenant_booking_permissions',
      MESSAGE    = 'un permiso de reserva lo firma el usuario que actúa',
      DETAIL     = format('permiso del tenant %s: firmado por %s, actúa %s',
                          NEW.tenant_id, NEW.updated_by, COALESCE(actor_setting, 'ninguno'));
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tenant_booking_permissions_guard() IS
  'Trigger de tenant_booking_permissions: el nodo no cambia (STW01 booking_permissions_tenant_immutable), el cambio lo firma el usuario del request (42501 booking_permissions_author, salvo un rol que se salta la RLS) y la hora la pone la base. Ver db/migrations/0055.';

CREATE TRIGGER tenant_booking_permissions_guard
  BEFORE INSERT OR UPDATE ON tenant_booking_permissions
  FOR EACH ROW EXECUTE FUNCTION tenant_booking_permissions_guard();

-- ============================================================================
-- 3. La RLS
-- ============================================================================
--   - leer: el propio nodo (tenant del request), quien administra un ancestro (can_read_membership) y
--     quien lo financia;
--   - fijar (insertar o cambiar): sólo quien lo financia (can_finance_tenant);
--   - borrar: nadie desde la aplicación. Volver a `allowed` es un cambio más, con su rastro.
ALTER TABLE tenant_booking_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_booking_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_booking_permissions_read ON tenant_booking_permissions
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR can_read_membership(tenant_id)
    OR can_finance_tenant(tenant_id)
  );

CREATE POLICY tenant_booking_permissions_insert ON tenant_booking_permissions
  FOR INSERT
  WITH CHECK (can_finance_tenant(tenant_id));

CREATE POLICY tenant_booking_permissions_update ON tenant_booking_permissions
  FOR UPDATE
  USING (can_finance_tenant(tenant_id))
  WITH CHECK (can_finance_tenant(tenant_id));

COMMENT ON POLICY tenant_booking_permissions_read ON tenant_booking_permissions IS
  'El nodo ve el suyo; quien administra un ancestro o lo financia, también.';
COMMENT ON POLICY tenant_booking_permissions_insert ON tenant_booking_permissions IS
  'Sólo quien financia al nodo (can_finance_tenant) le fija un permiso de reserva.';
COMMENT ON POLICY tenant_booking_permissions_update ON tenant_booking_permissions IS
  'Sólo quien financia al nodo (can_finance_tenant) le cambia un permiso de reserva.';

REVOKE DELETE ON tenant_booking_permissions FROM app_user;

-- ============================================================================
-- 4. ¿Rige un bloqueo para el nodo?
-- ============================================================================
-- 'own' si el propio nodo está bloqueado; 'inherited' si lo está un ancestro (y el nodo no); NULL si
-- ninguno. SECURITY DEFINER para ver las filas de los ancestros, que la RLS del nodo no muestra;
-- devuelve sólo eso, nunca cuál ancestro ni quién lo fijó.
--
-- Sólo responde por un nodo que quien pregunta puede ver: el tenant del request, uno que administra
-- (can_read_membership) o uno que financia. Por cualquier otro LANZA en vez de responder NULL: un
-- NULL diría "permitido", y una llamada mal cableada (sin el tenant fijado) dejaría reservar lo que
-- estaba bloqueado.
CREATE FUNCTION non_refundable_rates_block(p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  result TEXT;
BEGIN
  IF p_tenant_id IS NULL
     OR NOT (p_tenant_id::text = current_setting('app.current_tenant_id', true)
             OR can_read_membership(p_tenant_id)
             OR can_finance_tenant(p_tenant_id)) THEN
    RAISE EXCEPTION USING
      ERRCODE    = '42501',
      CONSTRAINT = 'booking_permissions_scope',
      MESSAGE    = 'no se puede consultar el permiso de reserva de un nodo ajeno',
      DETAIL     = format('tenant %s, tenant del request %s', p_tenant_id,
                          COALESCE(current_setting('app.current_tenant_id', true), 'ninguno'));
  END IF;

  SELECT CASE WHEN bool_or(a.id = t.id) THEN 'own' ELSE 'inherited' END
    INTO result
    FROM tenants t
    JOIN tenants a ON a.path OPERATOR(public.@>) t.path
    JOIN tenant_booking_permissions p ON p.tenant_id = a.id
   WHERE t.id = p_tenant_id
     AND p.non_refundable_rates = 'blocked'
  HAVING count(*) > 0;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION non_refundable_rates_block(uuid) IS
  '¿Rige un bloqueo de tarifas no reembolsables para el nodo? own (el propio), inherited (un ancestro) o NULL. Sólo para un nodo que quien pregunta puede ver (tenant del request, can_read_membership o can_finance_tenant); por otro lanza 42501. Ver db/migrations/0055.';

GRANT EXECUTE ON FUNCTION non_refundable_rates_block(uuid) TO app_user;
