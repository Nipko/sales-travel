import { BadRequestException } from '@nestjs/common';

/**
 * Los errores propios de Plataforma → Actividad (`GET /admin/audit`). La puerta (sólo el superadmin)
 * es de network/ (SuperadminGuard, rethrowAdminDbError) y el nodo inexistente es el 404 de toda la
 * consola (PlatformConsoleScopeNotFoundError).
 */

/** Un período que no se puede leer: al revés o más largo de lo que se admite. 400. */
export class AuditPeriodInvalidError extends BadRequestException {
  readonly reason = 'AUDIT_PERIOD_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'AuditPeriodInvalidError';
  }
}
