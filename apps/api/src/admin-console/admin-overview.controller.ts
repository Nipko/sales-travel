import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { assertPlatformConsoleAccess } from './admin-console.errors.js';
import { AdminOverviewQuerySchema, type AdminOverviewQuery } from './admin-overview.schemas.js';
import { AdminOverviewService, type AdminOverviewView } from './admin-overview.service.js';

/**
 * Plataforma → Resumen: cómo va la red entera (o el subárbol de un nodo) en un período.
 *
 * Sólo el superadmin, como el resto del panel de la plataforma: `@Roles` deja fuera a los roles de
 * nodo y {@link assertPlatformConsoleAccess} a `platform_admin`. Sólo lee y no es venta: el
 * superadmin cuadra la red pero no vende.
 */
@Roles(...PLATFORM_ROLES)
@Controller('admin/overview')
export class AdminOverviewController {
  constructor(
    private readonly overview: AdminOverviewService,
    private readonly network: NetworkService,
  ) {}

  @Get()
  async get(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(AdminOverviewQuerySchema)) query: AdminOverviewQuery,
  ): Promise<AdminOverviewView> {
    const actor = await assertPlatformConsoleAccess(this.network, userId);
    return this.overview.overview(actor, query);
  }
}
