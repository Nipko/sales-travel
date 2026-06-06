import { Global, Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { MailerService } from './mailer.service.js';

/** Global: cualquier módulo puede inyectar MailerService para enviar notificaciones por email. */
@Global()
@Module({
  imports: [ProviderCredentialsModule],
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
