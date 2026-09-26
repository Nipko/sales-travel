-- 0047_provider_reconciliation.sql
-- Conciliación diaria de las reservas de una cuenta de proveedor contra nuestras órdenes (M3 de
-- docs/tbo/08 §9 C-10; 04 §9; 08 RF-28). Detecta reservas que el proveedor tiene y nosotros no,
-- divergencias de estado y de precio, y da la evidencia con la que una reserva sin respuesta que
-- nunca apareció pasa a fallida (D-TBO-24 A).
--
-- La conciliación corre por CUENTA (`provider_accounts.id`) y no por tenant: con BYOC, la cuenta del
-- consolidador la heredan sus agencias, y el listado por fecha del proveedor devuelve las reservas de
-- toda la red juntas. Lo que se guarda se reparte con la misma regla con que se ven las reservas:
--
--   - la corrida (qué ventanas se leyeron, cuántas filas, cómo terminó) es del DUEÑO de la cuenta;
--   - una divergencia de una orden (R1, R3, R4, R5, R7, R8) es del tenant de ESA orden, y la FK
--     compuesta a `(orders.id, orders.tenant_id)` impide colgarla de otro tenant;
--   - una reserva que no es de ninguna orden (R2) y los montos que factura el proveedor (R6) son
--     datos comerciales del dueño de la cuenta: quedan con él y sin `order_id`.
--
-- Así nada de lo que devuelve el listado por fecha llega a una agencia si no es a través de una
-- orden suya (RNF-06 punto 5). Nada de esta migración nombra a un proveedor.

-- La corrida apunta a `(id, tenant_id)` de la cuenta, como `hotel_order_tracking` a la orden (0042):
-- las FK se verifican sin RLS, y con una FK a `id` a secas un tenant podría registrar corridas sobre
-- la cuenta de otro. Redundante como unicidad: `id` ya es PK.
ALTER TABLE provider_accounts ADD CONSTRAINT uq_provider_accounts_id_tenant UNIQUE (id, tenant_id);

-- ============================================================================
-- 1. Corridas: una por cuenta y ejecución
-- ============================================================================
CREATE TABLE provider_reconciliation_runs (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Dueño de la cuenta.
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id     UUID         NOT NULL,
  provider_code  TEXT         NOT NULL CHECK (btrim(provider_code) <> ''),
  -- scheduled: el planificador diario; sweep: el barrido que recupera una corrida que no salió;
  -- forced: el botón de operaciones.
  trigger        TEXT         NOT NULL CHECK (trigger IN ('scheduled', 'sweep', 'forced')),
  requested_by   UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
  -- completed: todas las ventanas se leyeron enteras y válidas; invalid: alguna respuesta no valía
  -- (una fila fuera de la ventana pedida, un cuerpo ilegible) y la corrida no cambió nada; failed:
  -- no se pudo leer; abandoned: el proceso murió con la corrida en curso.
  status         TEXT         NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'invalid', 'abandoned')),
  -- Las ventanas de fechas de creación pedidas, `[{"from","to","leg"}]`, extremos incluidos.
  windows        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  rows_read      INTEGER      NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
  rows_matched   INTEGER      NOT NULL DEFAULT 0 CHECK (rows_matched >= 0),
  discrepancies  INTEGER      NOT NULL DEFAULT 0 CHECK (discrepancies >= 0),
  -- Conteos por clase y por desenlace, con vocabulario cerrado. Nunca valores del proveedor.
  summary        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Nombre de la clase de error, o códigos `ruta:código`. Nunca un cuerpo ni un mensaje del proveedor.
  error_class    TEXT         NULL CHECK (error_class IS NULL OR length(error_class) <= 200),
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ  NULL,

  CONSTRAINT provider_reconciliation_runs_account_fk
    FOREIGN KEY (account_id, tenant_id) REFERENCES provider_accounts (id, tenant_id) ON DELETE CASCADE,
  -- Terminada = con fecha de fin; en curso = sin ella.
  CONSTRAINT provider_reconciliation_runs_finished
    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- Una sola corrida en curso por cuenta: el planificador, el barrido y el botón pueden coincidir, y
-- dos corridas a la vez leerían dos veces lo mismo al proveedor. La app da por abandonada una que
-- lleva demasiado en curso (el proceso murió) antes de abrir otra.
CREATE UNIQUE INDEX uq_provider_reconciliation_runs_running
  ON provider_reconciliation_runs (account_id)
  WHERE status = 'running';

CREATE INDEX idx_provider_reconciliation_runs_account
  ON provider_reconciliation_runs (account_id, started_at DESC);

