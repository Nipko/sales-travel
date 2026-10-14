-- 0077_provider_kill_switch.sql
-- Apagado de emergencia de un proveedor desde el panel de la plataforma, sin desplegar.
--
-- Qué resuelve: en un incidente (el proveedor responde mal, cobra de más, un bug nuestro en su ACL)
-- la única palanca que cortaba un proveedor para TODA la plataforma, post-venta incluida si hacía
-- falta, era la variable PROVIDERS_DISABLED: editar el entorno y desplegar, minutos que en un incidente
-- son ventas mal hechas. provider_enablement (0048) apaga desde el panel, pero sólo búsquedas y ventas
-- nuevas, y es una decisión comercial (quién vende con qué), no una de operaciones.
--
-- Una fila por proveedor apagado, con su nivel:
--
--   - `sales`: frena búsquedas, pre-reservas y reservas nuevas; lo ya vendido se sigue consultando,
--     cancelando y conciliando (el `código:ventas` de la variable);
--   - `all`: corta también la post-venta (el `código` a secas).
--
-- Lo aplica el circuit breaker de la API en CADA llamada al proveedor
-- (apps/api/src/search/circuit-breaker.service.ts), junto con la variable: gana el apagado más amplio
-- de los dos. La API lee esta tabla al arrancar y cada 10 s, y la réplica que recibe el cambio lo
-- aplica al instante. Si la lectura falla, la API se queda con la última que leyó: un error de la base
-- nunca enciende un proveedor que estaba apagado. PROVIDERS_DISABLED sigue siendo el respaldo que
-- gana siempre (infrastructure/hostinger/README.md §6.1).
--
-- `expires_at` opcional: el apagado vence solo (una hora, cuatro, un día) para que un incidente
-- resuelto de madrugada no deje al proveedor apagado hasta que alguien se acuerde. Una fila vencida
-- no apaga nada; la próxima que se ponga la reemplaza.
--
-- Quitar el apagado es borrar la fila. El rastro (quién, cuándo, por qué, el antes) queda en
-- domain_events: la API escribe `platform.provider_kill_switch.set` y `.cleared` en la misma
-- transacción que el cambio.

-- ============================================================================
-- 1. Los apagados
-- ============================================================================
-- Sin FK a un catálogo, como provider_enablement (0048): la API valida el código contra los registries,
-- que son la lista de lo que corre de verdad. El formato es más estricto que el de 0048 (empieza con
-- letra o dígito, hasta 40): todo código registrado hoy entra.
CREATE TABLE provider_kill_switches (
  provider_code TEXT          PRIMARY KEY
                              CHECK (provider_code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  level         TEXT          NOT NULL CHECK (level IN ('all', 'sales')),
  -- Obligatorio: un apagado de emergencia sin motivo es uno que nadie se anima a levantar. Nunca PII.
  reason        VARCHAR(500)  NOT NULL CHECK (btrim(reason) <> ''),
  -- Quién lo puso. Sin ON DELETE: un usuario que apagó un proveedor no se borra sin antes levantarlo.
  set_by        UUID          NOT NULL REFERENCES users(id),
  set_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- NULL = hasta que alguien lo levante.
  expires_at    TIMESTAMPTZ   NULL CHECK (expires_at IS NULL OR expires_at > set_at)
);

COMMENT ON TABLE provider_kill_switches IS
  'Apagado de emergencia de un proveedor para toda la plataforma, puesto desde el panel: sales (sólo ventas) o all (también la post-venta). Lo aplica el circuit breaker de la API junto con PROVIDERS_DISABLED (gana el más amplio). Lectura abierta para el servidor; sólo escribe el superadmin de la plataforma. Ver db/migrations/0077.';
COMMENT ON COLUMN provider_kill_switches.expires_at IS
  'NULL = sin vencimiento. Vencida, la fila no apaga nada; se reemplaza con el próximo apagado.';

-- ============================================================================
-- 2. Quién lee y quién escribe
-- ============================================================================
ALTER TABLE provider_kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_kill_switches FORCE  ROW LEVEL SECURITY;

-- Lectura abierta, como provider_enablement (0048): la lee el circuit breaker sin usuario en el
-- contexto (búsquedas, jobs de post-venta) y no hay nada de un tenant que aislar. Lo que protege esta
-- tabla es quién la ESCRIBE.
CREATE POLICY provider_kill_switches_read ON provider_kill_switches
  FOR SELECT
  USING (true);

-- Escribe sólo el superadmin de la plataforma (is_platform_superadmin(), 0075; platform_admin no), y
-- la fila tiene que nombrarlo a él: nadie deja un apagado a nombre de otro.
CREATE POLICY provider_kill_switches_superadmin_insert ON provider_kill_switches
  FOR INSERT
  WITH CHECK (
    public.is_platform_superadmin()
    AND set_by::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY provider_kill_switches_superadmin_update ON provider_kill_switches
  FOR UPDATE
  USING (public.is_platform_superadmin())
  WITH CHECK (
    public.is_platform_superadmin()
    AND set_by::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY provider_kill_switches_superadmin_delete ON provider_kill_switches
  FOR DELETE
  USING (public.is_platform_superadmin());

-- Las default privileges de 0001 dan todo. Se deja lo justo, explícito: la app pone, cambia y quita
-- (levantar el apagado es un DELETE), siempre por las policies de arriba.
REVOKE ALL ON provider_kill_switches FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_kill_switches TO app_user;
