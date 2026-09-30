import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { SessionFailureReason } from '../request-context/request-context.js';

/**
 * Rechazos de autenticación con motivo máquina (`reason`, que publica AllExceptionsFilter) y, los
 * que llevan datos para la pantalla, `publicDetails`. El panel decide con el `reason` qué mostrar
 * sin interpretar el texto.
 *
 * Ojo con el código HTTP: un 401 el panel lo lee como "la sesión murió" y manda al login. Los
 * errores de un código mal tipeado DENTRO de una sesión (confirmar el enrolamiento, regenerar
 * códigos, desactivar) son 400; sólo el paso MFA del login, donde todavía no hay sesión, usa 401.
 */

const SESSION_MESSAGES: Record<SessionFailureReason, string> = {
  SESSION_IDLE: 'Cerramos tu sesión por inactividad. Volvé a ingresar.',
  SESSION_REPLACED: 'Tu sesión se abrió en otro dispositivo.',
  SESSION_RELEASED: 'Un administrador liberó tu puesto.',
  SESSION_EXPIRED: 'Tu sesión venció. Volvé a ingresar.',
  SESSION_REVOKED: 'Tu sesión se cerró. Volvé a ingresar.',
};

/** El bearer venía firmado pero su sesión ya no sirve (inactividad, otro dispositivo...). 401. */
export class SessionInvalidError extends UnauthorizedException {
  readonly reason: SessionFailureReason;

  constructor(reason: SessionFailureReason) {
    super(SESSION_MESSAGES[reason]);
    this.name = 'SessionInvalidError';
    this.reason = reason;
  }
}

/**
 * No se pudo consultar la base para validar la sesión (pool saturado, Postgres reiniciando). 503 y
 * no 401: el panel lee un 401 como "la sesión murió" y echaba al login a quien navegara durante un
 * corte de segundos. Con el 503 el ping reintenta y la sesión, si sigue viva, sigue.
 */
export class SessionCheckUnavailableError extends ServiceUnavailableException {
  readonly reason = 'SESSION_CHECK_UNAVAILABLE';

  constructor() {
    super('No pudimos verificar tu sesión. Probá de nuevo en unos segundos.');
    this.name = 'SessionCheckUnavailableError';
  }
}

/** El rol exige MFA y el usuario no lo activó: sólo puede enrolarse (o salir). 403. */
export class MfaEnrollmentRequiredError extends ForbiddenException {
  readonly reason = 'MFA_ENROLLMENT_REQUIRED';

  constructor() {
    super('Tu rol exige la verificación en dos pasos. Activala para seguir.');
    this.name = 'MfaEnrollmentRequiredError';
  }
}

/** El rol exige MFA, lo tiene activo, pero ESTA sesión no pasó el segundo factor. 401. */
export class MfaStepUpRequiredError extends UnauthorizedException {
  readonly reason = 'MFA_STEP_UP_REQUIRED';

  constructor() {
    super('Esta sesión no pasó la verificación en dos pasos. Volvé a ingresar.');
    this.name = 'MfaStepUpRequiredError';
  }
}

/** Código incorrecto en el paso MFA del login. Quedan `attemptsLeft` en este desafío. 401. */
export class MfaCodeInvalidError extends UnauthorizedException {
  readonly reason = 'MFA_CODE_INVALID';
  readonly publicDetails: { readonly attemptsLeft: number };

  constructor(attemptsLeft: number) {
    super(
      attemptsLeft === 1
        ? 'El código no es válido. Te queda 1 intento.'
        : `El código no es válido. Te quedan ${attemptsLeft} intentos.`,
    );
    this.name = 'MfaCodeInvalidError';
    this.publicDetails = { attemptsLeft };
  }
}

/** El desafío venció, ya se usó o se quedó sin intentos: hay que volver a la contraseña. 401. */
export class MfaChallengeExpiredError extends UnauthorizedException {
  readonly reason = 'MFA_CHALLENGE_EXPIRED';

  constructor() {
    super('La verificación venció o superó los intentos. Volvé a ingresar tu contraseña.');
    this.name = 'MfaChallengeExpiredError';
  }
}

/**
 * La cuenta quedó bloqueada por fallos (contraseña y códigos suman al mismo contador) en el paso MFA
 * del login. 401, como el resto del paso. Decirlo no enumera nada: para tener un desafío ya se probó
 * la contraseña, y el panel ofrece restablecerla en vez de rechazarla como incorrecta 15 minutos.
 */
export class MfaAccountLockedError extends UnauthorizedException {
  readonly reason = 'MFA_ACCOUNT_LOCKED';

  constructor(minutes: number) {
    super(
      `Demasiados intentos fallidos: bloqueamos la cuenta ${minutes} minutos por seguridad. Probá de nuevo más tarde.`,
    );
    this.name = 'MfaAccountLockedError';
  }
}

/**
 * La misma cuenta bloqueada, pero DENTRO de una sesión (regenerar códigos, cambiar de teléfono,
 * desactivar): 429 y no 401, porque el panel lee un 401 como "la sesión murió".
 */
export class MfaReauthLockedError extends HttpException {
  readonly reason = 'MFA_ACCOUNT_LOCKED';

