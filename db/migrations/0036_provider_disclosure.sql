-- 0036_provider_disclosure.sql
-- ¿El vendedor ve de qué proveedor viene cada oferta de vuelo?
--
-- En un consolidador, la lista de proveedores es información comercial: dice con quién
-- tiene contrato la casa y por dónde compra. Una agencia de la red que lee "esta tarifa
-- salió de Sabre y esta otra de LATAM directo" puede ir a negociar por su cuenta con el
-- mismo proveedor. Por eso mostrarlo tiene que ser una DECISIÓN, no un efecto del diseño
-- de la pantalla.
--
-- Es un control de PRESENTACIÓN, no un límite de seguridad: `offer.provider.name` sigue
-- viajando en la respuesta de búsqueda porque revalidar precio y reservar se enrutan por
-- él (SearchService.priceOffer). Quien abra las herramientas de desarrollo del navegador
-- lo ve igual. Lo que esta migración gobierna es lo que la pantalla PINTA.

-- ============================================================================
-- 1. La preferencia, heredable por la jerarquía
-- ============================================================================
-- NULL = no configurado, y entonces manda la cadena de ancestros (ver la función de
-- abajo). Se guarda en `tenants` y no en una tabla de settings porque es exactamente la
-- misma forma que el branding heredable de 0030: un campo por nodo, resuelto por path.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS show_provider_in_results BOOLEAN;

COMMENT ON COLUMN tenants.show_provider_in_results IS
  'Si los resultados de búsqueda muestran de qué proveedor viene cada oferta. NULL = no configurado (hereda del ancestro; sin nadie configurado, oculto). Ocultar gana sobre mostrar a lo largo de la cadena. Ver db/migrations/0036.';

-- ============================================================================
-- 2. La cadena de valores, de la raíz al propio tenant
-- ============================================================================
-- Devuelve los valores CRUDOS y deja el plegado en el API (provider-disclosure.policy.ts).
-- Es a propósito: la regla —"ocultar gana, y por defecto oculto"— es una decisión de
-- producto que hay que poder probar con tests, y una función SQL que devuelve un booleano
-- ya plegado sólo se prueba con una base levantada.
--
-- SECURITY DEFINER como resolve_tenant_branding (0030) y resolve_provider_account (0012):
-- hace falta leer filas de tenants ANCESTROS, que la RLS del tenant activo no alcanza.
--
-- Sin filtro por `status`: si el consolidador queda suspendido, su "oculto" tiene que
-- seguir en pie. Filtrar por activo lo dejaría fuera de la cadena y destaparía la cadena
-- de suministro justo en el momento en que nadie está mirando.
CREATE OR REPLACE FUNCTION provider_disclosure_chain(p_tenant_id UUID)
RETURNS TABLE (
  tenant_id                UUID,
  lvl                      INTEGER,
  show_provider_in_results BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  WITH me AS (SELECT path FROM tenants WHERE id = p_tenant_id)
  SELECT t.id, nlevel(t.path)::int, t.show_provider_in_results
  FROM tenants t
  CROSS JOIN me
  WHERE t.path OPERATOR(public.@>) me.path   -- ancestros de p_tenant_id, él incluido
  ORDER BY nlevel(t.path);
$$;

COMMENT ON FUNCTION provider_disclosure_chain(UUID) IS
  'Valores de show_provider_in_results de la cadena consolidador → agencia → sub-agencia, de la raíz al propio tenant. El plegado (ocultar gana; por defecto oculto) vive en el API. Ver db/migrations/0036.';

GRANT EXECUTE ON FUNCTION provider_disclosure_chain(UUID) TO app_user;
