-- 0097_quotations_quote_number_unique.sql
-- El número de cotización no se repite dentro de una agencia (auditoría de flujos de venta, V5).
--
-- `quote_number` se calculaba como MAX + 1 sin nada que lo respaldara: dos cotizaciones creadas a
-- la vez en la misma agencia leían el mismo MAX y salían con el mismo número. La API ahora toma un
-- advisory lock por agencia antes de calcularlo (`QuotationsService.create`), y este índice único
-- es la red: si algún camino se lo saltara, la base rechaza el repetido (23505) en vez de
-- guardarlo.
--
-- Los repetidos que YA existan no se renumeran: ese número pudo haber salido por email o WhatsApp
-- al cliente, y cambiarlo dejaría al vendedor buscando una cotización que «no existe». Se marca
-- cada repetido salvo el más antiguo de su grupo (`quote_number_duplicate`) y el índice deja
-- fuera sólo a esos. Así la migración no falla con datos viejos y lo nuevo queda protegido: un
-- número nuevo es MAX + 1, nunca choca con uno viejo.

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS quote_number_duplicate BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN quotations.quote_number_duplicate IS
  'true sólo en cotizaciones anteriores a 0097 que salieron con un quote_number ya usado en su agencia (la carrera de MAX + 1). Se conservan con su número; el índice único las deja fuera. Nada nuevo la pone en true.';

-- Marcar repetidos no es una edición de la cotización: sin esto el trigger les movería updated_at.
ALTER TABLE quotations DISABLE TRIGGER set_updated_at_quotations;

UPDATE quotations q
   SET quote_number_duplicate = true
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY tenant_id, quote_number ORDER BY created_at, id) AS rn
      FROM quotations
  ) d
 WHERE d.id = q.id
   AND d.rn > 1;

ALTER TABLE quotations ENABLE TRIGGER set_updated_at_quotations;

CREATE UNIQUE INDEX IF NOT EXISTS uq_quotations_tenant_quote_number
  ON quotations (tenant_id, quote_number)
  WHERE NOT quote_number_duplicate;
