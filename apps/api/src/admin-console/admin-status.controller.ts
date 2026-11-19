import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { AdminStatusService } from './admin-status.service.js';
import type { PlatformStatusView } from './platform-status.fold.js';

/**
 * Plataforma → Estado (`GET /admin/status`): el semáforo de la plataforma y los pendientes del
 * proyecto. Sólo el superadmin, como el resto de la consola. Sólo lee.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/status')
export class AdminStatusController {
  constructor(private readonly statusService: AdminStatusService) {}

  @Get()
  async status(@CurrentUser() userId: string): Promise<PlatformStatusView> {
    return this.statusService.status(userId);
  }
}