  constructor(minutes: number) {
    super(
      `Demasiados intentos fallidos: pausamos la verificación ${minutes} minutos por seguridad. Probá de nuevo más tarde.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.name = 'MfaReauthLockedError';
  }
}

/** Código incorrecto dentro de una sesión (enrolar, regenerar, desactivar). 400, no 401. */
export class MfaCodeRejectedError extends BadRequestException {
  readonly reason = 'MFA_CODE_INVALID';

  constructor() {
    super('El código no es válido o ya se usó. Esperá el siguiente e intentá de nuevo.');
    this.name = 'MfaCodeRejectedError';
  }
}

/** Contraseña o código incorrectos al pedir una operación sensible sobre el MFA. 400. */
export class MfaReauthInvalidError extends BadRequestException {
  readonly reason = 'MFA_REAUTH_INVALID';

  constructor() {
    super('La contraseña o el código no son correctos.');
    this.name = 'MfaReauthInvalidError';
  }
}

/** Enrolar con MFA activo sin contraseña y código: pisaría el factor vigente. 409. */
export class MfaAlreadyEnabledError extends ConflictException {
  readonly reason = 'MFA_ALREADY_ENABLED';

  constructor() {
    super(
      'Ya tenés la verificación en dos pasos activa. Para cambiar de teléfono confirmá tu contraseña y un código actual.',
    );
    this.name = 'MfaAlreadyEnabledError';
  }
}

/** Confirmar sin un enrolamiento en curso. 409. */
export class MfaNoPendingEnrollmentError extends ConflictException {
  readonly reason = 'MFA_NO_PENDING_ENROLLMENT';

  constructor() {
    super('No hay una activación en curso. Empezá de nuevo.');
    this.name = 'MfaNoPendingEnrollmentError';
  }
}

/** Regenerar códigos sin MFA activo. 409. */
export class MfaNotEnabledError extends ConflictException {
  readonly reason = 'MFA_NOT_ENABLED';

  constructor() {
    super('La verificación en dos pasos no está activa.');
    this.name = 'MfaNotEnabledError';
  }
}

/** Desactivar el MFA con un rol que lo exige. 403. */
export class MfaRequiredByRoleError extends ForbiddenException {
  readonly reason = 'MFA_REQUIRED_BY_ROLE';

  constructor() {
    super('Tu rol exige la verificación en dos pasos: no se puede desactivar.');
    this.name = 'MfaRequiredByRoleError';
  }
}

export interface SeatHolderView {
  sessionId: string;
  name: string | null;
  email: string;
  tenantName: string | null;
  lastSeenAt: string;
  device: string | null;
  ip: string | null;
}

export interface SeatsFullDetails {
  tenantName: string;
  limit: number;
  inUse: number;
  /** Sólo si quien quedó afuera administra el nodo del cupo: con qué liberar uno y entrar. */
  release?: { token: string; sessions: SeatHolderView[] };
}

/** Todos los puestos simultáneos del nodo del cupo están ocupados. 409. */
export class SeatsFullError extends ConflictException {
  readonly reason = 'SEATS_FULL';
  readonly publicDetails: SeatsFullDetails;

  constructor(details: SeatsFullDetails) {
    super(
      details.limit === 1
        ? `El puesto de ${details.tenantName} está en uso.`
        : `Los ${details.limit} puestos de ${details.tenantName} están en uso.`,
    );
    this.name = 'SeatsFullError';
    this.publicDetails = details;
  }
}

/** El permiso para liberar un puesto venció, ya se usó o no es válido. 401. */
export class SeatReleaseExpiredError extends UnauthorizedException {
  readonly reason = 'SEAT_RELEASE_EXPIRED';

  constructor() {
    super('El permiso para liberar un puesto venció o ya se usó. Volvé a ingresar.');
    this.name = 'SeatReleaseExpiredError';
  }
}

/** Quien pide liberar un puesto ya no administra el nodo del cupo. 403. */
export class SeatReleaseForbiddenError extends ForbiddenException {
  readonly reason = 'SEAT_RELEASE_FORBIDDEN';

  constructor() {
    super('Ya no administrás este nodo: pedile a un administrador que libere un puesto.');
    this.name = 'SeatReleaseForbiddenError';
  }
}

/** Cerrar la sesión actual desde el listado: para eso está "Cerrar sesión". 400. */
export class CurrentSessionRevokeError extends BadRequestException {
  readonly reason = 'CANNOT_REVOKE_CURRENT_SESSION';

  constructor() {
    super('Esta es la sesión que estás usando: cerrala con "Cerrar sesión".');
    this.name = 'CurrentSessionRevokeError';
  }
}

/** La sesión no es del usuario, no existe o ya estaba cerrada. 404. */
export class SessionNotFoundError extends NotFoundException {
  readonly reason = 'SESSION_NOT_FOUND';

  constructor() {
    super('La sesión no existe o ya estaba cerrada.');
    this.name = 'SessionNotFoundError';
  }
}

/** El equipo no es del usuario, no existe o ya estaba quitado. 404. */
export class TrustedDeviceNotFoundError extends NotFoundException {
  readonly reason = 'TRUSTED_DEVICE_NOT_FOUND';

  constructor() {
    super('El equipo no existe o ya no era de confianza.');
    this.name = 'TrustedDeviceNotFoundError';
  }
}

/**
 * Cambiar a una agencia que no opera: ella o un ancestro está suspendido. La sesión actual sigue.
 * 403: la membership existe, pero el nodo no deja operar a nadie.
 */
export class TenantNotOperableError extends ForbiddenException {
  readonly reason = 'TENANT_SUSPENDED';

  constructor() {
    super('Esa agencia está suspendida: no se puede operar con ella por ahora.');
    this.name = 'TenantNotOperableError';
  }
}
