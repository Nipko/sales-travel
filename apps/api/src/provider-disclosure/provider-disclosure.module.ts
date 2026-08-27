import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderDisclosureController } from './provider-disclosure.controller.js';
import { ProviderDisclosureService } from './provider-disclosure.service.js';

/**
 * Exporta el servicio porque la búsqueda también lo necesita: el sobre de resultados lleva
 * el ajuste ya resuelto para que la pantalla no tenga que pedirlo por separado y pintar los
 * vuelos antes de saber si puede nombrar al proveedor.
 */
@Module({
  imports: [NetworkModule],
  controllers: [ProviderDisclosureController],
  providers: [ProviderDisclosureService],
  exports: [ProviderDisclosureService],
})
export class ProviderDisclosureModule {}
