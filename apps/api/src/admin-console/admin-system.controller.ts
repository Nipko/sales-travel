import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { AdminSystemService, type AdminSystemJobsView } from './admin-system.service.js';

/**
 * Plataforma → Sistema: lo que corre solo. Hoy, Procesos (`GET /admin/system/jobs`): el barrido de
 * post-venta, la conciliación diaria, los catálogos y su programación.
 *
 * Sólo el superadmin, como el resto de la consola: `@Roles` deja fuera a los roles de nodo y
 * {@link SuperadminGuard} a `platform_admin`. Sólo lee.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/system')
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}

  @Get('jobs')
  async jobs(@CurrentUser() userId: string): Promise<AdminSystemJobsView> {
    return this.system.jobs(userId);
  }
}
