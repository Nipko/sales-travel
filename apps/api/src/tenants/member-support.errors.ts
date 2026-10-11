import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * Los rechazos propios de enviarle a un miembro el enlace para restablecer su contraseña. Van en
 * castellano porque Equipo muestra el mensaje tal cual; el motivo es para que la web no tenga que
 * interpretar el texto.
 */

/** La cuenta está suspendida en toda la plataforma: un enlace no le serviría para entrar. 409. */
export class MemberAccountSuspendedError extends ConflictException {
  readonly reason = 'MEMBER_ACCOUNT_SUSPENDED';

  constructor() {
    super(
      'Su cuenta está suspendida en toda la plataforma: reactívala antes de enviarle el enlace.',
    );
    this.name = 'MemberAccountSuspendedError';
  }
}

/** Su membership en el nodo de la ruta está suspendida. 409. */
export class MembershipSuspendedError extends ConflictException {
  readonly reason = 'MEMBERSHIP_SUSPENDED';

  constructor() {
    super('Su acceso a este nodo está suspendido: reactívalo antes de enviarle el enlace.');
    this.name = 'MembershipSuspendedError';
  }
}

/**
 * Ya hay varios enlaces recientes para esa persona (los que pidió ella también cuentan): frena que
 * un admin le llene el buzón o deje sin efecto, una y otra vez, el enlace que acaba de recibir. 429.
 */
export class PasswordResetRateLimitedError extends HttpException {
  readonly reason = 'PASSWORD_RESET_RATE_LIMITED';

  constructor() {
    super(
      'Ya se enviaron varios enlaces a esta persona hace poco. Espera 15 minutos antes de enviar otro.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.name = 'PasswordResetRateLimitedError';
  }
}
