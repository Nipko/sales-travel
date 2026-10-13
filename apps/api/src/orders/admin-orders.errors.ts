import { NotFoundException } from '@nestjs/common';

/**
 * Los errores propios de Plataforma → Reservas de la red. La puerta (sólo el superadmin) es de
 * network/: SuperadminGuard, SuperadminRequiredError y rethrowAdminDbError; el nodo que no existe es
 * PlatformConsoleScopeNotFoundError, como en el Resumen.
 */

/** La reserva no existe en ningún nodo de la red. 404. */
export class AdminOrderNotFoundError extends NotFoundException {
  readonly reason = 'ORDER_NOT_FOUND';

  constructor() {
    super('No encontramos esa reserva.');
    this.name = 'AdminOrderNotFoundError';
  }
}
