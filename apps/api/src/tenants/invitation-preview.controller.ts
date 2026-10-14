import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { InvitationTokenBodySchema, type InvitationTokenBodyDto } from './dto.js';
import { InvitationPreviewService, type InvitationPreview } from './invitation-preview.service.js';

/**
 * La vista previa de la invitación que pinta /invitacion (USR-17). Aparte de InvitationsController
 * para que ése quede con lo que administra invitaciones.
 */
@Controller('invitations')
export class InvitationPreviewController {
  constructor(private readonly previews: InvitationPreviewService) {}

  /**
   * Pública: la abre quien todavía no tiene sesión. Si llega con una, dice si es la de la cuenta
   * invitada. Con throttle por IP, como el resto de lo que acepta un token sin sesión. Es POST para
   * que el token viaje en el cuerpo y no quede en los logs de acceso.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Public()
  @Post('preview')
  @HttpCode(200)
  preview(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(InvitationTokenBodySchema)) body: InvitationTokenBodyDto,
  ): Promise<InvitationPreview> {
    return this.previews.preview(body.token, userId);
  }
}
