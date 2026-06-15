import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { AgentCarsProviderFactory } from './agent-cars.factory.js';

/**
 * Provee el factory de adapters AgentCars resueltos por tenant (BYOC + fallback env).
 * Lo consume CarsModule.
 */
@Module({
  imports: [ProviderCredentialsModule],
  providers: [AgentCarsProviderFactory],
  exports: [AgentCarsProviderFactory],
})
export class AgentCarsProviderModule {}
