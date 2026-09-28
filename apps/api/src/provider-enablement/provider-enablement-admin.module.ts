import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { ProviderEnablementController } from './provider-enablement.controller.js';
import { ProviderEnablementModule } from './provider-enablement.module.js';
import { ProviderEnablementService } from './provider-enablement.service.js';

/**
 * El panel de la plataforma para la habilitación de proveedores. Aparte de
 * {@link ProviderEnablementModule} porque éste lo importan los registries, y el panel importa a los
 * registries: juntos serían un ciclo.
 */
@Module({
  imports: [ProviderEnablementModule, ProvidersModule, HotelProvidersModule, NetworkModule],
  controllers: [ProviderEnablementController],
  providers: [ProviderEnablementService],
})
export class ProviderEnablementAdminModule {}
