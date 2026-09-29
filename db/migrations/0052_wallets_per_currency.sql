-- 0052_wallets_per_currency.sql
-- Carteras por moneda, quién financia a cada nodo y depósitos informados por la agencia.
--
-- Decisión del founder del 2026-09-29 (opción A): la cartera de cada agencia la establece QUIEN LA
-- FINANCIA. Hasta ahora cada tenant tenía UNA cartera (UNIQUE tenant_id, 0010), que la API creaba en
-- COP con cupo 0 la primera vez que alguien la miraba, y la propia agencia se fijaba el cupo y se
-- registraba depósitos y retiros (brecha crítica de la auditoría del 2026-09-28). Esta migración deja
-- en la base:
--
--   1. Una cartera por (tenant, moneda). Las filas que ya existen quedan como la cartera de su moneda
--      actual: no se crea ni se borra ninguna. La moneda y el nodo de una cartera ya no cambian.
--   2. Quién financia a un nodo (tenant_financier_id) y si el usuario del request puede hacerlo
--      (can_finance_tenant).
--   3. La guarda: el cupo y el estado de una cartera, y sus depósitos y ajustes, sólo los escribe
--      quien la financia (o una sesión que se salta la RLS: migraciones, seeds, la consola del
--      operador). La agencia sigue moviendo su saldo con sus reservas (retenciones y liberaciones).
--      El libro de movimientos pasa a ser de sólo agregar para la aplicación, y la aplicación no
--      borra carteras.
--   4. Los depósitos que informa la agencia (portfolio_deposit_reports): nacen pendientes y quien la
--      financia los aprueba o los rechaza una sola vez, con su domain_event.
--
-- El crédito interno de 0007 (tenants.credit_limit) pasa al cupo de la cartera en 0053.
--
-- CONTRATO CON LA API. Las operaciones de quien financia (fijar cupo o estado, depositar, ajustar,
-- resolver un depósito informado) y el informe de un depósito tienen que correr con
-- `app.current_user_id` del usuario que actúa y `app.current_tenant_id` del nodo DUEÑO de la cartera
-- (DatabaseService.withRequestContext({ userId, tenantId })). Con sólo el tenant (withTenant) la base
-- las rechaza: no sabe quién actúa. Los tests que corren como superusuario no lo ven; los que corren
-- como app_user, sí.
--
-- Errores, con SQLSTATE propio para que la API los traduzca con motivo y no como un 500 genérico
-- (mismo esquema que STH01 en 0050): `CONSTRAINT` es el nombre de la regla, MESSAGE y HINT van en
-- castellano y sin ids, DETAIL lleva los ids para los logs.
--
--   STW01  la operación viola una regla de las carteras o de los depósitos informados (409).
--   42501  (insufficient_privilege) con la regla `portfolio_financier_required`: quien actúa no es
--          quien financia a ese nodo; o `deposit_report_resolver` / `portfolio_entry_author`: la
--          resolución o el asiento van a nombre de otro usuario (403).

