import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { GovernanceAdminService } from './governance-admin.service.js';
import { GovernanceController } from './governance.controller.js';

/**
 * El panel de gobierno de proveedores y formas de pago (docs/platform/17-opciones-de-pago.md).
 * Aparte del almacén (que vive en {@link ProviderEnablementModule} y leen los registries) por la
 * misma razón que el panel de proveedores: importa los registries para sembrar la configuración
 * vigente, y juntos serían un ciclo.
 */
@Module({
  imports: [ProviderEnablementModule, ProvidersModule, HotelProvidersModule, NetworkModule],
  controllers: [GovernanceController],
  providers: [GovernanceAdminService],
  exports: [GovernanceAdminService],
})
export class GovernanceAdminModule {}
