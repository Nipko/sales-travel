import { ForbiddenException } from '@nestjs/common';

/**
 * La puerta de las herramientas de la plataforma (`/admin/...` de la consola): sólo el superadmin.
 * La usan {@link SuperadminGuard} y las lecturas de toda la red, que la base vuelve a exigir.
 */

/** Quien no es el superadmin de la plataforma (`platform_admin` incluido, D7 B). 403. */
export class SuperadminRequiredError extends ForbiddenException {
  readonly reason = 'SUPERADMIN_REQUIRED';

  constructor() {
    super('Esta acción es sólo para el superadmin.');
    this.name = 'SuperadminRequiredError';
  }
}

/**
 * El mensaje con que las funciones de la consola (0075 en adelante) rechazan, con 42501, a quien no
 * es el superadmin (`is_platform_superadmin()`).
 */
export const ADMIN_SUPERADMIN_DB_DENIAL = 'admin_superadmin_required';

/** ¿Es el rechazo de la base a una lectura de toda la red? */
export function isAdminSuperadminDenial(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === '42501' && message === ADMIN_SUPERADMIN_DB_DENIAL;
}

/**
 * Relanza un error de la base: el rechazo de la consola como el mismo 403 que da la guarda (pasa si
 * el usuario deja de ser superadmin entre la comprobación de la app y la lectura); cualquier otro,
 * tal cual.
 */
export function rethrowAdminDbError(err: unknown): never {
  if (isAdminSuperadminDenial(err)) throw new SuperadminRequiredError();
  throw err;
}
