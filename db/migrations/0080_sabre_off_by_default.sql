-- 0080_sabre_off_by_default.sql
-- Sabre nace apagado para toda la red. Se enciende sólo donde el superadmin lo decide, desde
-- Proveedores de la plataforma → Sabre (una excepción **Habilitado** para la sucursal de
-- certificación, con motivo).
--
-- Por qué: la única cuenta de Sabre que existe es de certificación (CERT). Sus tarifas no se emiten
-- ni se facturan y sus reservas son PNR de prueba. Con Sabre en `always` y esa cuenta activa y
-- heredable en el nodo de la plataforma, cualquier sucursal o agencia colgada debajo veía tarifas
-- CERT en su cotización y podía crear PNR de prueba con su marca. Además sigue abierta P-01 (cómo
-- cobra Sabre la búsqueda de BFM, docs/sabre/11-plan-implementacion.md §5). El factory vuelve a
-- `opt-in` en el mismo cambio; esta fila hace que el estado se lea en el panel en vez de depender
-- de la política del código.
--
-- Cómo se pliega (0048, apps/api/src/provider-enablement/provider-enablement.policy.ts):
--
--   kill-switch (`PROVIDERS_DISABLED`) > ajuste del tenant más cercano en el árbol > ajuste global >
--   variable legado (`FLIGHT_PROVIDERS_OPT_IN`) > política del proveedor.
--
-- Por eso esta fila global apagada le gana también a un `FLIGHT_PROVIDERS_OPT_IN=sabre` que haya
-- quedado en el entorno, y por eso un ajuste POR TENANT que ya exista sigue mandando sobre ella:
-- un tenant (o su consolidador) que el superadmin encendió a propósito sigue encendido.
--
-- Idempotente y sin pisar a nadie: si ya hay un ajuste GLOBAL de Sabre —encendido o apagado—, no
-- se toca, y correrla otra vez no hace nada. Los ajustes por tenant no se miran.
--
-- `updated_by` queda en NULL porque lo escribe un proceso, no una persona, igual que el seed del
-- stack de certificación (tools/seed-tbo-cert-tenant). El rastro queda en `domain_events` con el
-- mismo tipo que escribe la API, sin actor y con la migración como origen. Sólo si la fila se
-- insertó: una corrida que no cambia nada no deja evento.
--
-- La post-venta de órdenes de Sabre ya hechas no se corta: el registry resuelve la post-venta sin
-- mirar la habilitación (`FlightProviderRegistry.byCode`). Lo que se corta es la búsqueda (Sabre
-- sale `platform-disabled`) y la venta nueva (revalidar y reservar, `byCodeForOffer`).

WITH inserted AS (
  INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason)
  SELECT 'sabre', NULL, false,
         'Sabre está en certificación (CERT): no emite ni factura. Habilítalo sólo para la sucursal de certificación.'
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_enablement WHERE provider_code = 'sabre' AND tenant_id IS NULL
  )
  -- Respaldo del NOT EXISTS ante una carrera: el índice único parcial de 0048 decide.
  ON CONFLICT (provider_code) WHERE tenant_id IS NULL DO NOTHING
  RETURNING provider_code, enabled, reason
)
INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
SELECT
  NULL,
  NULL,
  'platform.provider_enablement.updated',
  'provider_enablement',
  i.provider_code,
  jsonb_build_object(
    'providerCode', i.provider_code,
    'scope', 'global',
    'targetTenantId', NULL,
    'before', NULL,
    'after', jsonb_build_object('enabled', i.enabled, 'reason', i.reason),
    'source', 'migration:0080_sabre_off_by_default'
  )
FROM inserted i;
