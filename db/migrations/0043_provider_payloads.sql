-- 0043_provider_payloads.sql
-- Bóveda cifrada de los request/response completos que se cruzan con un proveedor.
--
-- Hay proveedores que, para investigar un error de su lado, piden el request y la response
-- completos de la llamada, y certificaciones que piden todos los JSON. Esos cuerpos llevan datos
-- de huéspedes (nombres, email, teléfono) y la tarifa neta de la cuenta, así que no pueden ir al
-- log ni a `domain_events`. Van acá:
--
--   * cifrados en la app (AES-256-GCM con una clave propia que vive fuera de la base): Postgres
--     sólo ve bytes, y un volcado de la base no expone ningún cuerpo;
--   * con vencimiento corto, garantizado por un CHECK y no sólo por la configuración: lo vencido
--     deja de leerse en el acto y una purga diaria lo borra;
--   * con lectura acotada y auditada: la plataforma y el administrador del consolidador dueño de
--     la cuenta, y la app registra cada lectura en `domain_events` en la MISMA transacción, así que
--     no hay lectura sin rastro.
--
-- Los metadatos que van en claro son identificadores operativos y números (id de la llamada,
-- operación, estado HTTP, tamaños): alcanzan para encontrar una llamada sin descifrar nada, y
-- ninguno es un dato personal. Nada de esta migración nombra a un proveedor.

