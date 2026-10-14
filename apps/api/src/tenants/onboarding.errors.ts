import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';

/**
 * `POST /admin/users` ya no da de alta a nadie (docs/platform/14). Vinculaba a su nodo cualquier
 * cuenta de la plataforma sin que aceptara y devolvía su id, nombre y estado: enumeración y PII entre
 * redes. Y a una cuenta nueva le ponía la contraseña que elegía el admin. 410, sin mirar la base: la
 * respuesta es la misma exista o no el email.
 */
export class UserCreationRetiredError extends GoneException {
  readonly reason = 'USER_CREATION_RETIRED';

  constructor() {
    super('Los usuarios se suman por invitación: usa POST /invitations.');
    this.name = 'UserCreationRetiredError';
  }
}

/**
 * La invitación no está pendiente en ese nodo: no existe, es de otro nodo, ya se aceptó o se revocó.
 * Un solo motivo para todo, así no se sondea qué invitaciones ajenas existen. 404.
 */
export class InvitationNotPendingError extends NotFoundException {
  readonly reason = 'INVITATION_NOT_PENDING';

  constructor() {
    super('Esa invitación ya no está pendiente en este nodo.');
    this.name = 'InvitationNotPendingError';
  }
}

/**
 * Ya hay una invitación pendiente (vencida o no) para ese correo en el nodo. Una segunda dejaría a
 * la persona con dos enlaces vigentes; lo que sirve es reenviar la que existe. 409.
 *
 * `publicDetails.invitationId` es para que Equipo ofrezca "Reenviar la invitación" sin buscarla: quien
 * invita administra el nodo y ya la ve en su lista. Puede faltar si la que ganó la carrera no se pudo
 * releer (la revocaron en el medio): el mensaje alcanza igual.
 */
export class InvitationAlreadyPendingError extends ConflictException {
  readonly reason = 'INVITATION_ALREADY_PENDING';
  readonly publicDetails: { readonly invitationId: string } | undefined;

  constructor(invitationId?: string) {
    super('Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.');
    this.name = 'InvitationAlreadyPendingError';
    this.publicDetails = invitationId === undefined ? undefined : { invitationId };
  }
}

/** Mensaje del 400 al alta de un nodo que trae contraseña para su admin. */
export const ADMIN_PASSWORD_RETIRED_MESSAGE =
  'El admin del nodo se invita por correo y elige su propia contraseña: no se envía adminPassword.';
