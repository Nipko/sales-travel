import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ADMIN_ORDERS_EXPORT_MAX_ROWS } from './admin-orders.schemas.js';

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

/**
 * Con estos filtros hay más reservas de las que caben en una exportación. 422: no se manda un archivo
 * a medias, que en una planilla de contabilidad pasaría por completo.
 */
export class AdminOrdersExportTooLargeError extends UnprocessableEntityException {
  readonly reason = 'EXPORT_TOO_LARGE';

  constructor() {
    super(
      `Hay más de ${ADMIN_ORDERS_EXPORT_MAX_ROWS.toLocaleString('es-CO')} reservas con estos ` +
        'filtros: acota las fechas o el nodo.',
    );
    this.name = 'AdminOrdersExportTooLargeError';
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
