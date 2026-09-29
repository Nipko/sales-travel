/**
 * Errores del sync del catálogo TBO. Como los del ACL, el `message` se arma sólo con vocabulario
 * nuestro (nombres de variables, `ruta:código`, `kind`, etiquetas de cuenta): el `main` lo escribe
 * tal cual en la línea JSON de salida, y ni `TBO_SYNC_PASSWORD` ni la contraseña de la bóveda pueden
 * terminar en el log del workflow.
 */

export abstract class SyncError extends Error {
  /** Lo único que la línea final del log lleva del error. */
  abstract toLogMeta(): Readonly<Record<string, string | number | readonly string[]>>;
}

/**
 * La configuración del despliegue no vale: variables `TBO_SYNC_*` mal formadas, faltan las `PG*`, o
 * hay una cuenta en la bóveda y falta (o no vale) `PROVIDER_CREDENTIALS_KEY` para abrirla. No es el
 * "todavía no hay cuenta" que se omite con salida 0: es un despliegue roto y el workflow tiene que
 * ponerse en rojo.
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
 * Por qué la cuenta de la bóveda no sirve para el sync. Todos son despliegues o cuentas rotas, no
 * "todavía no hay cuenta" (eso es `skip` con salida 0):
 *
 * - `ambiguous_platform`: más de una raíz `platform` (0050 lo impide; esto es la red).
 * - `ambiguous_accounts`: varias cuentas activas y ninguna es `catalogo` ni `default`.
 * - `undecryptable`: `PROVIDER_CREDENTIALS_KEY` no es la clave con que el api la cifró.
 * - `unreadable_credentials`: el blob descifrado no es un objeto JSON.
 * - `invalid_config`: `environment` o `baseUrl` no pasan las reglas del ACL.
 * - `incomplete`: falta usuario, contraseña o (en `live`) la URL.
 */
export type SyncVaultErrorCode =
  | 'ambiguous_platform'
  | 'ambiguous_accounts'
  | 'undecryptable'
  | 'unreadable_credentials'
  | 'invalid_config'
  | 'incomplete';

/**
 * La cuenta de TBO de la bóveda de la plataforma existe pero no se puede usar. El workflow queda en
 * rojo para que alguien la corrija en el panel. `account` es `<slug>/<etiqueta>` (o sólo el slug)
 * y `details` son etiquetas o `campo:código`: nunca un valor de la credencial.
 */
export class SyncVaultError extends SyncError {
  constructor(
    readonly code: SyncVaultErrorCode,
    readonly account: string,
    readonly details: readonly string[] = [],
  ) {
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    super(`la cuenta de TBO de la bóveda (${account}) no sirve para el sync [${code}]${suffix}`);
    this.name = 'SyncVaultError';
  }

  toLogMeta(): Readonly<Record<string, string | readonly string[]>> {
    return {
      errorClass: this.name,
      code: this.code,
      account: this.account,
      details: this.details,
    };
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
