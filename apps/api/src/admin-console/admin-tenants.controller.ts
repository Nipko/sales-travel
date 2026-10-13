import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { TenantIdParamSchema } from '../tenants/dto.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AdminTenantsService,
  type NodeImpactView,
  type NodeStatsView,
} from './admin-tenants.service.js';

/**
 * Plataforma → Agencias en números: puestos, ventas y pendientes de cada nodo, y qué arrastraría
 * suspender uno. La lista de la red y sus correcciones siguen en AdminController (`/admin/tenants`,
 * `PATCH /admin/tenants/:id`); acá sólo se lee.
 *
 * Sólo el superadmin, como el resto del panel de la plataforma: `@Roles` deja fuera a los roles de
 * nodo y {@link SuperadminGuard} a `platform_admin`. No hay `GET /admin/tenants/:id`: `stats` no
 * choca con ninguna ruta de un nodo.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/tenants')
export class AdminTenantsController {
  constructor(private readonly tenants: AdminTenantsService) {}

  @Get('stats')
  async stats(@CurrentUser() userId: string): Promise<{ nodes: NodeStatsView[] }> {
    return { nodes: await this.tenants.stats(userId) };
  }

  @Get(':id/impact')
  async impact(
    @CurrentUser() userId: string,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<NodeImpactView> {
    return this.tenants.impact(userId, tenantId);
  }
}
