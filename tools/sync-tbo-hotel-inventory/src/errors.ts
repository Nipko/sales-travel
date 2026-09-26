/**
 * Errores del sync del catálogo TBO. Como los del ACL, el `message` se arma sólo con vocabulario
 * nuestro (nombres de variables, `ruta:código`, `kind`): el `main` lo escribe tal cual en la línea
 * JSON de salida, y un valor de `TBO_SYNC_PASSWORD` no puede terminar en el log del workflow.
 */

export abstract class SyncError extends Error {
  /** Lo único que la línea final del log lleva del error. */
  abstract toLogMeta(): Readonly<Record<string, string | number | readonly string[]>>;
}

/**
 * La configuración del despliegue no vale: variables `TBO_SYNC_*` mal formadas o faltan las `PG*`.
 * Hay credenciales, así que no es el "todavía no está configurado" que se omite con salida 0: es
 * un despliegue roto y el workflow tiene que ponerse en rojo.
 */
export class SyncConfigError extends SyncError {
  constructor(readonly issues: readonly string[]) {
    super(`configuración del sync de TBO inválida (${issues.join(', ')})`);
    this.name = 'SyncConfigError';
  }

  toLogMeta(): Readonly<Record<string, string | readonly string[]>> {
    return { errorClass: this.name, issues: this.issues };
  }
}

/**
 * TBO rechazó la cuenta del catálogo (`401`, `402`) o el ACL se negó a armar la llamada por una
 * config que no sirve. Seguir sólo gastaría llamadas que van a fallar igual: la corrida termina y
 * el workflow queda en rojo para que alguien mire la cuenta.
 */
export class SyncAccountError extends SyncError {
  constructor(
    readonly code: string,
    readonly stage: string,
  ) {
    super(`TBO rechazó la cuenta del catálogo en ${stage} [${code}]`);
    this.name = 'SyncAccountError';
  }

  toLogMeta(): Readonly<Record<string, string>> {
    return { errorClass: this.name, code: this.code, stage: this.stage };
  }
}
