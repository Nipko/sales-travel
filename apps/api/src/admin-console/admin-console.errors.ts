import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * Los errores propios de la consola de la plataforma (Plataforma → Resumen y las consolas que se le
 * sumen). La puerta (sólo el superadmin) es de network/: SuperadminGuard, SuperadminRequiredError y
 * rethrowAdminDbError.
 */

/** El nodo por el que se quiere acotar la consola no existe. 404. */
export class PlatformConsoleScopeNotFoundError extends NotFoundException {
  readonly reason = 'PLATFORM_CONSOLE_SCOPE_NOT_FOUND';

  constructor() {
    super('Ese nodo no existe: elige otro o mira toda la red.');
    this.name = 'PlatformConsoleScopeNotFoundError';
  }
}

/** Un período que no se puede leer: al revés o más largo de lo que se admite. 400. */
export class InvalidOverviewPeriodError extends BadRequestException {
  readonly reason = 'OVERVIEW_PERIOD_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidOverviewPeriodError';
  }
}
