import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';

/**
 * Provee el factory de TBO Hotels resuelto por tenant: BYOC puro, con la cuenta del consolidador
 * heredada por su red y sin escalón de plataforma (D-TBO-03 A). Lo consume `HotelProvidersModule`.
 */
@Module({
  imports: [ProviderCredentialsModule],
  providers: [TboHotelsProviderFactory],
  exports: [TboHotelsProviderFactory],
})
export class TboHotelsProviderModule {}
