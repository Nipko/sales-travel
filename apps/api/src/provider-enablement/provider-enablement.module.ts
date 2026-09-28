import { Module } from '@nestjs/common';
import { ProviderEnablementStore } from './provider-enablement.store.js';

/**
 * El almacén de la habilitación de proveedores, con su caché. Lo importan los módulos de los
 * registries (vuelos y hoteles) y el panel de la plataforma, y tiene que ser UNA instancia: escribir
 * desde el panel invalida la caché que leen las búsquedas.
 */
@Module({
  providers: [ProviderEnablementStore],
  exports: [ProviderEnablementStore],
})
export class ProviderEnablementModule {}
