import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkModule } from '../network/network.module.js';
import { ProviderCredentialsController } from './provider-credentials.controller.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';

@Module({
  imports: [DatabaseModule, NetworkModule],
  controllers: [ProviderCredentialsController],
  providers: [ProviderCredentialsService],
  exports: [ProviderCredentialsService],
})
export class ProviderCredentialsModule {}
