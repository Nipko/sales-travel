import { Global, Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { MailController } from './mail.controller.js';
import { MailerService } from './mailer.service.js';

/** Global: cualquier módulo puede inyectar MailerService para enviar notificaciones por email. */
@Global()
@Module({
  imports: [ProviderCredentialsModule, NetworkModule],
  controllers: [MailController],
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