-- ============================================================================
-- 1. El error
-- ============================================================================
CREATE FUNCTION raise_portfolio_violation(p_rule TEXT, p_table TEXT, p_detail TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  msg    TEXT;
  advice TEXT;
  code   TEXT := 'STW01';
BEGIN
  msg := CASE p_rule
    WHEN 'portfolio_identity_immutable' THEN
      'la moneda y el nodo de una cartera no cambian: para operar en otra moneda se habilita otra cartera'
    WHEN 'portfolio_financier_required' THEN
      'sólo quien financia al nodo puede fijar el cupo o el estado de su cartera y registrarle depósitos o ajustes'
    WHEN 'deposit_report_born_pending' THEN
      'un depósito informado nace pendiente: lo aprueba o lo rechaza quien financia a la agencia'
    WHEN 'deposit_report_not_pending' THEN
      'el depósito informado ya fue resuelto: se aprueba o se rechaza una sola vez'
    WHEN 'deposit_report_transition' THEN
      'un depósito informado sólo pasa de pendiente a aprobado o a rechazado'
    WHEN 'deposit_report_immutable' THEN
      'lo que informó la agencia no se modifica: si está mal, se rechaza y la agencia lo informa de nuevo'
    WHEN 'deposit_report_resolver' THEN
      'quien resuelve un depósito informado tiene que ser el usuario que actúa'
    WHEN 'portfolio_entry_author' THEN
      'un depósito o un ajuste de cartera lo firma el usuario que actúa'
    WHEN 'deposit_report_ledger_entry' THEN
      'la aprobación tiene que apuntar al depósito que acreditó ese monto en esa cartera'
    ELSE 'la operación viola las reglas de las carteras'
  END;
  advice := CASE
    WHEN p_rule = 'portfolio_identity_immutable' THEN
      'El saldo, el cupo y los movimientos de una cartera están en su moneda: para otra moneda, quien financia al nodo le abre otra cartera.'
    WHEN p_rule IN ('portfolio_financier_required', 'deposit_report_resolver', 'portfolio_entry_author') THEN
      'Quien financia a un nodo es su ancestro inmediato: Planetour (su superadmin) para lo que cuelga de la plataforma, el consolidador para sus agencias y la agencia para sus sub-agencias; el superadmin, a todos. La operación corre con app.current_user_id del usuario que actúa y app.current_tenant_id del dueño de la cartera.'
    ELSE
      'Un depósito informado nace pendiente y quien financia a la agencia lo aprueba (con el DEPOSIT_PAYMENT que acredita ese monto en esa cartera) o lo rechaza (con motivo), una sola vez.'
  END;
  IF p_rule IN ('portfolio_financier_required', 'deposit_report_resolver', 'portfolio_entry_author') THEN
    code := '42501';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE    = code,
    CONSTRAINT = p_rule,
    TABLE      = p_table,
    MESSAGE    = msg,
    DETAIL     = p_detail,
    HINT       = advice;
END;
$$;

COMMENT ON FUNCTION raise_portfolio_violation(text, text, text) IS
  'Lanza el error de la regla p_rule de las carteras (STW01, o 42501 si falta ser quien financia), con CONSTRAINT = p_rule, mensaje en castellano sin ids y el detalle para los logs. Ver db/migrations/0052.';

-- ============================================================================
-- 2. ¿Quién financia a un nodo?
-- ============================================================================
-- El ancestro más cercano que puede financiar (platform, consolidator o agency). Con la matriz D4
-- (0050) es siempre el padre: Planetour para sus consolidadores, agencias y sucursales; el
-- consolidador para sus agencias; la agencia para sus sub-agencias. Una sub-agencia no financia a
-- nadie. La raíz no tiene quien la financie (NULL: sólo el superadmin gestiona la cartera de
-- Planetour), y un nodo legado fuera de la matriz (una agencia raíz suelta) tampoco, hasta que el
-- superadmin lo mueva (0051).
--
-- SECURITY DEFINER sólo para no depender de que `tenants` siga sin RLS; devuelve un id y nada más.
CREATE FUNCTION tenant_financier_id(p_tenant_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
    FROM tenants t
    JOIN tenants a
      ON a.path OPERATOR(public.@>) t.path
     AND a.id <> t.id
   WHERE t.id = p_tenant_id
     AND a.tenant_type IN ('platform', 'consolidator', 'agency')
   ORDER BY nlevel(a.path) DESC
   LIMIT 1;
$$;

COMMENT ON FUNCTION tenant_financier_id(uuid) IS
  'Quién financia al nodo: su ancestro más cercano de tipo platform, consolidator o agency (con la matriz D4, su padre). NULL para la raíz y para un nodo legado sin padre. Ver db/migrations/0052.';

GRANT EXECUTE ON FUNCTION tenant_financier_id(uuid) TO app_user;

-- ¿El usuario de `app.current_user_id` puede gestionar la cartera de `p_tenant_id`?
--
--   - el superadmin de la plataforma (membership activa en el tenant de tipo platform, usuario
--     activo), con cualquier nodo, la raíz incluida;
--   - un admin de nodo (consolidator_admin, tenant_admin, agency_admin, admin: AGENCY_ADMIN_ROLES de
--     apps/api/src/auth/roles.ts) con membership activa EN el nodo que lo financia, si ese nodo y sus
--     ancestros están activos (como NetworkService.canManageTenant) y no es la plataforma: lo que
--     cuelga de Planetour lo financia su superadmin.
--
-- Nunca el propio nodo: el admin de una agencia no se financia a sí mismo. Tampoco un ancestro más
-- arriba del que financia: el consolidador no gestiona la cartera de una sub-agencia de su agencia.
-- `platform_admin` está retirado (D7 B) y no cuenta.
--
-- SECURITY DEFINER para leer memberships sin re-disparar su RLS (mismo patrón que
-- can_read_membership, 0020). Sin usuario en el request, false.
CREATE FUNCTION can_finance_tenant(p_tenant_id UUID)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_setting  TEXT := current_setting('app.current_user_id', true);
  actor          UUID;
  financier      UUID;
  financier_type TEXT;
BEGIN
  IF actor_setting IS NULL
     OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  actor := actor_setting::uuid;

  IF p_tenant_id IS NULL OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM memberships m
      JOIN users u   ON u.id = m.user_id
      JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = actor
       AND m.role = 'superadmin'
       AND m.status = 'active'
       AND u.status = 'active'
       AND t.tenant_type = 'platform'
  ) THEN
    RETURN true;
  END IF;

  financier := tenant_financier_id(p_tenant_id);
  IF financier IS NULL THEN
    RETURN false;
  END IF;
  SELECT tenant_type INTO financier_type FROM tenants WHERE id = financier;
  IF financier_type = 'platform' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
           SELECT 1
             FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.user_id = actor
              AND m.tenant_id = financier
              AND m.status = 'active'
              AND u.status = 'active'
              AND m.role IN ('consolidator_admin', 'tenant_admin', 'agency_admin', 'admin')
         )
     AND NOT EXISTS (
           SELECT 1
             FROM tenants f
             JOIN tenants anc ON anc.path OPERATOR(public.@>) f.path
            WHERE f.id = financier
              AND anc.status <> 'active'
         );
