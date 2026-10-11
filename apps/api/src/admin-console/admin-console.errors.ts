import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { NetworkService } from '../network/network.service.js';

/**
 * Los errores de la consola de la plataforma (Plataforma → Resumen y las consolas que se le sumen) y
 * la puerta de entrada que comparten: sólo el superadmin.
 */

/** Quien no es el superadmin no ve la consola de la plataforma. 403. */
export class PlatformConsoleSuperadminOnlyError extends ForbiddenException {
  readonly reason = 'PLATFORM_CONSOLE_SUPERADMIN_ONLY';

  constructor() {
    super('Sólo el superadmin ve la consola de la plataforma. Lo de un nodo se ve desde ese nodo.');
    this.name = 'PlatformConsoleSuperadminOnlyError';
  }
}

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

/**
 * La puerta de la consola: un usuario autenticado que además es el superadmin. `@Roles` de los
 * controladores ya deja fuera a los roles de nodo; esto deja fuera a `platform_admin` (retirado,
 * D7 B), como el resto del panel de la plataforma. La base lo vuelve a exigir en cada lectura
 * (`platform_console_require_superadmin`, 0075).
 */
export async function assertPlatformConsoleAccess(
  network: Pick<NetworkService, 'isSuperadmin'>,
  userId: string | undefined,
): Promise<string> {
  if (!userId) throw new UnauthorizedException();
  if (!(await network.isSuperadmin(userId))) throw new PlatformConsoleSuperadminOnlyError();
  return userId;
}

/** El mensaje con que 0075 rechaza una lectura de toda la red a quien no es el superadmin. */
export const PLATFORM_CONSOLE_DB_DENIAL = 'platform_console_superadmin_required';

/**
 * El rechazo de la base traducido al mismo 403 que da el controlador, o `undefined` si el error es
 * otro. Pasa si el usuario deja de ser superadmin entre la comprobación de la app y la lectura.
 */
export function platformConsoleDbError(
  err: unknown,
): PlatformConsoleSuperadminOnlyError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === '42501' && message === PLATFORM_CONSOLE_DB_DENIAL
    ? new PlatformConsoleSuperadminOnlyError()
    : undefined;
}
