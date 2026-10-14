import { ConflictException } from '@nestjs/common';

/**
 * Los rechazos propios de una membership quitada del nodo (USR-11, 0067). En castellano porque
 * Equipo muestra el mensaje tal cual; el motivo es para que la web no tenga que interpretar el texto.
 */

/**
 * La persona ya no forma parte del nodo: se la quitó y la única vuelta es una invitación nueva. Ni
 * reactivarla, ni cambiarle el rol, ni quitarla otra vez. 409.
 */
export class MembershipRemovedError extends ConflictException {
  readonly reason = 'MEMBERSHIP_REMOVED';

  constructor() {
    super('Esta persona ya no forma parte de este nodo: para que vuelva, invítala de nuevo.');
    this.name = 'MembershipRemovedError';
  }
}

/**
 * Se canjeó una invitación de alguien que ya tiene una membership vigente (activa o suspendida) en
 * ese nodo. Invitar ya lo rechaza; esto cubre la carrera y las invitaciones de antes de esa regla.
 * La transacción del canje se deshace: la invitación queda pendiente. 409.
 */
export class AlreadyMemberError extends ConflictException {
  readonly reason = 'ALREADY_MEMBER';

  constructor() {
    super('Ya formas parte de este nodo: ingresa con tu cuenta.');
    this.name = 'AlreadyMemberError';
  }
}
