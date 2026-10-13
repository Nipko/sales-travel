import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Los rechazos propios de la gestión de cuentas de toda la plataforma (Plataforma → Usuarios, sólo
 * superadmin). En castellano porque el panel muestra el mensaje tal cual; el motivo es para que la
 * web decida sin interpretar el texto.
 */

/** No hay ninguna cuenta con ese id. 404. */
export class UserNotFoundError extends NotFoundException {
  readonly reason = 'USER_NOT_FOUND';

  constructor() {
    super('Ese usuario no existe.');
    this.name = 'UserNotFoundError';
  }
}

/**
 * Suspenderla dejaría la plataforma sin ningún superadmin activo: nadie podría reactivarla ni
 * administrar la red salvo por la base. 409.
 */
export class LastSuperadminError extends ConflictException {
  readonly reason = 'LAST_SUPERADMIN';

  constructor() {
    super('Es el último superadmin activo: no se puede suspender.');
    this.name = 'LastSuperadminError';
  }
}
