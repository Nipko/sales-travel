import { ForbiddenException } from '@nestjs/common';

/**
 * Un rol de plataforma (`superadmin`, `platform_admin`) llamó a una operación de venta. 403.
 *
 * El superadmin administra y cuadra la red, pero no vende: Planetour vende por sus sucursales. El
 * mensaje le dice qué hacer en vez de un "no tenés permiso" genérico, y `reason` le deja a la web
 * distinguirlo de cualquier otro 403 sin interpretar el texto.
 */
export class PlatformRoleCannotSellError extends ForbiddenException {
  readonly reason = 'PLATFORM_ROLE_CANNOT_SELL';

  constructor() {
    super('El superadministrador no vende: usá un usuario de una sucursal');
    this.name = 'PlatformRoleCannotSellError';
  }
}
