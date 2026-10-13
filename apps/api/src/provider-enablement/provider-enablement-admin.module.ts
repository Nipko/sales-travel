import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { SearchModule } from '../search/search.module.js';
import { ProviderEnablementController } from './provider-enablement.controller.js';
import { ProviderEnablementModule } from './provider-enablement.module.js';
import { ProviderEnablementService } from './provider-enablement.service.js';
import { ProviderHealthService } from './provider-health.service.js';

/**
 * El panel de la plataforma para la habilitación de proveedores y su salud. Aparte de
 * {@link ProviderEnablementModule} porque éste lo importan los registries, y el panel importa a los
 * registries: juntos serían un ciclo. `SearchModule` por el circuit breaker, cuyo estado vive en
 * memoria y es UNA instancia por réplica. Exporta el servicio para la consola de la plataforma (el
 * Resumen lee de él el apagado de emergencia de cada proveedor).
 */
@Module({
  imports: [
    ProviderEnablementModule,
    ProvidersModule,
    HotelProvidersModule,
    NetworkModule,
    SearchModule,
  ],
  controllers: [ProviderEnablementController],
  providers: [ProviderEnablementService, ProviderHealthService],
  exports: [ProviderEnablementService],
})
export class ProviderEnablementAdminModule {}
