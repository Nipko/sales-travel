import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { SabreProviderFactory } from './sabre.factory.js';

/**
 * Provee el factory de adapters de Sabre resueltos por tenant (BYOC, **sin** fallback a
 * credenciales de plataforma). Lo consume `ProvidersModule` a través del registry.
 */
@Module({
  imports: [ProviderCredentialsModule],
  providers: [SabreProviderFactory],
  exports: [SabreProviderFactory],
})
export class SabreProviderModule {}
