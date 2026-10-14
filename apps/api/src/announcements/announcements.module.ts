import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkModule } from '../network/network.module.js';
import { AdminAnnouncementsController } from './admin-announcements.controller.js';
import { AnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';

/**
 * Los anuncios de la plataforma (0079): la franja de avisos del panel para cualquier usuario
 * (AnnouncementsController) y su gestión desde Plataforma → Sistema › Anuncios, sólo del superadmin
 * (AdminAnnouncementsController). `NetworkModule` por SuperadminGuard; AuditService es global.
 */
@Module({
  imports: [DatabaseModule, NetworkModule],
  controllers: [AnnouncementsController, AdminAnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