END;
$$;

COMMENT ON FUNCTION can_finance_tenant(uuid) IS
  '¿El usuario de app.current_user_id gestiona la cartera del nodo? El superadmin de la plataforma con todos; un admin de nodo (consolidator_admin, tenant_admin, agency_admin, admin) con membership activa en el nodo que lo financia (tenant_financier_id), si ese nodo está activo y no es la plataforma. Nunca el propio nodo. Ver db/migrations/0052.';

GRANT EXECUTE ON FUNCTION can_finance_tenant(uuid) TO app_user;

-- ¿El rol que ejecuta la sentencia se salta la RLS (superusuario o BYPASSRLS)? Son las migraciones,
-- los seeds y la consola del operador: la guarda no los frena, igual que la RLS. SECURITY INVOKER a
-- propósito: `current_user` tiene que ser el de quien escribe. Llamarla sólo desde funciones
-- INVOKER (dentro de una SECURITY DEFINER, `current_user` es su dueño).
CREATE FUNCTION current_role_bypasses_rls()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user),
    false);
$$;

COMMENT ON FUNCTION current_role_bypasses_rls() IS
  '¿El rol que ejecuta la sentencia (current_user) es superusuario o BYPASSRLS? Para que las guardas de 0052 traten como la RLS a migraciones, seeds y la consola del operador. Llamarla sólo desde funciones SECURITY INVOKER.';

-- ============================================================================
-- 3. Una cartera por moneda
-- ============================================================================
-- Monedas en mayúsculas antes de exigirlas así. Como había una cartera por tenant, normalizar no
-- puede juntar dos carteras en la misma moneda.
UPDATE agency_portfolios
   SET currency = upper(btrim(currency))
 WHERE currency IS DISTINCT FROM upper(btrim(currency));

DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT count(*) INTO bad
    FROM agency_portfolios
   WHERE currency !~ '^[A-Z]{3}$'
      OR credit_limit_minor NOT BETWEEN 0 AND 9007199254740991
      OR status NOT IN ('active', 'suspended', 'overlimit');
  IF bad > 0 THEN
    RAISE EXCEPTION '% cartera(s) con moneda, cupo o estado inválidos: no se pueden pasar a carteras por moneda', bad
      USING HINT = 'Revisa SELECT id, tenant_id, currency, credit_limit_minor, status FROM agency_portfolios WHERE currency !~ ''^[A-Z]{3}$'' OR credit_limit_minor < 0 OR status NOT IN (''active'', ''suspended'', ''overlimit'') y corrígelas antes de migrar.';
  END IF;
END $$;

-- Sin moneda por defecto: una cartera sin moneda explícita quedaba en COP sin que nadie lo decidiera.
ALTER TABLE agency_portfolios
  ALTER COLUMN currency DROP DEFAULT,
  ADD CONSTRAINT agency_portfolios_currency_format
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT agency_portfolios_credit_limit_range
    CHECK (credit_limit_minor BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT agency_portfolios_status_check
    CHECK (status IN ('active', 'suspended', 'overlimit'));

ALTER TABLE agency_portfolios DROP CONSTRAINT unique_tenant_portfolio;

ALTER TABLE agency_portfolios
  ADD CONSTRAINT agency_portfolios_tenant_currency_key UNIQUE (tenant_id, currency),
  -- Destino de la FK compuesta de los depósitos informados: el depósito es de ESA cartera, de ese
  -- nodo y en esa moneda.
  ADD CONSTRAINT agency_portfolios_id_tenant_currency_key UNIQUE (id, tenant_id, currency);

COMMENT ON TABLE agency_portfolios IS
  'Carteras B2B: una por (tenant, moneda) desde 0052. Cupo y estado los fija quien financia al nodo (can_finance_tenant); el saldo lo mueven los asientos de portfolio_transactions. Ver db/migrations/0010 y 0052.';
COMMENT ON COLUMN agency_portfolios.currency IS
  'ISO 4217 en mayúsculas. Una cartera por moneda y tenant (agency_portfolios_tenant_currency_key); no cambia nunca (trigger agency_portfolios_keep_identity).';
COMMENT ON COLUMN agency_portfolios.credit_limit_minor IS
  'Cupo de crédito en unidades menores de `currency`. Lo fija sólo quien financia al nodo (trigger agency_portfolios_financier_guard, 0052). Desde 0053 absorbe el crédito interno de tenants.credit_limit.';
COMMENT ON COLUMN agency_portfolios.status IS
  'active | suspended | overlimit. Lo cambia sólo quien financia al nodo (0052).';

-- La moneda y el nodo de una cartera no cambian: su saldo, su cupo y sus movimientos están en esa
-- moneda, y cambiar la etiqueta convertiría 1.000.000 COP en 1.000.000 USD. Vale también para las
-- sesiones privilegiadas.
CREATE FUNCTION agency_portfolios_keep_identity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    PERFORM raise_portfolio_violation(
      'portfolio_identity_immutable',
      'agency_portfolios',
      format('cartera %s: tenant %s → %s, moneda %s → %s',
             OLD.id, OLD.tenant_id, NEW.tenant_id, OLD.currency, NEW.currency));
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION agency_portfolios_keep_identity() IS
  'Trigger de agency_portfolios: la moneda y el tenant de una cartera no cambian (STW01 portfolio_identity_immutable). Ver db/migrations/0052.';

CREATE TRIGGER agency_portfolios_keep_identity
  BEFORE UPDATE OF tenant_id, currency ON agency_portfolios
  FOR EACH ROW EXECUTE FUNCTION agency_portfolios_keep_identity();

-- ============================================================================
-- 4. La guarda: el cupo, el estado, los depósitos y los ajustes son de quien financia
-- ============================================================================
-- Qué frena y qué no:
--
--   - Cartera nueva con cupo o saldo: sólo quien financia. Una VACÍA (cupo 0, saldo 0) no da nada y
--     la puede abrir el propio nodo; qué monedas opera una agencia lo decide la API.
--   - Cambio de cupo o de estado: sólo quien financia. El saldo NO se guarda acá: lo mueven las
--     retenciones y liberaciones de las reservas, que corren con el tenant de la agencia y sin
--     usuario (PortfoliosService.holdBookingIntent, BookingHoldLedger).
--   - Asiento DEPOSIT_PAYMENT o MANUAL_ADJUSTMENT: sólo quien financia. BOOKING_* siguen siendo de la
--     agencia y de los procesos del sistema.
--   - Borrar una cartera o un asiento: nadie desde la aplicación (REVOKE más abajo).
--
-- SECURITY INVOKER: `current_role_bypasses_rls` mira al rol que escribe; can_finance_tenant ya es
-- SECURITY DEFINER.
CREATE FUNCTION agency_portfolios_financier_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.credit_limit_minor = 0 AND NEW.balance_minor = 0 THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.credit_limit_minor IS NOT DISTINCT FROM OLD.credit_limit_minor
        AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF current_role_bypasses_rls() OR can_finance_tenant(NEW.tenant_id) THEN
    RETURN NEW;
  END IF;

  PERFORM raise_portfolio_violation(
    'portfolio_financier_required',
    'agency_portfolios',
    format('cartera %s del tenant %s (%s): usuario %s',
           NEW.id, NEW.tenant_id, TG_OP,
           COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), 'ninguno')));
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION agency_portfolios_financier_guard() IS
  'Trigger de agency_portfolios: abrir una cartera con cupo o saldo, o cambiarle el cupo o el estado, exige ser quien financia al nodo (can_finance_tenant) o un rol que se salta la RLS. 42501 portfolio_financier_required. Ver db/migrations/0052.';

