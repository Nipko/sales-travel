import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { DespegarHotelsProviderFactory } from './despegar-hotels.factory.js';

/**
 * Provee el factory de adapters Despegar Hotels resueltos por tenant (BYOC + fallback env).
 * Lo consume HotelsModule.
 */
@Module({
  imports: [ProviderCredentialsModule],
  providers: [DespegarHotelsProviderFactory],
  exports: [DespegarHotelsProviderFactory],
})
export class DespegarHotelsProviderModule {}
