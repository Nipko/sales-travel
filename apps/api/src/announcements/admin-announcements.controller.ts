import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AnnouncementIdParamSchema,
  CreateAnnouncementSchema,
  UpdateAnnouncementSchema,
  type CreateAnnouncementDto,
  type UpdateAnnouncementDto,
} from './announcements.schemas.js';
import { AnnouncementsService, type AdminAnnouncementView } from './announcements.service.js';

/**
 * Plataforma → Sistema › Anuncios: publicar, corregir y archivar los avisos que ve la red en el
 * panel. Sólo el superadmin, como el resto de la consola: `@Roles` deja fuera a los roles de nodo y
 * {@link SuperadminGuard} —antes de los pipes: quien no es superadmin recibe 403 aunque el cuerpo sea
 * inválido— a `platform_admin`. La base lo vuelve a exigir (RLS de 0079).
 *
 * Nada de esto vende: un anuncio es texto plano. Cada cambio deja su rastro
 * (`platform.announcement.*`) con a quién iba y su gravedad, nunca el mensaje.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** Los últimos 50, con su estado: programado, vigente, vencido o archivado. */
  @Get()
  async list(@CurrentUser() userId: string): Promise<{ announcements: AdminAnnouncementView[] }> {
    return { announcements: await this.announcements.list(userId) };
  }

  @Post()
  async create(
    @CurrentUser() userId: string,
    @Body(new ZodValidationPipe(CreateAnnouncementSchema)) dto: CreateAnnouncementDto,
  ): Promise<AdminAnnouncementView> {
    return this.announcements.create(userId, dto);
  }

  @Patch(':id')
  async update(
    @CurrentUser() userId: string,
    @Param('id', new ZodValidationPipe(AnnouncementIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(UpdateAnnouncementSchema)) dto: UpdateAnnouncementDto,
  ): Promise<AdminAnnouncementView> {
    return this.announcements.update(userId, id, dto);
  }

  /** Deja de mostrarse en el acto. */
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @CurrentUser() userId: string,
    @Param('id', new ZodValidationPipe(AnnouncementIdParamSchema)) id: string,
  ): Promise<AdminAnnouncementView> {
    return this.announcements.archive(userId, id);
  }
}
