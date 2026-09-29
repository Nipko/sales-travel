/**
 * Errores del seed. Los mensajes llevan nombres de variable, slugs y motivos; nunca una contraseña
 * ni el correo del superadmin: la salida del contenedor queda en la terminal del VPS y en su
 * historial.
 */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/**
 * Variables del entorno ausentes o inválidas, como `VARIABLE:motivo`. Algunas sólo son obligatorias
 * según lo que haya en la base (`required_to_create_tenant`, `required_to_create_user`).
 */
export class SeedConfigError extends SeedError {
  constructor(readonly issues: readonly string[]) {
    super(`configuración del seed inválida: ${issues.join(', ')}`);
    this.name = 'SeedConfigError';
  }
}

/**
 * Sembrar rompería la red (una segunda plataforma, una raíz que cuelga de otro nodo) o la sesión no
 * puede ver lo que necesita. No se corrige solo: lo decide una persona.
 */
export class SeedRefusedError extends SeedError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SeedRefusedError';
  }
}
