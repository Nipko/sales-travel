/**
 * Se intentó construir el adapter de LATAM sin las credenciales que hacen falta para llamar
 * a LATAM.
 *
 * Es un error y no un modo degradado: la alternativa histórica —caer a fixtures— fabricaba
 * ofertas con forma de tarifa real. Falla ruidoso en el arranque del adapter; quien sabe
 * convertir esa negativa en "proveedor no habilitado" es el factory de `apps/api`.
 *
 * Sólo lleva NOMBRES de campo, nunca valores: el mensaje acaba en logs y en stack traces.
 */
export class LatamCredentialsMissingError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `no se puede construir el adapter de LATAM NDC sin credenciales usables (faltan: ${missing.join(', ')})`,
    );
    this.name = 'LatamCredentialsMissingError';
  }
}

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
