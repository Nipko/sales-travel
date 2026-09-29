-- 0053_tenant_credit_limit_to_wallets.sql
-- El crédito interno de 0007 (tenants.credit_limit) pasa al cupo de la cartera y deja de usarse.
--
-- Hasta 0052 había dos topes: el cupo de la cartera, que se fijaba la propia agencia, y el crédito
-- interno del tenant, que no editaba nadie por API y que la retención de hoteles combinaba con el
-- cupo (el menor de los dos) cuando la cuenta del proveedor era heredada (RF-23, booking-hold.ts).
-- Con la decisión del 2026-09-29 queda UN tope por cartera, su cupo, y lo fija quien financia al
-- nodo (0052). El crédito interno es el único de los dos que puso la red, así que:
--
--   - si es mayor que 0, pasa a ser el cupo de la cartera del tenant en su moneda por defecto
--     (`default_currency`, que es la moneda del crédito interno): reemplaza el que se había fijado
--     la agencia, y si no hay cartera en esa moneda se abre una vacía con ese cupo;
--   - si es 0, la cartera queda como está;
--   - cada cartera que cambia o se abre deja su domain_event, con actor NULL y la migración como
--     origen;
--   - la columna NO se borra ni se pone en 0: el dato queda y el COMMENT la marca como fuera de uso.
--     Mientras la API la siga leyendo (hasta que se retire de booking-hold.ts), el menor de los dos
--     es ese mismo valor, así que la retención ya usa el cupo nuevo con cuenta propia o heredada.
--
-- Las carteras con cupo que no vino de acá (lo fijó la agencia antes de 0052) se conservan y se
-- listan con un WARNING para que quien financia las revise.
--
-- Unidades: `credit_limit` es NUMERIC(14,2) en unidades MAYORES y el cupo va en unidades menores
-- con dos decimales, la misma regla que `internalCreditMinor` (booking-hold.ts).
--
-- Correrla dos veces no cambia nada: la segunda encuentra cada cartera con el cupo que le toca. Si
-- la API está viva durante el despliegue y abre la misma cartera a la vez, no falla: la encuentra.

DO $$
DECLARE
  r         RECORD;
  wallet_id UUID;
  old_limit BIGINT;
BEGIN
  FOR r IN
    SELECT t.id,
           t.slug,
           upper(btrim(t.default_currency))  AS currency,
           (t.credit_limit * 100)::bigint     AS limit_minor
      FROM tenants t
     WHERE t.credit_limit > 0
     ORDER BY t.path
  LOOP
    IF r.currency !~ '^[A-Z]{3}$' THEN
      RAISE WARNING
        'REVISAR: el tenant % tiene crédito interno pero su moneda por defecto (%) no es válida: no se pasó a ninguna cartera',
        r.slug, r.currency;
      CONTINUE;
    END IF;

    wallet_id := NULL;
    SELECT ap.id, ap.credit_limit_minor INTO wallet_id, old_limit
      FROM agency_portfolios ap
     WHERE ap.tenant_id = r.id AND ap.currency = r.currency
       FOR UPDATE;

    IF wallet_id IS NULL THEN
      INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor, status)
      VALUES (r.id, r.currency, r.limit_minor, 0, 'active')
      ON CONFLICT (tenant_id, currency) DO NOTHING
      RETURNING id INTO wallet_id;

      IF wallet_id IS NOT NULL THEN
        INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES (
          r.id, NULL, 'portfolio.created', 'agency_portfolio', wallet_id::text,
          jsonb_build_object(
            'currency', r.currency,
            'creditLimitMinor', r.limit_minor,
            'from', 'tenants.credit_limit',
            'source', 'migration:0053_tenant_credit_limit_to_wallets'
          )
        );
        CONTINUE;
      END IF;

      -- La abrió otro a la vez (la API, con cupo 0): se sigue como si ya estuviera.
      SELECT ap.id, ap.credit_limit_minor INTO wallet_id, old_limit
        FROM agency_portfolios ap
       WHERE ap.tenant_id = r.id AND ap.currency = r.currency
         FOR UPDATE;
    END IF;

    IF old_limit IS DISTINCT FROM r.limit_minor THEN
      UPDATE agency_portfolios SET credit_limit_minor = r.limit_minor WHERE id = wallet_id;

      INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
      VALUES (
        r.id, NULL, 'portfolio.credit_limit.changed', 'agency_portfolio', wallet_id::text,
        jsonb_build_object(
          'currency', r.currency,
          'fromMinor', old_limit,
          'toMinor', r.limit_minor,
          'from', 'tenants.credit_limit',
          'source', 'migration:0053_tenant_credit_limit_to_wallets'
        )
      );
    END IF;
  END LOOP;

  FOR r IN
    SELECT t.slug, ap.currency, ap.credit_limit_minor
      FROM agency_portfolios ap
      JOIN tenants t ON t.id = ap.tenant_id
     WHERE ap.credit_limit_minor > 0
       AND NOT (t.credit_limit > 0 AND ap.currency = upper(btrim(t.default_currency)))
     ORDER BY t.path, ap.currency
  LOOP
    RAISE WARNING
      'REVISAR: la cartera en % del tenant % tiene un cupo de % (unidades menores) que no fijó quien la financia: se conserva hasta que lo revise',
      r.currency, r.slug, r.credit_limit_minor;
  END LOOP;
END $$;

COMMENT ON COLUMN tenants.credit_limit IS
  'FUERA DE USO desde 0053: su valor pasó al cupo de la cartera en default_currency (agency_portfolios.credit_limit_minor), que fija quien financia al nodo. Se conserva como dato; no lo escribe ni lo lee nada nuevo.';
