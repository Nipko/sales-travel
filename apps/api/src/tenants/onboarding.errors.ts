import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';

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

/**
 * Se canjeó por el formulario de cuenta nueva (`POST /invitations/accept`) una invitación cuyo correo
 * ya tiene una cuenta (USR-17). Quien ya tiene cuenta no elige otra contraseña: ingresa con la suya y
 * acepta con la sesión abierta (`POST /invitations/join`). Antes la contraseña nueva se ignoraba en
 * silencio y la membership se sumaba sin que la cuenta se autenticara. La transacción del canje se
 * deshace: la invitación queda pendiente. 409.
 *
 * Sale sólo con un token vigente, así que no dice nada que quien controla ese buzón no sepa: la vista
 * previa de la invitación ya se lo cuenta.
 */
export class InvitationSignInRequiredError extends ConflictException {
  readonly reason = 'INVITATION_SIGN_IN_REQUIRED';

  constructor() {
    super('Ya tienes una cuenta con este correo: ingresa con ella para aceptar la invitación.');
    this.name = 'InvitationSignInRequiredError';
  }
}

/**
 * La sesión que acepta (`POST /invitations/join`) no es la de la cuenta del correo invitado (USR-17).
 * Sin esto, cualquiera con una cuenta y el enlace de otra persona sumaba SU cuenta al nodo con el rol
 * de la invitación. La transacción se deshace: la invitación queda pendiente para su dueño. 403.
 */
export class InvitationAccountMismatchError extends ForbiddenException {
  readonly reason = 'INVITATION_ACCOUNT_MISMATCH';

  constructor() {
    super('Esta invitación es para otra cuenta: ingresa con el correo al que te llegó.');
    this.name = 'InvitationAccountMismatchError';
  }
}

/** Mensaje del 400 al alta de un nodo que trae contraseña para su admin. */
export const ADMIN_PASSWORD_RETIRED_MESSAGE =
  'El admin del nodo se invita por correo y elige su propia contraseña: no se envía adminPassword.';
