import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { currentTenantId } from '../request-context/request-context.js';
import { AnnouncementsService, type ActiveAnnouncementView } from './announcements.service.js';

/**
 * La franja de avisos del panel (`GET /announcements/active`): los anuncios vigentes para quien mira
 * en su nodo activo. Cualquier usuario con sesión, sea cual sea su rol: sin `@Roles`, así que
 * RolesGuard no opina y AuthGuard pide la sesión.
 *
 * Una sola lectura (active_announcements(), 0079) que toma el usuario y el nodo del request: nadie
 * pregunta por otra red. El panel la llama al abrir y cada 5 minutos.
 */
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get('active')
  async active(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ announcements: ActiveAnnouncementView[] }> {
    if (!userId) throw new UnauthorizedException();
    return { announcements: await this.announcements.active(userId, currentTenantId()) };
  }
}
