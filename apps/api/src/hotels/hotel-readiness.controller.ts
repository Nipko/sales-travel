import { Controller, ForbiddenException, Get, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { NetworkService } from '../network/network.service.js';
import { HotelReadinessService, type HotelReadinessView } from './hotel-readiness.service.js';

/**
 * Qué le falta a cada sucursal para probar una reserva de hotel: la guía que ve el superadmin en
 * Hoteles en lugar de la búsqueda (D-TBO-H1 A). No es una venta: no da precio ni disponibilidad, y
 * no cambia la regla de que el superadmin no vende.
 *
 * Sólo el superadmin: `@Roles` deja fuera a todo rol de nodo, y la comprobación explícita deja fuera
 * a `platform_admin`, como el resto del panel de la plataforma (`/admin/providers`).
 */
@Roles('superadmin')
@Controller('admin/hotels')
export class HotelReadinessController {
  constructor(
    private readonly service: HotelReadinessService,
    private readonly network: NetworkService,
  ) {}

  @Get('readiness')
  async readiness(@CurrentUser() userId: string | undefined): Promise<HotelReadinessView> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new ForbiddenException('superadmin access required');
    }
    return this.service.readiness(userId);
  }
}
