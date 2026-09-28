import { Module } from '@nestjs/common';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { ProviderPayloadsModule } from '../provider-payloads/provider-payloads.module.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';

/**
 * Provee el factory de TBO Hotels resuelto por tenant: BYOC puro, con la cuenta del consolidador
 * heredada por su red y sin escalón de plataforma (D-TBO-03 A). Lo consume `HotelProvidersModule`.
 * La bóveda de payloads recibe los RQ/RS completos que el ACL nunca manda al log (PR-4.9).
 */
@Module({
  imports: [ProviderCredentialsModule, ProviderPayloadsModule],
  providers: [TboHotelsProviderFactory],
  exports: [TboHotelsProviderFactory],
})
export class TboHotelsProviderModule {}
