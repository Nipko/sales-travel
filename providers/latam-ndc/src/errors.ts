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

/** Status sintético de {@link LatamBusinessError}: LATAM respondió, pero dijo que no. */
export const LATAM_BUSINESS_ERROR_STATUS = 422;

/**
 * LATAM respondió con `<Error>` de negocio: fecha pasada, oferta vencida, documento inválido…
 *
 * Antes estos errores se convertían en un warning y la operación seguía: la revalidación devolvía
 * la oferta original como «confirmada» y la búsqueda devolvía «0 vuelos». Ahora se lanzan, y quien
 * llama decide qué hacer. Es subclase de {@link LatamApiError} para que el filtro HTTP y el
 * humanizador de `apps/api` la sigan atrapando sin cambios de cableado.
 *
 * `errors` lleva código y descripción de LATAM. No llevan PII: son mensajes de validación.
 */
export class LatamBusinessError extends LatamApiError {
  /**
   * Efecto sobre el circuit breaker de la búsqueda (`apps/api/src/search/circuit-breaker.service.ts`,
   * que lo lee por forma): LATAM respondió, así que no es una caída. Sin esto, cinco búsquedas con
   * una fecha pasada abrirían el circuito y apagarían LATAM para toda la red.
   */
  readonly failure = { circuit: 'IGNORE', kind: 'business' } as const;

  constructor(
    readonly errors: readonly { code: string; desc: string }[],
    path: string,
    readonly trackId?: string,
  ) {
    super(LATAM_BUSINESS_ERROR_STATUS, errors.map((e) => `${e.code}: ${e.desc}`).join(' | '), path);
    this.name = 'LatamBusinessError';
  }

  hasCode(...codes: string[]): boolean {
    return this.errors.some((e) => codes.includes(e.code));
  }
}
