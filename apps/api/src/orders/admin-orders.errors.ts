import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

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

/** La reserva no tiene localizador del proveedor: no hay con qué consultarla ni cancelarla. 409. */
export class AdminOrderWithoutLocatorError extends ConflictException {
  readonly reason = 'ORDER_WITHOUT_LOCATOR';

  constructor() {
    super('La reserva no tiene localizador del proveedor: no hay nada que consultar ni cancelar.');
    this.name = 'AdminOrderWithoutLocatorError';
  }
}

/** El número escrito para confirmar la cancelación no es el de la reserva. 400. */
export class AdminOrderNumberMismatchError extends BadRequestException {
  readonly reason = 'ORDER_NUMBER_MISMATCH';

  constructor() {
    super('El número de orden no coincide: escríbelo tal como aparece en la reserva.');
    this.name = 'AdminOrderNumberMismatchError';
  }
}
