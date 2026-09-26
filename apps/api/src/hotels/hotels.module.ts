import { Module } from '@nestjs/common';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProviderDisclosureModule } from '../provider-disclosure/provider-disclosure.module.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { SearchModule } from '../search/search.module.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import {
  HOTEL_SEARCH_CONTEXT_CACHE,
  HotelSearchContextStore,
} from './hotel-search-context.store.js';
import { HotelsController } from './hotels.controller.js';
import { HotelsService } from './hotels.service.js';

/**
 * La búsqueda va por el registry de proveedores de hoteles; el factory de Despegar se importa
 * sólo para las rutas de reserva que todavía hablan sus DTOs.
 *
 * El contexto de búsqueda (RF-08) tiene su propia instancia del `CachePort` en memoria y no
 * comparte la de la caché de vuelos: el desalojo por tamaño de una no le quita a la otra
 * contextos que el PreBook necesita.
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
  providers: [
    HotelsService,
    DespegarHotelReservationsService,
    HotelSearchContextStore,
    { provide: HOTEL_SEARCH_CONTEXT_CACHE, useClass: MemoryCacheAdapter },
  ],
})
export class HotelsModule {}
