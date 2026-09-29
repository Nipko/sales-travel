import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PortfoliosModule } from '../portfolios/portfolios.module.js';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProviderDisclosureModule } from '../provider-disclosure/provider-disclosure.module.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { SearchModule } from '../search/search.module.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { HcnTrackingService } from './hcn-tracking.service.js';
import { HcnTrackingStore } from './hcn-tracking.store.js';
import { HotelBookingVerificationService } from './hotel-booking-verification.service.js';
import { HotelBookingVerificationStore } from './hotel-booking-verification.store.js';
import { HotelBookingService } from './hotel-booking.service.js';
import { HotelCatalogStore } from './hotel-catalog.store.js';
import { HOTEL_CONTENT_CACHE, HotelContentService } from './hotel-content.service.js';
import { HotelPrebookSnapshotStore } from './hotel-prebook-snapshot.store.js';
import { HotelPrebookService } from './hotel-prebook.service.js';
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
 * contextos que el PreBook necesita. El snapshot del PreBook vive en esa misma instancia: depende
 * del contexto, y un despliegue que pierde uno pierde el otro.
 *
 * La reserva con el cuerpo neutral es una orden (PR-4.6): el intent llega de `OrdersModule`
 * (`ExternalOrderIntentService`). `AuditModule` es global y se importa igual para que la
 * dependencia de la saga con sus eventos quede declarada; `BrandingModule` y `LifecycleModule`
 * también son globales.
 *
 * La verificación de una reserva sin respuesta (PR-4.7) y el seguimiento del HCN (PR-5.4) se
 * exportan para `PostSaleModule`, que los ejecuta desde la cola y el barrido; la cola de post-venta
 * es global (`QueueModule`). El plan del HCN lo abren la saga y la verificación al confirmar.
 *
 * La saga retiene el precio de venta en la cartera de la agencia antes del Book y la libera si el
 * proveedor no reservó (PR-4.8): `PortfoliosModule`.
 *
 * La ficha de un hotel (PR-3.6) guarda lo que trae del proveedor en SU instancia del `CachePort`:
 * horas de contenido de catálogo no pueden desalojar los contextos de minutos que el PreBook
 * necesita, ni al revés. Las fotos de los resultados y las ciudades que se cargan al buscarlas
 * escriben el catálogo por `HotelCatalogStore`, sólo por las funciones de 0054.
 */
@Module({
  imports: [
    HotelProvidersModule,
    DespegarHotelsProviderModule,
    PricingModule,
    SearchModule,
    ProviderDisclosureModule,
    OrdersModule,
    PortfoliosModule,
    AuditModule,
  ],
  controllers: [HotelsController],
  providers: [
    HotelsService,
    DespegarHotelReservationsService,
    HotelSearchContextStore,
    HotelPrebookSnapshotStore,
    HotelPrebookService,
    HotelBookingService,
    HotelBookingVerificationStore,
    HotelBookingVerificationService,
    HcnTrackingStore,
    HcnTrackingService,
    HotelContentService,
    HotelCatalogStore,
    { provide: HOTEL_SEARCH_CONTEXT_CACHE, useClass: MemoryCacheAdapter },
    { provide: HOTEL_CONTENT_CACHE, useClass: MemoryCacheAdapter },
  ],
  exports: [HotelBookingVerificationService, HcnTrackingService],
})
export class HotelsModule {}