COMMENT ON TABLE provider_reconciliation_runs IS
  'Una corrida de la conciliación diaria de una cuenta de proveedor: ventanas leídas, conteos y desenlace. Del dueño de la cuenta, con RLS forzada. Ver db/migrations/0047.';
COMMENT ON COLUMN provider_reconciliation_runs.status IS
  'running, completed (ventanas válidas), invalid (una respuesta no valía y no se cambió nada), failed (no se pudo leer) o abandoned (el proceso murió en curso).';

-- ============================================================================
-- 2. Ítems: una fila por divergencia
-- ============================================================================
CREATE TABLE provider_reconciliation_items (
  id                   UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Quién la ve: el tenant de la orden, o el dueño de la cuenta en R2 y R6.
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id               UUID         NOT NULL REFERENCES provider_reconciliation_runs(id) ON DELETE CASCADE,
  account_id           UUID         NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_code        TEXT         NOT NULL CHECK (btrim(provider_code) <> ''),
  -- Clasificación de docs/tbo/04 §9.4.
  kind                 TEXT         NOT NULL CHECK (kind IN ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8')),
  severity             TEXT         NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- Qué hizo la conciliación: recovered (R1 consolidó el intent), cancelled (R3 la cerró),
  -- cancellation-verifying (R3 la dejó en "Cancelación en curso"), failed (R5 cerró el intent),
  -- reported (R2 al reporte del dueño), recorded (sólo se registró) o review (la mira una persona).
  action               TEXT         NOT NULL
    CHECK (action IN ('recovered', 'cancelled', 'cancellation-verifying', 'failed', 'reported',
                      'recorded', 'review')),
  order_id             UUID         NULL,
  -- Localizador del proveedor, si la divergencia tiene uno.
  provider_booking_id  TEXT         NULL CHECK (provider_booking_id IS NULL OR btrim(provider_booking_id) <> ''),
  -- `clase|sujeto|valor observado`: repetir una ventana no duplica el ítem ni su evento (04 §9.5
  -- punto 4). Lo arma la app.
  dedupe_key           TEXT         NOT NULL CHECK (btrim(dedupe_key) <> ''),
  -- Vocabulario cerrado: códigos, fechas, montos exactos. Nunca `TripName` ni texto del proveedor;
  -- `agencyName` y los montos sólo en R2 y R6, que son del dueño de la cuenta.
  details              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Con una orden, el ítem vive en el tenant de la orden y no en otro (misma defensa que 0042).
  CONSTRAINT provider_reconciliation_items_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE CASCADE,
  -- R2 no tiene orden y R6 lleva montos del dueño de la cuenta: ninguna de las dos se cuelga de una
  -- orden de agencia. Las demás son siempre de una orden.
  CONSTRAINT provider_reconciliation_items_subject CHECK (
    CASE
      WHEN kind IN ('R2', 'R6') THEN order_id IS NULL AND provider_booking_id IS NOT NULL
      ELSE order_id IS NOT NULL
    END
  ),
  CONSTRAINT uq_provider_reconciliation_items_dedupe UNIQUE (account_id, dedupe_key)
);

CREATE INDEX idx_provider_reconciliation_items_run ON provider_reconciliation_items (run_id);
CREATE INDEX idx_provider_reconciliation_items_order
  ON provider_reconciliation_items (order_id)
  WHERE order_id IS NOT NULL;

COMMENT ON TABLE provider_reconciliation_items IS
  'Una divergencia R1-R8 de la conciliación. Del tenant de la orden o, sin orden (R2) o con montos del proveedor (R6), del dueño de la cuenta. Append-only, con RLS forzada. Ver db/migrations/0047.';
COMMENT ON COLUMN provider_reconciliation_items.dedupe_key IS
  'clase|sujeto|valor observado. Única por cuenta: una ventana repetida no duplica el ítem ni su evento.';

-- ============================================================================
-- 3. RLS y permisos
-- ============================================================================
ALTER TABLE provider_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_reconciliation_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY provider_reconciliation_runs_tenant_isolation ON provider_reconciliation_runs
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

ALTER TABLE provider_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_reconciliation_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY provider_reconciliation_items_tenant_isolation ON provider_reconciliation_items
  USING       (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK  (tenant_id::text = current_setting('app.current_tenant_id', true));

-- `ALTER DEFAULT PRIVILEGES` de 0001 le da todo a `app_user`. Una corrida se cierra con un UPDATE
-- pero no se borra; un ítem es un registro de lo que se vio y se hizo, y no se toca después.
REVOKE DELETE ON provider_reconciliation_runs FROM app_user;
REVOKE UPDATE, DELETE ON provider_reconciliation_items FROM app_user;