CREATE TRIGGER agency_portfolios_financier_guard
  BEFORE INSERT OR UPDATE OF credit_limit_minor, status ON agency_portfolios
  FOR EACH ROW EXECUTE FUNCTION agency_portfolios_financier_guard();

CREATE FUNCTION portfolio_transactions_financier_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  wallet_tenant UUID;
BEGIN
  IF NEW.transaction_type NOT IN ('DEPOSIT_PAYMENT', 'MANUAL_ADJUSTMENT') THEN
    RETURN NEW;
  END IF;
  IF current_role_bypasses_rls() THEN
    RETURN NEW;
  END IF;

  -- Bajo la RLS de agency_portfolios: si la cartera no es del tenant del request, no se ve y la
  -- guarda falla cerrado (el WITH CHECK de portfolio_transactions también la rechazaría).
  SELECT tenant_id INTO wallet_tenant FROM agency_portfolios WHERE id = NEW.portfolio_id;
  IF wallet_tenant IS NOT NULL AND can_finance_tenant(wallet_tenant) THEN
    -- Quién y cuándo del asiento no se declaran: los firma el usuario que actúa (can_finance_tenant
    -- ya validó que es un UUID) con la hora de la base, como la resolución de un depósito informado.
    IF NEW.created_by IS DISTINCT FROM current_setting('app.current_user_id', true)::uuid THEN
      PERFORM raise_portfolio_violation(
        'portfolio_entry_author',
        'portfolio_transactions',
        format('asiento %s en la cartera %s (tenant %s): firmado por %s, actúa %s',
               NEW.transaction_type, NEW.portfolio_id, wallet_tenant, NEW.created_by,
               current_setting('app.current_user_id', true)));
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  PERFORM raise_portfolio_violation(
    'portfolio_financier_required',
    'portfolio_transactions',
    format('asiento %s en la cartera %s (tenant %s): usuario %s',
           NEW.transaction_type, NEW.portfolio_id, COALESCE(wallet_tenant::text, '?'),
           COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), 'ninguno')));
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION portfolio_transactions_financier_guard() IS
  'Trigger de portfolio_transactions: un DEPOSIT_PAYMENT o un MANUAL_ADJUSTMENT exige ser quien financia al dueño de la cartera (can_finance_tenant) o un rol que se salta la RLS, va firmado por el usuario que actúa (created_by) y con la hora de la base (created_at). 42501 portfolio_financier_required | portfolio_entry_author. Ver db/migrations/0052.';

