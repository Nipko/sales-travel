import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Los rechazos propios de la ficha de un usuario. En castellano porque el panel muestra el mensaje
 * tal cual; el motivo es para que la web decida sin interpretar el texto.
 */

/**
 * La sesión no está entre las abiertas de esa persona en el nodo de la ruta: ya se cerró (logout,
 * inactividad, otro admin), es de otra persona o cuelga de un nodo que no se administra desde ahí.
 * Un solo 404 para todo: no le cuenta a nadie si existe una sesión que no puede tocar.
 */
export class AdminSessionNotFoundError extends NotFoundException {
  readonly reason = 'SESSION_NOT_FOUND';

  constructor() {
    super('Esa sesión ya no está abierta.');
    this.name = 'AdminSessionNotFoundError';
  }
}

/** La ficha de cualquier persona de la plataforma (`/admin/users/:userId`) es del superadmin. 403. */
export class SuperadminOnlyError extends ForbiddenException {
  readonly reason = 'SUPERADMIN_ONLY';

  constructor() {
    super('Esta acción es sólo para el superadmin.');
    this.name = 'SuperadminOnlyError';
  }
}

/** Las sesiones propias se cierran desde Mi cuenta, donde se ve cuál es la de este equipo. */
export const OWN_SESSIONS_MESSAGE =
  'Tus propias sesiones se cierran desde Mi cuenta → Seguridad, no desde aquí.';
