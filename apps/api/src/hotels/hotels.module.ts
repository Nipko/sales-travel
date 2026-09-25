import { Module } from '@nestjs/common';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProviderDisclosureModule } from '../provider-disclosure/provider-disclosure.module.js';
import { SearchModule } from '../search/search.module.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { HotelsController } from './hotels.controller.js';
import { HotelsService } from './hotels.service.js';

/**
 * La búsqueda va por el registry de proveedores de hoteles; el factory de Despegar se importa
 * sólo para las rutas de reserva que todavía hablan sus DTOs.
 */
@Module({
  imports: [
    HotelProvidersModule,
    DespegarHotelsProviderModule,
    PricingModule,
    SearchModule,
    ProviderDisclosureModule,
  ],
  controllers: [HotelsController],
  providers: [HotelsService, DespegarHotelReservationsService],
})
export class HotelsModule {}