CREATE TRIGGER portfolio_transactions_financier_guard
  BEFORE INSERT ON portfolio_transactions
  FOR EACH ROW EXECUTE FUNCTION portfolio_transactions_financier_guard();

-- El libro es de sólo agregar para la aplicación: una liberación, un depósito o un ajuste se
-- corrigen con otro asiento, no reescribiendo uno. Ningún camino de la API lo actualiza ni lo borra;
-- el borrado en cascada de un tenant sigue funcionando (corre como dueño de la tabla).
REVOKE UPDATE, DELETE ON portfolio_transactions FROM app_user;

-- Y la cartera no se borra desde la aplicación: borrarla se llevaría en cascada su libro y sus
-- depósitos informados, y la agencia volvería a abrir una vacía sin su deuda ni sus retenciones.
-- Ningún camino de la API la borra; la cascada del borrado de un tenant corre como dueño.
REVOKE DELETE ON agency_portfolios FROM app_user;

-- ============================================================================
-- 5. Depósitos informados por la agencia
-- ============================================================================
-- La agencia avisa que depositó (transferencia, consignación) y quien la financia lo verifica contra
-- su banco: si lo aprueba, acredita el monto con un DEPOSIT_PAYMENT en la cartera y lo enlaza acá;
-- si lo rechaza, dice por qué. Una sola vez: pending → approved | rejected. Nada más cambia.
CREATE TABLE portfolio_deposit_reports (
  id                        UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                 UUID          NOT NULL,
  portfolio_id              UUID          NOT NULL,
  amount_minor              BIGINT        NOT NULL,
  currency                  VARCHAR(3)    NOT NULL,
  reference                 VARCHAR(100)  NOT NULL,
  deposited_on              DATE,
  notes                     VARCHAR(500),
  status                    TEXT          NOT NULL DEFAULT 'pending',
  idempotency_key           UUID,
  -- Sin ON DELETE: quién informó y quién resolvió un movimiento de plata no se pierde borrando un
  -- usuario (como orders.user_id).
  reported_by               UUID          NOT NULL REFERENCES users(id),
  reported_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  resolved_by               UUID          REFERENCES users(id),
  resolved_at               TIMESTAMPTZ,
  resolution_reason         VARCHAR(500),
  portfolio_transaction_id  UUID          REFERENCES portfolio_transactions(id),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT portfolio_deposit_reports_wallet_fk
    FOREIGN KEY (portfolio_id, tenant_id, currency)
    REFERENCES agency_portfolios (id, tenant_id, currency)
    ON DELETE CASCADE,
  CONSTRAINT portfolio_deposit_reports_amount_range
    CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  CONSTRAINT portfolio_deposit_reports_currency_format
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT portfolio_deposit_reports_reference_present
    CHECK (btrim(reference) <> ''),
  CONSTRAINT portfolio_deposit_reports_status_check
    CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT portfolio_deposit_reports_resolution
    CHECK ((status = 'pending') = (resolved_by IS NULL AND resolved_at IS NULL)),
  CONSTRAINT portfolio_deposit_reports_pending_without_reason
    CHECK (status <> 'pending' OR resolution_reason IS NULL),
  CONSTRAINT portfolio_deposit_reports_rejection_reason
    CHECK (status <> 'rejected' OR btrim(COALESCE(resolution_reason, '')) <> ''),
  CONSTRAINT portfolio_deposit_reports_approval_entry
    CHECK ((status = 'approved') = (portfolio_transaction_id IS NOT NULL)),
  CONSTRAINT portfolio_deposit_reports_one_report_per_entry
    UNIQUE (portfolio_transaction_id)
);

CREATE INDEX idx_portfolio_deposit_reports_tenant
  ON portfolio_deposit_reports (tenant_id, reported_at DESC);
CREATE INDEX idx_portfolio_deposit_reports_wallet
  ON portfolio_deposit_reports (portfolio_id);
