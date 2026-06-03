import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { LatamNdcProviderFactory } from './latam-ndc.factory.js';

/**
 * Provee el factory de adapters LATAM NDC resueltos por tenant (BYOC + fallback env).
 * Lo consumen SearchModule y OrdersModule.
 */
@Module({
  imports: [ProviderCredentialsModule],
  providers: [LatamNdcProviderFactory],
  exports: [LatamNdcProviderFactory],
})
export class LatamNdcProviderModule {}