CREATE TABLE provider_payloads (
  id                    UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_code         TEXT         NOT NULL
    CONSTRAINT provider_payloads_provider_code_format CHECK (provider_code ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Id de la llamada que genera el ACL y que aparece en su log: es la llave con que soporte pide
  -- "los logs completos" de un error. Los reintentos de una misma llamada lo comparten.
  request_id            TEXT         NOT NULL
    CONSTRAINT provider_payloads_request_id_format CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  attempt               SMALLINT     NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  operation             TEXT         NOT NULL CHECK (operation ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- Decide la exportación: lo de 'test' se entrega tal cual (datos sintéticos) y lo de 'live' sale
  -- redactado salvo pedido explícito con ticket.
  environment           TEXT         NOT NULL CHECK (environment IN ('test', 'live')),

  -- Dueño de la cuenta con que salió la llamada. Gobierna quién puede leer la fila: la tarifa
  -- neta de la respuesta es del dueño y no de la agencia que heredó la cuenta.
  owner_tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Borrar la cuenta no borra la evidencia de un incidente abierto; la purga la borra a su tiempo.
  provider_account_id   UUID         NULL REFERENCES provider_accounts(id) ON DELETE SET NULL,
  -- Huella de la cuenta que el ACL pone en su log: une esta fila con esas líneas.
  account_ref           TEXT         NULL CHECK (account_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- Tenant que originó la llamada, si se conoce (un job de fondo puede no tenerlo).
  tenant_id             UUID         NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Orden a la que pertenece la llamada. Sin FK a propósito: la fila se escribe en segundo plano,
  -- fuera de la transacción de la orden, y una FK convertiría una carrera con esa transacción en
  -- una evidencia perdida. La lectura por orden igual pasa por la policy de abajo.
  order_id              UUID         NULL,

  sent_at               TIMESTAMPTZ  NOT NULL,
  duration_ms           INTEGER      NOT NULL CHECK (duration_ms >= 0),
  -- 0 = no llegó una respuesta completa (red, timeout o cuerpo cortado).
  http_status           SMALLINT     NOT NULL CHECK (http_status BETWEEN 0 AND 599),
  provider_status_code  INTEGER      NULL,
  outcome               TEXT         NOT NULL CHECK (outcome ~ '^[A-Za-z0-9_-]{1,64}$'),

  -- Huella de la clave con que se cifró la fila. Permite rotar la clave sin perder lo ya guardado:
  -- la app descifra con la clave anterior mientras la fila no venza.
  key_id                TEXT         NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  -- `*_bytes` es el tamaño del cuerpo original; NULL = no hubo cuerpo. `*_enc` NULL con tamaño =
  -- el cuerpo no se guardó por su tamaño.
  request_bytes         INTEGER      NULL CHECK (request_bytes >= 0),
  request_enc           BYTEA        NULL,
  response_bytes        INTEGER      NULL CHECK (response_bytes >= 0),
  response_enc          BYTEA        NULL,

  expires_at            TIMESTAMPTZ  NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- `request_id` primero: la búsqueda de soporte llega sólo con él.
  CONSTRAINT provider_payloads_attempt_unique UNIQUE (request_id, provider_code, attempt),
  CONSTRAINT provider_payloads_request_sized CHECK (request_enc IS NULL OR request_bytes IS NOT NULL),
  CONSTRAINT provider_payloads_response_sized CHECK (response_enc IS NULL OR response_bytes IS NOT NULL),
  -- "Retención corta" como garantía de la base: ninguna configuración puede guardar un cuerpo con
  -- datos de huéspedes más de 90 días.
  CONSTRAINT provider_payloads_short_retention
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);

COMMENT ON TABLE provider_payloads IS
  'Bóveda de request/response completos de proveedor, cifrados en la app (AES-256-GCM, clave fuera de la base). Retención corta, lectura acotada al dueño de la cuenta y auditada en domain_events. Nunca se copian al log. Ver db/migrations/0043.';
COMMENT ON COLUMN provider_payloads.request_id IS
  'Id de la llamada generado por el ACL del proveedor; es el mismo que aparece en su log.';
COMMENT ON COLUMN provider_payloads.owner_tenant_id IS
  'Dueño de la cuenta de proveedor con que salió la llamada. Sólo él (su administrador de consolidador) y la plataforma leen la fila.';
COMMENT ON COLUMN provider_payloads.order_id IS
  'Orden a la que pertenece la llamada, si la llamada corrió dentro de su contexto. Sin FK: la escritura es asíncrona.';
COMMENT ON COLUMN provider_payloads.key_id IS
  'Huella (sha256 truncado, con separación de dominio) de la clave con que se cifró la fila. No revela la clave.';
COMMENT ON COLUMN provider_payloads.request_enc IS
  'Request cifrado. El texto en claro es un sobre que ata el cuerpo a (proveedor, request_id, attempt, parte, owner_tenant_id, environment): no se puede mover a otra fila, ni cambiarle el dueño o el entorno a la suya.';

-- Exportación por orden.
CREATE INDEX idx_provider_payloads_order
  ON provider_payloads (order_id)
  WHERE order_id IS NOT NULL;

-- Purga diaria.
CREATE INDEX idx_provider_payloads_expires ON provider_payloads (expires_at);

-- Borrado en cascada de un tenant, y la policy de lectura.
CREATE INDEX idx_provider_payloads_owner ON provider_payloads (owner_tenant_id);

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE provider_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_payloads FORCE  ROW LEVEL SECURITY;

-- Quién lee: los roles de plataforma, con alcance global como en la app (`PLATFORM_ROLES` de
-- apps/api/src/auth/roles.ts), y el administrador del consolidador dueño de la cuenta o de un
-- ancestro suyo. Más estrecho que can_read_membership() (0020) a propósito: esa función deja leer
-- a cualquier admin del subárbol, y estas filas tienen datos de huéspedes. Las agencias no leen
-- nunca, aunque la llamada fuera suya: la respuesta trae la tarifa neta del dueño de la cuenta.
--
-- SECURITY DEFINER (owner = postgres) por el mismo motivo que can_read_membership(): consultar
-- memberships desde una policy sin re-disparar su propia RLS.
CREATE FUNCTION can_read_provider_payloads(p_owner_tenant_id uuid) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships m
    JOIN tenants reader_t ON reader_t.id = m.tenant_id
    JOIN tenants owner_t  ON owner_t.id  = p_owner_tenant_id
    WHERE m.user_id::text = current_setting('app.current_user_id', true)
      AND m.status = 'active'
      AND (
        m.role IN ('superadmin', 'platform_admin')
        OR (
          m.role IN ('consolidator_admin')
          AND reader_t.path OPERATOR(public.@>) owner_t.path
        )
      )
  );
$$;

COMMENT ON FUNCTION can_read_provider_payloads(uuid) IS
  '¿El usuario de app.current_user_id puede leer los payloads de una cuenta de este dueño? Roles de plataforma, o consolidator_admin del dueño o de un ancestro. Ver db/migrations/0043.';

REVOKE ALL ON FUNCTION can_read_provider_payloads(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION can_read_provider_payloads(uuid) TO app_user;

-- Lo vencido deja de leerse aunque la purga no haya pasado todavía.
CREATE POLICY provider_payloads_reader_select ON provider_payloads
  FOR SELECT
  USING (expires_at > now() AND can_read_provider_payloads(owner_tenant_id));

-- INSERT permisivo, como domain_events (0029) y search_logs (0032): la escritura corre en segundo
-- plano, a veces sin usuario ni tenant en el contexto (jobs de post-venta), y una policy estricta
-- convertiría cada hueco de contexto en evidencia perdida. La app es el único escritor; la
-- protección de esta tabla es de lectura, y es inmutable: no hay UPDATE ni DELETE para app_user.
CREATE POLICY provider_payloads_append ON provider_payloads
  FOR INSERT
  WITH CHECK (true);

-- Las default privileges de 0001 dan SELECT, INSERT, UPDATE y DELETE: se deja lo justo.
REVOKE ALL ON provider_payloads FROM app_user;
GRANT SELECT, INSERT ON provider_payloads TO app_user;

-- ============================================================================
-- Purga
-- ============================================================================
-- La única forma de borrar. SECURITY DEFINER porque app_user no tiene DELETE, y sin parámetros que
-- elijan filas: sólo borra lo vencido, así que concederla no abre ningún borrado arbitrario. Por
-- lotes, para que una purga atrasada no tome un lock largo; SKIP LOCKED deja correr dos purgas a la
-- vez (dos réplicas de la API) sin que una espere a la otra.
CREATE FUNCTION purge_expired_provider_payloads(p_limit integer) RETURNS integer
  LANGUAGE sql SECURITY DEFINER VOLATILE
  SET search_path = public
AS $$
  WITH vencidas AS (
    SELECT id
    FROM provider_payloads
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000))
    FOR UPDATE SKIP LOCKED
  ),
  borradas AS (
    DELETE FROM provider_payloads p
    USING vencidas v
    WHERE p.id = v.id
    RETURNING 1
  )
  SELECT count(*)::integer FROM borradas;
$$;

COMMENT ON FUNCTION purge_expired_provider_payloads(integer) IS
  'Borra hasta p_limit (1 a 10000) filas vencidas de provider_payloads y devuelve cuántas. Única vía de borrado. Ver db/migrations/0043.';

REVOKE ALL ON FUNCTION purge_expired_provider_payloads(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_provider_payloads(integer) TO app_user;
