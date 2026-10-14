import { Global, Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { MailController } from './mail.controller.js';
import { MailerService } from './mailer.service.js';
import { SecurityNoticeService } from './security-notice.service.js';

/**
 * Global: cualquier módulo puede inyectar MailerService para enviar notificaciones por email, y
 * SecurityNoticeService para avisarle a una persona de un cambio de seguridad sobre su acceso.
 */
@Global()
@Module({
  imports: [ProviderCredentialsModule, NetworkModule],
  controllers: [MailController],
  providers: [MailerService, SecurityNoticeService],
  exports: [MailerService, SecurityNoticeService],
})
export class MailerModule {}
