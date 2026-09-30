import { ForbiddenException } from '@nestjs/common';

/**
 * Los errores de los permisos de reserva (db/migrations/0055), con motivo máquina (`reason`) para
 * que la web decida qué ofrecer sin interpretar el texto.
 */
export type BookingPermissionsReason = 'BOOKING_PERMISSIONS_FINANCIER_REQUIRED';

const MESSAGES: Readonly<Record<BookingPermissionsReason, string>> = {
  BOOKING_PERMISSIONS_FINANCIER_REQUIRED:
    'Sólo quien financia a este nodo decide qué tarifas puede reservar: su consolidador, su agencia o el superadmin de Planetour.',
};

/** 403: quien actúa no financia a ese nodo (o el nodo no existe: la misma respuesta). */
export class BookingPermissionsForbiddenError extends ForbiddenException {
  readonly reason: BookingPermissionsReason;

  constructor(reason: BookingPermissionsReason) {
    super(MESSAGES[reason]);
    this.reason = reason;
    this.name = 'BookingPermissionsForbiddenError';
  }
}

interface PgErrorFields {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

/**
 * Un 42501 de la base al escribir el permiso es la RLS o la guarda de 0055 diciendo que quien actúa
 * no financia al nodo (o no firma como él): el mismo 403 que la comprobación previa. Otro error sigue
 * su camino.
 */
export function rethrowBookingPermissionsError(error: unknown): never {
  if (typeof error === 'object' && error !== null) {
    const { code } = error as PgErrorFields;
    if (code === '42501') {
      throw new BookingPermissionsForbiddenError('BOOKING_PERMISSIONS_FINANCIER_REQUIRED');
    }
  }
  throw error;
}
