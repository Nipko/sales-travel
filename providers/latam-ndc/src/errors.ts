/**
 * Error tipado del proveedor LATAM NDC (red caída, timeout, auth/token, config faltante o
 * respuesta no parseable). `status === 0` indica fallo de red/timeout. Los errores de NEGOCIO
 * de LATAM viajan como XML 4xx parseado (los mappers los convierten en result.error), NO acá.
 */
export class LatamApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`LATAM ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'LatamApiError';
  }
}
