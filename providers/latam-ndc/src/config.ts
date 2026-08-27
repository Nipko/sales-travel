/**
 * Configuración runtime del adapter LATAM NDC. Se inyecta desde la app leyendo la cuenta
 * BYOC del tenant o, en su defecto, las variables de entorno de la plataforma.
 *
 * Este archivo YA NO tiene modo mock. Hasta esta tanda, una config incompleta —o un
 * `mock: true` en el JSONB de la cuenta— desviaba el adapter a fixtures: precios inventados
 * con la MISMA forma canónica que una tarifa real, delante de un vendedor que los cotiza a
 * un cliente. La postura ahora es la de Sabre: sin credenciales usables el proveedor queda
 * AUSENTE de la búsqueda, y quien resuelve la ausencia es el factory
 * (`apps/api/src/providers-latam/latam-ndc.factory.ts`), que la traduce a "no habilitado".
 */
export interface LatamNdcConfig {
  apiUrl: string;
  apiKey?: string;
  apiSecret?: string;
  agencyId?: string;
  agencyIata?: string;
  agencyName?: string;
  travelAgentId?: string;
  country?: string;
  accountCode?: string;
}

/**
 * Los cinco campos sin los cuales no se puede firmar ni enrutar una llamada a LATAM.
 *
 * `apiKey`/`apiSecret` son el OAuth; `agencyId`/`agencyIata` identifican a la agencia en el
 * request NDC; `country` es el Point of Sale, del que cuelga la moneda y la tarifa.
 */
export const LATAM_REQUIRED_CREDENTIAL_FIELDS = [
  'apiKey',
  'apiSecret',
  'agencyId',
  'agencyIata',
  'country',
] as const;

/**
 * Nombres —nunca valores— de las credenciales que faltan. Sirve para el log estructurado y
 * para el mensaje del panel BYOC.
 */
export function missingLatamCredentials(cfg: LatamNdcConfig): readonly string[] {
  return LATAM_REQUIRED_CREDENTIAL_FIELDS.filter((field) => {
    const value = cfg[field];
    return typeof value !== 'string' || value.length === 0;
  });
}

/** ¿Esta config puede llamar a LATAM de verdad? Si no, el proveedor no se sirve. */
export function hasUsableLatamCredentials(cfg: LatamNdcConfig): boolean {
  return missingLatamCredentials(cfg).length === 0;
}
