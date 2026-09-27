/**
 * Errores del seed. Los mensajes llevan nombres de variable, de tabla y motivos; nunca un valor de
 * credencial, porque el log del job de despliegue lo puede leer cualquiera con acceso al repo.
 */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** Variables del entorno ausentes o inválidas, como `VARIABLE:motivo`. */
export class SeedConfigError extends SeedError {
  constructor(readonly issues: readonly string[]) {
    super(`configuración del seed inválida: ${issues.join(', ')}`);
    this.name = 'SeedConfigError';
  }
}

/**
 * La base no es la que el seed puede tocar, o sembrar rompería algo que ya existe (una cuenta con
 * reservas, un usuario de otra red). No se corrige solo: lo decide una persona.
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
