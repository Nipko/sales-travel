import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { ProviderPayloadsModule } from '../provider-payloads/provider-payloads.module.js';
import { DespegarActivitiesProviderFactory } from './despegar-activities.factory.js';

/** Factory del ACL de actividades con la cuenta BYOC de Despegar del tenant (la de hoteles). */
@Module({
  imports: [ProviderCredentialsModule, ProviderPayloadsModule],
  providers: [DespegarActivitiesProviderFactory],
  exports: [DespegarActivitiesProviderFactory],
})
export class DespegarActivitiesProviderModule {}