CREATE INDEX idx_portfolio_deposit_reports_pending
  ON portfolio_deposit_reports (reported_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX uq_portfolio_deposit_reports_idempotency_key
  ON portfolio_deposit_reports (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE portfolio_deposit_reports IS
  'Depósitos que informa una agencia sobre una de sus carteras. Nacen pending; quien financia al nodo (can_finance_tenant) los pasa una sola vez a approved (con el DEPOSIT_PAYMENT que acreditó el monto) o a rejected (con motivo). Cada paso deja su domain_event. Ver db/migrations/0052.';
COMMENT ON COLUMN portfolio_deposit_reports.reference IS
  'Referencia del depósito que da la agencia (número de transferencia o consignación), para conciliarlo contra el banco.';
COMMENT ON COLUMN portfolio_deposit_reports.deposited_on IS
  'Fecha en que la agencia dice haber depositado. Opcional.';
COMMENT ON COLUMN portfolio_deposit_reports.notes IS
  'Comentario de la agencia. No va a los domain_events.';
COMMENT ON COLUMN portfolio_deposit_reports.idempotency_key IS
  'Idempotency-Key del informe HTTP: un doble envío no crea dos pendientes. Única por tenant.';
COMMENT ON COLUMN portfolio_deposit_reports.reported_at IS
  'Cuándo se informó. Lo fija la base al insertar.';
COMMENT ON COLUMN portfolio_deposit_reports.resolved_at IS
  'Cuándo se aprobó o rechazó. Lo fija la base al resolver.';
COMMENT ON COLUMN portfolio_deposit_reports.resolution_reason IS
  'Motivo de quien resuelve: obligatorio al rechazar, opcional al aprobar. Va al domain_event.';
COMMENT ON COLUMN portfolio_deposit_reports.portfolio_transaction_id IS
  'El DEPOSIT_PAYMENT de la misma cartera y por el mismo monto que acreditó el depósito aprobado. NULL si no está aprobado.';

-- Las reglas de la transición. SECURITY INVOKER: el asiento de la aprobación se busca con la RLS de
-- quien resuelve (que corre con el tenant de la agencia, porque acaba de escribir ese asiento), y
-- `current_role_bypasses_rls` mira al rol que escribe.
CREATE FUNCTION portfolio_deposit_reports_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor_setting TEXT := current_setting('app.current_user_id', true);
  actor         UUID;
  detail        TEXT := format('depósito informado %s de la cartera %s (tenant %s)',
                               NEW.id, NEW.portfolio_id, NEW.tenant_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      PERFORM raise_portfolio_violation('deposit_report_born_pending', 'portfolio_deposit_reports', detail);
    END IF;
    NEW.reported_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    PERFORM raise_portfolio_violation('deposit_report_not_pending', 'portfolio_deposit_reports', detail);
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') THEN
    PERFORM raise_portfolio_violation('deposit_report_transition', 'portfolio_deposit_reports', detail);
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.portfolio_id, NEW.amount_minor, NEW.currency, NEW.reference,
      NEW.deposited_on, NEW.notes, NEW.idempotency_key, NEW.reported_by, NEW.reported_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.portfolio_id, OLD.amount_minor, OLD.currency, OLD.reference,
      OLD.deposited_on, OLD.notes, OLD.idempotency_key, OLD.reported_by, OLD.reported_at) THEN
    PERFORM raise_portfolio_violation('deposit_report_immutable', 'portfolio_deposit_reports', detail);
  END IF;

  IF NOT current_role_bypasses_rls() THEN
    IF actor_setting ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      actor := actor_setting::uuid;
    END IF;
    IF actor IS NULL OR NEW.resolved_by IS DISTINCT FROM actor THEN
      PERFORM raise_portfolio_violation('deposit_report_resolver', 'portfolio_deposit_reports', detail);
    END IF;
  END IF;

  IF NEW.status = 'approved' AND NOT EXISTS (
       SELECT 1
         FROM portfolio_transactions pt
        WHERE pt.id = NEW.portfolio_transaction_id
          AND pt.portfolio_id = NEW.portfolio_id
          AND pt.transaction_type = 'DEPOSIT_PAYMENT'
          AND pt.amount_minor = NEW.amount_minor
     ) THEN
    PERFORM raise_portfolio_violation('deposit_report_ledger_entry', 'portfolio_deposit_reports', detail);
  END IF;

  NEW.resolved_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION portfolio_deposit_reports_guard() IS
  'Trigger de portfolio_deposit_reports: nace pending, pasa una sola vez a approved o rejected, lo informado no cambia, quien resuelve es el usuario del request y una aprobación apunta al DEPOSIT_PAYMENT de esa cartera por ese monto. Fija reported_at y resolved_at. Errores STW01 / 42501. Ver db/migrations/0052.';

CREATE TRIGGER portfolio_deposit_reports_guard
  BEFORE INSERT OR UPDATE ON portfolio_deposit_reports
  FOR EACH ROW EXECUTE FUNCTION portfolio_deposit_reports_guard();

-- El rastro de cada paso, en la misma transacción: la API no tiene que escribir otro. Sin la
-- referencia ni el comentario de la agencia; el motivo de quien resuelve, sí.
CREATE FUNCTION portfolio_deposit_reports_audit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (
    NEW.tenant_id,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.reported_by ELSE NEW.resolved_by END,
    'portfolio.deposit_report.' || CASE WHEN TG_OP = 'INSERT' THEN 'submitted' ELSE NEW.status END,
    'portfolio_deposit_report',
    NEW.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'portfolioId', NEW.portfolio_id,
      'amountMinor', NEW.amount_minor,
      'currency', NEW.currency,
      'status', NEW.status,
      'portfolioTransactionId', NEW.portfolio_transaction_id,
      'reason', NEW.resolution_reason,
      'source', 'db:portfolio_deposit_reports'
    ))
  );
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION portfolio_deposit_reports_audit() IS
  'Trigger de portfolio_deposit_reports: deja el domain_event portfolio.deposit_report.submitted | approved | rejected con quien actuó, en la misma transacción. Ver db/migrations/0052.';

