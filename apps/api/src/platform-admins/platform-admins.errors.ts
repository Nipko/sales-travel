import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Los rechazos de la gestión de superadmins y de las solicitudes de cambio (docs/platform/16). En
 * castellano porque el panel muestra el mensaje tal cual; el `reason` es para que la web decida sin
 * interpretar el texto.
 */

/**
 * Lo pidió un superadmin supervisado: no se aplicó, quedó como solicitud para un superadmin pleno.
 * 409 a propósito (y no 202): un panel que no conoce la solicitud muestra el mensaje en vez de leer
 * la respuesta como si el cambio ya estuviera hecho.
 */
export class ChangeRequestPendingError extends ConflictException {
  readonly reason = 'CHANGE_REQUEST_PENDING';
  readonly publicDetails: { changeRequestId: string };

  constructor(changeRequestId: string) {
    super(
      'Tu cambio quedó como solicitud: un superadmin pleno tiene que aprobarlo en Plataforma → Superadmins.',
    );
    this.name = 'ChangeRequestPendingError';
    this.publicDetails = { changeRequestId };
  }
}

/** Sólo un superadmin pleno (no supervisado). 403. */
export class FullSuperadminRequiredError extends ForbiddenException {
  readonly reason = 'FULL_SUPERADMIN_REQUIRED';

  constructor(message = 'Esta acción es sólo para un superadmin pleno.') {
    super(message);
    this.name = 'FullSuperadminRequiredError';
  }
}

/** Un supervisado no carga credenciales de proveedor: un secreto no espera en una cola. 403. */
export class SupervisedCredentialsError extends ForbiddenException {
  readonly reason = 'SUPERVISED_CANNOT_MANAGE_CREDENTIALS';

  constructor() {
    super(
      'Un superadmin supervisado no carga credenciales de proveedor: pídeselo a un superadmin pleno.',
    );
    this.name = 'SupervisedCredentialsError';
  }
}

export class ChangeRequestNotFoundError extends NotFoundException {
  readonly reason = 'CHANGE_REQUEST_NOT_FOUND';

  constructor() {
    super('Esa solicitud no existe.');
    this.name = 'ChangeRequestNotFoundError';
  }
}

/** Ya se aprobó, rechazó o canceló. 409. */
export class ChangeRequestNotPendingError extends ConflictException {
  readonly reason = 'CHANGE_REQUEST_NOT_PENDING';

  constructor() {
    super('Esa solicitud ya no está pendiente: vuelve a cargar la lista.');
    this.name = 'ChangeRequestNotPendingError';
  }
}

/** Nadie aprueba ni rechaza lo que pidió. 403. */
export class OwnChangeRequestError extends ForbiddenException {
  readonly reason = 'OWN_CHANGE_REQUEST';

  constructor() {
    super('No puedes decidir una solicitud tuya: la aprueba otro superadmin pleno.');
    this.name = 'OwnChangeRequestError';
  }
}

/** Sólo quien la pidió la cancela. 403. */
export class NotRequesterError extends ForbiddenException {
  readonly reason = 'NOT_REQUESTER';

  constructor() {
    super('Sólo quien pidió el cambio puede cancelarlo.');
    this.name = 'NotRequesterError';
  }
}

/** El tipo de cambio guardado ya no se sabe aplicar (lo quitó un despliegue). 422. */
export class ChangeKindUnknownError extends UnprocessableEntityException {
  readonly reason = 'CHANGE_KIND_UNKNOWN';

  constructor() {
    super('Este tipo de cambio ya no se puede aplicar: recházalo y pídelo de nuevo.');
    this.name = 'ChangeKindUnknownError';
  }
}

/** Sobre uno mismo no: darse, quitarse o cambiarse el tipo de superadmin. 403. */
export class SelfPlatformAdminChangeError extends ForbiddenException {
  readonly reason = 'SELF_PLATFORM_ADMIN_CHANGE';

  constructor() {
    super('No puedes cambiar tu propio acceso de superadmin: lo hace otro superadmin pleno.');
    this.name = 'SelfPlatformAdminChangeError';
  }
}

/** Dejaría la plataforma sin ningún superadmin pleno activo. 409. */
export class LastFullSuperadminError extends ConflictException {
  readonly reason = 'LAST_FULL_SUPERADMIN';

  constructor() {
    super('Es el último superadmin pleno activo: primero nombra a otro.');
    this.name = 'LastFullSuperadminError';
  }
}

/** No hay cuenta activa con ese correo. 404. */
export class PlatformAdminCandidateNotFoundError extends NotFoundException {
  readonly reason = 'USER_NOT_FOUND';

  constructor() {
    super(
      'No hay ninguna cuenta activa con ese correo: primero tiene que existir en la plataforma.',
    );
    this.name = 'PlatformAdminCandidateNotFoundError';
  }
}

/** La cuenta no es superadmin. 404. */
export class PlatformAdminNotFoundError extends NotFoundException {
  readonly reason = 'PLATFORM_ADMIN_NOT_FOUND';

  constructor() {
    super('Esa cuenta no es superadmin.');
    this.name = 'PlatformAdminNotFoundError';
  }
}

/** Los superadmins se manejan en Plataforma → Superadmins, no como un rol de nodo. 403. */
export class PlatformRoleManagedElsewhereError extends ForbiddenException {
  readonly reason = 'PLATFORM_ROLE_MANAGED_ELSEWHERE';

  constructor() {
    super('Los superadmins se gestionan en Plataforma → Superadmins.');
    this.name = 'PlatformRoleManagedElsewhereError';
  }
}