CREATE TRIGGER portfolio_deposit_reports_audit
  AFTER INSERT OR UPDATE ON portfolio_deposit_reports
  FOR EACH ROW EXECUTE FUNCTION portfolio_deposit_reports_audit();

-- La RLS:
--
--   - leer: la agencia los suyos (tenant del request) y quien administra un ancestro los de su red
--     (can_read_membership, el mismo predicado de subárbol que memberships y domain_events);
--   - informar: la agencia, en su propio tenant, a nombre del usuario del request y pendiente;
--   - resolver: sólo quien financia al nodo (can_finance_tenant);
--   - borrar: nadie desde la aplicación.
ALTER TABLE portfolio_deposit_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_deposit_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY portfolio_deposit_reports_read ON portfolio_deposit_reports
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR can_read_membership(tenant_id)
  );

CREATE POLICY portfolio_deposit_reports_submit ON portfolio_deposit_reports
  FOR INSERT
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    AND reported_by::text = current_setting('app.current_user_id', true)
    AND status = 'pending'
  );

CREATE POLICY portfolio_deposit_reports_resolve ON portfolio_deposit_reports
  FOR UPDATE
  USING (can_finance_tenant(tenant_id))
  WITH CHECK (can_finance_tenant(tenant_id));

COMMENT ON POLICY portfolio_deposit_reports_read ON portfolio_deposit_reports IS
  'La agencia ve los suyos (tenant del request); quien administra un ancestro ve los de su red (can_read_membership).';
COMMENT ON POLICY portfolio_deposit_reports_submit ON portfolio_deposit_reports IS
  'La agencia informa en su propio tenant, a nombre del usuario del request, y el informe nace pendiente.';
COMMENT ON POLICY portfolio_deposit_reports_resolve ON portfolio_deposit_reports IS
  'Sólo quien financia al nodo (can_finance_tenant) aprueba o rechaza; la transición la valida el trigger portfolio_deposit_reports_guard.';

REVOKE DELETE ON portfolio_deposit_reports FROM app_user;
